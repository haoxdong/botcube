from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory

# Live AgentCore's answers, recorded on dev from the live backend.
LIST_LAG = json.loads((Path(__file__).parents[4] / 'contract/regressions/agentcore-memory-list-lag.json').read_text())


def test_the_fake_lists_event_payloads_as_agentcore_does_issue_3501() -> None:
    memory = FakeAgentCoreMemory()
    marker = {'recordId': 'mem-x', 'text': 'T'}
    for blob in (marker, json.dumps(marker)):
        memory.create_event(
            memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-1',
            eventTimestamp=datetime(2026, 10, 6, tzinfo=UTC), payload=[{'blob': blob}],
        )

    listed = memory.list_events(memoryId=MEMORY_ID, actorId='actor-1', sessionId='session-1', includePayloads=True)

    assert [event['payload'] for event in listed['events']] == [event['payload'] for event in LIST_LAG['listEvents']['events']]
