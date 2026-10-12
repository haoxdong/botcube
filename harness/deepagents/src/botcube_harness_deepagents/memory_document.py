"""Memory as one document: a member's memory records, one line each, as the agent opens a conversation with them.

The Memory a Session opens with and the document the member edits are the same records:
the member's user preferences, then their semantic facts newest first. Editing a line
updates its record; deleting a line deletes it.

AgentCore's record listing shows a write only after about a minute, so each
save is also journaled as an event, which AgentCore reads back at once, and reads lay
the last five minutes of saves over the listing.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from ._env import positive_int
from .actor_identity import actor_namespace
from .memory_tools import extract_text, list_memory_record_summaries
from .pending_memory import pending_memory_session_ids, pending_memory_texts, utc_now
from .session_memory import render_memory

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore import BedrockAgentCoreClient
    from types_boto3_bedrock_agentcore.type_defs import (
        EventTypeDef,
        MemoryRecordSummaryTypeDef,
    )


# Live, the listing showed an update after 71-73 s and a delete after 59-63 s.
MEMORY_SAVE_WINDOW = timedelta(seconds=positive_int('BOTCUBE_MEMORY_SAVE_WINDOW_SECONDS', 300))


class MemoryLineNotFoundError(LookupError):
    """The member's Memory has no line for this record."""


def _newest_first(records: Sequence[MemoryRecordSummaryTypeDef]) -> list[MemoryRecordSummaryTypeDef]:
    # createdAt is a timezone-aware datetime; the stable sort keeps listing order for ties.
    return sorted(records, key=lambda record: record['createdAt'], reverse=True)


def actor_memory_records(
    client: BedrockAgentCoreClient,
    *,
    memory_id: str,
    actor_id: str,
) -> tuple[list[MemoryRecordSummaryTypeDef], list[MemoryRecordSummaryTypeDef]]:
    """The actor's user preference records, and their semantic fact records newest first.

    Listing each kind's namespace avoids semantic relevance cutoffs for durable preferences.
    """
    preferences, facts = (
        list_memory_record_summaries(client, memory_id=memory_id, namespace=actor_namespace(actor_id, kind))
        for kind in ('preferences', 'facts')
    )
    return _actor_memory_records(preferences, facts, _recent_saves(client, memory_id=memory_id, actor_id=actor_id))


def opening_memory(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str) -> str:
    """The Memory block a Session opens with (ADR 0031): preferences, then facts with Pending Memory first, newest first."""
    now = utc_now()
    preferences, facts = actor_memory_records(client, memory_id=memory_id, actor_id=actor_id)
    pending = pending_memory_texts(
        _session_events(client, memory_id=memory_id, actor_id=actor_id, session_ids=pending_memory_session_ids(now)),
        now=now,
    )
    return render_memory(_record_texts(_newest_first(preferences)), [*pending, *_record_texts(facts)])


def _record_texts(records: Sequence[MemoryRecordSummaryTypeDef]) -> list[str]:
    return [text for record in records if (text := record_text(record))]


def _actor_memory_records(
    preferences: Sequence[MemoryRecordSummaryTypeDef],
    facts: Sequence[MemoryRecordSummaryTypeDef],
    saves: Mapping[str, str | None],
) -> tuple[list[MemoryRecordSummaryTypeDef], list[MemoryRecordSummaryTypeDef]]:
    return _with_saves(preferences, saves), _newest_first(_with_saves(facts, saves))


def _saves_session_id(at: datetime) -> str:
    # One session per window, so a read lists two short sessions.
    return f'memory-saves-{int(at.timestamp() // MEMORY_SAVE_WINDOW.total_seconds())}'


def _save_session_ids(now: datetime) -> tuple[str, str]:
    return _saves_session_id(now - MEMORY_SAVE_WINDOW), _saves_session_id(now)


def _recent_saves(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str) -> dict[str, str | None]:
    """The actor's Memory saves of the last five minutes: each record's latest text, or None once deleted."""
    now = utc_now()
    return _saves_from_events(
        _session_events(client, memory_id=memory_id, actor_id=actor_id, session_ids=_save_session_ids(now)), now,
    )


def _session_events(
    client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str, session_ids: Sequence[str],
) -> list[EventTypeDef]:
    """Every event of the actor's sessions; a session never written to has none."""
    events: list[EventTypeDef] = []
    for session_id in session_ids:
        kwargs: dict[str, Any] = {
            'memoryId': memory_id, 'actorId': actor_id, 'sessionId': session_id, 'includePayloads': True, 'maxResults': 100,
        }
        while True:
            response = client.list_events(**kwargs)
            events += response['events']
            if 'nextToken' not in response:
                break
            kwargs['nextToken'] = response['nextToken']
    return events


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
    return extract_text(record['content']['text'])


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
