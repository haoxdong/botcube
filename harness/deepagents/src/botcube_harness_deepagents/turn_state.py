from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ag_ui.core import (
    EventType,
    ReasoningEndEvent,
    ReasoningMessageEndEvent,
    RunErrorEvent,
)
from ag_ui_langgraph import LangGraphAgent
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, RemoveMessage, ToolCall, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from . import message_times
from .conversation import MESSAGE_TIMES
from .steering import PendingSteering


@dataclass
class _Turn:
    run_id: str
    steering: PendingSteering = field(default_factory=PendingSteering)
    work: asyncio.Task[None] | None = None
    stopped: bool = False
    finished: bool = False
    interrupted: bool = False

    def observe(self, event: Any) -> None:
        if event.type == EventType.CUSTOM and getattr(event, 'name', None) == 'on_interrupt':
            self.interrupted = True
        if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
            self.finished = event.type == EventType.RUN_FINISHED
            self.interrupted |= getattr(getattr(event, 'outcome', None), 'type', None) == 'interrupt'

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
    """The text the run's model call is streaming: Stop cancels the call before LangGraph records it.

    The text ends before the call does when the model goes on to a tool call, so
    only the tool's result, which follows the recorded call, closes the reply.
    """

    def __init__(self) -> None:
        self.message_id = ''
        self.text = ''
        self.started_at = self.ended_at = 0
        self.open_thoughts: set[str] = set()
        # This model call's thoughts as they streamed, so a kept reply replays them as the user saw them.
        self.thoughts: list[dict[str, Any]] = []
        # The tool calls started and not yet answered: the ones Stop cuts while they run.
        self.open_calls: set[str] = set()

    def watching(self, put: Callable[[Any], None]) -> Callable[[Any], None]:
        def watched(event: Any) -> None:
            if event.type == EventType.REASONING_MESSAGE_START:
                self.open_thoughts.add(event.message_id)
                at = message_times.now()
                self.thoughts.append({'id': event.message_id, 'started_at': at, 'ended_at': at})
            elif event.type == EventType.REASONING_MESSAGE_END:
                self.open_thoughts.discard(event.message_id)
                at = message_times.now()
                for thought in self.thoughts:
                    if thought['id'] == event.message_id:
                        thought['ended_at'] = at
            elif event.type == EventType.TEXT_MESSAGE_START:
                self.message_id, self.text = event.message_id, ''
                self.started_at = self.ended_at = message_times.now()
            elif event.type == EventType.TEXT_MESSAGE_CONTENT:
                self.text += event.delta
                self.ended_at = message_times.now()
            elif event.type == EventType.TOOL_CALL_START:
                self.open_calls.add(event.tool_call_id)
            elif event.type == EventType.TOOL_CALL_RESULT:
                self.open_calls.discard(event.tool_call_id)
                self.message_id, self.text = '', ''
                self.thoughts = []
            put(event)

        return watched

    def finish_stopped(self, put: Callable[[Any], None]) -> None:
        for message_id in self.open_thoughts:
            put(ReasoningMessageEndEvent(message_id=message_id))
            put(ReasoningEndEvent(message_id=message_id))
        self.open_thoughts.clear()
        put(_stopped())

    async def keep(self, agent: LangGraphAgent, session: tuple[str | None, str | None]) -> None:
        """Record the text the user already read as the agent's answer, under its streamed ID."""
        if not self.text:
            return
        config = _session_config(session)
        recorded = (await agent.graph.aget_state(config)).values['messages']
        # A model call that finished, as one whose tool Stop cut short, is already recorded;
        # the saver follows its unanswered calls with placeholder results on load.
        if any(message.id == self.message_id for message in recorded):
            return
        reply = AIMessage(self.text, id=self.message_id)
        await agent.graph.aupdate_state(config, {'messages': [message_times.cut(reply, self.started_at, self.ended_at, self.thoughts)]}, as_node='model')


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

    A Session recorded before _SessionAgent's guard can hold a resent result after
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

