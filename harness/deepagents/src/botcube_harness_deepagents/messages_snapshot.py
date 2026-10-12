"""A Session's messages-only snapshot, kept beside its record for history reads (ADR 0067 §5).

A full state read of a long Session reads its whole record: 11.6 MB to return 742 KB of messages. The snapshot
holds only the conversation, in AG-UI message shape, as of one checkpoint. Each backend keeps it beside the
record: reads take the newest checkpoint's copy, a write replaces every copy it supersedes, and purging the
Session deletes it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ag_ui.core import Message, ReasoningMessage
from ag_ui_langgraph.utils import langchain_messages_to_agui
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph

# Where a recorded message keeps when it started and ended, in epoch ms, in its `response_metadata`; a replay
# copies them into its AG-UI `metadata` as `started_at` and `ended_at`. An agent message's entry
# also times each of its reasoning blocks, in order, and the start of each tool call it made: message_times.py
# stamps them. A message recorded before stamping has none.
MESSAGE_TIMES = 'message_times'


@dataclass(frozen=True)
class MessagesSnapshot:
    checkpoint: str
    messages: list[dict[str, Any]]
    # The settled Turn's run ID, or the marker a read checked against when it rebuilt this snapshot.
    checked: str | None = None

    def supersedes(self, other: MessagesSnapshot) -> bool:
        """Checkpoint IDs sort in the order LangGraph saved them; of two copies of one checkpoint, the later wins."""
        return self.checkpoint >= other.checkpoint


async def state_snapshot(
    graph: CompiledStateGraph[Any], config: RunnableConfig, checked: str | None = None
) -> MessagesSnapshot | None:
    """The Session's conversation as its latest checkpoint holds it; a Session with no record has none."""
    state = await graph.aget_state(config)
    messages = (state.values or {}).get('messages')
    if not messages:
        return None
    return MessagesSnapshot(state.config.get('configurable', {})['checkpoint_id'], conversation(messages), checked)


def conversation(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    """The Session's messages as the user saw them, in AG-UI shape.

    System messages are framework context injected per run (CopilotKit's App Context, in Sessions recorded
    by the earlier CopilotKit serving stack), never part of the conversation a user sees or sent.
    """
    return [
        replayed.model_dump(by_alias=True, exclude_none=True)
        for message in messages
        for replayed in _replayed(message)
        if replayed.role != 'system'
    ]


def reasoning_texts(message: BaseMessage) -> list[str]:
    """The text of each reasoning block an AI message replays as its own reasoning message."""
    blocks = message.content_blocks if isinstance(message, AIMessage) else []
    return [text for block in blocks if block['type'] == 'reasoning' and (text := block.get('reasoning'))]


def _replayed(message: BaseMessage) -> list[Message]:
    """The message as AG-UI messages; an AI message's reasoning goes first, as its Turn streamed it."""
    reasoning = reasoning_texts(message)
    times = message.response_metadata.get(MESSAGE_TIMES)
    return [
        *(
            ReasoningMessage(
                id=f'{message.id}-reasoning-{index}', content=text,
                metadata=_span(times['reasoning'][index]) if times else None,
            )
            for index, text in enumerate(reasoning)
        ),
        *(
            converted.model_copy(update={'metadata': _span(times)}) if times and converted.role != 'reasoning' else converted
            for converted in langchain_messages_to_agui([message])
            if not reasoning or converted.role != 'reasoning'
        ),
    ]


def _span(times: dict[str, Any]) -> dict[str, int]:
    return {'started_at': times['started_at'], 'ended_at': times['ended_at']}
