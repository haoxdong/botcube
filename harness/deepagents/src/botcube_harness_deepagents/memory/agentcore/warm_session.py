"""Write-through Session snapshots kept in a bounded microVM cache.

Generic reads confirm Memory's latest checkpoint and pending writes. A registered
Chat writer can consume a snapshot written by this process's successful finished
run under the Session lock, at the same writer epoch and invoking actor. Every
mutation revokes eligibility before writing; uncertain writes never promote.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextvars import ContextVar, copy_context
from dataclasses import dataclass
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph_checkpoint_aws import AgentCoreMemorySaver
from langgraph_checkpoint_aws.checkpoint.agentcore.helpers import (
    BedrockAgentCoreClientWithRetry,
    EventSerializer,
    EventType,
)
from langgraph_checkpoint_aws.checkpoint.agentcore.models import (
    CheckpointerConfig,
    CheckpointEvent,
    WriteItem,
    WritesEvent,
)
from langgraph_checkpoint_aws.checkpoint.agentcore.snapshot import (
    SNAPSHOT_LAYOUT,
    AgentCoreSnapshotClient,
)
from langgraph_checkpoint_aws.checkpoint.deferred_saver import PendingWrite

from ... import turn_timing

__all__ = ['WarmSessionSaver']

# The Sessions one microVM keeps warm: a Runtime session serves one member's few chats.
WARM_SESSIONS = 16

# The ListEvents page that finds a Session's newest checkpoint. The filter applies within a page, and every
# snapshot comes back in it: on a 742-event Session, a page of 100 cost ~800 ms without payloads and 67 MB with
# them, against ~200 ms and 2.5 MB for 5, while the newest checkpoint sits among the newest few events.
CHECKPOINT_PAGE = 5

# (memory ID, filing actor, AgentCore session ID): where a Session's checkpoints live.
_Key = tuple[str, str, str]


@dataclass(frozen=True)
class _Snapshot:
    """A Session's latest snapshot as this process last wrote or loaded it."""

    checkpoint_id: str
    events: tuple[str, ...]


@dataclass(frozen=True)
class _Finished:
    version: int
    actor_id: str
    epoch: str
    run_id: str
    snapshot: _Snapshot
    writes: str | None


class _WarmSessions:
    """The held snapshots, and each Session's version: every write, keep or load bumps it."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._lock = threading.Lock()
        self._snapshots: OrderedDict[_Key, _Snapshot] = OrderedDict()
        # Never evicted, so a version never repeats: one int per Session this process wrote or loaded.
        self._versions: dict[_Key, int] = {}
        self._finished: dict[_Key, _Finished] = {}

    def finished(self, key: _Key, actor_id: str, epoch: str) -> _Finished | None:
        with self._lock:
            held = self._finished.get(key)
            if (held is not None and held.actor_id == actor_id and held.epoch == epoch
                    and held.version == self._versions.get(key) and key in self._snapshots):
                self._snapshots.move_to_end(key)
                return held
            self._finished.pop(key, None)
            return None

    def promote(self, key: _Key, finished: _Finished) -> None:
        with self._lock:
            if finished.version == self._versions.get(key) and self._snapshots.get(key) == finished.snapshot:
                self._finished[key] = finished

    def revoke(self, key: _Key) -> None:
        with self._lock:
            self._finished.pop(key, None)

    def get(self, key: _Key) -> tuple[_Snapshot | None, int]:
        with self._lock:
            snapshot = self._snapshots.get(key)
            if snapshot is not None:
                self._snapshots.move_to_end(key)
            return snapshot, self._versions.get(key, 0)

    def keep(self, key: _Key, snapshot: _Snapshot) -> int:
        with self._lock:
            self._hold(key, snapshot)
            return self._bump(key)

    def replace(self, key: _Key, version: int, snapshot: _Snapshot | None) -> int | None:
        """Hold what a load found, unless the Session changed since `version`; the new version, if held."""
        with self._lock:
            if self._versions.get(key, 0) != version:
                return None
            if snapshot is None:
                self._snapshots.pop(key, None)
            else:
                self._hold(key, snapshot)
            return self._bump(key)

    def touch(self, key: _Key) -> None:
        """Mark the Session changed, so every Turn's confirmation of it lapses."""
        with self._lock:
            self._bump(key)

    def _hold(self, key: _Key, snapshot: _Snapshot) -> None:
        self._snapshots[key] = snapshot
        self._snapshots.move_to_end(key)
        while len(self._snapshots) > self._capacity:
            evicted, _ = self._snapshots.popitem(last=False)
            self._finished.pop(evicted, None)

    def _bump(self, key: _Key) -> int:
        self._finished.pop(key, None)
        version = self._versions[key] = self._versions.get(key, 0) + 1
        return version


_SESSIONS = _WarmSessions(WARM_SESSIONS)


@dataclass(frozen=True)
class _Confirmed:
    """What Memory confirmed for this Turn at a Session version: the snapshot (None: no checkpoint) and its pending writes."""

    version: int
    snapshot: _Snapshot | None
    writes: str | None


class _WarmSnapshotClient(AgentCoreSnapshotClient):
    """The stock snapshot client on the Turn's Memory client, holding each snapshot it stores."""

    def __init__(self, memory_id: str, serializer: EventSerializer, client: Any) -> None:
        # The Turn's client is already built with its credentials: no second boto3 client.
        self.memory_id = memory_id
        self.serializer = serializer
        self.client = BedrockAgentCoreClientWithRetry(client)
        self.kept: tuple[_Snapshot, int] | None = None
        self._stored_events: ContextVar[list[str] | None] = ContextVar('stored_snapshot_events', default=None)

    def store_snapshot(self, events: list[EventType], session_id: str, actor_id: str) -> None:
        stored: list[str] = []
        token = self._stored_events.set(stored)
        try:
            super().store_snapshot(events, session_id, actor_id)
            [checkpoint] = [event for event in events if isinstance(event, CheckpointEvent)]
            snapshot = _Snapshot(checkpoint.checkpoint_id, tuple(stored))
            self.kept = (snapshot, _SESSIONS.keep((self.memory_id, actor_id, session_id), snapshot))
        finally:
            self._stored_events.reset(token)

    def _create_snapshot_event(
        self, payload: list[str], session_id: str, actor_id: str, checkpoint: CheckpointEvent,
        kind: str, *, offset_ms: int = 0,
    ) -> dict[str, Any]:
        response = super()._create_snapshot_event(
            payload, session_id, actor_id, checkpoint, kind, offset_ms=offset_ms,
        )
        if (stored := self._stored_events.get()) is not None:
            stored.extend(json.loads(item)['blob'] for item in payload)
        return response


def _checkpoint_key(checkpoint_id: str) -> str:
    """A checkpoint ID as snapshot metadata records it."""
    return hashlib.sha256(checkpoint_id.encode()).hexdigest()


class WarmSessionSaver(AgentCoreMemorySaver):
    """One Turn's snapshot saver (ADR 0067 decision 9), on the Turn's Memory client. Build one per Turn."""

    def __init__(self, memory_id: str, client: Any, *, region_name: str) -> None:
        super().__init__(memory_id, checkpoint_format='snapshot', limit=None, region_name=region_name)
        self.checkpoint_event_client = _WarmSnapshotClient(memory_id, self.serializer, client)
        self._confirmed: dict[_Key, _Confirmed] = {}
        self._admission: tuple[_Key, str, str, str] | None = None
        self._written: tuple[_Key, _Confirmed] | None = None

    def admit_finished_reuse(self, config: RunnableConfig, actor_id: str, run_id: str, epoch: str | None) -> None:
        """Called only under the Session lock with Chat's registered writer epoch."""
        key = self._key(CheckpointerConfig.from_runnable_config(dict(config)))
        self._admission = None
        self._written = None
        self._confirmed.pop(key, None)
        if not epoch:
            _SESSIONS.revoke(key)
            return
        self._admission = (key, actor_id, run_id, epoch)
        held = _SESSIONS.finished(key, actor_id, epoch)
        _SESSIONS.revoke(key)
        if held is not None:
            self._confirmed[key] = _Confirmed(held.version, held.snapshot, held.writes)

    def finish_run(self) -> None:
        """Promote only after graph settlement and successful Files publication under the Session lock."""
        if self._admission is None or self._written is None:
            return
        key, actor_id, run_id, epoch = self._admission
        written_key, confirmed = self._written
        if written_key == key and confirmed.snapshot is not None:
            _SESSIONS.promote(key, _Finished(
                confirmed.version, actor_id, epoch, run_id, confirmed.snapshot, confirmed.writes,
            ))

    def abandon_run(self) -> None:
        if self._admission is not None:
            _SESSIONS.revoke(self._admission[0])
        self._written = None

    def _key(self, config: CheckpointerConfig) -> _Key:
        return (self.memory_id, config.actor_id, config.session_id)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        checkpoint_config = CheckpointerConfig.from_runnable_config(dict(config))
        if checkpoint_config.checkpoint_id is not None:
            return super().get_tuple(config)
        key = self._key(checkpoint_config)
        held, version = _SESSIONS.get(key)
        confirmed = self._confirmed.get(key)
        if confirmed is None or confirmed.version != version:
            if held is None:
                return self._load(config, checkpoint_config, key, version)
            head, writes = self._head_and_writes(checkpoint_config, held.checkpoint_id)
            if head != _checkpoint_key(held.checkpoint_id):
                return self._load(config, checkpoint_config, key, version)
            confirmed = self._confirmed[key] = _Confirmed(
                version, held, self._serialized_writes(held.checkpoint_id, writes))
        if confirmed.snapshot is None:
            return None
        events = [self.serializer.deserialize_event(blob) for blob in confirmed.snapshot.events]
        if confirmed.writes is not None:
            events.append(self.serializer.deserialize_event(confirmed.writes))
        return self._tuple(checkpoint_config, confirmed.snapshot.checkpoint_id, events)

    def _head_and_writes(self, config: CheckpointerConfig, checkpoint_id: str) -> tuple[str | None, list[WriteItem]]:
        """Memory's newest checkpoint key for the Session, and the held checkpoint's pending writes, read together.

        Fail-fast: the first failure propagates at once, leaving its sibling to finish on its own.
        """
        pool = ThreadPoolExecutor(max_workers=2)
        try:
            head = pool.submit(copy_context().run, self._head, config)
            writes = pool.submit(
                copy_context().run, self.checkpoint_event_client.get_pending_writes,
                config.thread_id, config.actor_id, checkpoint_id, self.max_results, checkpoint_ns=config.checkpoint_ns,
            )
            for read in as_completed((head, writes)):
                read.result()
            return head.result(), writes.result()
        finally:
            pool.shutdown(wait=False)

    def _head(self, config: CheckpointerConfig) -> str | None:
        """The newest snapshot checkpoint's key, read as the stock saver finds it, without payloads."""
        params: dict[str, Any] = {
            'memoryId': self.memory_id, 'actorId': config.actor_id, 'sessionId': config.session_id,
            'includePayloads': False, 'maxResults': CHECKPOINT_PAGE,
            'filter': {'eventMetadata': [{
                'left': {'metadataKey': 'lc_kind'}, 'operator': 'EQUALS_TO',
                'right': {'metadataValue': {'stringValue': 'checkpoint'}},
            }]},
        }
        while True:
            response = self.checkpoint_event_client.client.list_events(**params)
            for event in response.get('events', []):
                metadata = event.get('metadata', {})
                if (metadata.get('lc_layout', {}).get('stringValue') == SNAPSHOT_LAYOUT
                        and metadata.get('lc_kind', {}).get('stringValue') == 'checkpoint'):
                    return metadata['lc_checkpoint_id']['stringValue']
            if not response.get('nextToken'):
                return None
            params['nextToken'] = response['nextToken']

    def _load(
        self, config: RunnableConfig, checkpoint_config: CheckpointerConfig, key: _Key, version: int,
    ) -> CheckpointTuple | None:
        """Load the Session's latest snapshot in full, and hold it unless the Session changed since `version`."""
        self._confirmed.pop(key, None)
        events = self.checkpoint_event_client.get_snapshot(
            checkpoint_config.session_id, checkpoint_config.actor_id, None, CHECKPOINT_PAGE,
        )
        if events is None:
            # The legacy layout: the stock saver's walk, never held.
            _SESSIONS.replace(key, version, None)
            return super().get_tuple(config)
        checkpoints = [event for event in events if isinstance(event, CheckpointEvent)]
        if not checkpoints:
            if (loaded := _SESSIONS.replace(key, version, None)) is not None:
                self._confirmed[key] = _Confirmed(loaded, None, None)
            return None
        [checkpoint] = checkpoints
        writes = self.checkpoint_event_client.get_pending_writes(
            checkpoint_config.thread_id, checkpoint_config.actor_id, checkpoint.checkpoint_id, self.max_results,
            checkpoint_ns=checkpoint_config.checkpoint_ns,
        )
        snapshot = _Snapshot(checkpoint.checkpoint_id, tuple(self.serializer.serialize_event(event) for event in events))
        if (loaded := _SESSIONS.replace(key, version, snapshot)) is not None:
            self._confirmed[key] = _Confirmed(loaded, snapshot, self._serialized_writes(checkpoint.checkpoint_id, writes))
        return self._tuple(checkpoint_config, checkpoint.checkpoint_id,
                           [*events, WritesEvent(checkpoint_id=checkpoint.checkpoint_id, writes=writes)])

    def _serialized_writes(self, checkpoint_id: str, writes: list[WriteItem]) -> str | None:
        return self.serializer.serialize_event(WritesEvent(checkpoint_id=checkpoint_id, writes=writes)) if writes else None

    def _tuple(self, config: CheckpointerConfig, checkpoint_id: str, events: list[EventType]) -> CheckpointTuple:
        checkpoints, writes, channel_data = self.processor.process_events(events)
        return self.processor.build_checkpoint_tuple(checkpoints[checkpoint_id], writes[checkpoint_id], channel_data, config)

    def put_with_writes(
        self, config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata,
        new_versions: ChannelVersions, pending_writes: Sequence[PendingWrite],
    ) -> RunnableConfig:
        key = self._key(CheckpointerConfig.from_runnable_config(dict(config)))
        _SESSIONS.touch(key)
        self._written = None
        self._confirmed.pop(key, None)
        self.checkpoint_event_client.kept = None
        try:
            with turn_timing.phase('checkpoint_write'):
                stored = super().put_with_writes(config, checkpoint, metadata, new_versions, pending_writes)
        except BaseException:
            # Memory may hold the checkpoint or not: lapse every Turn's confirmation, even one made mid-write.
            _SESSIONS.touch(key)
            raise
        kept = self.checkpoint_event_client.kept
        if kept is not None and _SESSIONS.get(key) == kept:
            # Unchanged since this write: its pending writes are in the snapshot, none filed under it yet.
            self._confirmed[key] = confirmed = _Confirmed(kept[1], kept[0], None)
            self._written = (key, confirmed)
        return stored

    def put_writes(self, config: RunnableConfig, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = '') -> None:
        self._written = None
        _SESSIONS.touch(self._key(CheckpointerConfig.from_runnable_config(dict(config))))
        try:
            with turn_timing.phase('checkpoint_write'):
                super().put_writes(config, writes, task_id, task_path)
        finally:
            _SESSIONS.touch(self._key(CheckpointerConfig.from_runnable_config(dict(config))))
