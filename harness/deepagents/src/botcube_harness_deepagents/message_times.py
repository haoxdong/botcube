"""When each Turn message started and ended, kept in its record so a reopened chat can time it.

A thought starts at its first words, so the wait for a model's first token goes to whatever it streams first.
A message starts when its first AG-UI event streams and ends with its last: the agent's message from its
TEXT_MESSAGE_START or first TOOL_CALL_START to its model call's end, its reasoning from REASONING_START to
REASONING_END, and a tool's result from its call's TOOL_CALL_START to the result landing. The stream adapter
builds those events from the model's chunks, so the model call's chunks time them here, inside the graph, where
the stamps reach the record (conversation.MESSAGE_TIMES).
"""

from __future__ import annotations

import dataclasses
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from datetime import datetime
from typing import Any, TypeVar
from uuid import UUID

from ag_ui_langgraph.utils import (
    resolve_encrypted_reasoning_content,
    resolve_reasoning_content,
)
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolCall,
    ToolMessage,
)
from langchain_core.outputs import ChatGenerationChunk, GenerationChunk
from langchain_core.tracers.context import register_configure_hook
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from .conversation import MESSAGE_TIMES, reasoning_texts

_Message = TypeVar('_Message', bound=BaseMessage)
_clock: ContextVar[_ModelClock | None] = ContextVar('message_times_clock', default=None)
# LangChain adds the clock to every run configured while it is set: the model call MessageTimesMiddleware wraps.
register_configure_hook(_clock, inheritable=True)


def now() -> int:
    return time.time_ns() // 1_000_000


class _ModelClock(BaseCallbackHandler):
    """Times one model call's chunks, opening and closing reasoning where ag_ui_langgraph streams it."""

    run_inline = True
    raise_error = True

    def __init__(self) -> None:
        self.model_id: str | None = None
        self.started: int | None = None
        self.reasoning: list[list[int]] = []
        self.reasoning_index: int | None = None
        self.tool_calls: dict[str, int] = {}

    def on_chat_model_start(self, serialized: dict[str, Any], messages: list[list[BaseMessage]], *, run_id: UUID, **kwargs: Any) -> None:
        self.model_id = str(run_id)

    def on_llm_new_token(
        self,
        token: str | list[str | dict[str, Any]],
        *,
        chunk: GenerationChunk | ChatGenerationChunk | None = None,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        if not isinstance(chunk, ChatGenerationChunk) or not isinstance(chunk.message, AIMessageChunk):
            raise TypeError(f'A chat model streams agent message chunks, not {type(chunk).__name__}')
        message, at = chunk.message, now()
        reasoning = resolve_reasoning_content(message)
        if reasoning:
            if reasoning['text']:
                self._open_reasoning(reasoning.get('index', 0), at)
            return
        if resolve_encrypted_reasoning_content(message):
            return
        if not message.text and not message.tool_call_chunks:
            return
        self._close(at)
        if self.started is None:
            self.started = at
        for call in message.tool_call_chunks:
            if call['id']:
                self.tool_calls.setdefault(call['id'], at)

    def _open_reasoning(self, index: int, at: int) -> None:
        if self.reasoning_index == index:
            return
        self._close(at)
        self.reasoning.append([at])
        self.reasoning_index = index

    def _close(self, at: int) -> None:
        if self.reasoning and len(self.reasoning[-1]) == 1:
            self.reasoning[-1].append(at)
            self.reasoning_index = None

    def stamped(self, message: AIMessage, ended: int) -> AIMessage:
        self._close(ended)
        if len(self.reasoning) != len(reasoning_texts(message)):
            raise RuntimeError(
                f'The model streamed {len(self.reasoning)} reasoning blocks but answered with '
                f'{len(reasoning_texts(message))}'
            )
        calls: list[str] = []
        for call in message.tool_calls:
            if call['id'] is None:
                raise RuntimeError('The model made a tool call without an ID, so its result cannot be timed')
            calls.append(call['id'])
        # A message, or call, the model never streamed is emitted when its call ends.
        return _with_times(message, {
            'started_at': ended if self.started is None else self.started,
            'ended_at': ended,
            'reasoning': [{'id': f'{self.model_id}-reasoning-{index}', 'started_at': start, 'ended_at': end}
                          for index, (start, end) in enumerate(self.reasoning)],
            'tool_calls': {call: self.tool_calls.get(call, ended) for call in calls},
        })


class MessageTimesMiddleware(AgentMiddleware):
    """Stamps each model and tool call's messages with when they started and ended."""

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        thinking = bool(getattr(request.model, 'reasoning', None) or
                        (getattr(request.model, 'additional_model_request_fields', None) or {}).get('thinking'))
        request.model.metadata = {**(request.model.metadata or {}), 'botcube_thinking': thinking}
        clock = _ModelClock()
        token = _clock.set(clock)
        try:
            response = await handler(request)
        finally:
            _clock.reset(token)
        ended = now()
        return dataclasses.replace(response, result=[
            clock.stamped(message, ended) if isinstance(message, AIMessage) else message for message in response.result
        ])

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        result = await handler(request)
        call_id = request.tool_call['id']
        started = _call_started(request.state['messages'], call_id)
        if started is None:
            return result
        times = {'started_at': started, 'ended_at': now()}
        if isinstance(result, ToolMessage):
            return _with_times(result, times)
        if not isinstance(result.update, dict) or 'messages' not in result.update:
            return result
        # A tool that updates more state, as write_todos or task does, lands its result in its Command.
        return dataclasses.replace(result, update={**result.update, 'messages': [
            _with_times(message, times) if isinstance(message, ToolMessage) and message.tool_call_id == call_id else message
            for message in result.update['messages']
        ]})


def _call_started(messages: list[BaseMessage], call_id: str | None) -> int | None:
    """When the model began streaming the call; None for a call no stamped agent message made.

    Such a call's result stays untimed, as every message recorded before stamping is: a Session recorded
    earlier, or a call that reached the record some other way.
    """
    for message in reversed(messages):
        if isinstance(message, AIMessage) and any(call['id'] == call_id for call in message.tool_calls):
            times = message.response_metadata.get(MESSAGE_TIMES)
            return None if times is None else times['tool_calls'][call_id]
    return None


def cut(reply: AIMessage, started_at: int, ended_at: int, reasoning: list[dict[str, Any]]) -> AIMessage:
    """The text Stop cut short, timed from its first words to the last the user read, after the thoughts it streamed."""
    return _with_times(reply, {'started_at': started_at, 'ended_at': ended_at, 'reasoning': reasoning, 'tool_calls': {}})


def cut_call(call: ToolCall, words: str, started_at: int, stopped_at: int) -> ToolMessage:
    """The result of a call Stop cut short, in the saver's own `words`, timed from the call's start to the Stop."""
    result = ToolMessage(words, name=call['name'], tool_call_id=call['id'], id=f"{call['id']}-stopped", status='error')
    return _with_times(result, {'started_at': started_at, 'ended_at': stopped_at})


def turn_start(value: object) -> int | None:
    """The Chat Service's `turnStartedAt`, an ISO time, in epoch ms; a client sending none gets None."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f'turnStartedAt must be an ISO time, not {type(value).__name__}')
    return round(datetime.fromisoformat(value).timestamp() * 1000)


def asked(question: HumanMessage, at: int) -> HumanMessage:
    """The question stamped with its Turn's start, when the user sent it, so a replayed Worklog counts from Send."""
    return _with_times(question, {'started_at': at, 'ended_at': at})


def _with_times(message: _Message, times: dict[str, Any]) -> _Message:
    return message.model_copy(update={'response_metadata': {**message.response_metadata, MESSAGE_TIMES: times}})
