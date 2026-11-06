"""A Session record in the legacy checkpoint format, refused before LangGraph walks it (ADR 0067 decision 9).

A legacy checkpoint versions `messages` and `files` but stores neither: loading its state walks
every ancestor checkpoint for `files`, and still finds no messages. The snapshot format stores
each reducer channel it versions, so a read never walks. No legacy Session is converted.
"""

from __future__ import annotations

from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.channels.binop import BinaryOperatorAggregate
from langgraph.channels.delta import DeltaChannel
from langgraph.checkpoint.base import CheckpointTuple


class SessionFormatLegacyError(RuntimeError):
    code = 'SESSION_FORMAT_LEGACY'


async def latest_checkpoint(graph: Any, config: RunnableConfig) -> CheckpointTuple | None:
    """The Session's latest checkpoint, read once; SessionFormatLegacyError when it is in the legacy format."""
    saved = await graph.checkpointer.aget_tuple(config)
    if saved is None:
        return None
    checkpoint = saved.checkpoint
    unstored = sorted(
        name
        for name, channel in graph.channels.items()
        if isinstance(channel, DeltaChannel | BinaryOperatorAggregate)
        and name in checkpoint['channel_versions']
        and name not in checkpoint['channel_values']
    )
    if unstored:
        raise SessionFormatLegacyError(
            f"Session {config.get('configurable', {}).get('thread_id')} is in the legacy checkpoint format: "
            f"its latest checkpoint stores no {', '.join(unstored)}"
        )
    return saved
