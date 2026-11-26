"""A Session's messages as the user saw them, in AG-UI message shape (ADR 0067 §5)."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from contextlib import aclosing
from typing import Any

from ag_ui.core import (
    EventType,
    Message,
    ReasoningMessage,
    ToolCallArgsEvent,
    ToolCallStartEvent,
)
from ag_ui_langgraph.utils import langchain_messages_to_agui
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.messages.content import ReasoningContentBlock

# Replay maps this additional_kwargs key to `metadata.scheduledRun`.
SCHEDULED_RUN = 'scheduled_run'
OPENING_INSTRUCTION = 'opening_instruction'
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
        if not message.additional_kwargs.get(OPENING_INSTRUCTION)
        for replayed in _replayed(message)
        if replayed.role != 'system'
    ]


def connector_call(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    name, params = arguments.get('name'), arguments.get('arguments')
    if isinstance(name, str) and name and (params is None or isinstance(params, dict)):
        return name, params or {}
    return None


def connector_display(name: str, arguments: str) -> tuple[str, str]:
    if name == 'call_tool':
        try:
            payload = json.loads(arguments)
        except ValueError:
            return name, arguments
        if isinstance(payload, dict) and (call := connector_call(payload)):
            return call[0], json.dumps(call[1])
    return name, arguments


async def connector_activity(source: AsyncGenerator[Any, None], completed: dict[str, str]) -> AsyncGenerator[Any, None]:
    calls: dict[str, tuple[ToolCallStartEvent, list[str]]] = {}
    async with aclosing(source):
        async for event in source:
            if event.type == EventType.TOOL_CALL_START and event.tool_call_name == 'call_tool':
                calls[event.tool_call_id] = event, []
                continue
            if event.type == EventType.TOOL_CALL_ARGS and event.tool_call_id in calls:
                calls[event.tool_call_id][1].append(event.delta)
                continue
            if event.type == EventType.TOOL_CALL_END and event.tool_call_id in calls:
                start, deltas = calls.pop(event.tool_call_id)
                streamed = ''.join(deltas)
                prefix = completed.pop(event.tool_call_id, '')
                name, arguments = connector_display(start.tool_call_name, streamed)
                if name == 'call_tool' and prefix:
                    name, arguments = connector_display(name, prefix + streamed)
                start.tool_call_name = name
                yield start
                yield ToolCallArgsEvent(tool_call_id=event.tool_call_id, delta=arguments)
            yield event


def reasoning_blocks(message: AIMessage) -> list[ReasoningContentBlock]:
    return [block for block in message.content_blocks if block['type'] == 'reasoning']


def reasoning_chunk(message: AIMessage) -> ReasoningContentBlock | None:
    """A streamed reasoning item or summary, excluding its encrypted completion."""
    return next((block for block in reasoning_blocks(message)
                 if not block.get('extras', {}).get('encrypted_content')), None)


def reasoning_texts(message: BaseMessage, *, include_empty: bool = False) -> list[str]:
    """The text of each reasoning block an AI message replays as its own reasoning message."""
    blocks = reasoning_blocks(message) if isinstance(message, AIMessage) else []
    return [block.get('reasoning', '') for block in blocks if include_empty or block.get('reasoning')]


def _replayed(message: BaseMessage) -> list[Message]:
    """The message as AG-UI messages; an AI message's reasoning goes first, as its Turn streamed it."""
    reasoning = reasoning_texts(message)
    times = message.response_metadata.get(MESSAGE_TIMES)
    if times and len(times.get('reasoning', [])) > len(reasoning):
        reasoning = reasoning_texts(message, include_empty=True)
    if times and times.get('reasoning') and not reasoning:
        reasoning = ['']
    card = message.additional_kwargs.get(SCHEDULED_RUN)
    metadata = {**(_span(times) if times else {}),
                **({key: times[key] for key in ('worklog_clock', 'timing_id') if key in times} if times else {}),
                **({'scheduledRun': card} if card is not None else {})}
    return [
        *(
            ReasoningMessage(
                id=times['reasoning'][index].get('id', f'{message.id}-reasoning-{index}') if times else f'{message.id}-reasoning-{index}', content=text,
                metadata=_span(times['reasoning'][index]) if times else None,
            )
            for index, text in enumerate(reasoning)
        ),
        *(
            _timed_message(converted, times, metadata)
            for converted in langchain_messages_to_agui([message])
            if not reasoning or converted.role != 'reasoning'
        ),
    ]


def _timed_message(message: Message, times: dict[str, Any] | None, metadata: dict[str, Any]) -> Message:
    if message.role == 'assistant' and message.tool_calls:
        for call in message.tool_calls:
            name, arguments = connector_display(call.function.name, call.function.arguments)
            call.function.name, call.function.arguments = name, arguments
    if not metadata or message.role == 'reasoning':
        return message
    projected = message.model_copy(update={'metadata': metadata})
    if not times or 'timing_id' not in times or projected.role != 'assistant':
        return projected
    calls = []
    for call in projected.tool_calls or []:
        timing_id = times['tool_timing_ids'][call.id]
        began = times['started_at'] if timing_id == times['timing_id'] else times['tool_calls'][call.id]
        calls.append(call.model_copy(update={'metadata': {
            **(call.metadata or {}), 'timing_id': timing_id, 'worklog_started_at': began,
        }}))
    return projected.model_copy(update={'tool_calls': calls or None})


def _span(times: dict[str, Any]) -> dict[str, int]:
    return {'started_at': times['started_at'], 'ended_at': times['ended_at']}
