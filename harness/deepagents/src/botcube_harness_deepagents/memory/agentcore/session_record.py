"""Namespace-preserving checkpoint events in their owning physical Session."""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any, NamedTuple

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
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
    return checkpoint_config.actor_id, checkpoint_config.thread_id


def _configurable(config: RunnableConfig) -> dict[str, Any]:
    configurable = config.get('configurable')
    if configurable is None:
        raise ValueError('Checkpoint config carries no configurable section')
    return configurable


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
