from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from threading import Event
from typing import Any

import boto3
import pytest
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest, ToolRuntime
from moto import mock_aws

from botcube_harness_deepagents.files_sync import (
    FilesSync,
    FilesSyncError,
    excluded_paths,
)
from botcube_harness_deepagents.lazy_files import LazyFilesMiddleware, turn_files


@pytest.fixture
def files(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[FilesSync, Any]]:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        yield FilesSync('turn-files', 'owner/', 'us-east-1', {}), s3


def _request(name: str) -> ToolCallRequest:
    return ToolCallRequest(
        tool_call={'name': name, 'args': {}, 'id': name, 'type': 'tool_call'}, tool=None, state={},
        runtime=ToolRuntime(state={}, context=None, config={}, stream_writer=lambda _: None, tool_call_id=name, store=None),
    )


def test_first_workspace_tool_sees_files_and_its_edits_can_be_published(
    tmp_path: Path, files: tuple[FilesSync, Any],
) -> None:
    sync, s3 = files

    def read_then_edit(request: ToolCallRequest) -> ToolMessage:
        contents = (tmp_path / 'report.csv').read_text()
        (tmp_path / 'report.csv').write_text('date,close\n2026-10-08,10')
        return ToolMessage(contents, tool_call_id=request.tool_call['id'])

    with turn_files(sync, tmp_path, excluded_paths(())) as readiness:
        assert not readiness.ready
        message = LazyFilesMiddleware().wrap_tool_call(_request('read_file'), read_then_edit)
        assert isinstance(message, ToolMessage)
        assert message.content == 'date,close'
        assert readiness.ready
        sync.push(tmp_path, excluded_paths(()))

    assert s3.get_object(Bucket='turn-files', Key='owner/report.csv')['Body'].read() == b'date,close\n2026-10-08,10'


def test_plain_answer_startup_reads_and_nonworkspace_tools_do_not_pull(
    tmp_path: Path, files: tuple[FilesSync, Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    sync, s3 = files
    (tmp_path / 'ltm.md').write_text('Remember this')
    calls: list[str] = []

    def no_s3(**kwargs: Any) -> None:
        raise AssertionError('Plain answer accessed Files')

    monkeypatch.setattr(s3, 'list_objects_v2', no_s3)

    async def handler(request: ToolCallRequest) -> ToolMessage:
        calls.append(request.tool_call['name'])
        return ToolMessage('Done', tool_call_id=request.tool_call['id'])

    async def answer() -> None:
        with turn_files(sync, tmp_path, excluded_paths(())) as readiness:
            assert (tmp_path / 'ltm.md').read_text() == 'Remember this'
            for name in ('task', 'browser', 'agent_core_memory', 'web_search'):
                await LazyFilesMiddleware().awrap_tool_call(_request(name), handler)
            assert not readiness.ready

    asyncio.run(answer())
    assert calls == ['task', 'browser', 'agent_core_memory', 'web_search']
    assert not (tmp_path / 'report.csv').exists()


def test_parallel_child_tools_and_sync_tool_share_one_pull(
    tmp_path: Path, files: tuple[FilesSync, Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    sync, s3 = files
    listed = Event()
    release = Event()
    listing = s3.list_objects_v2
    listings: list[str] = []
    observed: list[str] = []

    def delayed_listing(**kwargs: Any) -> Any:
        listings.append(kwargs['Prefix'])
        listed.set()
        if not release.wait(5):
            raise AssertionError('Test never released Files listing')
        return listing(**kwargs)

    monkeypatch.setattr(s3, 'list_objects_v2', delayed_listing)

    def read(request: ToolCallRequest) -> ToolMessage:
        observed.append(request.tool_call['name'])
        return ToolMessage((tmp_path / 'report.csv').read_text(), tool_call_id=request.tool_call['id'])

    async def aread(request: ToolCallRequest) -> ToolMessage:
        return read(request)

    async def parallel() -> None:
        with turn_files(sync, tmp_path, excluded_paths(())) as readiness:
            parent = asyncio.create_task(LazyFilesMiddleware().awrap_tool_call(_request('read_file'), aread))
            assert await asyncio.to_thread(listed.wait, 5)
            children = [asyncio.create_task(LazyFilesMiddleware().awrap_tool_call(_request(name), aread))
                        for name in ('ls', 'write_file', 'edit_file', 'glob', 'grep')]
            synchronous = asyncio.create_task(asyncio.to_thread(LazyFilesMiddleware().wrap_tool_call, _request('execute'), read))
            assert observed == []
            assert not readiness.ready
            release.set()
            results = await asyncio.gather(parent, *children, synchronous)
            assert len(results) == 7
            for result in results:
                assert isinstance(result, ToolMessage)
                assert result.content == 'date,close'
            assert readiness.ready

    asyncio.run(parallel())
    assert listings == ['owner/']
    assert sorted(observed) == ['edit_file', 'execute', 'glob', 'grep', 'ls', 'read_file', 'write_file']


def test_failed_pull_preserves_exception_and_blocks_every_tool_without_retry(
    tmp_path: Path, files: tuple[FilesSync, Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    sync, s3 = files
    failure = FilesSyncError('Files listing failed')
    listings: list[str] = []

    def failed_listing(**kwargs: Any) -> None:
        listings.append(kwargs['Prefix'])
        raise failure

    monkeypatch.setattr(s3, 'list_objects_v2', failed_listing)

    def forbidden(request: ToolCallRequest) -> ToolMessage:
        raise AssertionError('A tool ran after Files pull failed')

    async def aforbidden(request: ToolCallRequest) -> ToolMessage:
        return forbidden(request)

    async def attempts() -> None:
        with turn_files(sync, tmp_path, excluded_paths(())) as readiness:
            results = await asyncio.gather(
                LazyFilesMiddleware().awrap_tool_call(_request('read_file'), aforbidden),
                LazyFilesMiddleware().awrap_tool_call(_request('write_file'), aforbidden),
                return_exceptions=True,
            )
            assert results == [failure, failure]
            with pytest.raises(FilesSyncError) as caught:
                LazyFilesMiddleware().wrap_tool_call(_request('execute'), forbidden)
            assert caught.value is failure
            assert not readiness.ready
            # The stream adapter catches graph errors; settlement must retain the original code.
            with pytest.raises(FilesSyncError) as settled:
                readiness.raise_if_failed()
            assert settled.value is failure

    asyncio.run(attempts())
    assert listings == ['owner/']


@pytest.mark.parametrize('fails', [False, True])
def test_cancelled_tool_finishes_pull_before_cancellation_escapes(
    tmp_path: Path, files: tuple[FilesSync, Any], monkeypatch: pytest.MonkeyPatch, fails: bool,
) -> None:
    sync, s3 = files
    listed = Event()
    release = Event()
    listing = s3.list_objects_v2
    tools: list[str] = []
    failure = FilesSyncError('Files listing failed while stopping')

    def delayed_listing(**kwargs: Any) -> Any:
        listed.set()
        if not release.wait(5):
            raise AssertionError('Test never released Files listing')
        if fails:
            raise failure
        return listing(**kwargs)

    monkeypatch.setattr(s3, 'list_objects_v2', delayed_listing)

    async def handler(request: ToolCallRequest) -> ToolMessage:
        tools.append(request.tool_call['name'])
        return ToolMessage('Done', tool_call_id=request.tool_call['id'])

    async def cancelled() -> None:
        with turn_files(sync, tmp_path, excluded_paths(())) as readiness:
            work = asyncio.create_task(LazyFilesMiddleware().awrap_tool_call(_request('write_file'), handler))
            assert await asyncio.to_thread(listed.wait, 5)
            work.cancel()
            await asyncio.sleep(0)
            assert not work.done()
            assert not readiness.ready
            release.set()
            if fails:
                with pytest.raises(FilesSyncError) as caught:
                    await work
                assert caught.value is failure
                assert not readiness.ready
            else:
                with pytest.raises(asyncio.CancelledError):
                    await work
                assert readiness.ready
                assert (tmp_path / 'report.csv').read_text() == 'date,close'

    asyncio.run(cancelled())
    assert tools == []


def test_each_turn_refreshes_and_scope_exit_does_not_leak_readiness(
    tmp_path: Path, files: tuple[FilesSync, Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    sync, s3 = files
    listing = s3.list_objects_v2
    listings: list[str] = []

    def count_listing(**kwargs: Any) -> Any:
        listings.append(kwargs['Prefix'])
        return listing(**kwargs)

    monkeypatch.setattr(s3, 'list_objects_v2', count_listing)

    def handler(request: ToolCallRequest) -> ToolMessage:
        return ToolMessage((tmp_path / 'report.csv').read_text(), tool_call_id=request.tool_call['id'])

    for _ in range(2):
        with turn_files(sync, tmp_path, excluded_paths(())) as readiness:
            LazyFilesMiddleware().wrap_tool_call(_request('read_file'), handler)
            assert readiness.ready
    with turn_files(sync, tmp_path, excluded_paths(())) as unused:
        assert not unused.ready
    LazyFilesMiddleware().wrap_tool_call(_request('read_file'), handler)
    assert listings == ['owner/', 'owner/']


def test_absent_files_binding_passes_workspace_tool_through(tmp_path: Path) -> None:
    def handler(request: ToolCallRequest) -> ToolMessage:
        return ToolMessage('Local workspace', tool_call_id=request.tool_call['id'])

    with turn_files(None, tmp_path, ()) as readiness:
        result = LazyFilesMiddleware().wrap_tool_call(_request('ls'), handler)
        assert isinstance(result, ToolMessage)
        assert result.content == 'Local workspace'
        assert not readiness.ready
