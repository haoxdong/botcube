"""Purge a Session and its pending writes one event at a time.

AgentCore allows 5 DeleteEvent calls per actor and Session per second.
Empty writes sessions before deleting checkpoints so a retry still finds
their IDs (ADR 0067 decision 9). A damaged snapshot requires a prefix scan.
"""

from __future__ import annotations

import logging
from threading import Lock
from time import monotonic, sleep
from typing import Any

from langgraph_checkpoint_aws.checkpoint.agentcore.constants import EventDecodingError
from langgraph_checkpoint_aws.checkpoint.agentcore.models import CheckpointEvent
from langgraph_checkpoint_aws.checkpoint.agentcore.snapshot import (
    _writes_session_prefix,
    writes_session_id,
)

log = logging.getLogger(__name__)
# Lambda's root logger defaults to WARNING; each page's progress line must reach CloudWatch, where the
# account-deletion stalled alarm counts it.
log.setLevel(logging.INFO)

_DELETE_INTERVAL_SECONDS = 1 / 5
_pace_lock = Lock()
_next_delete_at = 0.0


def purge_session(saver: Any, actor_id: str, session_id: str) -> None:
    """Delete every event of the Session and its writes sessions under the filing ID. Purging a purged Session is a no-op."""
    events = saver.checkpoint_event_client
    for writes_session in _writes_sessions(events, actor_id, session_id):
        _purge(events, actor_id, writes_session)
    _purge(events, actor_id, session_id)


def _writes_sessions(events: Any, actor_id: str, session_id: str) -> list[str]:
    try:
        read = events.read_events(session_id, actor_id)
    except (EventDecodingError, events.client.exceptions.ResourceNotFoundException):
        # A missing or corrupt fragment hides the checkpoint IDs; the writes prefix still finds every writes session.
        log.warning('Session snapshot does not decode; listing its writes sessions by prefix. session_id=%s', session_id)
        return _listed_writes_sessions(events, actor_id, session_id)
    # Subgraphs run without the saver, so every checkpoint is in the root namespace.
    checkpoints = {event.checkpoint_id for event in read.events if isinstance(event, CheckpointEvent)}
    return [writes_session_id(session_id, checkpoint) for checkpoint in sorted(checkpoints)]


def _listed_writes_sessions(events: Any, actor_id: str, session_id: str) -> list[str]:
    prefix = _writes_session_prefix(session_id)
    params: dict[str, Any] = {'memoryId': events.memory_id, 'actorId': actor_id, 'maxResults': 100}
    sessions: list[str] = []
    while True:
        try:
            page = events.client.list_sessions(**params)
        except events.client.exceptions.ResourceNotFoundException as error:
            # AgentCore answers an actor that never wrote an event as not found: it has no sessions.
            if f'Actor {actor_id} not found' not in str(error):
                raise
            return sessions
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
        deleted = 0
        for event in page:
            event_id = event['eventId']
            _pace()
            try:
                events.client.delete_event(
                    memoryId=events.memory_id,
                    actorId=actor_id,
                    sessionId=session_id,
                    eventId=event_id,
                )
            except events.client.exceptions.ResourceNotFoundException as error:
                if error.response.get('Error', {}).get('Message') != f'Event not found with id: {event_id}':
                    raise
                continue
            deleted += 1
        if deleted:
            log.info('Session purge deleted %d events. session_id=%s', deleted, session_id)


def _pace() -> None:
    global _next_delete_at
    with _pace_lock:
        sleep(max(0.0, _next_delete_at - monotonic()))
        _next_delete_at = max(_next_delete_at, monotonic()) + _DELETE_INTERVAL_SECONDS
