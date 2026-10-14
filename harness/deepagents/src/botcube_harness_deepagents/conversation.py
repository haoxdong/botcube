"""A Session's messages as the user saw them, in AG-UI message shape (ADR 0067 §5)."""

from __future__ import annotations

from typing import Any

from ag_ui.core import Message, ReasoningMessage
from ag_ui_langgraph.utils import langchain_messages_to_agui
from langchain_core.messages import AIMessage, BaseMessage

# The additional_kwargs key a scheduled run's post keeps its run card under; history replays it as `metadata.scheduledRun`.
SCHEDULED_RUN = 'scheduled_run'
# Where a recorded message keeps when it started and ended, in epoch ms, in its `response_metadata`; a replay
# copies them into its AG-UI `metadata` as `started_at` and `ended_at`. An agent message's entry
# also times each of its reasoning blocks, in order, and the start of each tool call it made: message_times.py
# stamps them. A message recorded before stamping has none.
MESSAGE_TIMES = 'message_times'


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
    if times and times.get('reasoning') and not reasoning:
        reasoning = ['']
    card = message.additional_kwargs.get(SCHEDULED_RUN)
    metadata = {**(_span(times) if times else {}), **({'scheduledRun': card} if card is not None else {})}
    return [
        *(
            ReasoningMessage(
                id=times['reasoning'][index].get('id', f'{message.id}-reasoning-{index}') if times else f'{message.id}-reasoning-{index}', content=text,
                metadata=_span(times['reasoning'][index]) if times else None,
            )
            for index, text in enumerate(reasoning)
        ),
        *(
            converted.model_copy(update={'metadata': metadata}) if metadata and converted.role != 'reasoning' else converted
            for converted in langchain_messages_to_agui([message])
            if not reasoning or converted.role != 'reasoning'
        ),
    ]


def _span(times: dict[str, Any]) -> dict[str, int]:
    return {'started_at': times['started_at'], 'ended_at': times['ended_at']}
