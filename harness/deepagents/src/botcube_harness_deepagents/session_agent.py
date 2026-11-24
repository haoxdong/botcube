from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from contextlib import aclosing
from dataclasses import dataclass
from time import perf_counter
from typing import Any, cast

from ag_ui.core import (
    EventType,
    Message,
    MessagesSnapshotEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunAgentInput,
    RunErrorEvent,
    StateSnapshotEvent,
)
from ag_ui_langgraph import LangGraphAgent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.messages.content import ReasoningContentBlock
from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph
from pydantic import TypeAdapter

from . import message_times, turn_timing
from .conversation import conversation, reasoning_chunk
from .graph_stream import answering_model_step, clock_events, drain_after_answer
from .turn_state import observe_reply_model

log = logging.getLogger(f'{__package__}.serving')


@dataclass
class _Thinking:
    block: int = 0
    index: int | str | None = None
    open: bool = False


class SessionAgent(LangGraphAgent):
    """Merge replayed tool calls and results by their persisted IDs.

    AG-UI streams fresh IDs until the final snapshot. Resent streams must not
    append duplicate replies or tool steps. Current web clients send only new
    user messages; older clients can resend the streamed history.
    """

    _graph_ended_at: float | None = None
    _interrupted: bool = False
    _graph_stream: Any = None
    _asked: int | None = None

    def __init__(self, **kwargs: Any) -> None:
        # The graph's raw events carry the Session's history, which no client reads; skip
        # building and JSON-converting them for every streamed event.
        kwargs.setdefault('emit_raw_events', False)
        super().__init__(**kwargs)
        self._model_lane: str | None = None
        self._thinking: dict[str, _Thinking] = {}
        self._early_answer = False
        self._used_tools = False

    async def _handle_stream_events(self, input: RunAgentInput) -> AsyncGenerator[Any, None]:
        self._asked = None
        self._used_tools = False
        try:
            source = super()._handle_stream_events(input)
            timed = clock_events(source, lambda: self._model_lane, canonical=(input.forwarded_props or {}).get('worklog_clock') == 1)
            async with aclosing(timed) as events:
                async for event in events:
                    if event.type == EventType.RUN_STARTED and self._asked is not None:
                        event.timestamp = self._asked
                    if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
                        for closed in self._close_thoughts():
                            yield closed
                    self._used_tools |= event.type == EventType.TOOL_CALL_START
                    yield event
                    if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
                        break
        except Exception as error:
            from .serving import _error_code

            log.exception('Error during graph streaming')
            for closed in self._close_thoughts():
                yield closed
            yield RunErrorEvent(message=str(error) or type(error).__name__, code=_error_code(error))
        finally:
            self._model_lane = None
            self._thinking.clear()
            self.messages_in_process.clear()
            if self._graph_stream is not None:
                await self._graph_stream.aclose()
                self._graph_stream = None

    def _close_thoughts(self) -> list[Any]:
        events = []
        for lane, thought in self._thinking.items():
            self._model_lane = lane
            events.extend(self._thought_end(lane, thought))
        self._thinking.clear()
        return events

    async def _handle_single_event(self, event: Any, state: Any) -> AsyncGenerator[Any, None]:
        graph_event = event.get('parent_ids') == []
        chunk = event.get('data', {}).get('chunk')
        if isinstance(chunk, tuple):
            chunk = chunk[-1]
        if graph_event and event.get('event') == 'on_chain_stream' and isinstance(chunk, dict) and '__interrupt__' in chunk:
            self._interrupted = True
        ended = graph_event and event.get('event') == 'on_chain_end'
        ended |= self._early_answer and not self._used_tools and answering_model_step(event)
        if ended:
            self._graph_ended_at = perf_counter()
        async with aclosing(self._handle_model_event(event, state)) as events:
            async for emitted in events:
                yield emitted
        if ended and not self._interrupted:
            for emitted in self.handle_node_change(None):
                yield emitted
            run = cast(dict[str, Any], self.active_run)
            yield self._emit_success_finish(thread_id=run['thread_id'], run_id=run['id'])

    def _thought_end(self, lane: str, thought: _Thinking) -> list[Any]:
        if not thought.open:
            return []
        thought.open = False
        message_id = f'{lane}-reasoning-{thought.block}'
        return [self._dispatch_event(ReasoningMessageEndEvent(message_id=message_id)),
                self._dispatch_event(ReasoningEndEvent(message_id=message_id))]

    def _reasoning_chunk(self, lane: str, thought: _Thinking, reasoning: ReasoningContentBlock) -> list[Any]:
        events = []
        index = reasoning.get('index', 0)
        if thought.open and thought.index != index:
            events.extend(self._thought_end(lane, thought))
            thought.block += 1
        message_id = f'{lane}-reasoning-{thought.block}'
        if not thought.open:
            events.extend([
                self._dispatch_event(ReasoningStartEvent(message_id=message_id)),
                self._dispatch_event(ReasoningMessageStartEvent(message_id=message_id, role='reasoning')),
            ])
            thought.open = True
        thought.index = index
        if text := reasoning.get('reasoning'):
            events.append(self._dispatch_event(ReasoningMessageContentEvent(
                message_id=message_id, delta=text)))
        return events

    def _thought_chunk(self, event: Any, lane: str, thought: _Thinking | None, chunk: Any) -> list[Any] | None:
        if thought is None or chunk is None:
            return None
        reasoning = reasoning_chunk(chunk)
        if reasoning is not None:
            return self._reasoning_chunk(lane, thought, reasoning)
        if not chunk.text and not chunk.tool_call_chunks:
            self._record_usage(event, chunk.usage_metadata, streamed=True)
            return []
        return None

    async def _handle_model_event(self, event: Any, state: Any) -> AsyncGenerator[Any, None]:
        kind = event.get('event')
        if kind not in {'on_chat_model_start', 'on_chat_model_stream', 'on_chat_model_end'}:
            async for emitted in super()._handle_single_event(event, state):
                yield emitted
            return
        metadata = event.get('metadata', {})
        if metadata.get('lc_source') == 'summarization':
            data = event.get('data', {})
            if kind == 'on_chat_model_stream':
                self._record_usage(event, getattr(data.get('chunk'), 'usage_metadata', None), streamed=True)
            elif kind == 'on_chat_model_end':
                self._record_usage(event, getattr(data.get('output'), 'usage_metadata', None), streamed=False)
            return
        observe_reply_model(event)
        if kind == 'on_chat_model_end' and (error := self._model_completion_error(event)) is not None:
            yield error
            return
        lane = event['run_id']
        self._model_lane = lane
        try:
            if kind == 'on_chat_model_start' and metadata.get('botcube_thinking'):
                self._thinking[lane] = _Thinking()
            thought = self._thinking.get(lane)
            chunk = event.get('data', {}).get('chunk')
            handled = self._thought_chunk(event, lane, thought, chunk)
            if handled is not None:
                for emitted in handled:
                    yield emitted
                return
            async with aclosing(self._model_output(event, state, lane, thought)) as events:
                async for emitted in events:
                    yield emitted
        finally:
            self._model_lane = None

    def _model_completion_error(self, event: Any) -> RunErrorEvent | None:
        output = event.get('data', {}).get('output')
        response = getattr(output, 'response_metadata', {})
        reason = (response.get('finish_reason') or response.get('stop_reason') or response.get('stopReason')
                  or (response.get('incomplete_details') or {}).get('reason'))
        usage = getattr(output, 'usage_metadata', None)
        self._record_usage(event, usage, streamed=False)
        log.info('Harness model completed model_run_id=%s finish_reason=%s usage=%s', event['run_id'], reason, usage)
        if reason not in {'length', 'max_tokens', 'max_output_tokens'}:
            return None
        log.warning('Harness model output limit model_run_id=%s finish_reason=%s usage=%s',
                    event['run_id'], reason, usage)
        return RunErrorEvent(
            message='Agent reached the model output limit. Try again with a shorter request or lower reasoning effort.',
            code='AGENT_OUTPUT_LIMIT',
            usage=self._collect_run_usage(),
        )

    async def _model_output(self, event: Any, state: Any, lane: str, thought: _Thinking | None) -> AsyncGenerator[Any, None]:
        async with aclosing(super()._handle_single_event(event, state)) as events:
            async for emitted in events:
                if thought is not None and emitted.type in {EventType.TEXT_MESSAGE_START, EventType.TOOL_CALL_START}:
                    for closed in self._thought_end(lane, thought):
                        yield closed
                    self._thinking.pop(lane)
                    thought = None
                yield emitted

    def _current_lane(self) -> str:
        return self._model_lane or super()._current_lane()

    async def get_state_and_messages_snapshots(self, config: RunnableConfig) -> AsyncGenerator[Any, None]:
        if self._graph_ended_at is not None:
            return
        state = await self.graph.aget_state(config)
        if not isinstance(state.values, dict):
            raise TypeError('Checkpoint snapshot must contain a state mapping')
        if not (self.emit_subagent_events and cast(dict[str, Any], self.active_run).get('current_subagent_run_id')):
            yield self._dispatch_event(StateSnapshotEvent(snapshot=self.get_state_snapshot(state.values)))
        messages = self._filter_orphan_tool_messages(state.values.get('messages', []))
        projected = TypeAdapter(list[Message]).validate_python(conversation(messages))
        yield self._dispatch_event(MessagesSnapshotEvent(messages=self._merge_subagent_messages(
            self._translate_snapshot_ids(projected))))

    async def prepare_stream(self, input: RunAgentInput, agent_state: Any, config: RunnableConfig) -> Any:
        self._graph_ended_at = None
        self._interrupted = False
        self._thinking.clear()
        self._model_lane = None
        self.messages_in_process.clear()
        # Stop records the visible text before a model finishes its tool call.
        # A client can resend that message with unfinished JSON arguments; the
        # library decodes those before its merge discards already-recorded IDs.
        kept_text_ids = {
            message.id
            for message in agent_state.values.get('messages', [])
            if isinstance(message, AIMessage) and not message.tool_calls
        }
        input = input.model_copy(update={'thread_id': input.thread_id or config.get('configurable', {})['thread_id'], 'messages': [
            message for message in input.messages
            if not (message.role == 'assistant' and message.id in kept_text_ids and message.tool_calls)
        ]})
        for message in input.messages:
            if message.role != 'assistant':
                continue
            for call in message.tool_calls or []:
                if call.function.arguments:
                    json.loads(call.function.arguments)
        if (timing := turn_timing.current()) is not None:
            timing.history_messages = len(agent_state.values.get('messages', []))
        configurable = config.setdefault('configurable', {})
        configurable['scheduled_task_model'] = (input.forwarded_props or {}).get('model')
        configurable['timezone'] = (input.forwarded_props or {}).get('timezone')
        self._asked = message_times.turn_start((input.forwarded_props or {}).get('turn_started_at'))
        with turn_timing.phase('state_preparation'):
            prepared = await super().prepare_stream(input, agent_state, config)
        if (source := prepared.get('stream')) is not None:
            self._early_answer = (isinstance(self.graph, CompiledStateGraph)
                                  and not self.graph.interrupt_before_nodes and not self.graph.interrupt_after_nodes
                                  and not (self.config or {}).get('callbacks'))
            prepared['stream'] = self._graph_stream = drain_after_answer(source, early=self._early_answer)
        return prepared

    def langgraph_default_merge_state(self, state: Any, messages: list[Any], input: RunAgentInput) -> Any:
        merged = super().langgraph_default_merge_state(state, messages, input)
        recorded = state.get('messages', [])
        recorded_ids = {message.id for message in recorded}
        answered = {message.tool_call_id for message in recorded if isinstance(message, ToolMessage)}
        called = {call['id'] for message in recorded if isinstance(message, AIMessage) for call in message.tool_calls}
        asked = self._asked
        merged['messages'] = [
            message_times.asked(message, asked)
            if asked is not None and isinstance(message, HumanMessage) and message.id not in recorded_ids else message
            for message in merged['messages']
            if message.id in recorded_ids
            or not (
                (isinstance(message, ToolMessage) and message.tool_call_id in answered)
                or (isinstance(message, AIMessage) and message.tool_calls and {call['id'] for call in message.tool_calls} <= called)
            )
        ]
        message_times.resume_clock(merged['messages'])
        return merged
