from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from ._env import positive_int
from .actor_identity import ANONYMOUS_ACTOR_ID

AGENTCORE_SESSION_ID_MAX_LENGTH = 100
PENDING_MEMORY_SESSION_PREFIX = 'pending-memory-'
PENDING_MEMORY_WINDOW = timedelta(seconds=positive_int('BOTCUBE_PENDING_MEMORY_WINDOW_SECONDS', 900))
THREAD_HASH_LENGTH = 12
_AGENTCORE_SESSION_ID_INVALID_RE = re.compile(r'[^a-z0-9_-]+')
_AGENTCORE_SESSION_ID_SEPARATOR_RE = re.compile(r'[_-]+')
# The characters a sanitized suffix may begin or end with that it must not.
_AGENTCORE_SESSION_ID_EDGE_CHARS = '_-'


def utc_now() -> datetime:
    return datetime.now(UTC)


def pending_memory_session_id(
    now: datetime | None = None,
    *,
    actor_id: str,
    thread_id: str | None,
) -> str:
    """The Pending Memory session of *now*'s UTC day; an anonymous actor's is per thread."""
    base = (now or utc_now()).strftime(f'{PENDING_MEMORY_SESSION_PREFIX}%Y%m%d')
    if actor_id == ANONYMOUS_ACTOR_ID and thread_id:
        suffix = _bounded_anonymous_thread_suffix(
            thread_id,
            max_length=AGENTCORE_SESSION_ID_MAX_LENGTH - len(base) - 1,
        )
        return f'{base}-{suffix}'
    return base


def pending_memory_session_ids(now: datetime, *, actor_id: str, thread_id: str | None) -> list[str]:
    """The sessions a save within the window of *now* (a UTC time) may be in."""
    session_ids = [
        pending_memory_session_id(now, actor_id=actor_id, thread_id=thread_id),
        pending_memory_session_id(now - timedelta(days=1), actor_id=actor_id, thread_id=thread_id),
    ]
    future = now + PENDING_MEMORY_WINDOW
    if future.date() != now.date():
        session_ids.append(pending_memory_session_id(future, actor_id=actor_id, thread_id=thread_id))
    return session_ids


def _bounded_anonymous_thread_suffix(thread_id: str, *, max_length: int) -> str:
    sanitized = _sanitize_agentcore_session_id_suffix(thread_id)
    if len(sanitized) <= max_length and sanitized == thread_id:
        return sanitized
    # A changed or shortened thread id carries the digest of the raw one, so two threads never share a session.
    digest = hashlib.sha256(thread_id.encode()).hexdigest()[:THREAD_HASH_LENGTH]
    # A sanitized id never starts with an edge character, so the prefix is never empty.
    prefix = sanitized[: max_length - len(digest) - 1].rstrip(_AGENTCORE_SESSION_ID_EDGE_CHARS)
    return f'{prefix}-{digest}'


def _sanitize_agentcore_session_id_suffix(value: str) -> str:
    sanitized = _AGENTCORE_SESSION_ID_INVALID_RE.sub('_', value.lower())
    sanitized = _AGENTCORE_SESSION_ID_SEPARATOR_RE.sub('_', sanitized).strip(_AGENTCORE_SESSION_ID_EDGE_CHARS)
    return sanitized or ANONYMOUS_ACTOR_ID


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
