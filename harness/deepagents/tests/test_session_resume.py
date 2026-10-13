from __future__ import annotations

import asyncio
import contextlib
import gc
import hashlib
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    Iterator,
    Sequence,
)
from pathlib import Path
from typing import Any, NamedTuple, NoReturn
from unittest.mock import ANY

import boto3
import pytest
from deepagents.backends import LocalShellBackend
from langchain.agents import AgentState
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    AnyMessage,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.messages.tool import tool_call_chunk
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph.state import CompiledStateGraph
from langgraph_checkpoint_aws import AgentCoreMemorySaver

from agentcore_fake import (
    MEMORY_ID,
    PAGE_SIZE,
    another_microvm,
    install_tagged_memory,
    turn_identity,
)
from agentcore_fake import FakeAgentCoreMemory as _FakeAgentCoreMemory
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.memory import agentcore
from conftest import ToolBindableFakeModel

TURNS = 30
# ListEvents calls of one state read: the newest checkpoint event, then its pending writes.
READS_PER_STATE = 2
THREAD = {'thread_id': 'session-1', 'actor_id': 'user-1'}
CONFIG: RunnableConfig = {'configurable': THREAD}


def _graph(checkpointer: BaseCheckpointSaver[str], tmp_path: Path, responses: list[str]) -> CompiledStateGraph[AgentState]:
    return build_agent(
        model=ToolBindableFakeModel(responses=responses),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[],
        tools=[],
        memory=[],
        checkpointer=checkpointer,
    )


def _write_long_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[_FakeAgentCoreMemory, list[tuple[str, object]], CompiledStateGraph[AgentState]]:
    memory = _FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    writer = _graph(
        agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'),
        tmp_path,
        [f'Answer {turn}' for turn in range(TURNS)],
    )
    streamed = [
        writer.invoke({'messages': [HumanMessage(f'Question {turn}')]}, config=CONFIG)
        for turn in range(TURNS)
    ][-1]
    streamed_messages: list[tuple[str, object]] = [(m.type, m.content) for m in streamed['messages']]
    assert len(streamed_messages) == 2 * TURNS

    memory.list_events_calls = 0
    reader = _graph(
        agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'),
        tmp_path,
        [],
    )
    return memory, streamed_messages, reader


def _assert_bounded_read(memory: _FakeAgentCoreMemory) -> None:
    # The latest snapshot and its pending writes, never a walk over the Session's events.
    assert len(memory.events[('user-1', 'session-1')]) > PAGE_SIZE
    assert memory.list_events_calls <= READS_PER_STATE


def test_long_agentcore_session_resumes_identically_from_its_latest_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    memory, streamed_messages, reader = _write_long_session(tmp_path, monkeypatch)

    resumed = reader.get_state(CONFIG).values['messages']

    assert [(m.type, m.content) for m in resumed] == streamed_messages
    _assert_bounded_read(memory)


def test_long_agentcore_session_resumes_identically_from_its_latest_snapshot_async(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    memory, streamed_messages, reader = _write_long_session(tmp_path, monkeypatch)

    resumed = asyncio.run(reader.aget_state(CONFIG)).values['messages']

    assert [(m.type, m.content) for m in resumed] == streamed_messages
    _assert_bounded_read(memory)


def test_a_session_written_turn_by_turn_by_the_harness_replays_fully(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each Turn's latest snapshot holds the whole Session, so replay and a restarted Harness see it all."""
    from botcube_harness_deepagents import session_api

    memory = _FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, '_GRAPH', None)

    def turn_checkpointer() -> BaseCheckpointSaver[str]:
        identity = turn_identity('user-1', 'user-1', 'session-1')
        return agentcore.turn_memory(MEMORY_ID, identity, region_name='us-east-1', run_id='run-1', turn=0)[0]

    writer = _graph(turn_checkpointer(), tmp_path, [f'Answer {turn}' for turn in range(TURNS)])

    async def run_turns() -> list[AnyMessage]:
        messages: list[AnyMessage] = []
        for turn in range(TURNS):
            state = await writer.ainvoke({'messages': [HumanMessage(f'Question {turn}')]}, config=CONFIG)
            messages = state['messages']
        return messages

    streamed = asyncio.run(run_turns())
    replayed = asyncio.run(session_api.get_session('user-1', 'session-1'))

    assert len(streamed) == 2 * TURNS
    assert [(m['role'], m['content']) for m in replayed] == [
        ({'human': 'user', 'ai': 'assistant'}[m.type], m.content) for m in streamed
    ]

    # A restarted Harness continues the Session from the record.
    restarted = _graph(turn_checkpointer(), tmp_path, ['Answer after restart'])
    continued = asyncio.run(restarted.ainvoke({'messages': [HumanMessage('Question after restart')]}, config=CONFIG))
    replayed = asyncio.run(session_api.get_session('user-1', 'session-1'))

    assert len(continued['messages']) == 2 * TURNS + 2
    assert [m['content'] for m in replayed] == [m.content for m in continued['messages']]


def test_a_purge_deletes_every_event_of_the_session_and_its_writes_sessions_at_agentcores_delete_rate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botcube_harness_deepagents import session_api
    from botcube_harness_deepagents.memory.agentcore import purge as purge_module

    memory = _FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, '_GRAPH', None)

    def sleep(seconds: float) -> None:
        memory.clock += seconds

    monkeypatch.setattr(purge_module, 'monotonic', lambda: memory.clock)
    monkeypatch.setattr(purge_module, 'sleep', sleep)
    writes = 'lgw-' + hashlib.sha256(b'session-1').hexdigest()[:32]
    others = 'lgw-' + hashlib.sha256(b'session-2').hexdigest()[:32]
    for _ in range(PAGE_SIZE + 12):  # more than one page of events
        memory.seed('user-1', 'session-1')
    for key in ('checkpoint-1', 'checkpoint-2'):
        memory.seed('user-1', f'{writes}-{key}')
    memory.seed('user-1', 'session-2')
    memory.seed('user-1', f'{others}-checkpoint-1')
    memory.seed('user-2', 'session-1')
    memory.seed('user-2', f'{writes}-checkpoint-1')
    purge = {'operation': 'purge', 'sessionId': 'session-1', 'userId': 'user-1'}
    deleted = PAGE_SIZE + 12 + 2

    assert asyncio.run(session_api.handle(purge)) == {}

    assert memory.events[('user-1', 'session-1')] == []
    assert memory.events[('user-1', f'{writes}-checkpoint-1')] == []
    assert memory.events[('user-1', f'{writes}-checkpoint-2')] == []
    for kept in [('user-1', 'session-2'), ('user-1', f'{others}-checkpoint-1'), ('user-2', 'session-1'), ('user-2', f'{writes}-checkpoint-1')]:
        assert len(memory.events[kept]) == 1
    # AgentCore keeps listing emptied sessions: the purge is done once their events are gone.
    listed = memory.list_sessions(memoryId=MEMORY_ID, actorId='user-1')['sessionSummaries']
    assert {f'{writes}-checkpoint-1', f'{writes}-checkpoint-2'} <= {summary['sessionId'] for summary in listed}
    # DeleteEvent allows 5 TPS per actor and Session: no 6 deletes within one second.
    assert len(memory.deleted_at) == deleted
    assert all(
        later - earlier >= 1.0 - 1e-9
        for earlier, later in zip(memory.deleted_at, memory.deleted_at[5:], strict=False)
    )

    # A purge retry is harmless.
    assert asyncio.run(session_api.handle(purge)) == {}
    assert len(memory.deleted_at) == deleted


class _ToolCallingModel(BaseChatModel):
    """Streams one tool call per user message, then a text answer once the tool replies."""

    @property
    def _llm_type(self) -> str:
        return 'fake-tool-calling'

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        raise AssertionError('The Harness streams model output')

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        _require_paired_tool_results(messages)
        if isinstance(messages[-1], HumanMessage):
            call = tool_call_chunk(name='ls', args='{"path": "/"}', id=f'call-{len(messages)}', index=0)
            yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))
            return
        yield ChatGenerationChunk(message=AIMessageChunk(content='Listed '))
        yield ChatGenerationChunk(message=AIMessageChunk(content='the files.'))

    def bind_tools(
        self, tools: Sequence[Any], *, tool_choice: str | None = None, **kwargs: Any
    ) -> _ToolCallingModel:
        return self


class _HeldModel(_ToolCallingModel):
    """Holds its first call open until released, as the model call of a Turn the user Stopped."""

    gate: Any = None
    calls: list[str] = []

    async def _astream(
        self, messages: list[BaseMessage], *args: Any, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        self.calls.append(f'model: {messages[-1].content}')
        if self.gate is not None:
            held, released, settled = self.gate
            self.gate = None
            held.set()
            try:
                await released.wait()
            except asyncio.CancelledError:
                # A cancelled Turn still flushes its checkpoints before it settles.
                await settled.wait()
                raise
        for chunk in self._stream(messages, *args, **kwargs):
            yield chunk


def _slow_checkpoints(monkeypatch: pytest.MonkeyPatch, log: list[str]) -> tuple[asyncio.Event, asyncio.Event]:
    """Hold each checkpoint write until released, logging when it persists: (writing, persisted)."""
    writing, persisted = asyncio.Event(), asyncio.Event()
    aput = AgentCoreMemorySaver.aput

    async def slow_put(saver: AgentCoreMemorySaver, *args: Any) -> RunnableConfig:
        writing.set()
        await persisted.wait()
        written = await aput(saver, *args)
        log.append('checkpointed')
        return written

    monkeypatch.setattr(AgentCoreMemorySaver, 'aput', slow_put)
    return writing, persisted


def _finishes_only_started_steps(events: list[Any]) -> bool:
    """AG-UI's client check: each STEP_FINISHED ends the step its run started last."""
    started: list[str] = []
    for event in events:
        if event.type == 'STEP_STARTED':
            started.append(event.step_name)
        elif event.type == 'STEP_FINISHED' and (not started or started.pop() != event.step_name):
            return False
    return True


def _require_paired_tool_results(messages: list[BaseMessage]) -> None:
    """Refuse a history as Bedrock's Converse does: each tool result answers a call of the message before it."""
    calls: set[str | None] = set()
    for message in messages:
        if isinstance(message, ToolMessage):
            if message.tool_call_id not in calls:
                raise ValueError('The number of toolResult blocks exceeds the number of toolUse blocks of previous turn')
            calls.discard(message.tool_call_id)
        else:
            _require_answered_tool_calls(calls)
            calls = {call['id'] for call in message.tool_calls} if isinstance(message, AIMessage) else set()
    _require_answered_tool_calls(calls)


def _require_answered_tool_calls(calls: set[str | None]) -> None:
    if calls:
        raise ValueError('A model request is missing the results of its tool calls')


def _client_message_ids(sent: list[dict[str, Any]], events: list[Any]) -> list[str]:
    """The message IDs an AG-UI client holds after a run: streamed messages, then any snapshot."""
    ids = [message['id'] for message in sent]
    for event in events:
        if event.type == 'MESSAGES_SNAPSHOT':
            ids = [message.id for message in event.messages]
        elif event.type in ('TEXT_MESSAGE_START', 'TOOL_CALL_RESULT'):
            ids.append(event.message_id)
        elif event.type == 'TOOL_CALL_START' and event.parent_message_id not in ids:
            ids.append(event.parent_message_id)
    return ids


class _ServedSession(NamedTuple):
    turn: Callable[[list[dict[str, Any]]], Awaitable[list[str]]]
    events: Callable[[list[dict[str, Any]]], Coroutine[Any, Any, list[Any]]]
    replay: Callable[[], Awaitable[list[dict[str, Any]]]]


def _serve_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, memory: _FakeAgentCoreMemory, *, session_id: str = 'session-1'
) -> _ServedSession:
    """Serve the selected public Session through the Harness, recorded in `memory`."""
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving, session_api

    install_tagged_memory(monkeypatch, memory)
    for name, value in {
        'AGENTCORE_MEMORY_ID': MEMORY_ID,
        '_CHECKPOINTER': None,
        '_STORE': None,
        '_AGENTS': {},
        '_BACKENDS': {},
        '_AGENT_BACKENDS': {},
        'build_model': lambda **_kwargs: _ToolCallingModel(),
        '_cartridge': serving.HarnessCartridge(
            system_prompt='',
            skills=[],
            agent_name='round-trip',
            prepare_invocation=lambda _input: serving.InvocationAuth('user-1', False, None),
            actor_path_segment=lambda value: value,
            sanitize_actor_id=lambda value: value,
            build_backend=lambda _env: LocalShellBackend(
                root_dir=tmp_path, virtual_mode=True, inherit_env=False
            ),
            apply_session_id=lambda _backend, _session_id: None,
            environment_cache_key=lambda _env: (),
        ),
    }.items():
        monkeypatch.setattr(serving, name, value)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    context = serving._RequestContext('agentcore-session-1')
    get = {'operation': 'get', 'sessionId': session_id, 'userId': 'user-1'}

    async def events(sent: list[dict[str, Any]]) -> list[Any]:
        # Validated from wire-shaped messages, as the Harness receives them.
        run = RunAgentInput.model_validate({
            'thread_id': session_id,
            'run_id': f'run-{len(sent)}',
            'messages': sent,
            'tools': [],
            'context': [],
            'state': {},
            'forwarded_props': {'sessionUserId': 'user-1', 'turnIdentity': turn_identity('user-1', 'user-1', session_id)},
        })
        received = [event async for event in serving.invoke(run, context)]
        lock = serving._SESSION_TURNS._locks.get(('user-1', session_id))
        if lock is not None:
            async with lock:
                pass
        return received

    async def turn(sent: list[dict[str, Any]]) -> list[str]:
        return _client_message_ids(sent, await events(sent))

    async def replay() -> list[dict[str, Any]]:
        monkeypatch.setattr(session_api, '_GRAPH', None)  # a fresh reader of the record
        return (await session_api.handle(get))['messages']

    return _ServedSession(turn, events, replay)



async def _await_fixture_admission_or_public_completion(
    reader: asyncio.Task[list[Any]], admission: asyncio.Event
) -> None:
    """Observe a rejected public stream before waiting for a fixture it can no longer reach."""
    waiter = asyncio.create_task(admission.wait())
    try:
        await asyncio.wait([reader, waiter], return_when=asyncio.FIRST_COMPLETED)
        if reader.done():
            try:
                events = await reader
            except Exception as error:
                raise AssertionError('The healthy public Turn stream must complete without rejection') from error
            assert [event.type for event in events if event.type in ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR')] == [
                'RUN_STARTED', 'RUN_FINISHED',
            ]
        assert admission.is_set(), 'The public Turn must reach fixture admission'
    finally:
        # Only this helper's admission waiter is owned here; keep the admitted public reader running.
        await _cancel_unfinished_readers(waiter)


def test_a_healthy_completed_public_turn_without_fixture_admission_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())

    async def completed_without_admission() -> None:
        admission = asyncio.Event()
        reader = asyncio.create_task(session.events([
            {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'},
        ]))
        events = await reader
        assert [event.type for event in events if event.type in ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR')] == [
            'RUN_STARTED', 'RUN_FINISHED',
        ]
        assert not admission.is_set()
        with pytest.raises(AssertionError, match='The public Turn must reach fixture admission'):
            await _await_fixture_admission_or_public_completion(reader, admission)

    asyncio.run(asyncio.wait_for(completed_without_admission(), timeout=10))


async def _cancel_unfinished_readers(*readers: asyncio.Task[Any] | None) -> None:
    active = [reader for reader in readers if reader is not None]
    for reader in active:
        if not reader.done():
            reader.cancel()
    await asyncio.gather(*active, return_exceptions=True)


def test_concurrent_sessions_keep_their_active_turns_and_replay_independent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Another Session neither Stops this Session's active Turn nor owns its record (ADR 0077)."""
    from ag_ui.core import BaseEvent

    from botcube_harness_deepagents import serving

    memory = _FakeAgentCoreMemory()
    first_session = _serve_session(tmp_path, monkeypatch, memory, session_id='session-1')
    second_session = _serve_session(tmp_path, monkeypatch, memory, session_id='session-2')
    model = _HeldModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)

    async def simultaneous_turns() -> None:
        held, released, settled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        settled.set()
        model.gate = (held, released, settled)
        first = asyncio.create_task(first_session.events([
            {'id': 'first-user-message', 'role': 'user', 'content': 'List the first session files'},
        ]))
        admission = asyncio.create_task(held.wait())
        second: asyncio.Task[list[Any]] | None = None
        try:
            # Completion before the model accepts this request is an observable failed stream, not a wait.
            await asyncio.wait([first, admission], return_when=asyncio.FIRST_COMPLETED)
            assert held.is_set()
            another_microvm()
            second = asyncio.create_task(second_session.events([
                {'id': 'second-user-message', 'role': 'user', 'content': 'List the second session files'},
            ]))
            finished, _pending = await asyncio.wait([first, second], return_when=asyncio.FIRST_COMPLETED)
            assert second in finished
            assert first not in finished
            second_events = await second
            assert all(isinstance(event, BaseEvent) for event in second_events)
            assert second_events[-1].type == 'RUN_FINISHED'
            assert 'RUN_ERROR' not in [event.type for event in second_events]
            released.set()
            first_events = await first
            assert all(isinstance(event, BaseEvent) for event in first_events)
            assert first_events[-1].type == 'RUN_FINISHED'
            assert 'RUN_ERROR' not in [event.type for event in first_events]
            first_record = await first_session.replay()
            second_record = await second_session.replay()
            assert [message['id'] for message in first_record if message['role'] == 'user'] == ['first-user-message']
            assert [message['id'] for message in second_record if message['role'] == 'user'] == ['second-user-message']
            assert first_record[-1] == {'id': ANY, 'role': 'assistant', 'content': 'Listed the files.', 'metadata': ANY}
            assert second_record[-1] == {'id': ANY, 'role': 'assistant', 'content': 'Listed the files.', 'metadata': ANY}
        finally:
            # Every fixture gate is released even if a stream's behavior assertion fails.
            released.set()
            settled.set()
            await _cancel_unfinished_readers(first, admission, second)

    asyncio.run(asyncio.wait_for(simultaneous_turns(), timeout=10))

def test_the_turn_sent_after_stop_stays_the_sessions_latest_once_the_stopped_turn_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stop leaves the stopped Turn running; it must neither break nor outlive the Turn sent next."""
    from ag_ui.core import RunErrorEvent

    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _HeldModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
    first = {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}

    async def stop_then_send() -> None:
        held, released, settled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        settled.set()
        model.gate = (held, released, settled)
        stopped = asyncio.create_task(session.events([first]))
        await _await_fixture_admission_or_public_completion(stopped, held)
        sent = await session.events([first, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}])
        released.set()
        stopped_events = await stopped
        assert isinstance(stopped_events[-1], RunErrorEvent)
        assert stopped_events[-1].code == 'TURN_STOPPED'
        assert stopped_events[-1].message == 'The Turn was stopped, or a newer Turn on this Session replaced it'
        assert sent[-1].type == 'RUN_FINISHED'
        assert _finishes_only_started_steps(sent)
        replayed = await session.replay()
        assert [message['id'] for message in replayed if message['role'] == 'user'] == ['user-message-1', 'user-message-2']
        assert replayed[-1] == {'id': ANY, 'role': 'assistant', 'content': 'Listed the files.', 'metadata': ANY}

    asyncio.run(stop_then_send())


async def _stop(run_id: str) -> list[Any]:
    """The Chat Service's stop invocation for one Run: AgentCore keeps the Turn running after its caller goes away."""
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving

    run = RunAgentInput.model_validate({
        'thread_id': 'session-1', 'run_id': run_id, 'messages': [], 'tools': [], 'context': [], 'state': {},
        'forwarded_props': {'stop': True, 'sessionUserId': 'user-1'},
    })
    return [event async for event in serving.invoke(run, serving._RequestContext('agentcore-session-1'))]


def test_a_stop_invocation_stops_the_running_turn_it_names(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _HeldModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)

    async def stop_mid_turn() -> None:
        held, settled = asyncio.Event(), asyncio.Event()
        settled.set()
        # The model call is never released: only the stop can end the Turn.
        model.gate = (held, asyncio.Event(), settled)
        running = asyncio.create_task(session.events([{'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}]))
        await _await_fixture_admission_or_public_completion(running, held)

        assert await session.replay() == [
            {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'},
        ]
        assert await _stop('run-1') == []
        events = await running
        assert (events[-1].type, events[-1].code) == ('RUN_ERROR', 'TURN_STOPPED')
        assert await session.replay() == [
            {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'},
        ]

    asyncio.run(asyncio.wait_for(stop_mid_turn(), timeout=10))


class _StoppedMidReplyModel(_ToolCallingModel):
    """Streams the start of a text answer on its first call, then holds until the Turn is stopped.

    With `then_ls`, it goes on to stream the start of an `ls` call: the text ends before the model call does.
    """

    text_streamed: asyncio.Event | None = None
    then_ls: bool = False

    async def _astream(
        self, messages: list[BaseMessage], *args: Any, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        if self.text_streamed is None:
            for chunk in self._stream(messages, *args, **kwargs):
                yield chunk
            return
        yield ChatGenerationChunk(message=AIMessageChunk(content='Duration measures '))
        yield ChatGenerationChunk(message=AIMessageChunk(content='rate risk.'))
        if self.then_ls:
            call = tool_call_chunk(name='ls', args='', id='call-cut', index=0)
            yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))
            partial = tool_call_chunk(name=None, args='{"pa', id=None, index=0)
            yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[partial]))
        text_streamed, self.text_streamed = self.text_streamed, None
        text_streamed.set()
        await asyncio.Event().wait()


@pytest.mark.parametrize('then_ls', [False, True], ids=['mid-text', 'mid-tool-call'])
def test_a_reply_cut_short_by_stop_stays_in_the_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, then_ls: bool
) -> None:
    """The text a user read before Stop survives a reload."""
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _StoppedMidReplyModel(then_ls=then_ls)
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)

    async def stop_mid_reply() -> None:
        model.text_streamed = text_streamed = asyncio.Event()
        running = asyncio.create_task(session.events([{'id': 'user-message-1', 'role': 'user', 'content': 'Explain duration'}]))
        await text_streamed.wait()
        await _stop('run-1')
        events = await running
        cut_reply_id = next(event.message_id for event in events if event.type == 'TEXT_MESSAGE_START')

        kept = [
            {'id': 'user-message-1', 'role': 'user', 'content': 'Explain duration'},
            {'id': cut_reply_id, 'role': 'assistant', 'content': 'Duration measures rate risk.'},
        ]
        # The cut reply is timed from its first words to the last the user read.
        replayed = await session.replay()
        assert replayed == [kept[0], {**kept[1], 'metadata': ANY}]
        assert replayed[1]['metadata']['started_at'] <= replayed[1]['metadata']['ended_at']

        # AG-UI keeps the partial tool call on the same assistant message as its text.
        resent = [dict(message) for message in kept]
        if then_ls:
            resent[1]['toolCalls'] = [_streamed_partial_ls(events, cut_reply_id)]

        # The next Turn resends the cut reply under its streamed ID: it stays one message.
        await session.events([*resent, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}])
        assert [message['role'] for message in await session.replay()] == ['user', 'assistant', 'user', 'assistant', 'tool', 'assistant']

    asyncio.run(asyncio.wait_for(stop_mid_reply(), timeout=10))


def test_a_stopped_turns_cut_reply_reaches_the_sessions_history_issue_3354(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stopped Turn saves its request and cut reply, as a finished Turn does."""
    from botcube_harness_deepagents import serving

    memory = _FakeAgentCoreMemory()
    session = _serve_session(tmp_path, monkeypatch, memory)
    model = _StoppedMidReplyModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)

    async def stop_after_a_finished_turn() -> None:
        await session.events([{'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}])
        finished = await session.replay()
        model.text_streamed = text_streamed = asyncio.Event()
        sent = [*finished, {'id': 'user-message-2', 'role': 'user', 'content': 'Explain duration'}]
        running = asyncio.create_task(session.events(sent))
        await text_streamed.wait()
        await _stop(f'run-{len(sent)}')
        events = await running
        cut_reply_id = next(event.message_id for event in events if event.type == 'TEXT_MESSAGE_START')

        assert await session.replay() == [
            *sent,
            {'id': cut_reply_id, 'role': 'assistant', 'content': 'Duration measures rate risk.', 'metadata': ANY},
        ]

    asyncio.run(asyncio.wait_for(stop_after_a_finished_turn(), timeout=10))


@pytest.mark.parametrize('failed', [False, True])
def test_a_settled_turn_serves_its_request_in_history_issue_3354(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failed: bool
) -> None:
    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    if failed:

        def unavailable(*_args: Any, **_kwargs: Any) -> NoReturn:
            raise RuntimeError('provider unavailable')

        monkeypatch.setattr(_ToolCallingModel, '_stream', unavailable)

    async def scenario() -> None:
        sent = [{'id': 'original-request', 'role': 'user', 'content': 'List the files'}]
        events = await session.events(sent)
        if failed:
            assert events[-1].type == 'RUN_ERROR'
            assert events[-1].message == 'provider unavailable'
        else:
            assert events[-1].type == 'RUN_FINISHED'
        assert (await session.replay())[0] == {'id': 'original-request', 'role': 'user', 'content': 'List the files'}

    asyncio.run(scenario())


def _streamed_partial_ls(events: list[Any], message_id: str) -> dict[str, Any]:
    call_start = next(event for event in events if event.type == 'TOOL_CALL_START')
    arguments = ''.join(event.delta for event in events if event.type == 'TOOL_CALL_ARGS')
    assert call_start.parent_message_id == message_id
    assert arguments == '{"pa'
    assert call_start.tool_call_id == 'call-cut'
    assert call_start.tool_call_name == 'ls'
    return {
        'id': call_start.tool_call_id,
        'type': 'function',
        'function': {'name': call_start.tool_call_name, 'arguments': arguments},
    }


def test_unrecorded_tool_call_arguments_still_fail_loud(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _ToolCallingModel())
    messages = [
        {'id': 'user-1', 'role': 'user', 'content': 'List the files'},
        {'id': 'unrecorded', 'role': 'assistant', 'content': 'Let me look.', 'toolCalls': [
            {'id': 'call-cut', 'type': 'function', 'function': {'name': 'ls', 'arguments': '{"pa'}},
        ]},
    ]
    events = asyncio.run(session.events(messages))
    assert events[-1].type == 'RUN_ERROR'
    assert events[-1].message == 'Unterminated string starting at: line 1 column 2 (char 1)'
    assert not any(event.type == 'TEXT_MESSAGE_CONTENT' for event in events)


class _TextThenLsModel(_ToolCallingModel):
    """Writes a line of text before its `ls` call, as a model announcing its tool use."""

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        yield ChatGenerationChunk(message=AIMessageChunk(content='Let me look.'))
        call = tool_call_chunk(name='ls', args='{"path": "/"}', id='call-1', index=0)
        yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))


def test_a_turn_stopped_while_its_tool_runs_keeps_the_recorded_tool_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A finished model call is already recorded: Stop adds no second copy of its text."""
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _TextThenLsModel())
    tool_running = asyncio.Event()

    async def held_ls(_self: LocalShellBackend, _path: str) -> NoReturn:
        tool_running.set()
        await asyncio.Event().wait()
        raise AssertionError('unreachable')

    monkeypatch.setattr(LocalShellBackend, 'als', held_ls)

    async def stop_mid_tool() -> None:
        running = asyncio.create_task(session.events([{'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}]))
        await tool_running.wait()
        await _stop('run-1')
        events = await running
        announced = next(event.message_id for event in events if event.type == 'TEXT_MESSAGE_START')

        call = {'id': 'call-1', 'type': 'function', 'function': {'name': 'ls', 'arguments': '{"path": "/"}'}}
        replayed = await session.replay()
        # The saver answers the cut call with a placeholder result on load.
        assert replayed == [
            {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'},
            {'id': announced, 'role': 'assistant', 'content': 'Let me look.', 'toolCalls': [call], 'metadata': ANY},
            {'id': ANY, 'role': 'tool', 'content': "Tool call 'ls' with id 'call-1' was interrupted before completion.",
             'toolCallId': 'call-1', 'error': 'error'},
        ]
        assert await session.replay() == replayed

    asyncio.run(asyncio.wait_for(stop_mid_tool(), timeout=10))


def test_a_cut_reply_that_cannot_be_kept_fails_its_turn_loud(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, retrieved_turn_failure: None,
) -> None:
    """Keeping the cut reply fails the stopped Turn loud (ADR 0030); the Session stays answerable."""
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _StoppedMidReplyModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)

    async def failing_keep(*_args: Any) -> NoReturn:
        raise RuntimeError('cut reply not kept')

    monkeypatch.setattr(serving._OpenReply, 'keep', failing_keep)
    first = {'id': 'user-message-1', 'role': 'user', 'content': 'Explain duration'}

    async def stop_mid_reply() -> None:
        model.text_streamed = text_streamed = asyncio.Event()
        running = asyncio.create_task(session.events([first]))
        await text_streamed.wait()
        await _stop('run-1')
        await asyncio.gather(running, return_exceptions=True)

        assert await session.replay() == [first]
        events = await session.events([first, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}])
        assert events[-1].type == 'RUN_FINISHED'

    asyncio.run(asyncio.wait_for(stop_mid_reply(), timeout=10))


def test_a_stop_for_an_earlier_run_leaves_the_sessions_newer_turn_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stop that arrives after the user's next Turn started must not stop that Turn."""
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _HeldModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
    first = {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}

    async def late_stop() -> None:
        await session.events([first])
        held, released, settled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        settled.set()
        model.gate = (held, released, settled)
        newer = asyncio.create_task(session.events([first, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}]))
        await _await_fixture_admission_or_public_completion(newer, held)

        await _stop('run-1')
        released.set()
        assert (await newer)[-1].type == 'RUN_FINISHED'

    asyncio.run(asyncio.wait_for(late_stop(), timeout=10))


def test_of_two_turns_sent_while_a_stopped_turn_settles_only_the_later_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each Turn supersedes the one before it, even when both arrive while the stopped Turn flushes."""
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _HeldModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
    first = {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}

    async def two_turns_after_stop() -> None:
        held, settled = asyncio.Event(), asyncio.Event()
        model.gate = (held, asyncio.Event(), settled)
        stopped = asyncio.create_task(session.events([first]))
        await _await_fixture_admission_or_public_completion(stopped, held)
        turns = [
            asyncio.create_task(session.events([first, {'id': f'user-message-{n}', 'role': 'user', 'content': 'Again'}]))
            for n in (2, 3)
        ]
        for _ in range(50):
            await asyncio.sleep(0)
        settled.set()
        earlier, later = await asyncio.wait_for(asyncio.gather(*turns), timeout=10)
        await stopped
        assert (earlier[-1].type, getattr(earlier[-1], 'code', None)) == ('RUN_ERROR', 'TURN_STOPPED')
        assert later[-1].type == 'RUN_FINISHED'

    asyncio.run(two_turns_after_stop())


def test_the_turn_sent_after_stop_starts_once_the_stopped_turns_checkpoints_have_persisted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tearing down the stopped Turn's stream mid-write leaves its checkpoints to persist before the next Turn."""
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _HeldModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
    first = {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}

    async def stop_mid_write_then_send() -> None:
        writing, persisted = _slow_checkpoints(monkeypatch, model.calls)
        stopped = asyncio.create_task(session.events([first]))
        await writing.wait()
        stopped.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await stopped
        sent = asyncio.create_task(session.events([first, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}]))
        # Room for the next Turn to run, were it not waiting on the checkpoint writes.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(asyncio.shield(sent), timeout=1)
        assert 'model: Again' not in model.calls
        persisted.set()
        assert (await asyncio.wait_for(sent, timeout=10))[-1].type == 'RUN_FINISHED'
        assert 'checkpointed' in model.calls[:model.calls.index('model: Again')]
        replayed = await session.replay()
        assert [message['id'] for message in replayed if message['role'] == 'user'] == ['user-message-1', 'user-message-2']
        assert replayed[-1] == {'id': ANY, 'role': 'assistant', 'content': 'Listed the files.', 'metadata': ANY}

    asyncio.run(stop_mid_write_then_send())


def test_a_streamed_session_reopens_and_keeps_recorded_ids_when_the_client_resends_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())

    async def round_trip() -> None:
        held = await session.turn(
            [{'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}]
        )
        replayed = await session.replay()
        # AG-UI's wire shape: camelCase tool fields, no empty ones.
        assert replayed == [
            {'id': 'user-message-1', 'role': 'user', 'content': 'List the files'},
            {
                'id': ANY,
                'role': 'assistant',
                'content': '',
                'toolCalls': [
                    {'id': 'call-2', 'type': 'function', 'function': {'name': 'ls', 'arguments': '{"path": "/"}'}}
                ],
                'metadata': ANY,
            },
            {'id': ANY, 'role': 'tool', 'content': ANY, 'toolCallId': 'call-2', 'metadata': ANY},
            {'id': ANY, 'role': 'assistant', 'content': 'Listed the files.', 'metadata': ANY},
        ]
        assert len(held) == 4
        assert held[0] == replayed[0]['id']

        # The next Turn resends the replayed Session; the record keeps its IDs.
        held = await session.turn(
            [*replayed, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}]
        )
        replayed_again = [message['id'] for message in await session.replay()]
        assert len(held) == len(replayed_again) == 8
        assert replayed_again[:5] == [message['id'] for message in replayed] + ['user-message-2']

    asyncio.run(round_trip())


def test_a_turn_streams_neither_the_graphs_raw_events_nor_its_state_issue_3291(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both carry the Session's history, and the web's chat deep-copies the state once per message on each render."""
    from ag_ui_langgraph import LangGraphAgent

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    dispatched: list[str] = []
    dispatch = LangGraphAgent._dispatch_event

    def recording(self: LangGraphAgent, event: Any) -> Any:
        dispatched.append(event.type)
        return dispatch(self, event)

    monkeypatch.setattr(LangGraphAgent, '_dispatch_event', recording)

    events = asyncio.run(session.events([{'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}]))
    streamed = {event.type for event in events}
    assert {'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'TEXT_MESSAGE_CONTENT', 'RUN_FINISHED'} <= streamed
    assert streamed.isdisjoint({'RAW', 'STATE_SNAPSHOT'})
    # Each streamed token carried the graph's raw chunk too, and a reply's end its model input.
    assert [event.type for event in events if event.raw_event is not None] == []
    # Nor does the Turn build them only to drop them: each was a JSON-safe copy of the history.
    assert 'RAW' not in dispatched


class _MissingToolModel(_ToolCallingModel):
    """Calls a tool the agent does not have, so the Turn's tool result is an error."""

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        if isinstance(messages[-1], HumanMessage):
            call = tool_call_chunk(name='no_such_tool', args='{}', id=f'call-{len(messages)}', index=0)
            yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))
            return
        yield ChatGenerationChunk(message=AIMessageChunk(content='That tool failed.'))


def test_a_turns_persisted_state_holds_the_messages_it_produced_issue_3265(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())

    def use(model: BaseChatModel, *, restart: bool) -> None:
        monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
        names = ('_CHECKPOINTER', '_STORE', '_AGENTS') if restart else ('_AGENTS',)
        for name in names:
            monkeypatch.setattr(serving, name, {} if name == '_AGENTS' else None)

    async def turn(replayed: list[dict[str, Any]], number: int) -> list[dict[str, Any]]:
        sent = [*replayed, {'id': f'user-message-{number}', 'role': 'user', 'content': f'Question {number}'}]
        events = await session.events(sent)
        assert events[-1].type == 'RUN_FINISHED'
        assert 'MESSAGES_SNAPSHOT' not in [event.type for event in events]
        replayed = await session.replay()
        # The Turn's user message, tool call, tool result and answer.
        assert len(replayed) == len(sent) + 3
        assert replayed[:len(sent)] == sent
        return replayed

    async def scenario() -> list[str | None]:
        replayed: list[dict[str, Any]] = []
        for number, (model, restart) in enumerate([
            (_ToolCallingModel(), False),
            (_ToolCallingModel(), False),
            (_ToolCallingModel(), False),  # warm
            (_MissingToolModel(), False),  # warm, tool error
            (_ToolCallingModel(), True),  # cold
            (_MissingToolModel(), True),  # cold, tool error
        ], start=1):
            use(model, restart=restart)
            replayed = await turn(replayed, number)
        return [message.get('content') for message in replayed[-2:]]

    tool_error, answer = asyncio.run(scenario())

    assert 'no_such_tool' in str(tool_error)
    assert answer == 'That tool failed.'


def test_a_client_that_resends_streamed_messages_without_a_snapshot_leaves_the_session_answerable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())

    async def round_trip() -> None:
        first = [{'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}]
        events = await session.events(first)
        assert 'MESSAGES_SNAPSHOT' not in [event.type for event in events]
        held = _streamed_steps(first, events)
        answer_id = next(event.message_id for event in events if event.type == 'TEXT_MESSAGE_START')
        held.append({'id': answer_id, 'role': 'assistant', 'content': 'Listed the files.'})
        assert [message['id'] for message in held] == _client_message_ids(first, events)

        await session.turn([*held, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}])

        assert [message['role'] for message in await session.replay()] == [
            'user', 'assistant', 'tool', 'assistant',
            'user', 'assistant', 'tool', 'assistant',
        ]

    asyncio.run(round_trip())


class _ProviderIdModel(_HeldModel):
    """Names each message it streamed under a run ID with its own ID at the end, as OpenAI's Responses API does."""

    def _stream(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        yield from super()._stream(messages, *args, **kwargs)
        yield ChatGenerationChunk(message=AIMessageChunk(content='', id=f'resp-{len(messages)}'))


def _streamed_steps(sent: list[dict[str, Any]], events: list[Any]) -> list[dict[str, Any]]:
    """The tool steps a stopped stream left the client, under their streamed IDs: no snapshot renamed them."""
    held = list(sent)
    for event in events:
        if event.type == 'TOOL_CALL_START':
            call = {'id': event.tool_call_id, 'type': 'function', 'function': {'name': event.tool_call_name, 'arguments': ''}}
            held.append({'id': event.parent_message_id, 'role': 'assistant', 'content': '', 'toolCalls': [call]})
        elif event.type == 'TOOL_CALL_ARGS':
            held[-1]['toolCalls'][0]['function']['arguments'] += event.delta
        elif event.type == 'TOOL_CALL_RESULT':
            held.append({'id': event.message_id, 'role': 'tool', 'content': event.content, 'toolCallId': event.tool_call_id})
    return held


def test_the_steps_of_a_stopped_turn_stay_under_it_once_the_next_turn_resends_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Turn sent after Stop resends the stopped Turn's steps under their streamed IDs."""
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _ProviderIdModel()
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
    first = {'id': 'user-message-1', 'role': 'user', 'content': 'Research'}
    run = RunAgentInput.model_validate({
        'thread_id': 'session-1', 'run_id': 'run-1', 'messages': [first], 'tools': [], 'context': [],
        'state': {}, 'forwarded_props': {'sessionUserId': 'user-1', 'turnIdentity': turn_identity('user-1', 'user-1', 'session-1')},
    })

    async def stop_then_send() -> None:
        held, settled = asyncio.Event(), asyncio.Event()
        settled.set()
        events: list[Any] = []

        async def stopped_turn() -> list[Any]:
            async for event in serving.invoke(run, serving._RequestContext('agentcore-session-1')):
                events.append(event)
                if event.type == 'TOOL_CALL_RESULT':
                    # The Turn's next model call is under way when the user stops it.
                    model.gate = (held, asyncio.Event(), settled)
            return events

        stopped = asyncio.create_task(stopped_turn())
        await _await_fixture_admission_or_public_completion(stopped, held)
        stopped.cancel()
        await asyncio.gather(stopped, return_exceptions=True)
        await session.events([*_streamed_steps([first], events), {'id': 'user-message-2', 'role': 'user', 'content': '2+2'}])

        assert [message['role'] for message in await session.replay()] == [
            'user', 'assistant', 'tool',
            'user', 'assistant', 'tool', 'assistant',
        ]

    asyncio.run(stop_then_send())


def test_a_resent_result_still_repairs_its_interrupted_recorded_call(tmp_path: Path) -> None:
    """The recorded result the library repairs from a resent one is kept; the resent copy is not."""
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving

    placeholder = "Tool call 'ls' with id 'call-1' was interrupted before completion."
    recorded = [
        HumanMessage('List the files', id='user-1'),
        AIMessage('', id='ai-1', tool_calls=[{'name': 'ls', 'args': {}, 'id': 'call-1'}]),
        ToolMessage(placeholder, id='tool-1', tool_call_id='call-1'),
    ]
    resent = ToolMessage('a.txt', id='streamed-tool-1', tool_call_id='call-1')
    run = RunAgentInput.model_validate({
        'thread_id': 'session-1', 'run_id': 'run-2', 'messages': [], 'tools': [], 'context': [], 'state': {}, 'forwarded_props': {},
    })
    agent = serving._SessionAgent(name='agent', graph=_graph(InMemorySaver(), tmp_path, []))

    merged = agent.langgraph_default_merge_state({'messages': recorded}, [resent], run)

    assert [(message.id, message.content) for message in merged['messages']] == [('tool-1', 'a.txt')]


@pytest.mark.parametrize('summarize', [False, True])
def test_a_session_recorded_with_a_resent_tool_result_answers_its_next_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, summarize: bool
) -> None:
    """A record that took a resent result before duplicate-result filtering still answers; the record keeps it."""
    memory = _FakeAgentCoreMemory()

    async def round_trip() -> None:
        recorded = _serve_session(tmp_path, monkeypatch, memory)
        await recorded.turn([{'id': 'user-message-1', 'role': 'user', 'content': 'List the files'}])
        call_id = (await recorded.replay())[2]['toolCallId']
        # A second answer to the answered call after the Turn's answer, as the earlier merge without duplicate-result filtering appended it.
        _graph(agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'), tmp_path, []).update_state(
            CONFIG, {'messages': [ToolMessage('a.txt', id='streamed-tool-1', tool_call_id=call_id)]}, as_node='model'
        )
        if summarize:
            import deepagents.graph
            from deepagents.middleware.summarization import SummarizationMiddleware
            from langchain_core.language_models.fake_chat_models import (
                FakeListChatModel,
            )

            # Keep the native summarizer and its cutoff logic; shorten only its
            # trigger/retention and supply a deterministic summary model.
            monkeypatch.setattr(
                deepagents.graph, 'create_summarization_middleware',
                lambda _model, backend: SummarizationMiddleware(
                    model=FakeListChatModel(responses=['Earlier conversation.']),
                    backend=backend, trigger=('messages', 5), keep=('messages', 3),
                ),
            )
        # A fresh Harness reads the corrupted record.
        session = _serve_session(tmp_path, monkeypatch, memory)
        replayed = await session.replay()

        events = await session.events([*replayed, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}])

        assert events[-1].type == 'RUN_FINISHED'
        assert 'RUN_ERROR' not in [event.type for event in events]
        assert [message['role'] for message in await session.replay()] == [
            'user', 'assistant', 'tool', 'assistant', 'tool',
            'user', 'assistant', 'tool', 'assistant',
        ]
        if summarize:
            checkpoint = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').get_tuple(CONFIG)
            assert checkpoint is not None
            assert 'Earlier conversation.' in checkpoint.checkpoint['channel_values']['_summarization_event']['summary_message'].content

    asyncio.run(round_trip())


@pytest.fixture
def retrieved_turn_failure(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    from botcube_harness_deepagents import serving

    monkeypatch.setattr(serving, '_SESSION_TURNS', serving._SessionTurns())
    yield
    gc.collect()
    records = [*caplog.get_records('call'), *caplog.get_records('teardown')]
    assert all('Task exception was never retrieved' not in record.getMessage() for record in records)
    failures = [record for record in records if record.getMessage().startswith('Harness Turn failed')]
    assert failures
    assert all('code=INTERNAL_ERROR' in record.getMessage() and record.exc_info for record in failures)
