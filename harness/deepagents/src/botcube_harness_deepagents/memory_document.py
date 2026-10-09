"""Memory as one document: a member's memory records, one line each, as the agent opens a conversation with them.

The agent's startup memory and the document the member edits are the same records:
the member's user preferences, then their semantic facts newest first. Editing a line
updates its record; deleting a line deletes it.

AgentCore's record listing shows a write only after about a minute, so each
save is also journaled as an event, which AgentCore reads back at once, and reads lay
the last five minutes of saves over the listing.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from ._env import positive_int
from .actor_identity import record_belongs_to_actor
from .memory_tools import _extract_text, list_actor_memory_record_summaries
from .pending_memory import utc_now

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore import BedrockAgentCoreClient
    from types_boto3_bedrock_agentcore.type_defs import (
        EventTypeDef,
        MemoryRecordSummaryTypeDef,
    )

    from .memory_broker import MemoryBrokerClient


# Live, the listing showed an update after 71-73 s and a delete after 59-63 s.
MEMORY_SAVE_WINDOW = timedelta(seconds=positive_int('BOTCUBE_MEMORY_SAVE_WINDOW_SECONDS', 300))


class MemoryLineNotFoundError(LookupError):
    """The member's Memory has no line for this record."""


def _is_user_preference_record(record: Mapping[str, Any]) -> bool:
    # Case-insensitive: console default names strategies 'UserPreferences-...',
    # but the CDK L3 default formats USER_PREFERENCE as 'Userpreference'.
    return 'userpreference' in record['memoryStrategyId'].lower()


def _is_semantic_fact_record(record: Mapping[str, Any]) -> bool:
    return 'semantic' in record['memoryStrategyId'].lower()


def _newest_first(records: Sequence[MemoryRecordSummaryTypeDef]) -> list[MemoryRecordSummaryTypeDef]:
    # createdAt is a timezone-aware datetime; the stable sort keeps listing order for ties.
    return sorted(records, key=lambda record: record['createdAt'], reverse=True)


def actor_memory_records(
    client: BedrockAgentCoreClient | MemoryBrokerClient,
    *,
    memory_id: str,
    actor_id: str,
    belongs: Callable[[Mapping[str, Any], str], bool] = record_belongs_to_actor,
) -> tuple[list[MemoryRecordSummaryTypeDef], list[MemoryRecordSummaryTypeDef]]:
    """The actor's user preference records, and their semantic fact records newest first.

    Listing each actor leaf avoids semantic relevance cutoffs for durable preferences.
    """
    summaries = list_actor_memory_record_summaries(client, memory_id=memory_id, actor_id=actor_id)
    return _actor_memory_records(summaries, _recent_saves(client, memory_id=memory_id, actor_id=actor_id), actor_id, belongs)


def startup_memory_records(
    client: MemoryBrokerClient,
    *,
    memory_id: str,
    actor_id: str,
    pending_session_ids: Sequence[str],
    now: datetime,
    belongs: Callable[[Mapping[str, Any], str], bool] = record_belongs_to_actor,
) -> tuple[list[MemoryRecordSummaryTypeDef], list[MemoryRecordSummaryTypeDef], list[EventTypeDef]]:
    """Read startup records and journals together, using the same Memory document rules."""
    save_session_ids = _save_session_ids(now)
    snapshot = client.startup_snapshot(memory_id, actor_id, [*save_session_ids, *pending_session_ids])
    events = snapshot['eventsBySession']
    saves = _saves_from_events([event for session in save_session_ids for event in events[session]], now)
    preferences, facts = _actor_memory_records(snapshot['memoryRecordSummaries'], saves, actor_id, belongs)
    return preferences, facts, [event for session in pending_session_ids for event in events[session]]


def _actor_memory_records(
    summaries: Sequence[MemoryRecordSummaryTypeDef],
    saves: Mapping[str, str | None],
    actor_id: str,
    belongs: Callable[[Mapping[str, Any], str], bool],
) -> tuple[list[MemoryRecordSummaryTypeDef], list[MemoryRecordSummaryTypeDef]]:
    actor_summaries = _with_saves(
        [summary for summary in summaries if belongs(summary, actor_id)],
        saves,
    )
    preferences = [summary for summary in actor_summaries if _is_user_preference_record(summary)]
    facts = _newest_first([summary for summary in actor_summaries if _is_semantic_fact_record(summary)])
    return preferences, facts


def _saves_session_id(at: datetime) -> str:
    # One session per window, so a read lists two short sessions.
    return f'memory-saves-{int(at.timestamp() // MEMORY_SAVE_WINDOW.total_seconds())}'


def _save_session_ids(now: datetime) -> tuple[str, str]:
    return _saves_session_id(now - MEMORY_SAVE_WINDOW), _saves_session_id(now)


def _recent_saves(client: BedrockAgentCoreClient | MemoryBrokerClient, *, memory_id: str, actor_id: str) -> dict[str, str | None]:
    """The actor's Memory saves of the last five minutes: each record's latest text, or None once deleted."""
    now = utc_now()
    events: list[Any] = []
    for session_id in _save_session_ids(now):
        kwargs: dict[str, Any] = {
            'memoryId': memory_id, 'actorId': actor_id, 'sessionId': session_id, 'includePayloads': True, 'maxResults': 100,
        }
        while True:
            response = client.list_events(**kwargs)
            events += response['events']
            if 'nextToken' not in response:
                break
            kwargs['nextToken'] = response['nextToken']
    return _saves_from_events(events, now)


def _saves_from_events(events: Sequence[Mapping[str, Any]], now: datetime) -> dict[str, str | None]:
    saves: dict[str, str | None] = {}
    for event in sorted(events, key=lambda event: event['eventTimestamp']):
        if now - event['eventTimestamp'] <= MEMORY_SAVE_WINDOW:
            [item] = event['payload']
            save = json.loads(item['blob'])
            saves[save['recordId']] = save['text']
    return saves


def _with_saves(
    summaries: Sequence[MemoryRecordSummaryTypeDef], saves: Mapping[str, str | None]
) -> list[MemoryRecordSummaryTypeDef]:
    current: list[MemoryRecordSummaryTypeDef] = []
    for summary in summaries:
        record_id = summary['memoryRecordId']
        if record_id not in saves:
            current.append(summary)
        elif (text := saves[record_id]) is not None:
            edited = summary.copy()
            edited['content'] = {'text': text}
            current.append(edited)
    return current


def _journal_save(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str, record_id: str, text: str | None) -> None:
    now = utc_now()
    # A JSON string, though the stubs type a blob as a mapping: AgentCore returns a dict blob as a Java-style string.
    blob: Any = json.dumps({'recordId': record_id, 'text': text})
    client.create_event(
        memoryId=memory_id, actorId=actor_id, sessionId=_saves_session_id(now), eventTimestamp=now, payload=[{'blob': blob}],
        # Kept out of long-term extraction, which would turn the save into a Memory record of its own.
        extractionMode='SKIP',
    )


def record_text(record: Mapping[str, Any]) -> str:
    """The text a record shows the agent and the member."""
    return _extract_text(record['content']['text'])


def memory_lines(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str) -> list[dict[str, str]]:
    """The actor's Memory document: one line per record the agent opens a conversation with."""
    preferences, facts = actor_memory_records(client, memory_id=memory_id, actor_id=actor_id)
    lines = [{'id': record['memoryRecordId'], 'text': record_text(record)} for record in [*preferences, *facts]]
    return [line for line in lines if line['text']]


def _require_line(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str, record_id: str) -> None:
    if not any(line['id'] == record_id for line in memory_lines(client, memory_id=memory_id, actor_id=actor_id)):
        raise MemoryLineNotFoundError(f'Memory has no line {record_id}')


def edit_memory_line(
    client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str, record_id: str, text: str
) -> None:
    """Rewrite one line of the actor's Memory: its record's content becomes this text."""
    _require_line(client, memory_id=memory_id, actor_id=actor_id, record_id=record_id)
    response = client.batch_update_memory_records(
        memoryId=memory_id,
        records=[{'memoryRecordId': record_id, 'timestamp': utc_now(), 'content': {'text': text}}],
    )
    if response['failedRecords']:
        [failed] = response['failedRecords']
        if failed.get('errorCode') == 404:
            raise MemoryLineNotFoundError(f'Memory has no line {record_id}')
        raise RuntimeError(f'Updating memory record {record_id} failed: {failed.get("errorMessage", failed["status"])}')
    _journal_save(client, memory_id=memory_id, actor_id=actor_id, record_id=record_id, text=text)


def delete_memory_line(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str, record_id: str) -> None:
    """Delete one line of the actor's Memory, and with it its record."""
    _require_line(client, memory_id=memory_id, actor_id=actor_id, record_id=record_id)
    client.delete_memory_record(memoryId=memory_id, memoryRecordId=record_id)
    _journal_save(client, memory_id=memory_id, actor_id=actor_id, record_id=record_id, text=None)
