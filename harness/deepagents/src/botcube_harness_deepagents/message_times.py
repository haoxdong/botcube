"""When each Turn message started and ended, kept in its record so a reopened chat can time it.

A message starts when its first AG-UI event streams and ends with its last: the agent's message from its
TEXT_MESSAGE_START or first TOOL_CALL_START to its model call's end, its reasoning from REASONING_START to
REASONING_END, and a tool's result from its call's TOOL_CALL_START to the result landing. The stream adapter
builds those events from the model's chunks, so the model call's chunks time them here, inside the graph, where
the stamps reach the record (messages_snapshot.MESSAGE_TIMES).
"""

from __future__ import annotations

import dataclasses
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
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
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGenerationChunk, GenerationChunk
from langchain_core.tracers.context import register_configure_hook
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from .messages_snapshot import MESSAGE_TIMES, reasoning_texts

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
        self.started: int | None = None
        self.reasoning: list[list[int]] = []
        self.reasoning_index: int | None = None
        self.tool_calls: dict[str, int] = {}

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
            # A text-less reasoning chunk only names the reasoning to come.
            if reasoning['text']:
                index = reasoning.get('index', 0)
                if self.reasoning_index != index:
                    self._close(at)
                    self.reasoning.append([at])
                    self.reasoning_index = index
            return
        if resolve_encrypted_reasoning_content(message):
            return
        self._close(at)
        if self.started is None and (message.text or message.tool_call_chunks):
            self.started = at
        for call in message.tool_call_chunks:
            if call['id']:
                self.tool_calls.setdefault(call['id'], at)

    def _close(self, at: int) -> None:
        if self.reasoning_index is not None:
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
            'reasoning': [{'started_at': start, 'ended_at': end} for start, end in self.reasoning],
            'tool_calls': {call: self.tool_calls.get(call, ended) for call in calls},
        })


class MessageTimesMiddleware(AgentMiddleware):
    """Stamps each model and tool call's messages with when they started and ended."""

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
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


def cut(reply: AIMessage, started_at: int, ended_at: int) -> AIMessage:
    """The text Stop cut short, timed from its first words to the last the user read."""
    return _with_times(reply, {'started_at': started_at, 'ended_at': ended_at, 'reasoning': [], 'tool_calls': {}})


def _with_times(message: _Message, times: dict[str, Any]) -> _Message:
    return message.model_copy(update={'response_metadata': {**message.response_metadata, MESSAGE_TIMES: times}})
