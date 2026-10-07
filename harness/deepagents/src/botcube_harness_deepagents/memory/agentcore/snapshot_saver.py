"""AgentCore saver that can serve many state reads from one ListEvents pass.

Reading a Session's state asks the record for its latest checkpoint, then again
for that checkpoint and its ancestors' DeltaChannel history: three ListEvents
passes over the same events, and a Harness Turn reads its state four times.
Inside `reading_once()`, this saver pages each Session's record at most once and
builds every checkpoint from it, so the cached record lacks whatever the block
writes: the Turn saver holds a Turn's checkpoints in its buffer, readable before
and after its flush, so reads in the block see them there.
Outside it, it reads as `OnePassAgentCoreMemorySaver` does.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextvars import ContextVar
from typing import TYPE_CHECKING

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import CheckpointTuple, get_checkpoint_id
from langgraph_checkpoint_aws.checkpoint.agentcore.models import CheckpointerConfig

from .one_pass_saver import OnePassAgentCoreMemorySaver, _replay_delta_channel_history

if TYPE_CHECKING:
    from langgraph.checkpoint.base import DeltaChannelHistory

# Each Session's checkpoints by ID, as the current `reading_once()` read them.
_RECORDS: ContextVar[dict[tuple[str, str, str], dict[str, CheckpointTuple]] | None] = ContextVar(
    '_RECORDS', default=None
)
_LOCK = threading.Lock()


@contextlib.contextmanager
def reading_once() -> Iterator[None]:
    """Read each Session's record at most once until the block exits."""
    token = _RECORDS.set({})
    try:
        yield
    finally:
        _RECORDS.reset(token)


def _record_key(config: RunnableConfig) -> tuple[str, str, str]:
    checkpoint_config = CheckpointerConfig.from_runnable_config(dict(config))
    return checkpoint_config.actor_id, checkpoint_config.session_id, checkpoint_config.checkpoint_ns


class SnapshotAgentCoreMemorySaver(OnePassAgentCoreMemorySaver):
    def _record(self, config: RunnableConfig) -> dict[str, CheckpointTuple] | None:
        records = _RECORDS.get()
        if records is None:
            return None
        key = _record_key(config)
        with _LOCK:
            record = records.get(key)
        if record is None:
            checkpoint_config = CheckpointerConfig.from_runnable_config(dict(config))
            events = [event for page in self._iter_event_pages(checkpoint_config) for event in page]
            record = self._tuples_by_checkpoint_id(events, checkpoint_config)
            with _LOCK:
                records[key] = record
        return record

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        record = self._record(config)
        if record is None:
            return super().get_tuple(config)
        return record.get(get_checkpoint_id(config) or max(record, default=''))

    def delta_channel_history(
        self,
        *,
        config: RunnableConfig,
        channels: Sequence[str],
        target: CheckpointTuple | None,
        known: Mapping[str, CheckpointTuple],
    ) -> dict[str, DeltaChannelHistory]:
        """Walk `known` first, then the read record instead of paging it again."""
        if _RECORDS.get() is not None:
            result, complete = _replay_delta_channel_history(target, {**known}, channels)
            if complete:
                return result
            known = {**(self._record(config) or {}), **known}
        return super().delta_channel_history(config=config, channels=channels, target=target, known=known)
