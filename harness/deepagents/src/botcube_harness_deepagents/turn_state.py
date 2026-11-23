from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar, copy_context
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any

from ag_ui.core import (
    EventType,
    ReasoningEndEvent,
    ReasoningMessageEndEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateDeltaEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.utils import agui_messages_to_langchain
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    ToolCall,
    ToolMessage,
)
from langchain_core.messages.content import ContentBlock
from langchain_core.runnables import RunnableConfig
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from . import message_times
from .conversation import MESSAGE_TIMES
from .lazy_files import TurnFiles
from .steering import PendingSteering
from .turn_memory import TurnFeeds

log = logging.getLogger(__name__)


class CheckpointWriteError(RuntimeError):
    code = 'CHECKPOINT_WRITE_FAILED'


_active_reply: ContextVar[_OpenReply | None] = ContextVar('_active_reply', default=None)


async def _turn_events(
    agent: LangGraphAgent,
    input_data: RunAgentInput,
    put: Callable[[Any], None],
) -> None:
    async for event in agent.run(input_data):
        if event.type != EventType.STATE_SNAPSHOT:
            put(event)
            if event.type == EventType.RUN_FINISHED:
                graph_end = getattr(agent, '_graph_ended_at', None)
                if graph_end is not None:
                    log.info('Harness Turn graph timing run_id=%s graph_end_to_completion_ms=%.3f snapshot=omitted',
                             input_data.run_id, (perf_counter() - graph_end) * 1000)


@dataclass
class _Turn:
    run_id: str
    input_data: RunAgentInput | None = None
    steering: PendingSteering = field(default_factory=PendingSteering)
    work: asyncio.Task[None] | None = None
    response_finished: bool = False
    used_tools: bool = False
    completion: RunFinishedEvent | RunErrorEvent | None = None
    stopped: bool = False
    finished: bool = False
    interrupted: bool = False

    def publish(self, event: Any, *, put: Callable[[Any], None], files: TurnFiles, feeds: TurnFeeds) -> None:
        self.used_tools |= event.type == EventType.TOOL_CALL_START
        if event.type == EventType.CUSTOM and getattr(event, 'name', None) == 'on_interrupt':
            self.interrupted = True
        if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
            self.finished = event.type == EventType.RUN_FINISHED
            self.interrupted |= getattr(getattr(event, 'outcome', None), 'type', None) == 'interrupt'
            self.completion = event
            if self.finished and not self.interrupted and not self.used_tools and not files.used and feeds.compaction is None:
                self.release(put)
            return
        put(event)

    def release(self, put: Callable[[Any], None]) -> None:
        if not self.response_finished:
            assert self.completion is not None
            self.response_finished = True
            put(self.completion)

    def failure_after_answer(self, error: Exception) -> Exception | None:
        if not self.finished:
            return None
        return CheckpointWriteError(str(error)) if self.response_finished else error

    def finished_without_interruption(self, agent: LangGraphAgent) -> bool:
        return (self.finished and not self.stopped and not self.interrupted
                and not getattr(agent, '_interrupted', False))

    def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        if self.work is not None and not self.finished:
            self.work.cancel()



class _OpenReply:
    def __init__(self) -> None:
        self.clock: message_times.ClockFrame | None = None
        self.timing_id: str | None = None
        self.started = False
        self.open_text = False
        self.message_id = ''
        self.model_message_id: str | None = None
        self.text = ''
        self.started_at = self.ended_at = 0
        self.open_thoughts: set[str] = set()
        self.thoughts: dict[str, dict[str, Any] | None] = {}
        # The tool calls started and not yet answered: the ones Stop cuts while they run.
        self.open_calls: set[str] = set()

    def create_task(self, events: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        context = copy_context()
        context.run(_active_reply.set, self)
        return asyncio.create_task(events, context=context)

    def watching(self, put: Callable[[Any], None]) -> Callable[[Any], None]:
        def watched(event: Any) -> None:
            self._watch_clock(event)
            self._watch_thought(event)
            if event.type == EventType.RUN_STARTED:
                self.started = True
            if event.type == EventType.TEXT_MESSAGE_START:
                self.open_text = True
                self.message_id, self.text = event.message_id, ''
                self.timing_id = (event.metadata or {}).get('timing_id')
                self.started_at = self.ended_at = message_times.now()
            elif event.type == EventType.TEXT_MESSAGE_END:
                self.open_text = False
            elif event.type == EventType.TEXT_MESSAGE_CONTENT:
                self.text += event.delta
                self.ended_at = message_times.now()
            elif event.type == EventType.TOOL_CALL_START:
                self.open_calls.add(event.tool_call_id)
            elif event.type == EventType.TOOL_CALL_RESULT:
                self.open_calls.discard(event.tool_call_id)
                self.message_id, self.text, self.timing_id = '', '', None
            put(event)

        return watched

    def register_thought(self, message_id: str) -> None:
        self.thoughts[message_id] = None

    def _watch_thought(self, event: Any) -> None:
        if event.type == EventType.REASONING_MESSAGE_START:
            message_id = event.message_id
            self.open_thoughts.add(message_id)
            if message_id in self.thoughts:
                at = message_times.now()
                self.thoughts[message_id] = {'id': message_id, 'started_at': at, 'ended_at': at, 'text': ''}
        elif event.type == EventType.REASONING_MESSAGE_END:
            self.open_thoughts.discard(event.message_id)
            if (thought := self.thoughts.get(event.message_id)) is not None:
                thought['ended_at'] = message_times.now()
        elif event.type == EventType.REASONING_MESSAGE_CONTENT and (thought := self.thoughts.get(event.message_id)) is not None:
            thought['text'] += event.delta

    def _watch_clock(self, event: Any) -> None:
        if event.type == EventType.STATE_DELTA:
            for operation in event.delta:
                if operation.op == 'add' and operation.path == '/worklog_clock':
                    self.clock = operation.value

    async def keep_failed(self, event: Any, agent: LangGraphAgent, session: tuple[str | None, str | None], put: Callable[[Any], None]) -> None:
        if event.type == EventType.RUN_ERROR and self.clock is not None:
            await self.keep(agent, session)
            await self.keep_clock(agent, session, put)

    def _close_messages(self, put: Callable[[Any], None]) -> None:
        for message_id in self.open_thoughts:
            put(ReasoningMessageEndEvent(message_id=message_id))
            put(ReasoningEndEvent(message_id=message_id))
        self.open_thoughts.clear()
        if self.open_text:
            put(TextMessageEndEvent(message_id=self.message_id))
            self.open_text = False

    def finish_stopped(self, put: Callable[[Any], None]) -> None:
        self._close_messages(put)
        put(_stopped())

    async def finish_cancelled(
        self, agent: LangGraphAgent, session: tuple[str | None, str | None],
        input_data: RunAgentInput, put: Callable[[Any], None], *, limited: bool,
    ) -> None:
        if limited:
            await self.finish_limited(agent, session, input_data, put)
        else:
            self.finish_stopped(put)

    async def finish_limited(
        self, agent: LangGraphAgent, session: tuple[str | None, str | None],
        input_data: RunAgentInput, put: Callable[[Any], None],
    ) -> None:
        self._close_messages(put)
        incoming = [] if self.started else agui_messages_to_langchain(input_data.messages)
        if not self.started:
            put(RunStartedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id))
        message_id = f'{input_data.run_id}-time-limit'
        message = AIMessage(
            'I ran out of time for this Turn. Send another message to continue.', id=message_id,
        )
        now = message_times.now()
        await agent.graph.aupdate_state(_session_config(session), {
            'messages': [*incoming, message_times.cut(message, now, now, [])],
        }, as_node='model')
        put(TextMessageStartEvent(message_id=message_id, role='assistant'))
        put(TextMessageContentEvent(message_id=message_id, delta=message.text))
        put(TextMessageEndEvent(message_id=message_id))
        put(RunFinishedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id))

    async def keep(self, agent: LangGraphAgent, session: tuple[str | None, str | None]) -> None:
        thoughts = [thought for thought in self.thoughts.values() if thought is not None]
        if not self.text and not thoughts:
            return
        self.message_id = self.message_id or f"{thoughts[0]['id']}-reply"
        config = _session_config(session)
        recorded = (await agent.graph.aget_state(config)).values['messages']
        if any(message.id and message.id in (self.message_id, self.model_message_id) for message in recorded):
            return
        blocks: list[ContentBlock] = [{'type': 'reasoning', 'reasoning': thought['text']} for thought in thoughts]
        if self.text:
            blocks.append({'type': 'text', 'text': self.text})
        reply = AIMessage(content_blocks=blocks, id=self.message_id)
        started = self.started_at if self.text else thoughts[0]['started_at']
        ended = self.ended_at if self.text else thoughts[-1]['ended_at']
        await agent.graph.aupdate_state(config, {'messages': [message_times.cut(reply, started, ended, thoughts, timing_id=self.timing_id)]}, as_node='model')

    async def keep_clock(self, agent: LangGraphAgent, session: tuple[str | None, str | None], put: Callable[[Any], None]) -> None:
        if self.clock is None:
            return
        clock = message_times.stop_frame(self.clock, message_times.now())
        config = _session_config(session)
        recorded = (await agent.graph.aget_state(config)).values['messages']
        question = next(message for message in recorded if isinstance(message, HumanMessage) and message.id == clock['question_id'])
        metadata = question.response_metadata
        question = question.model_copy(update={'response_metadata': {
            **metadata, MESSAGE_TIMES: {**metadata[MESSAGE_TIMES], 'worklog_clock': clock},
        }})
        await agent.graph.aupdate_state(config, {'messages': [question]}, as_node='model')
        put(StateDeltaEvent(delta=[{'op': 'add', 'path': '/worklog_clock', 'value': clock}]))

    async def answer_cut_calls(self, agent: LangGraphAgent, session: tuple[str | None, str | None]) -> None:
        """Answer each call Stop cut while it ran, timed to the Stop, in place of the saver's placeholder.

        The saver answers such a call on every load with an untimed placeholder, so a reopened Turn ended at the call's
        start. Its own words answer it here, timed: every reader of them still reads the call as cut.
        """
        if not self.open_calls:
            return
        config = _session_config(session)
        recorded = (await agent.graph.aget_state(config)).values['messages']
        answered = {message.tool_call_id for message in recorded if isinstance(message, ToolMessage) and not _unanswered(message)}
        cut = self.open_calls - answered
        if cut:
            messages = _answered(recorded, cut, message_times.now())
            await agent.graph.aupdate_state(config, {'messages': [RemoveMessage(id=REMOVE_ALL_MESSAGES), *messages]}, as_node='model')


def _answered(recorded: list[Any], cut: set[str], stopped_at: int) -> list[Any]:
    """The record with each `cut` call answered right after the message that made it, and any placeholder for it gone."""
    messages: list[Any] = []
    for message in recorded:
        if isinstance(message, ToolMessage) and message.tool_call_id in cut:
            continue
        messages.append(message)
        if isinstance(message, AIMessage):
            messages.extend(_cut_result(message, call, stopped_at) for call in message.tool_calls if call['id'] in cut)
    return messages


def _cut_result(message: AIMessage, call: ToolCall, stopped_at: int) -> ToolMessage:
    times = message.response_metadata.get(MESSAGE_TIMES) or {}
    started_at = times.get('tool_calls', {}).get(call['id'], times.get('ended_at', stopped_at))
    words = f"Tool call '{call['name']}' with id '{call['id']}' was interrupted before completion."
    return message_times.cut_call(call, words, started_at, stopped_at)


def _unanswered(message: ToolMessage) -> bool:
    """The saver's placeholder for a call that has no result (langgraph-checkpoint-aws), as ag_ui_langgraph reads it."""
    return isinstance(message.content, str) and LangGraphAgent._ORPHAN_TOOL_MSG_RE.match(message.content) is not None


def _stopped() -> RunErrorEvent:
    return RunErrorEvent(message='The Turn was stopped, or a newer Turn on this Session replaced it', code='TURN_STOPPED')



def _session_config(session: tuple[str | None, str | None]) -> RunnableConfig:
    session_user_id, thread_id = session
    return {'configurable': {'thread_id': thread_id, **({'actor_id': session_user_id} if session_user_id is not None else {})}}



class AnsweredToolResultsMiddleware(AgentMiddleware):
    """Sends the model only the first recorded result of each tool call.

    A Session recorded before SessionAgent's guard can hold a resent result after
    its call was answered, and Bedrock refuses every later Turn on it. The
    record keeps that result; only the model's request leaves it out. Read the
    first result's identity from the full state because native summarization
    can remove it from the request while keeping the replayed result.
    """
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        first_results: dict[str, str | None] = {}
        for message in request.state['messages']:
            if isinstance(message, ToolMessage):
                first_results.setdefault(message.tool_call_id, message.id)
        messages = [
            message for message in request.messages
            if not isinstance(message, ToolMessage) or message.id == first_results[message.tool_call_id]
        ]
        return await handler(request.override(messages=messages))

