"""Purge a Session's events from AgentCore Memory.

AgentCore has no delete-by-session call: a Session is purged one ``DeleteEvent``
at a time. ``DeleteEvent`` allows 5 TPS per actor and Session and 20 TPS per
account, so every delete in this process is paced to 5 TPS, within both.
"""

from __future__ import annotations

from threading import Lock
from time import monotonic, sleep
from typing import Any

_DELETE_INTERVAL_SECONDS = 1 / 5
_pace_lock = Lock()
_next_delete_at = 0.0


def purge_session(saver: Any, actor_id: str, session_id: str) -> None:
    """Delete every event filed under (actor, Session). Purging a purged Session is a no-op."""
    events = saver.checkpoint_event_client
    while True:
        # Always re-list the first page: deleting events invalidates a nextToken.
        page = events.client.list_events(
            memoryId=events.memory_id,
            actorId=actor_id,
            sessionId=session_id,
            maxResults=100,
            includePayloads=False,
        )['events']
        if not page:
            return
        for event in page:
            _pace()
            events.client.delete_event(
                memoryId=events.memory_id,
                actorId=actor_id,
                sessionId=session_id,
                eventId=event['eventId'],
            )


def _pace() -> None:
    global _next_delete_at
    with _pace_lock:
        sleep(max(0.0, _next_delete_at - monotonic()))
        _next_delete_at = max(_next_delete_at, monotonic()) + _DELETE_INTERVAL_SECONDS
