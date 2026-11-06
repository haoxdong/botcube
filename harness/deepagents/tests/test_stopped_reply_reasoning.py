"""A Turn stopped after its reply began keeps the reply's thought, as the user saw it."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, cast

from ag_ui.core import (
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    TextMessageContentEvent,
    TextMessageStartEvent,
)

from botcube_harness_deepagents import message_times
from botcube_harness_deepagents.conversation import conversation
from botcube_harness_deepagents.turn_state import _OpenReply


class _Graph:
    """The agent's graph as `_OpenReply.keep` uses it: what is recorded, and what it records."""

    def __init__(self) -> None:
        self.recorded: list[Any] = []

    async def aget_state(self, _config: Any) -> Any:
        return SimpleNamespace(values={'messages': list(self.recorded)})

    async def aupdate_state(self, _config: Any, update: dict[str, Any], as_node: str) -> None:
        assert as_node == 'model'
        self.recorded.extend(update['messages'])


def test_a_reply_stopped_after_its_thought_replays_with_that_thought(monkeypatch: Any) -> None:
    clock = iter([1000, 1400, 1500, 1600])
    monkeypatch.setattr(message_times, 'now', lambda: next(clock))
    reply = _OpenReply()
    watched = reply.watching(lambda _event: None)
    watched(ReasoningMessageStartEvent(message_id='thought-1', role='reasoning'))
    watched(ReasoningMessageEndEvent(message_id='thought-1'))
    watched(TextMessageStartEvent(message_id='answer-1', role='assistant'))
    watched(TextMessageContentEvent(message_id='answer-1', delta='Prime numbers have'))
    graph = _Graph()

    asyncio.run(reply.keep(cast(Any, SimpleNamespace(graph=graph)), ('user-1', 'thread-1')))

    replayed = conversation(graph.recorded)
    assert [(message['role'], message['id']) for message in replayed] == [('reasoning', 'thought-1'), ('assistant', 'answer-1')]
    assert replayed[0]['metadata'] == {'started_at': 1000, 'ended_at': 1400}
    assert replayed[1]['metadata'] == {'started_at': 1500, 'ended_at': 1600}
