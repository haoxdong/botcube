from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore import BedrockAgentCoreClient


PENDING_MEMORY_SESSION_PREFIX = 'pending-memory-'
PENDING_MEMORY_WINDOW = timedelta(seconds=900)


def utc_now() -> datetime:
    return datetime.now(UTC)


def pending_memory_session_id(now: datetime | None = None) -> str:
    """The actor's Pending Memory session of *now*'s UTC day."""
    return (now or utc_now()).strftime(f'{PENDING_MEMORY_SESSION_PREFIX}%Y%m%d')


def pending_memory_session_ids(now: datetime) -> list[str]:
    """The sessions a save within the window of *now* (a UTC time) may be in."""
    session_ids = [pending_memory_session_id(now)]
    past = now - PENDING_MEMORY_WINDOW
    if past.date() != now.date():
        session_ids.append(pending_memory_session_id(past))
    future = now + PENDING_MEMORY_WINDOW
    if future.date() != now.date():
        session_ids.append(pending_memory_session_id(future))
    return session_ids


def pending_memory_texts(events: Sequence[Mapping[str, Any]], *, now: datetime) -> list[str]:
    """The texts of the Pending Memory saves made within the window of *now*."""
    texts: list[str] = []
    for event in events:
        if abs(event['eventTimestamp'] - now) > PENDING_MEMORY_WINDOW:
            continue
        texts.extend(
            item['conversational']['content']['text'] for item in event['payload'] if 'conversational' in item
        )
    return texts


def record_pending_memory(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str, text: str) -> dict[str, str]:
    """Write the same extraction event for the memory tool and the Memory page."""
    now = utc_now()
    session_id = pending_memory_session_id(now)
    response = client.create_event(
        memoryId=memory_id, actorId=actor_id, sessionId=session_id, eventTimestamp=now,
        payload=[{'conversational': {'content': {'text': text}, 'role': 'USER'}}],
    )
    return {'id': f'pending:{session_id}:{response["event"]["eventId"]}', 'text': text}
