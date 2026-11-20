"""A Session purge empties the Session and its writes sessions without listing the actor's sessions."""

from __future__ import annotations

import logging
from typing import Any

import boto3
import pytest
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint
from langgraph_checkpoint_aws.checkpoint.agentcore.snapshot import (
    _writes_session_prefix,
)

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore import purge as purge_module

SESSION = 'session-1'
OTHER = 'session-2'


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    monkeypatch.setattr(purge_module, 'sleep', lambda seconds: None)

    def list_sessions(**params: Any) -> dict[str, Any]:
        raise AssertionError('A purge lists no sessions')

    monkeypatch.setattr(memory, 'list_sessions', list_sessions)
    return memory


def _write(saver: Any, session: str, checkpoints: int) -> None:
    """Checkpoints of a Session, each with pending writes in its own writes session, as a Turn files them."""
    config: RunnableConfig = {'configurable': {'thread_id': session, 'actor_id': 'user-1'}}
    for step in range(checkpoints):
        config = saver.put(config, empty_checkpoint(), {'source': 'loop', 'step': step, 'parents': {}}, {})
        saver.put_writes(config, [('messages', f'write {step}')], task_id=f'task-{step}')


def _left(memory: FakeAgentCoreMemory, session: str) -> dict[str, int]:
    prefix = _writes_session_prefix(session)
    return {
        name: len(events) for (actor, name), events in memory.events.items()
        if events and actor == 'user-1' and (name == session or name.startswith(prefix))
    }


def test_a_purge_empties_the_session_and_every_writes_session_and_leaves_the_actors_other_sessions(
    memory: FakeAgentCoreMemory,
) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    _write(saver, SESSION, 3)
    _write(saver, OTHER, 2)
    assert len(_left(memory, SESSION)) == 4

    purge_module.purge_session(saver, 'user-1', SESSION)

    assert _left(memory, SESSION) == {}
    assert len(_left(memory, OTHER)) == 3


def test_a_purge_reads_only_its_own_session_whatever_the_actor_has(memory: FakeAgentCoreMemory) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    for session in range(500):
        memory.seed('user-1', f'old-{session}')
    _write(saver, SESSION, 2)

    purge_module.purge_session(saver, 'user-1', SESSION)

    assert _left(memory, SESSION) == {}
    prefix = _writes_session_prefix(SESSION)
    assert all(name == SESSION or name.startswith(prefix) for name in memory.listed), memory.listed


def test_a_purge_of_an_emptied_session_reads_one_page(memory: FakeAgentCoreMemory) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    _write(saver, SESSION, 2)
    purge_module.purge_session(saver, 'user-1', SESSION)
    memory.listed.clear()

    purge_module.purge_session(saver, 'user-1', SESSION)

    assert memory.listed == {SESSION: 2}


def test_a_purge_retried_after_failing_part_way_empties_everything(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    _write(saver, SESSION, 3)
    delete = memory.delete_event
    deleted = [0]

    def failing_delete(**params: Any) -> dict[str, Any]:
        deleted[0] += 1
        if deleted[0] == 2:
            raise memory.exceptions.ThrottlingException(
                {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}}, 'DeleteEvent')
        return delete(**params)

    monkeypatch.setattr(memory, 'delete_event', failing_delete)
    with pytest.raises(memory.exceptions.ThrottlingException):
        purge_module.purge_session(saver, 'user-1', SESSION)
    assert _left(memory, SESSION)

    purge_module.purge_session(saver, 'user-1', SESSION)

    assert _left(memory, SESSION) == {}


def test_a_purge_deletes_at_five_per_second(memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [10.0]
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(purge_module, '_next_delete_at', 0.0)
    monkeypatch.setattr(purge_module, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(purge_module, 'sleep', sleep)
    for _ in range(3):
        memory.seed('user-1', SESSION)

    purge_module.purge_session(agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'), 'user-1', SESSION)

    # The first delete goes at once; each next waits out the rest of its 0.2 s slot.
    assert sleeps == [0.0, pytest.approx(0.2), pytest.approx(0.2)]


def test_a_purge_logs_each_page_it_deletes(memory: FakeAgentCoreMemory, caplog: pytest.LogCaptureFixture) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    _write(saver, SESSION, 3)
    left = _left(memory, SESSION)

    with caplog.at_level(logging.INFO, logger=purge_module.__name__):
        purge_module.purge_session(saver, 'user-1', SESSION)

    assert sorted(record.getMessage() for record in caplog.records) == sorted(
        f'Session purge deleted {count} events. session_id={name}' for name, count in left.items()
    )


@pytest.mark.parametrize('damage', ['missing', 'corrupt'])
def test_a_session_whose_snapshot_no_longer_decodes_still_purges_every_writes_session(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, damage: str,
) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    config: RunnableConfig = {'configurable': {'thread_id': SESSION, 'actor_id': 'user-1'}}
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('x' * 200_000)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    config = saver.put(config, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'})
    saver.put_writes(config, [('messages', 'write')], task_id='task-1')
    _write(saver, OTHER, 1)
    events = memory.events[('user-1', SESSION)]
    fragment = next(event for event in events if event.get('metadata', {}).get('lc_kind', {}).get('stringValue') == 'blob_fragment')
    if damage == 'missing':
        events.remove(fragment)
    else:
        fragment['payload'][0]['blob'] = 'Y29ycnVwdA=='
    assert len(_left(memory, SESSION)) == 2
    monkeypatch.undo()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    monkeypatch.setattr(purge_module, 'sleep', lambda seconds: None)

    with caplog.at_level(logging.WARNING, logger=purge_module.__name__):
        purge_module.purge_session(agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'), 'user-1', SESSION)

    assert _left(memory, SESSION) == {}
    assert len(_left(memory, OTHER)) == 2
    assert [record.getMessage() for record in caplog.records] == [
        f'Session snapshot does not decode; listing its writes sessions by prefix. session_id={SESSION}',
    ]
