from __future__ import annotations

import base64
import hashlib
import json
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from langgraph_checkpoint_aws.checkpoint.agentcore.constants import EventDecodingError
from langgraph_checkpoint_aws.checkpoint.agentcore.helpers import (
    EventReadResult,
    EventSerializer,
    EventType,
)
from langgraph_checkpoint_aws.checkpoint.agentcore.models import CheckpointEvent
from langgraph_checkpoint_aws.checkpoint.agentcore.snapshot import (
    AgentCoreSnapshotClient,
)
from pydantic import BaseModel, Field

_BLOB_BYTES = 90_000
_FRAGMENT_BYTES = 64_000


class _Reference(BaseModel):
    event_type: Literal['botcube_fragmented'] = 'botcube_fragmented'
    event_ids: list[str] = Field(min_length=1)
    sha256: str


@dataclass(frozen=True)
class _WriteScope:
    session_id: str
    actor_id: str
    checkpoint: CheckpointEvent
    referenced_blobs: dict[str, str] = field(default_factory=dict)


class FragmentedSnapshotClient(AgentCoreSnapshotClient):
    def __init__(self, memory_id: str, serializer: EventSerializer, client: Any, *, fragment: bool = False) -> None:
        self.memory_id = memory_id
        self.serializer = serializer
        self.client = client
        self._fragment = fragment
        self._scope: ContextVar[_WriteScope] = ContextVar('checkpoint_fragment_scope')

    def store_snapshot(self, events: list[EventType], session_id: str, actor_id: str) -> None:
        checkpoint = next(event for event in events if isinstance(event, CheckpointEvent))
        token = self._scope.set(_WriteScope(session_id, actor_id, checkpoint))
        try:
            super().store_snapshot(events, session_id, actor_id)
        finally:
            self._scope.reset(token)

    def store_blob_event(self, event: EventType, session_id: str, actor_id: str) -> None:
        serialized = self.serializer.serialize_event(event)
        checkpoint = CheckpointEvent(
            checkpoint_id=hashlib.sha256(serialized.encode()).hexdigest(),
            checkpoint_data={'ts': datetime.now(UTC).isoformat()}, metadata={}, thread_id=session_id,
        )
        token = self._scope.set(_WriteScope(session_id, actor_id, checkpoint))
        try:
            blob = self._fragment_blob(serialized)
            self.client.create_event(
                memoryId=self.memory_id, sessionId=session_id, actorId=actor_id,
                eventTimestamp=datetime.now(UTC), payload=[{'blob': blob}],
            )
        finally:
            self._scope.reset(token)

    def _blob_payload(self, event: EventType) -> str:
        return json.dumps({'blob': self._fragment_blob(self.serializer.serialize_event(event))})

    def _fragment_blob(self, blob: str) -> str:
        data = blob.encode()
        if not self._fragment or len(data) <= _BLOB_BYTES:
            return blob
        scope = self._scope.get()
        fragments = [
            json.dumps({'blob': base64.b64encode(data[index:index + _FRAGMENT_BYTES]).decode('ascii')})
            for index in range(0, len(data), _FRAGMENT_BYTES)
        ]
        event_ids: list[str] = []
        for payload in self._chunk_payload(fragments, 100, 9_000_000):
            response = self._create_snapshot_event(
                payload, scope.session_id, scope.actor_id, scope.checkpoint, 'blob_fragment', offset_ms=1000,
            )
            event_ids.append(response['event']['eventId'])
        reference = _Reference(event_ids=event_ids, sha256=hashlib.sha256(data).hexdigest()).model_dump_json()
        if len(reference.encode()) > _BLOB_BYTES:
            raise ValueError('The checkpoint fragment reference exceeds the AgentCore message size limit')
        scope.referenced_blobs[reference] = blob
        return reference

    def read_events(
        self, session_id: str, actor_id: str, limit: int | None = None, max_results: int | None = 100,
    ) -> EventReadResult:
        if (limit is not None and limit <= 0) or (max_results is not None and max_results <= 0):
            return EventReadResult([])
        params: dict[str, Any] = {
            'memoryId': self.memory_id, 'actorId': actor_id, 'sessionId': session_id, 'includePayloads': True,
        }
        if max_results is not None:
            params['maxResults'] = max_results
        events: list[EventType] = []
        while True:
            response = self.client.list_events(**params)
            raw_events = response.get('events', [])
            for index, raw_event in enumerate(raw_events):
                events.extend(self._decode_payload(raw_event))
                if limit is not None and len(events) >= limit:
                    truncated = len(events) > limit or index + 1 < len(raw_events) or bool(response.get('nextToken'))
                    return EventReadResult(events[:limit], truncated=truncated)
            if not response.get('nextToken'):
                return EventReadResult(events)
            params['nextToken'] = response['nextToken']

    def _decode_payload(self, event: dict[str, Any]) -> list[EventType]:
        if event.get('metadata', {}).get('lc_kind', {}).get('stringValue') == 'blob_fragment':
            return []
        return [self._decode_blob(item['blob'], event) for item in event.get('payload', []) if 'blob' in item]

    def _decode_blob(self, blob: str, event: dict[str, Any]) -> EventType:
        decoded = json.loads(blob)
        if not isinstance(decoded, dict) or decoded.get('event_type') != 'botcube_fragmented':
            return self.serializer.deserialize_event(blob)
        reference = _Reference.model_validate(decoded)
        parts: list[bytes] = []
        for event_id in reference.event_ids:
            fragment = self.client.get_event(
                memoryId=self.memory_id, sessionId=event['sessionId'], actorId=event['actorId'], eventId=event_id,
            )['event']
            if fragment.get('metadata', {}).get('lc_kind', {}).get('stringValue') != 'blob_fragment':
                raise EventDecodingError('Checkpoint reference does not identify a blob fragment')
            parts.extend(base64.b64decode(item['blob'], validate=True) for item in fragment['payload'])
        data = b''.join(parts)
        if hashlib.sha256(data).hexdigest() != reference.sha256:
            raise EventDecodingError('Checkpoint blob fragment checksum mismatch')
        return self.serializer.deserialize_event(data.decode())
