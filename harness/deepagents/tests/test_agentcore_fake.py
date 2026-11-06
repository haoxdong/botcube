from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory


def test_the_fake_lists_event_payloads_as_agentcore_does() -> None:
    memory = FakeAgentCoreMemory()
    marker = {'recordId': 'mem-x', 'text': 'T'}
    for blob in (marker, json.dumps(marker)):
        memory.create_event(
            memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-1',
            eventTimestamp=datetime(2026, 10, 6, tzinfo=UTC), payload=[{'blob': blob}],
        )

    listed = memory.list_events(memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-1', includePayloads=True)

    assert [event['payload'] for event in listed['events']] == [
        [{'blob': '{"recordId": "mem-x", "text": "T"}'}],
        [{'blob': '{recordId=mem-x, text=T}'}],
    ]


def _create(memory: FakeAgentCoreMemory, session: str, kind: str, token: str | None = None) -> dict[str, Any]:
    return memory.create_event(
        memoryId=MEMORY_ID, actorId='actor-1', sessionId=session,
        eventTimestamp=datetime(2026, 10, 6, tzinfo=UTC), payload=[{'blob': kind}],
        metadata={'lc_kind': {'stringValue': kind}}, **({'clientToken': token} if token else {}),
    )['event']


def test_the_fake_filters_events_by_metadata_and_gets_one_by_id() -> None:
    memory = FakeAgentCoreMemory()
    chunk = _create(memory, 'session-1', 'checkpoint_data')
    _create(memory, 'session-1', 'checkpoint')
    _create(memory, 'session-1', 'checkpoint_data')
    condition: Any = {'left': {'metadataKey': 'lc_kind'}, 'operator': 'EQUALS_TO',
                      'right': {'metadataValue': {'stringValue': 'checkpoint'}}}

    listed = memory.list_events(memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-1',
                                filter={'eventMetadata': [condition]}, maxResults=1)
    got = memory.get_event(memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-1', eventId=chunk['eventId'])

    assert [event['payload'] for event in listed['events']] == [[{'blob': 'checkpoint'}]]
    assert 'nextToken' not in listed
    assert got['event']['payload'] == [{'blob': 'checkpoint_data'}]
    with pytest.raises(memory.exceptions.ResourceNotFoundException):
        memory.get_event(memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-2', eventId=chunk['eventId'])


def test_a_repeated_client_token_creates_the_event_once() -> None:
    memory = FakeAgentCoreMemory()
    first = _create(memory, 'session-1', 'checkpoint', token='token-1')
    again = _create(memory, 'session-1', 'checkpoint', token='token-1')

    assert again == first
    assert len(memory.list_events(memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-1')['events']) == 1


def test_list_sessions_keeps_listing_emptied_sessions_by_page() -> None:
    memory = FakeAgentCoreMemory()
    events = [_create(memory, f'session-{index}', 'checkpoint') for index in range(101)]
    memory.delete_event(memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-100', eventId=events[-1]['eventId'])
    memory.list_events(memoryId=MEMORY_ID, actorId='actor-1', sessionId='never-written')

    first = memory.list_sessions(memoryId=MEMORY_ID, actorId='actor-1', maxResults=100)
    second = memory.list_sessions(memoryId=MEMORY_ID, actorId='actor-1', maxResults=100, nextToken=first['nextToken'])

    listed = [summary['sessionId'] for page in (first, second) for summary in page['sessionSummaries']]
    assert sorted(listed) == sorted(f'session-{index}' for index in range(101))
    assert 'nextToken' not in second
    assert memory.list_sessions(memoryId=MEMORY_ID, actorId='actor-2')['sessionSummaries'] == []
