from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from ag_ui.core import EventType, RunAgentInput
from ag_ui_langgraph import LangGraphAgent
from langchain.agents import AgentState
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt.tool_node import ToolCallRequest, ToolRuntime

from botcube_harness_deepagents import serving
from botcube_harness_deepagents.files_mount import FilesMount
from botcube_harness_deepagents.lazy_files import (
    LazyFilesMiddleware,
    current_turn_files,
)
from conftest import prepared


def _use_workspace() -> None:
    request = ToolCallRequest(
        tool_call={'name': 'write_file', 'args': {}, 'id': 'file-tool', 'type': 'tool_call'},
        tool=None, state={},
        runtime=ToolRuntime(state={}, context=None, config={}, stream_writer=lambda _: None, tool_call_id='file-tool', store=None),
    )
    LazyFilesMiddleware().wrap_tool_call(request, lambda call: ToolMessage('Done', tool_call_id=call.tool_call['id']))


def _agent(*, use_files: bool = False) -> serving._SessionAgent:
    def reply(state: Any) -> dict[str, Any]:
        if use_files:
            _use_workspace()
        return {'messages': [AIMessage('Done', id='answer')]}

    graph = StateGraph(AgentState)
    graph.add_node('reply', reply)
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


def test_replacement_after_completion_does_not_cancel_iterator_cleanup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from ag_ui.core import RunFinishedEvent

    async def exercise() -> None:
        closing = asyncio.Event()
        release = asyncio.Event()

        class Agent:
            async def run(self, input: RunAgentInput):
                try:
                    _use_workspace()
                    yield RunFinishedEvent(thread_id=input.thread_id or '', run_id=input.run_id)
                finally:
                    closing.set()
                    await release.wait()


        monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
        files = cast(FilesMount, SimpleNamespace(pull=lambda *args: None))
        turns = serving._SessionTurns()
        stream = turns.stream(('owner', 'session'), prepared(cast(LangGraphAgent, Agent()), tmp_path), _input(), files, serving._RequestContext(None))
        completion = asyncio.create_task(anext(stream))
        await closing.wait()
        assert not completion.done()
        next_stream = turns.stream(('owner', 'session'), prepared(_agent(), tmp_path), _input('next'), None, serving._RequestContext(None))
        next_event = asyncio.create_task(anext(next_stream))
        await asyncio.sleep(0.02)
        assert not next_event.done()
        release.set()
        assert (await completion).type == EventType.RUN_FINISHED
        await next_event
        await next_stream.aclose()
        assert [event async for event in stream] == []

    asyncio.run(exercise())


def test_an_errored_graph_does_not_publish_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from ag_ui.core import RunErrorEvent

    from botcube_harness_deepagents import publish

    def forbidden(*args: Any, **kwargs: Any) -> None:
        raise AssertionError('An errored graph published linked Files')

    monkeypatch.setattr(publish, 'import_linked_files', forbidden)

    class Agent:
        async def run(self, input: RunAgentInput):
            _use_workspace()
            yield RunErrorEvent(message='Graph failed', code='GRAPH_FAILED')


    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
    files = cast(FilesMount, SimpleNamespace(pull=lambda *args: None))

    async def exercise() -> None:
        events = [event async for event in serving._SessionTurns().stream(
            ('owner', 'session'), prepared(cast(LangGraphAgent, Agent()), tmp_path), _input(), files, serving._RequestContext(None),
        )]
        assert [(event.type, event.code) for event in events] == [(EventType.RUN_ERROR, 'GRAPH_FAILED')]

    asyncio.run(exercise())


def test_an_errored_stream_drains_background_files_before_eof(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from ag_ui.core import RunErrorEvent, ToolCallStartEvent

    entered, release = threading.Event(), threading.Event()
    marker = tmp_path / 'downloaded.txt'

    def pull(*args: Any) -> None:
        entered.set()
        assert release.wait(5)
        marker.write_text('settled')

    class Agent:
        async def run(self, input: RunAgentInput):
            readiness = current_turn_files()
            assert readiness is not None
            readiness.prefetch()
            readiness.used = True
            yield ToolCallStartEvent(tool_call_id='selected', tool_call_name='execute')
            assert await asyncio.to_thread(entered.wait, 5)
            yield RunErrorEvent(message='Arguments failed', code='GRAPH_FAILED')

    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
    files = cast(FilesMount, SimpleNamespace(pull=pull))

    async def exercise() -> None:
        stream = serving._SessionTurns().stream(
            ('owner', 'session'), prepared(cast(LangGraphAgent, Agent()), tmp_path),
            _input(), files, serving._RequestContext(None),
        )
        assert (await anext(stream)).type == EventType.TOOL_CALL_START
        completion = asyncio.create_task(anext(stream))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            await asyncio.sleep(0)
            assert not completion.done()
        finally:
            release.set()
        assert (await completion).code == 'GRAPH_FAILED'
        assert marker.read_text() == 'settled'
        await stream.aclose()

    asyncio.run(exercise())


@pytest.mark.parametrize('stop_first', [False, True])
def test_cancelled_publish_settles_before_the_replacement_writes_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stop_first: bool,
) -> None:
    from ag_ui.core import RunFinishedEvent

    from botcube_harness_deepagents import publish
    from botcube_harness_deepagents.publish import publish_tool

    async def exercise() -> None:
        uploading = threading.Event()
        release = threading.Event()
        replacement_started = asyncio.Event()
        stored: list[bytes] = []
        source = tmp_path / 'tmp' / 'chart.svg'
        source.parent.mkdir()
        source.write_bytes(b'old chart')

        original = publish._publish_file

        def move(root: Path, excluded: Any, path: str) -> str:
            result = original(root, excluded, path)
            content = (root / 'artifacts' / 'chart.svg').read_bytes()
            if not stored:
                uploading.set()
                if not release.wait(5):
                    raise AssertionError('The publish upload was never released')
            stored.append(content)
            return result

        monkeypatch.setattr(publish, '_publish_file', move)

        class Agent:
            async def run(self, input: RunAgentInput):
                if input.run_id == 'run':
                    await publish_tool(tmp_path).ainvoke({'path': str(source)})
                else:
                    replacement_started.set()
                    (tmp_path / 'artifacts' / 'chart.svg').write_bytes(b'replacement chart')
                    await publish_tool(tmp_path).ainvoke({'path': '/artifacts/chart.svg'})
                yield RunFinishedEvent(thread_id=input.thread_id or '', run_id=input.run_id)

        monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
        files = cast(FilesMount, SimpleNamespace(pull=lambda *args: None))
        turns = serving._SessionTurns()
        session = ('owner', 'session')
        agent = cast(LangGraphAgent, Agent())
        stream = turns.stream(session, prepared(agent, tmp_path), _input(), files, serving._RequestContext(None))
        replacement = turns.stream(session, prepared(agent, tmp_path), _input('next'), files, serving._RequestContext(None))
        completion = asyncio.create_task(anext(stream))
        completions = [completion]
        try:
            assert await asyncio.to_thread(uploading.wait, 2)
            if stop_first:
                turns.stop(session, 'run')
            next_completion = asyncio.create_task(anext(replacement))
            completions.append(next_completion)
            for _ in range(20):
                await asyncio.sleep(0)
            assert not replacement_started.is_set(), 'Replacement started before the cancelled publication drained'
            release.set()
            async with asyncio.timeout(2):
                await completion
                assert (await next_completion).type == EventType.RUN_FINISHED
            assert stored[-1] == b'replacement chart'
            assert (tmp_path / 'artifacts' / 'chart.svg').read_bytes() == b'replacement chart'
        finally:
            release.set()
            await asyncio.gather(*completions)
            await stream.aclose()
            await replacement.aclose()

    asyncio.run(exercise())
