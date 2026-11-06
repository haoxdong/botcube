"""The Turn feed: a completed Turn's messages feed AgentCore extraction (ADR 0032 §7)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from functools import partial
from typing import Any
from uuid import uuid4

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, BaseMessage
from langgraph.store.base import BaseStore

# AgentCore's CreateEvent takes at most this many characters of conversational text.
MESSAGE_TEXT_LIMIT = 100_000
_FED_TYPES = ('human', 'ai', 'tool')

TurnFeed = Callable[[], Awaitable[None]]
_FEEDS: ContextVar[list[TurnFeed] | None] = ContextVar('turn_feeds', default=None)


class TurnFeedError(RuntimeError):
    """A completed Turn could not feed AgentCore extraction."""

    code = 'TURN_FEED_FAILED'


@contextmanager
def collecting_turn_feeds() -> Iterator[list[TurnFeed]]:
    """Collect the feeds of the graph runs started inside, for the caller to run after the response."""
    feeds: list[TurnFeed] = []
    token = _FEEDS.set(feeds)
    try:
        yield feeds
    finally:
        _FEEDS.reset(token)


def defer_turn_work(work: TurnFeed) -> None:
    feeds = _FEEDS.get()
    if feeds is None:
        raise TurnFeedError('A Turn ran outside collecting_turn_feeds, so its deferred work would be lost')
    feeds.append(work)


class AnswerMiddleware(AgentMiddleware):
    """Middleware that acts on the agent's state once a model step answers the Turn."""

    def after_answer(self, state: dict[str, Any], runtime: Any) -> None:
        raise NotImplementedError

    def wrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        response = handler(request)
        if (state := answered_state(request, response)) is not None:
            self.after_answer(state, request.runtime)
        return response

    async def awrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        response = await handler(request)
        if (state := answered_state(request, response)) is not None:
            self.after_answer(state, request.runtime)
        return response


def answered_state(request: ModelRequest[Any], response: ModelResponse[Any]) -> dict[str, Any] | None:
    """The agent's final state when `response` calls no tool, else None.

    LangChain routes a model response that calls no tool to the agent's exit.
    """
    if any(isinstance(message, AIMessage) and message.tool_calls for message in response.result):
        return None
    return {**request.state, 'messages': [*request.state['messages'], *response.result]}


class TurnMemoryMiddleware(AnswerMiddleware):
    """Hand the completed Turn's messages to the Turn's caller, which feeds them off the response path."""

    def __init__(self, *, actor_id: str, session_id: str) -> None:
        self.actor_id = actor_id
        self.session_id = session_id

    def after_answer(self, state: dict[str, Any], runtime: Any) -> None:
        if (store := runtime.store) is None:
            raise TurnFeedError('A Turn ran without its Memory store, so its feed would be lost')
        defer_turn_work(partial(feed_turn, store, (self.actor_id, self.session_id),
                                latest_turn_messages(state['messages'])))


def latest_turn_messages(messages: Sequence[Any]) -> list[BaseMessage]:
    typed = [message for message in messages if isinstance(message, BaseMessage)]
    human_indexes = [index for index, message in enumerate(typed) if message.type == 'human']
    if not human_indexes:
        return []
    return [message for message in typed[human_indexes[-1]:] if message.type in _FED_TYPES]


async def feed_turn(store: BaseStore, namespace: tuple[str, str], messages: Sequence[BaseMessage]) -> None:
    """One conversational event per message, untrimmed, in order.

    Messages without text, as assistant messages that only call tools, feed nothing:
    the store's converter would skip them.
    """
    fed = [message for message in messages if message.text.strip()]
    for message in fed:
        if len(message.text) > MESSAGE_TEXT_LIMIT:
            raise TurnFeedError(
                f'A {message.type} message of {len(message.text)} characters is over AgentCore\'s '
                f'{MESSAGE_TEXT_LIMIT}-character limit, so the Turn was not fed to Memory'
            )
    for message in fed:
        try:
            await store.aput(namespace, str(uuid4()), {'message': message})
        except Exception as failure:
            raise TurnFeedError(f'The Turn could not be fed to Memory: {failure}') from failure
