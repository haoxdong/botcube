from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from ._env import positive_int

PENDING_MEMORY_SESSION_PREFIX = 'pending-memory-'
PENDING_MEMORY_WINDOW = timedelta(seconds=positive_int('BOTCUBE_PENDING_MEMORY_WINDOW_SECONDS', 900))


def utc_now() -> datetime:
    return datetime.now(UTC)


def pending_memory_session_id(now: datetime | None = None) -> str:
    """The actor's Pending Memory session of *now*'s UTC day."""
    return (now or utc_now()).strftime(f'{PENDING_MEMORY_SESSION_PREFIX}%Y%m%d')


def pending_memory_session_ids(now: datetime) -> list[str]:
    """The sessions a save within the window of *now* (a UTC time) may be in."""
    session_ids = [pending_memory_session_id(now), pending_memory_session_id(now - timedelta(days=1))]
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
