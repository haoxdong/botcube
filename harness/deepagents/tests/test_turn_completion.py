from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from ag_ui.core import EventType, RunAgentInput, RunErrorEvent, UserMessage
from ag_ui_langgraph import LangGraphAgent
from langchain.agents import AgentState
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt.tool_node import ToolCallRequest, ToolRuntime
from opentelemetry.instrumentation.langchain.patch import (
    create_graph_invocation_wrapper,
)
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from botcube_harness_deepagents import serving, turn_lifecycle
from botcube_harness_deepagents.files_mount import FilesMount
from botcube_harness_deepagents.lazy_files import (
    LazyFilesMiddleware,
    current_turn_files,
)
from botcube_harness_deepagents.session_agent import SessionAgent
from conftest import prepared


def _use_workspace() -> None:
    request = ToolCallRequest(
        tool_call={'name': 'write_file', 'args': {}, 'id': 'file-tool', 'type': 'tool_call'},
        tool=None, state={},
        runtime=ToolRuntime(state={}, context=None, config={}, stream_writer=lambda _: None, tool_call_id='file-tool', store=None),
    )
    LazyFilesMiddleware().wrap_tool_call(request, lambda call: ToolMessage('Done', tool_call_id=call.tool_call['id']))


def _agent(*, use_files: bool = False) -> SessionAgent:
    def reply(state: Any) -> dict[str, Any]:
        if use_files:
            _use_workspace()
        return {'messages': [AIMessage('Done', id='answer')]}

    graph = StateGraph(AgentState)
    graph.add_node('reply', reply)
    graph.add_edge(START, 'reply')
    graph.add_edge('reply', END)
    return SessionAgent(name='test', graph=graph.compile(checkpointer=MemorySaver()))


def _input(run_id: str = 'run') -> RunAgentInput:
    return RunAgentInput(thread_id='session', run_id=run_id, messages=[], tools=[], context=[], state={}, forwarded_props={})


def test_run_started_carries_the_accepted_turn_origin() -> None:
    async def exercise() -> None:
        request = _input()
        assert request.forwarded_props is not None
        request.forwarded_props['turn_started_at'] = '2026-11-16T12:00:00Z'
        events = [event async for event in _agent().run(request)]
        [started] = [event for event in events if event.type == EventType.RUN_STARTED]
        assert started.timestamp == 1794830400000

    asyncio.run(exercise())


def test_live_clock_freezes_at_the_same_end_as_the_saved_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    from langchain.agents import create_agent

    from botcube_harness_deepagents import message_times
    from botcube_harness_deepagents.conversation import MESSAGE_TIMES
    from conftest import ToolBindableFakeModel

    at = 1794830400000

    def advancing_clock() -> int:
        nonlocal at
        at += 100
        return at

    monkeypatch.setattr(message_times, 'now', advancing_clock)

    async def exercise() -> None:
        graph = create_agent(
            ToolBindableFakeModel(responses=['Done']), tools=[],
            middleware=[message_times.MessageTimesMiddleware()], checkpointer=MemorySaver(),
        )
        agent = SessionAgent(name='test', graph=graph)
        request = _input()
        request.messages = [UserMessage(id='canonical-question', content='Compare markets')]
        assert request.forwarded_props is not None
        request.forwarded_props['worklog_clock'] = 1
        request.forwarded_props['turn_started_at'] = '2026-11-16T12:00:00Z'
        events = [event async for event in agent.run(request)]
        [started] = [event for event in events if event.type == EventType.RUN_STARTED]
        assert started.metadata and started.metadata['worklog_clock']['version'] == 1
        frames = [operation['value'] for event in events if event.type == EventType.STATE_DELTA
                  for operation in event.model_dump(mode='json')['delta'] if operation.get('path') == '/worklog_clock']
        assert frames
        saved = await graph.aget_state({'configurable': {'thread_id': 'session'}})
        answer = saved.values['messages'][-1]
        assert frames[-1]['at'] == answer.response_metadata[MESSAGE_TIMES]['ended_at']
        assert frames[-1]['ended_at'] == frames[-1]['at']
        assert frames[-1]['question_id'] == 'canonical-question'
        assert events[-1].type == EventType.RUN_FINISHED

    asyncio.run(exercise())


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


@pytest.mark.integration
def test_successful_graph_exhausts_before_the_terminal_without_cancellation(monkeypatch: pytest.MonkeyPatch) -> None:
    async def exercise() -> None:
        agent = _agent()
        graph = agent.graph
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        wrapper = create_graph_invocation_wrapper(provider.get_tracer('completion'), is_async=True)
        original = graph.astream
        monkeypatch.setattr(graph, 'astream', lambda *args, **kwargs: wrapper(original, graph, args, kwargs))
        try:
            events = [event async for event in agent.run(_input())]
            assert [event.type for event in events if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR)] == [EventType.RUN_FINISHED]
            assert not [event for span in exporter.get_finished_spans() for event in span.events if event.name == 'exception']
            state = await graph.aget_state({'configurable': {'thread_id': 'session'}})
            assert state.values['messages'][-1].content == 'Done'
        finally:
            provider.shutdown()

    asyncio.run(exercise())


@pytest.mark.integration
def test_terminal_callback_failure_is_an_error_instead_of_a_successful_turn() -> None:
    class FailingRoot(AsyncCallbackHandler):
        raise_error = True

        async def on_chain_end(self, outputs: Any, *, parent_run_id: Any = None, **kwargs: Any) -> None:
            if parent_run_id is None:
                raise ValueError('terminal callback failed')

    async def exercise() -> None:
        agent = _agent()
        agent.config = {'callbacks': [FailingRoot()]}
        events = [event async for event in agent.run(_input())]
        assert [event.type for event in events if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR)] == [EventType.RUN_ERROR]
        assert isinstance(events[-1], RunErrorEvent)
        assert events[-1].message == 'terminal callback failed'

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
    saver = MemorySaver()
    agent = SessionAgent(name='test', graph=graph.compile(
        checkpointer=saver,
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


        monkeypatch.setattr(serving, '_require_bot', lambda: SimpleNamespace(skills=()))
        files = cast(FilesMount, SimpleNamespace(pull=lambda *args: None))
        turns = turn_lifecycle.SessionTurns()
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

    monkeypatch.setattr(serving, '_require_bot', lambda: SimpleNamespace(skills=()))
    files = cast(FilesMount, SimpleNamespace(pull=pull))

    async def exercise() -> None:
        stream = turn_lifecycle.SessionTurns().stream(
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
