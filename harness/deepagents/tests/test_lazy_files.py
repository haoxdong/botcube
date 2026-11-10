from __future__ import annotations

import asyncio
from pathlib import Path
from threading import Event
from typing import Any

import pytest
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest, ToolRuntime

from botcube_harness_deepagents import turn_timing
from botcube_harness_deepagents.files_mount import FilesMount, FilesMountError
from botcube_harness_deepagents.lazy_files import LazyFilesMiddleware, turn_files
from mounted_files import binding


def request(name: str) -> ToolCallRequest:
    return ToolCallRequest(
        tool_call={'name': name, 'args': {}, 'id': name, 'type': 'tool_call'}, tool=None, state={},
        runtime=ToolRuntime(state={}, context=None, config={}, stream_writer=lambda _: None, tool_call_id=name, store=None),
    )


def test_workspace_tools_share_one_mount_and_keep_edits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    entered, release = Event(), Event()
    mounts: list[Path] = []

    def mount(self: FilesMount, root: Path, excluded: Any) -> None:
        mounts.append(root)
        entered.set()
        assert release.wait(5)
        (root / 'report.csv').write_text('date,close')

    monkeypatch.setattr(FilesMount, 'pull', mount)

    async def read(call: ToolCallRequest) -> ToolMessage:
        return ToolMessage((tmp_path / 'report.csv').read_text(), tool_call_id=call.tool_call['id'])

    async def exercise() -> None:
        with turn_files(FilesMount.from_binding(binding()), tmp_path, ()) as readiness:
            tasks = [asyncio.create_task(LazyFilesMiddleware().awrap_tool_call(request(name), read))
                     for name in ('read_file', 'ls', 'write_file', 'execute')]
            assert await asyncio.to_thread(entered.wait, 5)
            assert not readiness.ready
            release.set()
            results = await asyncio.gather(*tasks)
            assert all(isinstance(result, ToolMessage) and result.content == 'date,close' for result in results)
            assert readiness.ready
            (tmp_path / 'report.csv').write_text('edited')
        assert (tmp_path / 'report.csv').read_text() == 'edited'
        assert mounts == [tmp_path]

    asyncio.run(exercise())


def test_nonworkspace_tools_do_not_require_a_mount(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: Any) -> None:
        raise AssertionError('Nonworkspace tool required Files')

    monkeypatch.setattr(FilesMount, 'pull', forbidden)

    def answer(call: ToolCallRequest) -> ToolMessage:
        return ToolMessage('Done', tool_call_id=call.tool_call['id'])

    with turn_files(FilesMount.from_binding(binding()), tmp_path, ()) as readiness:
        for name in ('task', 'browser', 'memory', 'web_search'):
            LazyFilesMiddleware().wrap_tool_call(request(name), answer)
        assert not readiness.used
        assert not readiness.ready


@pytest.mark.parametrize('fails', [False, True])
def test_cancelled_workspace_tool_settles_mount_before_releasing_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fails: bool,
) -> None:
    entered, release = Event(), Event()
    failure = FilesMountError('EFS unavailable')

    def mount(*args: Any) -> None:
        entered.set()
        assert release.wait(5)
        if fails:
            raise failure
        (tmp_path / 'report.csv').write_text('mounted')

    monkeypatch.setattr(FilesMount, 'pull', mount)

    async def forbidden(call: ToolCallRequest) -> ToolMessage:
        raise AssertionError('Cancelled tool ran')

    async def exercise() -> None:
        with turn_files(FilesMount.from_binding(binding()), tmp_path, ()) as readiness:
            work = asyncio.create_task(LazyFilesMiddleware().awrap_tool_call(request('read_file'), forbidden))
            assert await asyncio.to_thread(entered.wait, 5)
            work.cancel()
            await asyncio.sleep(0)
            assert not work.done()
            release.set()
            with pytest.raises(FilesMountError if fails else asyncio.CancelledError):
                await work
            if fails:
                with pytest.raises(FilesMountError) as caught:
                    readiness.ensure()
                assert caught.value is failure
            else:
                assert readiness.ready
                assert (tmp_path / 'report.csv').read_text() == 'mounted'

    asyncio.run(exercise())


def test_failed_mount_blocks_parallel_and_later_tools_without_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    failure = FilesMountError('EFS unavailable')
    calls: list[bool] = []

    def mount(*args: Any) -> None:
        calls.append(True)
        raise failure

    monkeypatch.setattr(FilesMount, 'pull', mount)

    async def forbidden(call: ToolCallRequest) -> ToolMessage:
        raise AssertionError('Tool ran without Files')

    async def exercise() -> None:
        with turn_files(FilesMount.from_binding(binding()), tmp_path, ()) as readiness:
            results = await asyncio.gather(*(LazyFilesMiddleware().awrap_tool_call(request(name), forbidden)
                                             for name in ('read_file', 'write_file')), return_exceptions=True)
            assert results == [failure, failure]
            with pytest.raises(FilesMountError) as caught:
                readiness.ensure()
            assert caught.value is failure
        assert calls == [True]

    asyncio.run(exercise())


def test_each_turn_checks_mount_and_times_it_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mounts: list[Path] = []
    monkeypatch.setattr(FilesMount, 'pull', lambda self, root, excluded: mounts.append(root))
    timing = turn_timing.TurnTiming('run', 'session', 'model', warmup=False, receipt=0.0)
    for _ in range(2):
        with turn_timing.use(timing), turn_files(FilesMount.from_binding(binding()), tmp_path, ()) as readiness:
            readiness.ensure()
            readiness.ensure()
        with turn_files(None, tmp_path, ()) as unbound:
            assert not unbound.ready
    assert mounts == [tmp_path, tmp_path]
    record = timing.record(turn_timing.perf_counter(), 'finished')
    assert record['phaseCounts'] == {'files_pull': 2}
    assert record['phasesMs']['files_pull'] > 0
