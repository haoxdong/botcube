from __future__ import annotations

import json
from datetime import UTC, datetime

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
