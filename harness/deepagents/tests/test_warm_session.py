"""A continuing Session stays warm in the microVM: its latest snapshot loads from Memory only when another process wrote it since."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import boto3
import pytest
from deepagents.backends import LocalShellBackend
from langchain.agents import AgentState
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    Checkpoint,
    copy_checkpoint,
    empty_checkpoint,
)
from langgraph.checkpoint.base.id import uuid6
from langgraph.graph.state import CompiledStateGraph
from langgraph_checkpoint_aws import AgentCoreMemorySaver

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory, fresh_warm_sessions
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.warm_session import WarmSessionSaver
from conftest import ToolBindableFakeModel

CONFIG: RunnableConfig = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}
WRITES_PREFIX = 'lgw-'


class _Recorded:
    """The Memory client, recording each call as (operation, session, whether it lists payloads)."""

    def __init__(self, memory: FakeAgentCoreMemory) -> None:
        self.memory = memory
        self.calls: list[tuple[str, str, bool]] = []

    def __getattr__(self, operation: str) -> Any:
        call = getattr(self.memory, operation)

        def recorded(**params: Any) -> Any:
            session = params.get('sessionId', '')
            self.calls.append((operation, 'writes' if session.startswith(WRITES_PREFIX) else session,
                               params.get('includePayloads', True)))
            return call(**params)

        return recorded


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    fresh_warm_sessions(monkeypatch)
    memory = FakeAgentCoreMemory()
    # The stock saver, standing in for another microVM, builds its client through boto3.
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    return memory


def _turn(memory: FakeAgentCoreMemory) -> tuple[WarmSessionSaver, _Recorded]:
    client = _Recorded(memory)
    return WarmSessionSaver(MEMORY_ID, client, region_name='us-east-1'), client


def _another_microvm() -> AgentCoreMemorySaver:
    return agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')


def _graph(saver: BaseCheckpointSaver[str], tmp_path: Path, *answers: str) -> CompiledStateGraph[AgentState]:
    return build_agent(
        model=ToolBindableFakeModel(responses=list(answers) or ['unused']),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], tools=[], memory=[], checkpointer=saver,
    )


def _ask(saver: BaseCheckpointSaver[str], tmp_path: Path, question: str, answer: str) -> None:
    _graph(saver, tmp_path, answer).invoke({'messages': [HumanMessage(question)]}, config=CONFIG)


def _said(saver: BaseCheckpointSaver[str], tmp_path: Path) -> list[str]:
    return [message.text for message in _graph(saver, tmp_path).get_state(CONFIG).values['messages']]


def test_a_continuing_session_reads_only_memorys_newest_checkpoint_and_its_pending_writes(
    memory: FakeAgentCoreMemory, tmp_path: Path,
) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    saver, client = _turn(memory)

    said = _said(saver, tmp_path)

    assert said == ['Question 1', 'Answer 1'] == _said(_another_microvm(), tmp_path)
    # The newest checkpoint's key without payloads, and its pending writes: no snapshot load.
    assert sorted(client.calls) == [('list_events', 'session-1', False), ('list_events', 'writes', True)]


def test_the_warm_checkpoint_is_the_one_memory_holds(memory: FakeAgentCoreMemory, tmp_path: Path) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')

    warm = _turn(memory)[0].get_tuple(CONFIG)
    loaded = _another_microvm().get_tuple(CONFIG)

    assert warm is not None and loaded is not None
    assert warm == loaded


def test_a_turns_later_reads_reuse_its_confirmation(memory: FakeAgentCoreMemory, tmp_path: Path) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    saver, client = _turn(memory)

    for _ in range(3):
        assert _said(saver, tmp_path) == ['Question 1', 'Answer 1']

    assert len(client.calls) == 2


def test_a_checkpoint_another_microvm_wrote_since_loads_in_full(memory: FakeAgentCoreMemory, tmp_path: Path) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    _ask(_another_microvm(), tmp_path, 'Question 2', 'Answer 2')
    saver, client = _turn(memory)

    said = _said(saver, tmp_path)

    assert said == ['Question 1', 'Answer 1', 'Question 2', 'Answer 2']
    assert ('list_events', 'session-1', True) in client.calls
    # The loaded checkpoint is held: the next Turn confirms it without a load.
    saver, client = _turn(memory)
    assert _said(saver, tmp_path) == said
    assert ('list_events', 'session-1', True) not in client.calls


def test_a_session_deleted_elsewhere_reads_as_empty(memory: FakeAgentCoreMemory, tmp_path: Path) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    _another_microvm().delete_thread('session-1', 'user-1')

    assert _turn(memory)[0].get_tuple(CONFIG) is None


def test_pending_writes_filed_elsewhere_under_the_warm_checkpoint_are_read(memory: FakeAgentCoreMemory, tmp_path: Path) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    other = _another_microvm()
    latest = other.get_tuple(CONFIG)
    assert latest is not None and latest.pending_writes == []
    other.put_writes(latest.config, [('messages', [HumanMessage('Interrupted question')])], 'task-1')

    warm = _turn(memory)[0].get_tuple(CONFIG)

    assert warm is not None
    assert warm.pending_writes == [('task-1', 'messages', [HumanMessage('Interrupted question')])]


def test_a_failed_checkpoint_write_fails_the_turn_and_the_next_turn_loads_from_memory(
    memory: FakeAgentCoreMemory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    create_event = memory.create_event

    def lost_reply(**params: Any) -> Any:
        # AgentCore stores the commit, but its reply never arrives.
        created = create_event(**params)
        if params.get('metadata', {}).get('lc_kind') == {'stringValue': 'checkpoint'}:
            raise ConnectionError('Memory reply lost')
        return created

    monkeypatch.setattr(memory, 'create_event', lost_reply)
    with pytest.raises(ConnectionError, match='Memory reply lost'):
        _ask(_turn(memory)[0], tmp_path, 'Question 2', 'Answer 2')
    monkeypatch.setattr(memory, 'create_event', create_event)
    saver, client = _turn(memory)

    said = _said(saver, tmp_path)

    assert said == _said(_another_microvm(), tmp_path)
    assert ('list_events', 'session-1', True) in client.calls


def _lose_checkpoint_replies(memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch) -> Callable[[], None]:
    """Memory stores each checkpoint commit but its reply is lost; the returned call restores the replies."""
    create_event = memory.create_event

    def lost_reply(**params: Any) -> Any:
        created = create_event(**params)
        if params.get('metadata', {}).get('lc_kind') == {'stringValue': 'checkpoint'}:
            raise ConnectionError('Memory reply lost')
        return created

    monkeypatch.setattr(memory, 'create_event', lost_reply)
    return lambda: monkeypatch.setattr(memory, 'create_event', create_event)


def _kept_reply(writer: WarmSessionSaver) -> tuple[RunnableConfig, Checkpoint]:
    """The stopped Turn keeps the reply its member already read: one checkpoint, no pending writes."""
    latest = writer.get_tuple(CONFIG)
    assert latest is not None
    kept = copy_checkpoint(latest.checkpoint)
    kept['id'] = str(uuid6())
    kept['channel_values']['messages'] = [*kept['channel_values']['messages'], AIMessage('Kept reply')]
    kept['channel_versions']['messages'] = writer.get_next_version(str(kept['channel_versions']['messages']))
    return latest.config, kept


def test_a_lost_first_checkpoint_write_makes_every_turns_saver_ask_memory_again(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A replacement Turn prepared on a new Session, confirming it has no checkpoint, while this one writes.
    prepared = _turn(memory)[0]
    assert prepared.get_tuple(CONFIG) is None
    restore = _lose_checkpoint_replies(memory, monkeypatch)
    first = empty_checkpoint()
    with pytest.raises(ConnectionError, match='Memory reply lost'):
        _turn(memory)[0].put(CONFIG, first, {'source': 'input', 'step': -1, 'parents': {}}, {})
    restore()

    warm, stock = prepared.get_tuple(CONFIG), _another_microvm().get_tuple(CONFIG)
    assert warm is not None and stock is not None
    assert warm.checkpoint['id'] == stock.checkpoint['id'] == first['id']


def test_a_lost_checkpoint_write_makes_every_turns_saver_ask_memory_again(
    memory: FakeAgentCoreMemory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    # A replacement Turn prepared, confirming the held checkpoint, while this one still writes.
    prepared = _turn(memory)[0]
    assert _said(prepared, tmp_path) == ['Question 1', 'Answer 1']
    restore = _lose_checkpoint_replies(memory, monkeypatch)
    writer = _turn(memory)[0]
    latest, kept = _kept_reply(writer)
    with pytest.raises(ConnectionError, match='Memory reply lost'):
        writer.put(latest, kept, {'source': 'update', 'step': 3, 'parents': {}}, {})
    restore()

    assert _said(prepared, tmp_path) == _said(_another_microvm(), tmp_path) == ['Question 1', 'Answer 1', 'Kept reply']


def test_a_turn_confirming_while_a_checkpoint_write_is_lost_asks_memory_again(
    memory: FakeAgentCoreMemory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    prepared = _turn(memory)[0]
    create_event = memory.create_event

    def confirm_then_lose_reply(**params: Any) -> Any:
        if params.get('metadata', {}).get('lc_kind') == {'stringValue': 'checkpoint'}:
            # A replacement Turn confirms the old checkpoint after the writer's invalidation, before its commit.
            assert _said(prepared, tmp_path) == ['Question 1', 'Answer 1']
            create_event(**params)
            raise ConnectionError('Memory reply lost')
        return create_event(**params)

    writer = _turn(memory)[0]
    latest, kept = _kept_reply(writer)
    monkeypatch.setattr(memory, 'create_event', confirm_then_lose_reply)
    with pytest.raises(ConnectionError, match='Memory reply lost'):
        writer.put(latest, kept, {'source': 'update', 'step': 3, 'parents': {}}, {})
    monkeypatch.setattr(memory, 'create_event', create_event)

    assert _said(prepared, tmp_path) == _said(_another_microvm(), tmp_path) == ['Question 1', 'Answer 1', 'Kept reply']


def test_a_failed_confirmation_read_fails_without_waiting_for_its_sibling(
    memory: FakeAgentCoreMemory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ask(_turn(memory)[0], tmp_path, 'Question 1', 'Answer 1')
    released = threading.Event()
    list_events = memory.list_events

    def partial_outage(**params: Any) -> Any:
        if params['sessionId'].startswith(WRITES_PREFIX):
            released.wait(5)
            return list_events(**params)
        raise ConnectionError('ListEvents unavailable')

    monkeypatch.setattr(memory, 'list_events', partial_outage)
    started = time.perf_counter()
    try:
        with pytest.raises(ConnectionError, match='ListEvents unavailable'):
            _turn(memory)[0].get_tuple(CONFIG)
        assert time.perf_counter() - started < 1
    finally:
        released.set()
