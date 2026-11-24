"""A Turn stopped after its reply began keeps the reply's thought, as the user saw it."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ag_ui.core import (
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    RunAgentInput,
    TextMessageContentEvent,
    TextMessageStartEvent,
)

from botcube_harness_deepagents import message_times
from botcube_harness_deepagents.conversation import conversation
from botcube_harness_deepagents.definition import InvocationContext
from botcube_harness_deepagents.turn_lifecycle import SessionTurns, observe_reply_model
from conftest import prepared


class _Graph:
    def __init__(self) -> None:
        self.recorded: list[Any] = []

    async def aget_state(self, _config: Any) -> Any:
        return SimpleNamespace(values={'messages': list(self.recorded)})

    async def aupdate_state(self, _config: Any, update: dict[str, Any], as_node: str) -> None:
        assert as_node == 'model'
        self.recorded.extend(update['messages'])


def _stopped_reply(events: list[Any], root: Path) -> list[dict[str, Any]]:
    session = ('user-1', 'thread-1')
    turns = SessionTurns()
    graph = _Graph()
    request = RunAgentInput(thread_id=session[1], run_id='run-1', messages=[], tools=[], context=[], state={})

    async def run(_request: RunAgentInput) -> AsyncIterator[Any]:
        observe_reply_model({'event': 'on_chat_model_start', 'run_id': 'root'})
        for event in events:
            yield event
        await asyncio.Event().wait()

    async def exercise() -> None:
        agent = SimpleNamespace(graph=graph, run=run)
        received = []
        async for event in turns.stream(session, prepared(agent, root), request, None, InvocationContext(None)):
            received.append(event)
            if event is events[-1]:
                turns.stop(session, request.run_id)
        assert received[-1].code == 'TURN_STOPPED'

    asyncio.run(exercise())
    return conversation(graph.recorded)


def test_a_reply_stopped_after_its_thought_replays_with_that_thought(monkeypatch: Any, tmp_path: Path) -> None:
    clock = iter([1000, 1400, 1500, 1600])
    monkeypatch.setattr(message_times, 'now', lambda: next(clock))
    replayed = _stopped_reply([
        ReasoningMessageStartEvent(message_id='root-reasoning-0', role='reasoning'),
        ReasoningMessageEndEvent(message_id='root-reasoning-0'),
        TextMessageStartEvent(message_id='answer-1', role='assistant'),
        TextMessageContentEvent(message_id='answer-1', delta='Prime numbers have'),
    ], tmp_path)
    assert [(message['role'], message['id']) for message in replayed] == [('reasoning', 'root-reasoning-0'), ('assistant', 'answer-1')]
    assert replayed[0]['metadata'] == {'started_at': 1000, 'ended_at': 1400}
    assert replayed[1]['metadata'] == {'started_at': 1500, 'ended_at': 1600}


def test_a_reasoning_only_stop_keeps_the_thought_without_inventing_answer_text(monkeypatch: Any, tmp_path: Path) -> None:
    from ag_ui.core import ReasoningMessageContentEvent

    clock = iter([1000, 1800])
    monkeypatch.setattr(message_times, 'now', lambda: next(clock))
    replayed = _stopped_reply([
        ReasoningMessageStartEvent(message_id='root-reasoning-0', role='reasoning'),
        ReasoningMessageContentEvent(message_id='root-reasoning-0', delta='Compare the bond durations'),
        ReasoningMessageEndEvent(message_id='root-reasoning-0'),
    ], tmp_path)
    thought, answer = replayed
    assert (thought['role'], thought['id'], thought['content']) == (
        'reasoning', 'root-reasoning-0', 'Compare the bond durations',
    )
    assert thought['metadata'] == {'started_at': 1000, 'ended_at': 1800}
    assert answer['content'] == ''
