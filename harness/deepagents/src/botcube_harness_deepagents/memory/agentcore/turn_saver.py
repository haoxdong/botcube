"""Upstream `DeferredCheckpointSaver` keeps only
the last checkpoint of the buffer, so the persisted checkpoint's parent never
reaches the record and a DeltaChannel read stops at the missing parent: a
replay returned only part of the Session. This saver keeps every checkpoint
and persists them all, with their writes, in one batch per Session.
"""

from __future__ import annotations

import contextlib
import threading
from collections import defaultdict
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from langchain_core.runnables import RunnableConfig, run_in_executor
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
    get_checkpoint_id,
    get_checkpoint_metadata,
)

from .one_pass_saver import OnePassAgentCoreMemorySaver
from .session_record import (
    _Checkpoint,
    _configurable,
    _events_by_session,
    _session_key,
    _Writes,
)

if TYPE_CHECKING:
    from langgraph.checkpoint.base import DeltaChannelHistory

    from ...messages_snapshot import MessagesSnapshot


def _latest_key(config: RunnableConfig) -> tuple[str, str, str]:
    configurable = _configurable(config)
    return configurable['actor_id'], configurable['thread_id'], configurable.get('checkpoint_ns', '')


class TurnCheckpointSaver(BaseCheckpointSaver[str]):
    """Publishes a new Session's question, then buffers its Turn until `aflush`.

    Each Session retains its flushed Turn and the ancestors needed to seed its
    DeltaChannels, so warm Turns do not re-read that history from AgentCore Memory.
    """

    def __init__(self, saver: OnePassAgentCoreMemorySaver) -> None:
        super().__init__()
        self._saver = saver
        self._lock = threading.Lock()
        self._flush_lock = threading.Lock()
        # Readable checkpoints (unflushed plus the last flushed Turn) and their writes.
        self._checkpoints: dict[str, _Checkpoint] = {}
        self._writes: dict[str, list[_Writes]] = defaultdict(list)
        self._latest: dict[tuple[str, str, str], str] = {}
        self._delta_channels: dict[tuple[str, str, str], set[str]] = defaultdict(set)
        # What the next flush persists, in the order LangGraph produced it.
        self._unflushed_checkpoints: list[str] = []
        self._unflushed_writes: list[_Writes] = []

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        result: RunnableConfig = {'configurable': {**_configurable(config), 'checkpoint_id': checkpoint['id']}}
        with self._lock:
            self._checkpoints[checkpoint['id']] = _Checkpoint(config, checkpoint, metadata, new_versions)
            self._unflushed_checkpoints.append(checkpoint['id'])
            self._latest[_latest_key(config)] = checkpoint['id']
        return result

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        result = self.put(config, checkpoint, metadata, new_versions)
        if not _configurable(config).get('checkpoint_ns') and metadata.get('source') == 'loop' and metadata.get('step') == 0:
            await run_in_executor(None, self._publish_initial, _session_key(config))
        return result

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = '',
    ) -> None:
        entry = _Writes(config, list(writes), task_id, task_path)
        with self._lock:
            self._writes[_configurable(config)['checkpoint_id']].append(entry)
            self._unflushed_writes.append(entry)

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = '',
    ) -> None:
        self.put_writes(config, writes, task_id, task_path)

    def _tuple(self, checkpoint_id: str) -> CheckpointTuple:
        """Must be called with the lock held."""
        entry = self._checkpoints[checkpoint_id]
        configurable = _configurable(entry.config)
        parent_id = configurable.get('checkpoint_id')
        return CheckpointTuple(
            config={'configurable': {**configurable, 'checkpoint_id': checkpoint_id}},
            checkpoint=entry.checkpoint,
            metadata=get_checkpoint_metadata(entry.config, entry.metadata),
            parent_config=(
                {'configurable': {**configurable, 'checkpoint_id': parent_id}} if parent_id else None
            ),
            pending_writes=[
                (writes.task_id, channel, value)
                for writes in self._writes.get(checkpoint_id, [])
                for channel, value in writes.writes
            ],
        )

    def _buffered_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        with self._lock:
            checkpoint_id = get_checkpoint_id(config) or self._latest.get(_latest_key(config))
            if checkpoint_id not in self._checkpoints:
                return None
            return self._tuple(checkpoint_id)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return self._buffered_tuple(config) or self._saver.get_tuple(config)

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return self._buffered_tuple(config) or await self._saver.aget_tuple(config)

    def get_delta_channel_history(
        self, *, config: RunnableConfig, channels: Sequence[str]
    ) -> Mapping[str, DeltaChannelHistory]:
        """Walk the buffered checkpoints first, then the record in one pass (langchain-aws#1237)."""
        if not channels:
            return {}
        with self._lock:
            self._delta_channels[_latest_key(config)].update(channels)
            buffered = {checkpoint_id: self._tuple(checkpoint_id) for checkpoint_id in self._checkpoints}
        target = self.get_tuple(config)
        persisted: dict[str, CheckpointTuple] = {}
        result = self._saver.delta_channel_history(
            config=config, channels=channels, target=target, known=buffered, persisted=persisted
        )
        self._retain_history(target, channels, {**persisted, **buffered})
        return result

    def _retain_history(
        self, target: CheckpointTuple | None, channels: Sequence[str], known: Mapping[str, CheckpointTuple],
    ) -> None:
        remaining = set(channels)
        ancestor = target
        with self._lock:
            while ancestor is not None:
                checkpoint_id = ancestor.checkpoint['id']
                if checkpoint_id not in self._checkpoints:
                    parent = ancestor.parent_config or {'configurable': {
                        key: value for key, value in _configurable(ancestor.config).items() if key != 'checkpoint_id'
                    }}
                    self._checkpoints[checkpoint_id] = _Checkpoint(parent, ancestor.checkpoint, ancestor.metadata, {})
                    self._writes[checkpoint_id] = [
                        _Writes(ancestor.config, [(channel, value)], task_id, '')
                        for task_id, channel, value in ancestor.pending_writes or []
                    ]
                remaining.difference_update(ancestor.checkpoint['channel_values'])
                if not remaining or ancestor.parent_config is None:
                    break
                parent_id = get_checkpoint_id(ancestor.parent_config)
                ancestor = known.get(parent_id) if parent_id is not None else None

    async def aget_delta_channel_history(
        self, *, config: RunnableConfig, channels: Sequence[str]
    ) -> Mapping[str, DeltaChannelHistory]:
        return await run_in_executor(
            None, self.get_delta_channel_history, config=config, channels=channels
        )

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        """Persisted checkpoints only, as upstream `DeferredCheckpointSaver` lists."""
        yield from self._saver.list(
            config,
            filter=filter,
            before=before,
            limit=limit,
        )

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        async for item in self._saver.alist(
            config,
            filter=filter,
            before=before,
            limit=limit,
        ):
            yield item

    # The record's version scheme; it reads nothing from the saver.
    get_next_version = OnePassAgentCoreMemorySaver.get_next_version

    def flush(self, session: tuple[str, str] | None = None) -> None:
        """Persist every buffered checkpoint and write, one event batch per Session."""
        # A successful overlapping flush must not prune a failed flush's retry data.
        with self._flush_lock:
            self._flush(session)

    def _publish_initial(self, session: tuple[str, str]) -> None:
        with self._flush_lock:
            self._flush(session)

    def _take_unflushed(self, session: tuple[str, str] | None) -> tuple[list[str], list[_Writes]]:
        checkpoint_ids = [checkpoint_id for checkpoint_id in self._unflushed_checkpoints
                          if session is None or _session_key(self._checkpoints[checkpoint_id].config) == session]
        writes = [entry for entry in self._unflushed_writes
                  if session is None or _session_key(entry.config) == session]
        flushed_ids = set(checkpoint_ids)
        self._unflushed_checkpoints = [checkpoint_id for checkpoint_id in self._unflushed_checkpoints
                                      if checkpoint_id not in flushed_ids]
        self._unflushed_writes = [entry for entry in self._unflushed_writes
                                 if session is not None and _session_key(entry.config) != session]
        return checkpoint_ids, writes

    def _flush(self, session: tuple[str, str] | None = None) -> None:
        with self._lock:
            checkpoint_ids, writes = self._take_unflushed(session)
            checkpoints = [self._checkpoints[checkpoint_id] for checkpoint_id in checkpoint_ids]
        try:
            for (actor_id, session_id), events in _events_by_session(checkpoints, writes).items():
                self._saver.checkpoint_event_client.store_blob_events_batch(events, session_id, actor_id)
        except Exception:
            with self._lock:
                self._unflushed_checkpoints = checkpoint_ids + self._unflushed_checkpoints
                self._unflushed_writes = writes + self._unflushed_writes
            raise
        with self._lock:
            flushed_sessions = {_session_key(entry.config) for entry in checkpoints}
            keep = set(checkpoint_ids) | set(self._unflushed_checkpoints) | {
                checkpoint_id for checkpoint_id, entry in self._checkpoints.items()
                if _session_key(entry.config) not in flushed_sessions
            }
            keep |= _turn_checkpoint_ids(self._checkpoints, checkpoint_ids, self._delta_channels)
            self._checkpoints = {k: v for k, v in self._checkpoints.items() if k in keep}
            self._writes = defaultdict(list, {k: v for k, v in self._writes.items() if k in keep})
            self._latest = {k: v for k, v in self._latest.items() if v in keep}

    async def aflush(self, session: tuple[str, str] | None = None) -> None:
        await run_in_executor(None, self.flush, session)

    # The snapshot is written once a Turn's checkpoints are flushed: it passes straight to the record.
    async def aread_messages_snapshot(self, user_id: str, session_id: str) -> MessagesSnapshot | None:
        return await self._saver.aread_messages_snapshot(user_id, session_id)

    async def awrite_messages_snapshot(self, user_id: str, session_id: str, snapshot: MessagesSnapshot) -> None:
        await self._saver.awrite_messages_snapshot(user_id, session_id, snapshot)

    @contextlib.asynccontextmanager
    async def aflush_on_exit(self) -> AsyncIterator[TurnCheckpointSaver]:
        try:
            yield self
        finally:
            await self.aflush()


def _turn_checkpoint_ids(
    checkpoints: Mapping[str, _Checkpoint], checkpoint_ids: Sequence[str],
    delta_channels: Mapping[tuple[str, str, str], set[str]],
) -> set[str]:
    retained: set[str] = set()
    for checkpoint_id in checkpoint_ids:
        channels = delta_channels.get(_latest_key(checkpoints[checkpoint_id].config), set())
        remaining = set(channels)
        ancestor: str | None = checkpoint_id
        while ancestor is not None and ancestor in checkpoints and ancestor not in retained:
            retained.add(ancestor)
            entry = checkpoints[ancestor]
            remaining.difference_update(entry.checkpoint['channel_values'])
            if not remaining and (channels or entry.metadata.get('source') == 'input'):
                break
            ancestor = _configurable(entry.config).get('checkpoint_id')
    return retained
