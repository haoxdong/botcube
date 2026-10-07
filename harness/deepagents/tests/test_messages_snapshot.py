"""A Session's messages-only snapshot, kept beside its record on every backend (ADR 0067 §5)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import boto3
import pytest

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents.memory import agentcore, inmem, local
from botcube_harness_deepagents.memory.agentcore.turn_saver import TurnCheckpointSaver
from botcube_harness_deepagents.messages_snapshot import MessagesSnapshot

OLDER = MessagesSnapshot('1f0a0000-0000-6000-8000-000000000001', [{'id': 'user-1', 'role': 'user', 'content': 'hi'}])
NEWER = MessagesSnapshot(
    '1f0a0000-0000-6000-8000-000000000002',
    [*OLDER.messages, {'id': 'answer-1', 'role': 'assistant', 'content': 'hello'}],
)


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    return memory


def _agentcore(memory: FakeAgentCoreMemory, _tmp_path: Path) -> Any:
    return agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')


def _turn_saver(memory: FakeAgentCoreMemory, _tmp_path: Path) -> Any:
    return agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1', wrapper=TurnCheckpointSaver)


def _local(_memory: FakeAgentCoreMemory, tmp_path: Path) -> Any:
    return local.build_checkpointer(tmp_path / 'checkpoints.sqlite3')


def _inmem(_memory: FakeAgentCoreMemory, _tmp_path: Path) -> Any:
    return inmem.build_checkpointer()


BACKENDS = pytest.mark.parametrize('backend', [_agentcore, _turn_saver, _local, _inmem])


@BACKENDS
def test_a_session_without_a_snapshot_reads_none(
    backend: Callable[..., Any], memory: FakeAgentCoreMemory, tmp_path: Path
) -> None:
    saver = backend(memory, tmp_path)

    assert asyncio.run(saver.aread_messages_snapshot('user-1', 'session-1')) is None


@BACKENDS
def test_reads_take_the_newest_checkpoint_whichever_was_written_last(
    backend: Callable[..., Any], memory: FakeAgentCoreMemory, tmp_path: Path
) -> None:
    """A slow rebuild of an older checkpoint lands after a Turn's newer snapshot."""
    saver = backend(memory, tmp_path)

    async def write_and_read() -> tuple[Any, Any, Any]:
        await saver.awrite_messages_snapshot('user-1', 'session-1', NEWER)
        await saver.awrite_messages_snapshot('user-1', 'session-1', OLDER)
        return (
            await saver.aread_messages_snapshot('user-1', 'session-1'),
            await saver.aread_messages_snapshot('user-2', 'session-1'),
            await saver.aread_messages_snapshot('user-1', 'session-2'),
        )

    assert asyncio.run(write_and_read()) == (NEWER, None, None)


@BACKENDS
def test_a_later_snapshot_of_the_same_checkpoint_replaces_it(
    backend: Callable[..., Any], memory: FakeAgentCoreMemory, tmp_path: Path
) -> None:
    """A read that rebuilt the snapshot records the message it checked it against."""
    saver = backend(memory, tmp_path)
    checked = MessagesSnapshot(NEWER.checkpoint, NEWER.messages, checked='post-1')

    async def write_and_read() -> Any:
        await saver.awrite_messages_snapshot('user-1', 'session-1', NEWER)
        await saver.awrite_messages_snapshot('user-1', 'session-1', checked)
        return await saver.aread_messages_snapshot('user-1', 'session-1')

    assert asyncio.run(write_and_read()) == checked


# The in-memory record is never purged: only the session API purges, and it refuses that record.
@pytest.mark.parametrize('backend', [_agentcore, _local])
def test_purging_a_session_deletes_its_snapshot(
    backend: Callable[..., Any], memory: FakeAgentCoreMemory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from botcube_harness_deepagents.memory.agentcore import purge

    monkeypatch.setattr(purge, '_pace', lambda: None)
    saver = backend(memory, tmp_path)

    async def write_purge_and_read() -> tuple[Any, Any]:
        # Opens the user's record, as the Session's first Turn would have.
        await saver.aget_tuple({'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}})
        await saver.awrite_messages_snapshot('user-1', 'session-1', NEWER)
        await saver.awrite_messages_snapshot('user-1', 'session-2', NEWER)
        await saver.adelete_session('user-1', 'session-1')
        return (
            await saver.aread_messages_snapshot('user-1', 'session-1'),
            await saver.aread_messages_snapshot('user-1', 'session-2'),
        )

    assert asyncio.run(write_purge_and_read()) == (None, NEWER)


def test_agentcore_keeps_one_snapshot_beside_the_record_never_in_it(memory: FakeAgentCoreMemory) -> None:
    """State reads list the Session's own events: the snapshot's copies would load with every resume."""
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')

    async def write_twice() -> None:
        await saver.awrite_messages_snapshot('user-1', 'session-1', OLDER)
        await saver.awrite_messages_snapshot('user-1', 'session-1', NEWER)

    asyncio.run(write_twice())

    assert list(memory.events) == [('user-1', 'session-1-messages')]
    [kept] = memory.events[('user-1', 'session-1-messages')]
    assert kept['metadata'] == {'checkpoint': {'stringValue': NEWER.checkpoint}}


def test_agentcore_paces_the_deletes_that_replace_a_snapshot(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    from botcube_harness_deepagents.memory.agentcore import one_pass_saver

    paced: list[None] = []
    monkeypatch.setattr(one_pass_saver, '_pace', lambda: paced.append(None))
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')

    async def write_twice() -> None:
        await saver.awrite_messages_snapshot('user-1', 'session-1', OLDER)
        await saver.awrite_messages_snapshot('user-1', 'session-1', NEWER)

    asyncio.run(write_twice())

    assert len(paced) == 1


@pytest.mark.parametrize('text', ['a' * 100_000, '漢😀' * 100_000], ids=['ascii', 'unicode'])
def test_agentcore_round_trips_a_snapshot_larger_than_one_message(
    memory: FakeAgentCoreMemory, text: str
) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    snapshot = MessagesSnapshot(NEWER.checkpoint, [{'id': 'long-answer', 'role': 'assistant', 'content': text}])

    async def write_and_read() -> MessagesSnapshot | None:
        await saver.awrite_messages_snapshot('user-1', 'session-1', snapshot)
        return await saver.aread_messages_snapshot('user-1', 'session-1')

    assert asyncio.run(write_and_read()) == snapshot
    [event] = memory.events[('user-1', 'session-1-messages')]
    assert len(event['payload']) > 1
    assert all(len(item['blob'].encode('utf-8')) <= 100_000 for item in event['payload'])


@pytest.mark.parametrize('text', ['a' * 10_000_000, '"' * 3_000_000], ids=['item-limit', 'wire-size-limit'])
def test_agentcore_round_trips_a_snapshot_larger_than_one_event(memory: FakeAgentCoreMemory, text: str) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    snapshot = MessagesSnapshot(NEWER.checkpoint, [{'id': 'large', 'role': 'assistant', 'content': text}])

    async def write_and_read() -> MessagesSnapshot | None:
        await saver.awrite_messages_snapshot('user-1', 'session-1', snapshot)
        return await saver.aread_messages_snapshot('user-1', 'session-1')

    assert asyncio.run(write_and_read()) == snapshot
    assert len(memory.events[('user-1', 'session-1-messages')]) > 1


@pytest.mark.parametrize('failed_kind', ['fragment', 'manifest'])
def test_a_failed_multipart_snapshot_preserves_the_previous_copy(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, failed_kind: str
) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    asyncio.run(saver.awrite_messages_snapshot('user-1', 'session-1', OLDER))
    create_event = memory.create_event

    def fail_after_one_fragment(**params: Any) -> dict[str, Any]:
        kind = params['metadata'].get('snapshot_kind', {}).get('stringValue')
        if kind == failed_kind and memory.create_event_calls > 1:
            raise RuntimeError('snapshot upload failed')
        return create_event(**params)

    monkeypatch.setattr(memory, 'create_event', fail_after_one_fragment)
    snapshot = MessagesSnapshot(NEWER.checkpoint, [{'id': 'large', 'role': 'assistant', 'content': 'a' * 10_000_000}])

    with pytest.raises(RuntimeError, match='^snapshot upload failed$'):
        asyncio.run(saver.awrite_messages_snapshot('user-1', 'session-1', snapshot))

    assert asyncio.run(saver.aread_messages_snapshot('user-1', 'session-1')) == OLDER
    assert len(memory.events[('user-1', 'session-1-messages')]) == 1


def test_replacing_and_purging_a_multipart_snapshot_deletes_its_fragments(memory: FakeAgentCoreMemory) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    snapshot = MessagesSnapshot(NEWER.checkpoint, [{'id': 'large', 'role': 'assistant', 'content': 'a' * 10_000_000}])

    async def replace_and_purge() -> None:
        await saver.awrite_messages_snapshot('user-1', 'session-1', snapshot)
        await saver.awrite_messages_snapshot('user-1', 'session-1', NEWER)
        assert await saver.aread_messages_snapshot('user-1', 'session-1') == NEWER
        assert len(memory.events[('user-1', 'session-1-messages')]) == 1
        await saver.awrite_messages_snapshot('user-1', 'session-1', snapshot)
        await saver.adelete_session('user-1', 'session-1')
        assert await saver.aread_messages_snapshot('user-1', 'session-1') is None
        assert not memory.events[('user-1', 'session-1-messages')]

    asyncio.run(replace_and_purge())


def test_an_overlapping_snapshot_write_keeps_the_newer_completed_copy(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    list_events = memory.list_events
    newer = MessagesSnapshot(NEWER.checkpoint, NEWER.messages, checked='new-marker')
    replaced = False

    def replace_before_cleanup(**params: Any) -> dict[str, Any]:
        nonlocal replaced
        if not replaced and not params.get('includePayloads', True):
            replaced = True
            asyncio.run(saver.awrite_messages_snapshot('user-1', 'session-1', newer))
        return list_events(**params)

    monkeypatch.setattr(memory, 'list_events', replace_before_cleanup)
    asyncio.run(saver.awrite_messages_snapshot('user-1', 'session-1', NEWER))

    assert asyncio.run(saver.aread_messages_snapshot('user-1', 'session-1')) == newer
    assert len(memory.events[('user-1', 'session-1-messages')]) == 1


def test_replacing_a_multipart_snapshot_between_pages_retries_the_read(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    snapshot = MessagesSnapshot(NEWER.checkpoint, [{'id': 'large', 'role': 'assistant', 'content': 'a' * 10_000_000}])
    asyncio.run(saver.awrite_messages_snapshot('user-1', 'session-1', snapshot))
    list_events = memory.list_events
    replaced = False

    def replace_between_pages(**params: Any) -> dict[str, Any]:
        nonlocal replaced
        if params.get('includePayloads', True):
            params['maxResults'] = 1
            if params.get('nextToken') and not replaced:
                replaced = True
                asyncio.run(saver.awrite_messages_snapshot('user-1', 'session-1', NEWER))
        return list_events(**params)

    monkeypatch.setattr(memory, 'list_events', replace_between_pages)
    assert asyncio.run(saver.aread_messages_snapshot('user-1', 'session-1')) == NEWER


def test_an_incomplete_published_snapshot_fails_after_bounded_reads(memory: FakeAgentCoreMemory) -> None:
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    snapshot = MessagesSnapshot(NEWER.checkpoint, [{'id': 'large', 'role': 'assistant', 'content': 'a' * 10_000_000}])
    asyncio.run(saver.awrite_messages_snapshot('user-1', 'session-1', snapshot))
    memory.events[('user-1', 'session-1-messages')].pop(0)
    reads_before = memory.list_events_calls

    with pytest.raises(RuntimeError, match='^Messages snapshot remained incomplete after three reads$'):
        asyncio.run(saver.aread_messages_snapshot('user-1', 'session-1'))

    assert memory.list_events_calls - reads_before == 3
