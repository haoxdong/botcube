from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError
from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import BaseMessage

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore import BedrockAgentCoreClient

TURN_EVENT_CONTENT_LIMIT = 16_000
TURN_EVENT_PAYLOAD_LIMIT = 100
TURN_EVENT_CONFLICT_BACKOFF_SECONDS = (0.25, 0.5, 1.0, 2.0, 4.0)
_TRUNCATION_SUFFIX = '\n[truncated]'
_EVENT_ROLES = {'human': 'USER', 'ai': 'ASSISTANT', 'tool': 'TOOL'}


class TurnMemoryMiddleware(AgentMiddleware):
    """Write one AgentCore conversational event after a completed turn."""

    def __init__(
        self,
        *,
        memory_id: str,
        actor_id: str,
        session_id: str,
    ) -> None:
        self.memory_id = memory_id
        self.actor_id = actor_id
        self.session_id = session_id

    async def aafter_agent(self, state: Any, runtime: Any) -> None:
        store = runtime.store
        if store is None:
            return
        messages = latest_turn_messages(state['messages'])
        if not messages:
            return

        task = asyncio.create_task(asyncio.to_thread(
            record_turn_memory_event,
            store,
            memory_id=self.memory_id,
            actor_id=self.actor_id,
            session_id=self.session_id,
            messages=messages,
        ))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise



def latest_turn_messages(messages: Sequence[Any]) -> list[BaseMessage]:
    typed = [message for message in messages if isinstance(message, BaseMessage)]
    human_indexes = [index for index, message in enumerate(typed) if message.type == 'human']
    if not human_indexes:
        return []
    return [message for message in typed[human_indexes[-1]:] if message.type in _EVENT_ROLES]


def record_turn_memory_event(
    store: Any,
    *,
    memory_id: str,
    actor_id: str,
    session_id: str,
    messages: Sequence[BaseMessage],
    now: datetime | None = None,
) -> None:
    event_messages = _truncate_event_messages(
        _limit_event_message_count(_event_messages(messages))
    )
    if not event_messages:
        return

    _create_event_with_retry(
        store.client,
        {
            'memoryId': memory_id,
            'actorId': actor_id,
            'sessionId': session_id,
            'eventTimestamp': now or datetime.now(UTC),
            'payload': [
                {'conversational': {'content': {'text': text}, 'role': role}}
                for text, role in event_messages
            ],
        },
    )


def _create_event_with_retry(client: BedrockAgentCoreClient, kwargs: Mapping[str, Any]) -> None:
    for delay in (*TURN_EVENT_CONFLICT_BACKOFF_SECONDS, None):
        try:
            client.create_event(**kwargs)
            return
        except ClientError as exc:
            if delay is not None and exc.response.get('Error', {}).get('Code') == 'RetryableConflictException':
                time.sleep(delay)
                continue
            raise


def _event_messages(messages: Sequence[BaseMessage]) -> list[tuple[str, str]]:
    converted: list[tuple[str, str]] = []
    for message in messages:
        text = _message_text(message)
        if not text.strip():
            continue
        converted.append((text, _EVENT_ROLES[message.type]))
    return converted


def _message_text(message: BaseMessage) -> str:
    tool_calls = getattr(message, 'tool_calls', None)
    if message.type == 'ai' and tool_calls:
        tool_call_text = '\n'.join(_tool_call_text(call) for call in tool_calls)
        content_text = _content_text(message.content)
        if content_text.strip():
            return f'{content_text}\n{tool_call_text}'
        return tool_call_text
    return _content_text(message.content)


def _content_text(content: str | list[str | dict[str, object]]) -> str:
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(text := item.get('text'), str):
            parts.append(text)
    return '\n'.join(parts)


def _tool_call_text(tool_call: Mapping[str, Any]) -> str:
    return f'Tool call: {tool_call["name"]} {json.dumps(tool_call["args"], sort_keys=True)}'


def _truncate_event_messages(messages: Sequence[tuple[str, str]]) -> list[tuple[str, str]]:
    """Share the event's character limit fairly: each message gets an equal part of what is left.

    At most TURN_EVENT_PAYLOAD_LIMIT messages arrive, so every share outgrows the suffix.
    """
    if sum(len(text) for text, _role in messages) <= TURN_EVENT_CONTENT_LIMIT:
        return list(messages)

    remaining = TURN_EVENT_CONTENT_LIMIT
    truncated: list[tuple[str, str]] = []
    for index, (text, role) in enumerate(messages):
        budget = remaining // (len(messages) - index)
        if len(text) > budget:
            text = text[:budget - len(_TRUNCATION_SUFFIX)] + _TRUNCATION_SUFFIX
        truncated.append((text, role))
        remaining -= len(text)
    return truncated


def _limit_event_message_count(messages: Sequence[tuple[str, str]]) -> list[tuple[str, str]]:
    if len(messages) <= TURN_EVENT_PAYLOAD_LIMIT:
        return list(messages)

    coalesced = _coalesce_adjacent_event_messages(messages)
    if len(coalesced) <= TURN_EVENT_PAYLOAD_LIMIT:
        return coalesced

    head_count = TURN_EVENT_PAYLOAD_LIMIT // 2
    tail_count = TURN_EVENT_PAYLOAD_LIMIT - head_count - 1
    omitted_count = len(coalesced) - head_count - tail_count
    omitted_role = coalesced[head_count][1]
    omitted_text = (
        f'[{omitted_count} turn messages omitted '
        'to fit AgentCore payload item limit]'
    )
    return [
        *coalesced[:head_count],
        (omitted_text, omitted_role),
        *coalesced[-tail_count:],
    ]


def _coalesce_adjacent_event_messages(
    messages: Sequence[tuple[str, str]],
) -> list[tuple[str, str]]:
    coalesced: list[tuple[str, str]] = []
    for text, role in messages:
        if coalesced and coalesced[-1][1] == role:
            previous_text = coalesced[-1][0]
            coalesced[-1] = (f'{previous_text}\n{text}', role)
        else:
            coalesced.append((text, role))
    return coalesced
