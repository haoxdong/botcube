"""The AgentCore memory backend's factory slots and Session purge, against the bedrock-agentcore API."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber

from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore import purge as purge_module
from botcube_harness_deepagents.memory_tools import agent_core_memory
from botcube_harness_deepagents.pending_memory import pending_memory_session_id

MEMORY_ID = 'memory_1-0123456789'


@pytest.fixture(autouse=True)
def aws_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-west-2')


def test_the_checkpointer_reads_the_configured_memory_in_the_configured_region() -> None:
    events = agentcore.build_checkpointer(MEMORY_ID, region_name='eu-west-1').checkpoint_event_client

    assert (events.memory_id, events.client.meta.region_name) == (MEMORY_ID, 'eu-west-1')


def test_the_store_reads_the_configured_memory_in_the_configured_region() -> None:
    store = agentcore.build_store(MEMORY_ID, region_name='eu-west-1')

    assert (store.memory_id, store.client.meta.region_name) == (MEMORY_ID, 'eu-west-1')


def test_the_memory_tools_record_each_turn_of_the_actors_thread() -> None:
    tools, middleware = agentcore.build_memory_tools(
        store=agentcore.build_store(MEMORY_ID, region_name='eu-west-1'),
        actor_id='jane.doe_ny',
        thread_id='thread-1',
        memory_id=MEMORY_ID,
    )

    assert tools == [agent_core_memory]
    assert [(m.memory_id, m.actor_id, m.session_id) for m in middleware] == [
        (MEMORY_ID, 'jane.doe_ny', 'thread-1')
    ]


class _PendingMemoryClient:
    """Serves no strategy records, and one Pending Memory event per seeded (actor, Session)."""

    def __init__(self, texts_by_session: dict[tuple[str, str], str]) -> None:
        self.texts_by_session = texts_by_session

    def get_paginator(self, operation: str) -> Any:
        assert operation == 'list_memory_records'
        return SimpleNamespace(paginate=lambda **_params: [{'memoryRecordSummaries': []}])

    def list_events(self, *, actorId: str, sessionId: str, **_params: Any) -> dict[str, Any]:
        text = self.texts_by_session.get((actorId, sessionId))
        if text is None:
            return {'events': []}
        payload = [{'conversational': {'content': {'text': text}, 'role': 'USER'}}]
        return {'events': [{'eventTimestamp': datetime.now(UTC), 'payload': payload}]}


@pytest.mark.parametrize(
    ('actor_id', 'thread_id', 'expected'),
    [
        ('anonymous', 'thread-1', 'semantic facts:\n- Prefers copper'),
        ('anonymous', 'thread-2', None),
        ('jane.doe_ny', 'thread-1', None),
    ],
)
def test_prewarm_reads_the_pending_memory_of_the_actors_thread(actor_id: str, thread_id: str, expected: str | None) -> None:
    # An anonymous actor's Pending Memory is filed per thread.
    session_id = pending_memory_session_id(actor_id='anonymous', thread_id='thread-1')
    store: Any = SimpleNamespace(client=_PendingMemoryClient({('anonymous', session_id): 'Prefers copper'}))

    assert agentcore.prewarm_ltm(store, actor_id, thread_id=thread_id) == expected


# -- Session purge ---------------------------------------------------------------


def _event(event_id: str) -> dict[str, Any]:
    return {
        'memoryId': MEMORY_ID,
        'actorId': 'user-1',
        'sessionId': 'session-1',
        'eventId': event_id,
        'eventTimestamp': datetime(2026, 7, 2, tzinfo=UTC),
        'payload': [],
    }


@pytest.fixture
def events_client() -> Iterator[tuple[Any, Stubber]]:
    client = boto3.client('bedrock-agentcore', region_name='us-east-1')
    with Stubber(client) as stubber:
        yield client, stubber
        stubber.assert_no_pending_responses()


def test_a_purge_lists_event_ids_only_and_deletes_each_at_five_per_second(events_client: tuple[Any, Stubber], monkeypatch: pytest.MonkeyPatch) -> None:
    client, stubber = events_client
    clock = [10.0]
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(purge_module, '_next_delete_at', 0.0)
    monkeypatch.setattr(purge_module, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(purge_module, 'sleep', sleep)
    list_request = {
        'memoryId': MEMORY_ID,
        'actorId': 'user-1',
        'sessionId': 'session-1',
        'maxResults': 100,
        'includePayloads': False,
    }
    stubber.add_response('list_events', {'events': [_event('1#a1'), _event('2#b2')]}, list_request)
    for event_id in ('1#a1', '2#b2'):
        stubber.add_response(
            'delete_event',
            {'eventId': event_id},
            {'memoryId': MEMORY_ID, 'actorId': 'user-1', 'sessionId': 'session-1', 'eventId': event_id},
        )
    stubber.add_response('list_events', {'events': []}, list_request)
    saver = SimpleNamespace(checkpoint_event_client=SimpleNamespace(client=client, memory_id=MEMORY_ID))

    purge_module.purge_session(saver, 'user-1', 'session-1')

    # The first delete goes at once; the second waits out the rest of its 0.2 s slot.
    assert sleeps == [0.0, pytest.approx(0.2)]
