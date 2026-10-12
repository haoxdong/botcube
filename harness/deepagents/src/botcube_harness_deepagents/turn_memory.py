"""The Turn feed: a completed Turn's messages feed AgentCore extraction (ADR 0032 §7)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from functools import partial
from typing import Any
from uuid import uuid4

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import BaseMessage
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


class TurnMemoryMiddleware(AgentMiddleware):
    """Hand the completed Turn's messages to the Turn's caller, which feeds them off the response path."""

    def __init__(self, *, actor_id: str, session_id: str) -> None:
        self.actor_id = actor_id
        self.session_id = session_id

    async def aafter_agent(self, state: Any, runtime: Any) -> None:
        feeds = _FEEDS.get()
        if feeds is None:
            raise TurnFeedError('A Turn ran outside collecting_turn_feeds, so its feed would be lost')
        feeds.append(partial(feed_turn, runtime.store, (self.actor_id, self.session_id),
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
