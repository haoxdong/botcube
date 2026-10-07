from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import boto3
import pytest
from ag_ui.core import EventType, RunAgentInput
from ag_ui_langgraph import LangGraphAgent
from langchain.agents import AgentState
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from moto import mock_aws

from botcube_harness_deepagents import serving
from botcube_harness_deepagents.files_sync import FilesSync


def _agent() -> serving._SessionAgent:
    graph = StateGraph(AgentState)
    graph.add_node('reply', lambda state: {'messages': [AIMessage('Done', id='answer')]})
    graph.add_edge(START, 'reply')
    graph.add_edge('reply', END)
    return serving._SessionAgent(name='test', graph=graph.compile(checkpointer=MemorySaver()))


def _input(run_id: str = 'run') -> RunAgentInput:
    return RunAgentInput(thread_id='session', run_id=run_id, messages=[], tools=[], context=[], state={}, forwarded_props={})


def test_finished_run_does_not_build_the_whole_session_messages_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    async def unexpected_snapshot(self: Any, config: Any):
        raise AssertionError('A finished Turn rebuilt its whole Session snapshot')
        yield

    monkeypatch.setattr(LangGraphAgent, 'get_state_and_messages_snapshots', unexpected_snapshot)

    async def exercise() -> None:
        agent = _agent()
        read = agent.graph.aget_state

        async def read_before_completion(*args: Any, **kwargs: Any):
            assert agent._graph_ended_at is None, 'A finished graph was read again before RUN_FINISHED'
            return await read(*args, **kwargs)

        monkeypatch.setattr(agent.graph, 'aget_state', read_before_completion)
        events = [event async for event in agent.run(_input())]
        assert events[-1].type == EventType.RUN_FINISHED
        assert EventType.MESSAGES_SNAPSHOT not in [event.type for event in events]
        assert agent.active_run is None

    asyncio.run(exercise())


def test_run_finished_makes_a_new_chart_readable_without_reloading(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    chart = '<svg xmlns="http://www.w3.org/2000/svg"><text>Chart</text></svg>'

    async def snapshot(*args: Any) -> None:
        pass

    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
    monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
    monkeypatch.setattr(serving, '_DEFERRED_SAVER', None)
    for name in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_ENDPOINT_URL_S3'):
        monkeypatch.delenv(name, raising=False)

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        upload = s3.upload_file

        def gated_upload(*args: Any, **kwargs: Any) -> None:
            entered.set()
            if not release.wait(5):
                raise AssertionError('The chart upload was never released')
            upload(*args, **kwargs)

        monkeypatch.setattr(s3, 'upload_file', gated_upload)
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        graph = StateGraph(AgentState)

        def reply(state: Any) -> dict[str, Any]:
            (tmp_path / 'chart.svg').write_text(chart)
            return {'messages': [AIMessage('![Chart](chart.svg)', id='answer')]}

        graph.add_node('reply', reply)
        graph.add_edge(START, 'reply')
        graph.add_edge('reply', END)
        agent = serving._SessionAgent(name='test', graph=graph.compile(checkpointer=MemorySaver()))

        async def exercise() -> None:
            stream = serving._SessionTurns().stream(
                ('owner', 'session'), agent, _input(), files, tmp_path, serving._RequestContext(None),
            )

            async def read_chart_on_completion() -> str:
                async for event in stream:
                    if event.type == EventType.RUN_FINISHED:
                        return s3.get_object(Bucket='turn-files', Key='owner/chart.svg')['Body'].read().decode()
                raise AssertionError('The Turn did not finish')

            read = asyncio.create_task(read_chart_on_completion())
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                await asyncio.sleep(0)
                if read.done():
                    assert await read == chart
                release.set()
                async with asyncio.timeout(2):
                    assert await read == chart
            finally:
                release.set()
                await stream.aclose()

        asyncio.run(exercise())


def test_turn_without_files_finishes_after_history_settlement(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    async def exercise() -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def snapshot(*args: Any) -> None:
            entered.set()
            await release.wait()

        monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
        monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
        monkeypatch.setattr(serving, '_DEFERRED_SAVER', None)
        stream = serving._SessionTurns().stream(
            ('owner', 'session'), _agent(), _input(), None, tmp_path, serving._RequestContext(None),
        )
        try:
            async def collect() -> list[EventType]:
                return [event.type async for event in stream]

            completion = asyncio.create_task(collect())
            async with asyncio.timeout(2):
                await entered.wait()
            assert not completion.done()
            release.set()
            async with asyncio.timeout(2):
                assert (await completion)[-1] == EventType.RUN_FINISHED
        finally:
            release.set()
            await stream.aclose()

    asyncio.run(exercise())


@pytest.mark.parametrize('mode', ['dynamic', 'before', 'after'])
def test_graph_interrupts_keep_the_adapters_finalization(mode: str) -> None:
    from langgraph.types import interrupt

    graph = StateGraph(AgentState)

    def reply(state: Any) -> dict[str, Any]:
        if mode == 'dynamic':
            interrupt('Approval required')
        return {'messages': [AIMessage('Done', id='answer')]}

    graph.add_node('reply', reply)
    graph.add_node('next', lambda state: {})
    graph.add_edge(START, 'reply')
    graph.add_edge('reply', 'next')
    graph.add_edge('next', END)
    agent = serving._SessionAgent(name='test', graph=graph.compile(
        checkpointer=MemorySaver(),
        interrupt_before=['reply'] if mode == 'before' else None,
        interrupt_after=['reply'] if mode == 'after' else None,
    ))

    async def exercise() -> None:
        events = [event async for event in agent.run(_input())]
        assert events[-1].type == EventType.RUN_FINISHED
        assert agent._interrupted
        assert agent.active_run is None
        if mode == 'dynamic':
            assert [event.value for event in events if event.type == EventType.CUSTOM] == ['Approval required']
        state = await agent.graph.aget_state({'configurable': {'thread_id': 'session'}})
        assert state.next == (('next',) if mode == 'after' else ('reply',))

    asyncio.run(exercise())


def test_failed_files_settlement_preserves_history_and_fails_the_current_turn(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    saved: list[str] = []
    failure = serving.FilesSyncError('Files could not be uploaded')

    def push(*args: Any) -> None:
        raise failure

    async def snapshot(*args: Any) -> None:
        saved.append('history')

    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
    monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
    monkeypatch.setattr(serving, '_DEFERRED_SAVER', None)
    files = cast(FilesSync, SimpleNamespace(pull=lambda *args: None, push=push))

    async def exercise() -> None:
        turns = serving._SessionTurns()
        received = []
        with pytest.raises(serving.FilesSyncError) as caught:
            async for event in turns.stream(
                ('owner', 'session'), _agent(), _input(), files, tmp_path, serving._RequestContext(None),
            ):
                received.extend([event.type])
        assert EventType.RUN_FINISHED not in received
        assert caught.value is failure
        assert saved == ['history']
        await asyncio.sleep(0)
        assert 'Task exception was never retrieved' not in caplog.text

    asyncio.run(exercise())


def test_replacement_after_completion_does_not_cancel_iterator_cleanup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from ag_ui.core import RunFinishedEvent

    async def exercise() -> None:
        closing = asyncio.Event()
        release = asyncio.Event()
        pushed = []

        class Agent:
            async def run(self, input: RunAgentInput):
                try:
                    yield RunFinishedEvent(thread_id=input.thread_id or '', run_id=input.run_id)
                finally:
                    closing.set()
                    await release.wait()

        async def snapshot(*args: Any) -> None:
            pass

        monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
        monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
        monkeypatch.setattr(serving, '_DEFERRED_SAVER', None)
        files = cast(FilesSync, SimpleNamespace(pull=lambda *args: None, push=lambda *args: pushed.append('files')))
        turns = serving._SessionTurns()
        stream = turns.stream(('owner', 'session'), cast(LangGraphAgent, Agent()), _input(), files, tmp_path, serving._RequestContext(None))
        completion = asyncio.create_task(anext(stream))
        await closing.wait()
        assert not completion.done()
        next_stream = turns.stream(('owner', 'session'), _agent(), _input('next'), None, tmp_path, serving._RequestContext(None))
        next_event = asyncio.create_task(anext(next_stream))
        await asyncio.sleep(0.02)
        assert not next_event.done()
        release.set()
        assert (await completion).type == EventType.RUN_FINISHED
        await next_event
        assert pushed == ['files']
        await next_stream.aclose()
        assert [event async for event in stream] == []

    asyncio.run(exercise())


def test_an_errored_graph_does_not_publish_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from ag_ui.core import RunErrorEvent

    pushed: list[str] = []

    class Agent:
        async def run(self, input: RunAgentInput):
            yield RunErrorEvent(message='Graph failed', code='GRAPH_FAILED')

    async def snapshot(*args: Any) -> None:
        pass

    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
    monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
    monkeypatch.setattr(serving, '_DEFERRED_SAVER', None)
    files = cast(FilesSync, SimpleNamespace(pull=lambda *args: None, push=lambda *args: pushed.append('files')))

    async def exercise() -> None:
        events = [event async for event in serving._SessionTurns().stream(
            ('owner', 'session'), cast(LangGraphAgent, Agent()), _input(), files, tmp_path, serving._RequestContext(None),
        )]
        assert [(event.type, event.code) for event in events] == [(EventType.RUN_ERROR, 'GRAPH_FAILED')]
        assert pushed == []

    asyncio.run(exercise())


def test_files_completion_waits_for_checkpoint_flush_and_stop_keeps_the_upload_lock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    async def exercise() -> None:
        uploading = threading.Event()
        stored = threading.Event()
        flushing = asyncio.Event()
        flushed = asyncio.Event()
        snapshots: list[str] = []
        started: list[str] = []

        def push(*args: Any) -> None:
            uploading.set()
            if not stored.wait(5):
                raise AssertionError('The upload was never released')

        async def flush(session: tuple[str, str]) -> None:
            flushing.set()
            await flushed.wait()

        async def snapshot(session: Any, agent: Any, run_id: str) -> None:
            snapshots.append(run_id)

        from ag_ui.core import RunFinishedEvent

        class Agent:
            async def run(self, input: RunAgentInput):
                started.append(input.run_id)
                yield RunFinishedEvent(thread_id=input.thread_id or '', run_id=input.run_id)

        monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
        monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
        monkeypatch.setattr(serving, '_DEFERRED_SAVER', SimpleNamespace(aflush=flush))
        files = cast(FilesSync, SimpleNamespace(pull=lambda *args: None, push=push))
        turns = serving._SessionTurns()
        session = ('owner', 'session')
        agent = cast(LangGraphAgent, Agent())
        stream = turns.stream(session, agent, _input(), files, tmp_path, serving._RequestContext(None))
        completion = asyncio.create_task(anext(stream))
        next_stream = turns.stream(session, agent, _input('next'), None, tmp_path, serving._RequestContext(None))
        try:
            assert await asyncio.to_thread(uploading.wait, 2)
            turns.stop(session, 'run')
            next_completion = asyncio.create_task(anext(next_stream))
            await asyncio.sleep(0)
            assert not completion.done()
            assert not next_completion.done()
            assert started == ['run']
            stored.set()
            async with asyncio.timeout(2):
                await flushing.wait()
            assert not completion.done()
            assert snapshots == []
            assert not next_completion.done()
            assert started == ['run']
            flushed.set()
            async with asyncio.timeout(2):
                assert (await completion).type == EventType.RUN_FINISHED
                assert (await next_completion).type == EventType.RUN_FINISHED
            assert snapshots[0] == 'run'
            assert started == ['run', 'next']
        finally:
            stored.set()
            flushed.set()
            await stream.aclose()
            await next_stream.aclose()

    asyncio.run(exercise())
