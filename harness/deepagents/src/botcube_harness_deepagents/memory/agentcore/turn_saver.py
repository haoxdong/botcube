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
from typing import TYPE_CHECKING, Any, NamedTuple

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
from langgraph_checkpoint_aws.checkpoint.agentcore.constants import EMPTY_CHANNEL_VALUE
from langgraph_checkpoint_aws.checkpoint.agentcore.helpers import EventType
from langgraph_checkpoint_aws.checkpoint.agentcore.models import (
    ChannelDataEvent,
    CheckpointerConfig,
    CheckpointEvent,
    WriteItem,
    WritesEvent,
)

from .one_pass_saver import OnePassAgentCoreMemorySaver

if TYPE_CHECKING:
    from langgraph.checkpoint.base import DeltaChannelHistory

    from ...messages_snapshot import MessagesSnapshot


class _Checkpoint(NamedTuple):
    config: RunnableConfig
    checkpoint: Checkpoint
    metadata: CheckpointMetadata
    new_versions: ChannelVersions


class _Writes(NamedTuple):
    config: RunnableConfig
    writes: list[tuple[str, Any]]
    task_id: str
    task_path: str


def _session_key(config: RunnableConfig) -> tuple[str, str]:
    checkpoint_config = CheckpointerConfig.from_runnable_config(dict(config))
    return checkpoint_config.actor_id, checkpoint_config.session_id


def _configurable(config: RunnableConfig) -> dict[str, Any]:
    configurable = config.get('configurable')
    if configurable is None:
        raise ValueError('Checkpoint config carries no configurable section')
    return configurable


def _latest_key(config: RunnableConfig) -> tuple[str, str, str]:
    configurable = _configurable(config)
    return configurable['actor_id'], configurable['thread_id'], configurable.get('checkpoint_ns', '')


class TurnCheckpointSaver(BaseCheckpointSaver[str]):
    """Publishes a new Session's question, then buffers its Turn until `aflush`.

    Each Session's last flushed Turn stays readable from memory, so the next Turn starts
    without re-reading it from AgentCore Memory.
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
            buffered = {checkpoint_id: self._tuple(checkpoint_id) for checkpoint_id in self._checkpoints}
        return self._saver.delta_channel_history(
            config=config, channels=channels, target=self.get_tuple(config), known=buffered
        )

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
            # Upstream AgentCoreMemorySaver.list accepts filter but never reads it, so handing on
            # None or dropping the keyword (its default is None) lists the same checkpoints.
            filter=filter,  # pragma: no mutate: list never reads filter
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
            # alist hands filter to list, which never reads it, so handing on None or dropping the
            # keyword (its default is None) lists the same checkpoints.
            filter=filter,  # pragma: no mutate: list never reads filter
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
            keep |= _turn_checkpoint_ids(self._checkpoints, checkpoint_ids)
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


def _turn_checkpoint_ids(checkpoints: Mapping[str, _Checkpoint], checkpoint_ids: Sequence[str]) -> set[str]:
    retained: set[str] = set()
    for checkpoint_id in checkpoint_ids:
        ancestor: str | None = checkpoint_id
        while ancestor is not None and ancestor in checkpoints and ancestor not in retained:
            retained.add(ancestor)
            entry = checkpoints[ancestor]
            if entry.metadata.get('source') == 'input':
                break
            ancestor = _configurable(entry.config).get('checkpoint_id')
    return retained


def _events_by_session(
    checkpoints: Sequence[_Checkpoint], writes: Sequence[_Writes]
) -> dict[tuple[str, str], list[EventType]]:
    """The AgentCore Memory events `AgentCoreMemorySaver.put`/`put_writes` would store."""
    events: dict[tuple[str, str], list[EventType]] = defaultdict(list)
    for entry in checkpoints:
        checkpoint_config = CheckpointerConfig.from_runnable_config(dict(entry.config))
        checkpoint_data: dict[str, Any] = dict(entry.checkpoint)
        channel_values: dict[str, Any] = checkpoint_data.pop('channel_values')
        session_events = events[_session_key(entry.config)]
        session_events.extend(
            ChannelDataEvent(
                channel=channel,
                version=str(version),
                value=channel_values.get(channel, EMPTY_CHANNEL_VALUE),
                thread_id=checkpoint_config.thread_id,
                checkpoint_ns=checkpoint_config.checkpoint_ns,
            )
            for channel, version in entry.new_versions.items()
        )
        session_events.append(
            CheckpointEvent(
                checkpoint_id=entry.checkpoint['id'],
                checkpoint_data=checkpoint_data,
                metadata=dict(get_checkpoint_metadata(entry.config, entry.metadata)),
                parent_checkpoint_id=checkpoint_config.checkpoint_id,
                thread_id=checkpoint_config.thread_id,
                checkpoint_ns=checkpoint_config.checkpoint_ns,
            )
        )
    for entry in writes:
        events[_session_key(entry.config)].append(
            WritesEvent(
                checkpoint_id=_configurable(entry.config)['checkpoint_id'],
                writes=[
                    WriteItem(task_id=entry.task_id, channel=channel, value=value, task_path=entry.task_path)
                    for channel, value in entry.writes
                ],
            )
        )
    return events
