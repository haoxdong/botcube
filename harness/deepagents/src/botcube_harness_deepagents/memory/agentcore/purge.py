"""Purge a Session's events from AgentCore Memory.

AgentCore has no delete-by-session call: a Session is purged one ``DeleteEvent``
at a time. ``DeleteEvent`` allows 5 TPS per actor and Session and 20 TPS per
account, so every delete in this process is paced to 5 TPS, within both.

The checkpointer files each checkpoint's pending writes in its own AgentCore
session, named by the Session ID's writes prefix (ADR 0067 decision 9), so a
purge empties the Session and then each of those. ``ListSessions`` keeps
listing a session once its events are gone, so a session counts as purged when
``ListEvents`` returns none.
"""

from __future__ import annotations

from threading import Lock
from time import monotonic, sleep
from typing import Any

from langgraph_checkpoint_aws.checkpoint.agentcore.snapshot import (
    _writes_session_prefix,
)

_DELETE_INTERVAL_SECONDS = 1 / 5
_pace_lock = Lock()
_next_delete_at = 0.0


def purge_session(saver: Any, actor_id: str, session_id: str) -> None:
    """Delete every event of the Session and its writes sessions under the filing ID. Purging a purged Session is a no-op."""
    events = saver.checkpoint_event_client
    _purge(events, actor_id, session_id)
    for writes_session in _writes_sessions(events, actor_id, session_id):
        _purge(events, actor_id, writes_session)


def _writes_sessions(events: Any, actor_id: str, session_id: str) -> list[str]:
    prefix = _writes_session_prefix(session_id)
    params: dict[str, Any] = {'memoryId': events.memory_id, 'actorId': actor_id, 'maxResults': 100}
    sessions: list[str] = []
    while True:
        page = events.client.list_sessions(**params)
        sessions.extend(item['sessionId'] for item in page['sessionSummaries'] if item['sessionId'].startswith(prefix))
        if not page.get('nextToken'):
            return sessions
        params['nextToken'] = page['nextToken']


def _purge(events: Any, actor_id: str, session_id: str) -> None:
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
