"""When each Turn message started and ended, kept in its record so a reopened chat can time it.

A thought starts at its reasoning item, before its summary or words may arrive.
A message starts when its first AG-UI event streams and ends with its last: the agent's message from its
TEXT_MESSAGE_START or first TOOL_CALL_START to its model call's end, its reasoning from REASONING_START to
REASONING_END, and a tool's result from its call's TOOL_CALL_START to the result landing. The stream adapter
builds those events from the model's chunks, so the model call's chunks time them here, inside the graph, where
the stamps reach the record (conversation.MESSAGE_TIMES).
"""

from __future__ import annotations

import dataclasses
import time
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from typing import Any, Literal, NotRequired, TypedDict, TypeVar
from uuid import UUID

from ag_ui_langgraph.utils import resolve_encrypted_reasoning_content
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
from langchain_core.outputs import (
    ChatGeneration,
    ChatGenerationChunk,
    Generation,
    GenerationChunk,
    LLMResult,
)
from langchain_core.tracers.context import register_configure_hook
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from .conversation import MESSAGE_TIMES, reasoning_chunk, reasoning_texts

_Message = TypeVar('_Message', bound=BaseMessage)


class StepTime(TypedDict):
    started_at: int
    ended_at: NotRequired[int]


class ClockFrame(TypedDict):
    version: Literal[1]
    question_id: str
    started_at: int
    at: int
    steps: dict[str, StepTime]
    ended_at: NotRequired[int]


class TurnClock:
    def __init__(self, *, accepts_new: bool = True) -> None:
        self.accepts_new = accepts_new
        self.question_id: str | None = None
        self.started_at = 0
        self.through_at = 0
        self.steps: dict[str, StepTime] = {}
        self.tools: dict[str, str] = {}
        self.models_with_tools: set[str] = set()
        self.starts: set[str] = set()
        self.ends: set[str] = set()
        self.terminal_end: int | None = None
        self.revision = 0

    def begin(self, question_id: str, at: int) -> None:
        self.question_id = question_id
        self.started_at = self.through_at = at

    def start(self, step_id: str, at: int) -> None:
        if step_id not in self.steps:
            self.steps[step_id] = {'started_at': at}
            self.revision += 1

    def end(self, step_id: str, at: int) -> None:
        self.steps[step_id]['ended_at'] = at
        self.revision += 1

    def public_start(self, step_id: str) -> None:
        if step_id not in self.starts:
            self.starts.add(step_id)
            self.revision += 1

    def public_end(self, step_id: str, *, closes_text: bool = False) -> None:
        if closes_text and step_id in self.models_with_tools:
            return
        if step_id not in self.ends:
            self.ends.add(step_id)
            self.revision += 1

    def tool_started(self, call_id: str, model_id: str, at: int) -> None:
        if call_id in self.tools:
            return
        step_id = call_id if model_id in self.models_with_tools else model_id
        self.models_with_tools.add(model_id)
        self.tools[call_id] = step_id
        self.start(step_id, at)

    def tool_id(self, call_id: str) -> str:
        return self.tools.get(call_id, call_id)

    def tool_finished(self, call_id: str, at: int) -> None:
        self.end(self.tool_id(call_id), at)

    def begin_model(self) -> None:
        self.terminal_end = None

    def model_finished(self, model_id: str, at: int) -> None:
        if model_id not in self.models_with_tools:
            if model_id in self.steps:
                self.end(model_id, at)
            self.terminal_end = at

    def stop(self, at: int) -> None:
        ended = self.terminal_end if self.terminal_end is not None else max(at, self.through_at)
        self.steps = {key: span for key, span in self.steps.items() if key in self.starts}
        for key, span in self.steps.items():
            span.setdefault('ended_at', ended)
            self.ends.add(key)
        self.terminal_end = ended
        self.revision += 1

    def snapshot(self, at: int) -> ClockFrame:
        if self.question_id is None:
            raise ValueError('A Turn clock needs its question before publishing')
        pending = [span['started_at'] for key, span in self.steps.items() if key not in self.starts]
        pending.extend(span['ended_at'] for key, span in self.steps.items() if 'ended_at' in span and key not in self.ends)
        if self.terminal_end is not None:
            pending.append(self.terminal_end)
        self.through_at = max(self.through_at, min(at, *pending) if pending else at)
        visible: dict[str, StepTime] = {
            key: {'started_at': span['started_at'], **({'ended_at': span['ended_at']} if key in self.ends and 'ended_at' in span else {})}
            for key, span in self.steps.items() if key in self.starts
        }
        frame: ClockFrame = {'version': 1, 'question_id': self.question_id, 'started_at': self.started_at, 'at': self.through_at, 'steps': visible}
        if self.terminal_end is not None:
            frame['ended_at'] = self.terminal_end
        return frame


def stop_frame(frame: ClockFrame, at: int) -> ClockFrame:
    ended = frame.get('ended_at', max(at, frame['at']))
    return {**frame, 'at': ended, 'ended_at': ended, 'steps': {
        key: {**span, 'ended_at': span.get('ended_at', ended)} for key, span in frame['steps'].items()
    }}


_turn_clock: ContextVar[TurnClock | None] = ContextVar('turn_clock', default=None)


@contextmanager
def record_turn(clock: TurnClock | None = None) -> Generator[TurnClock]:
    clock = TurnClock() if clock is None else clock
    token = _turn_clock.set(clock)
    try:
        yield clock
    finally:
        _turn_clock.reset(token)


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
        self.reasoning_index: int | str | None = None
        self.tool_calls: dict[str, int] = {}
        self.turn_clock: TurnClock | None = None
        self.ended_at: int | None = None
        self.ignored_runs: set[str] = set()

    def on_chat_model_start(self, serialized: dict[str, Any], messages: list[list[BaseMessage]], *, run_id: UUID, **kwargs: Any) -> None:
        metadata = kwargs.get('metadata') or {}
        shared = _turn_clock.get()
        if shared is not None and shared.question_id is not None:
            if metadata.get('lc_source') == 'summarization' or metadata.get('lc_agent_name'):
                self.ignored_runs.add(str(run_id))
                return
            self.turn_clock = shared
            shared.begin_model()
        self.model_id = str(run_id)
        if metadata.get('botcube_thinking'):
            self._open_reasoning(None, now())

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
        if str(run_id) in self.ignored_runs:
            return
        if not isinstance(chunk, ChatGenerationChunk) or not isinstance(chunk.message, AIMessageChunk):
            raise TypeError(f'A chat model streams agent message chunks, not {type(chunk).__name__}')
        message, at = chunk.message, now()
        reasoning = reasoning_chunk(message)
        if reasoning is not None:
            self._open_reasoning(reasoning.get('index', 0), at)
            return
        if resolve_encrypted_reasoning_content(message):
            return
        if not message.text and not message.tool_call_chunks:
            return
        self._record_output(message, at)

    def _record_output(self, message: AIMessageChunk, at: int) -> None:
        self._close(at)
        if self.started is None:
            self.started = at
            if self.turn_clock is not None and self.model_id is not None:
                self.turn_clock.start(self.model_id, at)
        for call in message.tool_call_chunks:
            if call['id']:
                self.tool_calls.setdefault(call['id'], at)
                if self.turn_clock is not None and self.model_id is not None:
                    self.turn_clock.tool_started(call['id'], self.model_id, at)

    def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        if self.turn_clock is None or str(run_id) != self.model_id:
            return
        at = self.ended_at = now()
        self._close(at)
        for group in response.generations:
            for generation in group:
                self._record_generation(generation, at)
        self.turn_clock.model_finished(str(run_id), at)

    def _record_generation(self, generation: Generation, at: int) -> None:
        if not isinstance(generation, ChatGeneration) or not isinstance(generation.message, AIMessage):
            raise TypeError('A chat model must return assistant message generations')
        if self.turn_clock is None or self.model_id is None:
            return
        message = generation.message
        if message.text or message.tool_calls:
            self.turn_clock.start(self.model_id, self.started if self.started is not None else at)
        for call in message.tool_calls:
            if call['id'] is None:
                raise RuntimeError('A tool call needs an ID before its clock starts')
            self.turn_clock.tool_started(call['id'], self.model_id, self.tool_calls.get(call['id'], at))

    def _open_reasoning(self, index: int | str | None, at: int) -> None:
        if self.reasoning and len(self.reasoning[-1]) == 1 and self.reasoning_index in (None, index):
            self.reasoning_index = index
            return
        self._close(at)
        self.reasoning.append([at])
        self.reasoning_index = index
        if self.turn_clock is not None and self.model_id is not None:
            self.turn_clock.start(f'{self.model_id}-reasoning-{len(self.reasoning) - 1}', at)

    def _close(self, at: int) -> None:
        if self.reasoning and len(self.reasoning[-1]) == 1:
            self.reasoning[-1].append(at)
            if self.turn_clock is not None and self.model_id is not None:
                self.turn_clock.end(f'{self.model_id}-reasoning-{len(self.reasoning) - 1}', at)

    def stamped(self, message: AIMessage, ended: int) -> AIMessage:
        self._close(ended)
        blocks = reasoning_texts(message, include_empty=True)
        wordless = len(self.reasoning) == 1 and self.reasoning_index is None
        if len(self.reasoning) != len(blocks) and not (wordless and not blocks):
            raise RuntimeError(
                f'The model streamed {len(self.reasoning)} reasoning blocks but answered with '
                f'{len(blocks)}'
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
            **({'timing_id': self.model_id, 'tool_timing_ids': {
                call: self.turn_clock.tool_id(call) for call in calls
            }} if self.turn_clock is not None else {}),
        })


class MessageTimesMiddleware(AgentMiddleware):
    """Stamps each model and tool call's messages with when they started and ended."""

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        thinking = bool(getattr(request.model, 'reasoning', None) or getattr(request.model, 'thinking', None) or
                        (getattr(request.model, 'additional_model_request_fields', None) or {}).get('thinking'))
        request.model.metadata = {**(request.model.metadata or {}), 'botcube_thinking': thinking}
        clock = _ModelClock()
        token = _clock.set(clock)
        try:
            response = await handler(request)
        finally:
            _clock.reset(token)
        ended = clock.ended_at if clock.ended_at is not None else now()
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
        if (clock := _turn_clock.get()) is not None and call_id in clock.tools:
            clock.tool_finished(call_id, times['ended_at'])
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


def cut(reply: AIMessage, started_at: int, ended_at: int, reasoning: list[dict[str, Any]], *, timing_id: str | None = None) -> AIMessage:
    """The text Stop cut short, timed from its first words to the last the user read, after the thoughts it streamed."""
    return _with_times(reply, {'started_at': started_at, 'ended_at': ended_at, 'reasoning': reasoning, 'tool_calls': {},
                               **({'timing_id': timing_id, 'tool_timing_ids': {}} if timing_id is not None else {})})


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


def asked(question: HumanMessage, at: int, *, canonical: bool = False) -> HumanMessage:
    """The question stamped with its Turn's start, when the user sent it, so a replayed Worklog counts from Send."""
    if (clock := _turn_clock.get()) is not None and clock.accepts_new:
        if question.id is None:
            raise ValueError('A timed question needs its message ID')
        clock.begin(question.id, at)
        canonical = True
    return _with_times(question, {'started_at': at, 'ended_at': at,
                                  **({'worklog_clock': {'version': 1}} if canonical else {})})


def resume_clock(messages: list[BaseMessage]) -> None:
    clock = _turn_clock.get()
    question = next((message for message in reversed(messages) if isinstance(message, HumanMessage)), None)
    if clock is None or clock.question_id is not None or question is None:
        return
    times = question.response_metadata.get(MESSAGE_TIMES) or {}
    if times.get('worklog_clock') == {'version': 1}:
        if question.id is None:
            raise ValueError('A timed question needs its message ID')
        clock.begin(question.id, times['started_at'])


def _with_times(message: _Message, times: dict[str, Any]) -> _Message:
    return message.model_copy(update={'response_metadata': {**message.response_metadata, MESSAGE_TIMES: times}})
