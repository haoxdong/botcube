"""The AgentCore memory backend's factory slots and Session purge, against the bedrock-agentcore API."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber
from langgraph_checkpoint_aws.checkpoint.agentcore.snapshot import (
    _writes_session_prefix,
)

from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore import purge as purge_module
from botcube_harness_deepagents.session_memory import SessionMemoryMiddleware
from botcube_harness_deepagents.turn_memory import TurnMemoryMiddleware

MEMORY_ID = 'memory_1-0123456789'


@pytest.fixture(autouse=True)
def aws_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-west-2')


def test_the_checkpointers_writes_prefix_is_the_one_the_chat_service_signs() -> None:
    # The Session ID and prefix of botcube/chat's turn-identity.test.ts: the Memory role allows `${writesPrefix}-*`.
    assert _writes_session_prefix('3f2b8c1e-5d4a-4f6b-9c2d-1a2b3c4d5e6f') == 'lgw-3d005e2ccf2461767eb01d780463736c-'


def test_the_checkpointer_reads_the_configured_memory_in_the_configured_region() -> None:
    events = agentcore.build_checkpointer(MEMORY_ID, region_name='eu-west-1').checkpoint_event_client

    assert (events.memory_id, events.client.meta.region_name) == (MEMORY_ID, 'eu-west-1')


def test_the_store_reads_the_configured_memory_in_the_configured_region() -> None:
    store = agentcore.build_store(MEMORY_ID, region_name='eu-west-1')

    assert (store.memory_id, store.client.meta.region_name) == (MEMORY_ID, 'eu-west-1')


def test_the_actor_gets_one_memory_tool_its_turns_recorded_and_memory_loaded_once() -> None:
    tools, middleware = agentcore.build_memory_tools(actor_id='jane.doe_ny', thread_id='thread-1')

    assert [tool.name for tool in tools] == ['memory']
    turns, session = middleware
    assert isinstance(turns, TurnMemoryMiddleware)
    assert (turns.actor_id, turns.session_id) == ('jane.doe_ny', 'thread-1')
    assert isinstance(session, SessionMemoryMiddleware)


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


def test_a_purge_lists_event_ids_only_and_deletes_each_at_five_per_second_in_the_session_and_its_writes_sessions(events_client: tuple[Any, Stubber], monkeypatch: pytest.MonkeyPatch) -> None:
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
    writes = 'lgw-84097828fc31a8c8d29210df48901a85-checkpoint-1'
    others = 'lgw-5d9061408048c12d053925aed45333a1-checkpoint-1'
    listed = datetime(2026, 7, 2, tzinfo=UTC)
    sessions = {'memoryId': MEMORY_ID, 'actorId': 'user-1', 'maxResults': 100}
    stubber.add_response('list_sessions', {'sessionSummaries': [
        {'sessionId': session, 'actorId': 'user-1', 'createdAt': listed} for session in ('session-1', writes)
    ], 'nextToken': 'page-2'}, sessions)
    stubber.add_response('list_sessions', {'sessionSummaries': [
        {'sessionId': others, 'actorId': 'user-1', 'createdAt': listed},
    ]}, {**sessions, 'nextToken': 'page-2'})
    writes_request = {**list_request, 'sessionId': writes}
    stubber.add_response('list_events', {'events': [{**_event('3#c3'), 'sessionId': writes}]}, writes_request)
    stubber.add_response(
        'delete_event', {'eventId': '3#c3'},
        {'memoryId': MEMORY_ID, 'actorId': 'user-1', 'sessionId': writes, 'eventId': '3#c3'},
    )
    stubber.add_response('list_events', {'events': []}, writes_request)
    saver = SimpleNamespace(checkpoint_event_client=SimpleNamespace(client=client, memory_id=MEMORY_ID))

    purge_module.purge_session(saver, 'user-1', 'session-1')

    # The first delete goes at once; each next waits out the rest of its 0.2 s slot.
    assert sleeps == [0.0, pytest.approx(0.2), pytest.approx(0.2)]
