from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from ag_ui.core import EventType, RunAgentInput
from botcube_cartridge import InvocationAuth, ModelRelay
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver

from botcube_harness_deepagents import serving
from botcube_harness_deepagents.agent import build_agent
from conftest import ToolBindableFakeMessagesModel

EPOCH = 1_700_000_000


class StreamingToolModel(ToolBindableFakeMessagesModel):
    def _stream(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        message = self._generate(messages).generations[0].message
        assert isinstance(message, AIMessage)
        yield ChatGenerationChunk(message=AIMessageChunk(content=message.text, tool_call_chunks=[
            {'name': call['name'], 'args': json.dumps(call['args']), 'id': call['id'], 'index': index}
            for index, call in enumerate(message.tool_calls)
        ]))


def _relay(expires_at: int) -> ModelRelay:
    payload = base64.urlsafe_b64encode(json.dumps({'expires_at': expires_at}).encode()).decode().rstrip('=')
    return ModelRelay('https://relay.invalid', f'v1.{payload}.synthetic-signature', {}, 'session')


def _input(run: str) -> RunAgentInput:
    return RunAgentInput(thread_id='session', run_id=run, messages=[
        {'id': run, 'role': 'user', 'content': 'Continue the work'},
    ], tools=[], context=[], state={}, forwarded_props={})


async def _pause(phase: str, started: asyncio.Event, release: asyncio.Event, cancelled: list[bool]) -> None:
    if phase == 'tool':
        started.set()
    asyncio.get_running_loop().call_later(3602, release.set)
    try:
        await release.wait()
    except asyncio.CancelledError:
        cancelled.append(True)
        raise


def _model(phase: str, pause: Callable[[], Awaitable[None]]) -> StreamingToolModel:
    class Model(StreamingToolModel):
        async def _astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
            for chunk in self._stream(*args, **kwargs):
                yield chunk
                if phase == 'text' and chunk.message.text == 'Working':
                    await pause()

    return Model(responses=[
        AIMessage('Working', tool_calls=[{'id': 'slow-call', 'name': 'slow_work', 'args': {}}] if phase == 'tool' else []),
        AIMessage('Done'),
    ])


async def _collect(run: str, relay: ModelRelay, started: asyncio.Event | None) -> list[Any]:
    events = []
    async for event in serving._invoke_agent(
        _input(run), serving._RequestContext(None), {},
        InvocationAuth('owner', False, None, relay), 'owner', None, None, False, None,
    ):
        events.append(event)
        if started is not None and event.type == EventType.TEXT_MESSAGE_CONTENT and event.delta == 'Working':
            started.set()
    return events


def _assert_closed_replies(events: list[Any]) -> None:
    opened = None
    for event in events:
        if event.type == EventType.TEXT_MESSAGE_START:
            assert opened is None
            opened = event.message_id
        elif event.type == EventType.TEXT_MESSAGE_END:
            assert opened == event.message_id
            opened = None
    assert opened is None


@pytest.mark.parametrize('phase', ['tool', 'text'])
@pytest.mark.parametrize('advance', [3540, 3601], ids=['deadline', 'crossed'])
def test_turn_crossing_the_token_limit_finishes_with_a_persisted_answer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str, advance: int,
) -> None:
    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(
        skills=(), apply_session_id=lambda *args: None,
    ))

    async def exercise() -> None:
        loop = asyncio.get_running_loop()
        monotonic = loop.time
        clock = {'seconds': 0}
        monkeypatch.setattr(loop, 'time', lambda: monotonic() + clock['seconds'])
        monkeypatch.setattr('time.time', lambda: EPOCH + clock['seconds'])
        started, release = asyncio.Event(), asyncio.Event()
        cancelled = []

        async def pause() -> None:
            await _pause(phase, started, release, cancelled)

        @tool
        async def slow_work() -> str:
            """Wait for work to complete."""
            await pause()
            return 'Completed'

        model = _model(phase, pause)
        graph = build_agent(model=model, tools=[slow_work], backend=None, skills=(), checkpointer=MemorySaver(),
                            middleware=[serving.SteeringMiddleware()])
        agent = serving._SessionAgent(name='test', graph=graph, config={'configurable': {'actor_id': 'owner'}})
        monkeypatch.setattr(serving, '_SESSION_TURNS', serving._SessionTurns())
        monkeypatch.setattr(serving, '_agent_and_backend', lambda **kwargs: (agent, SimpleNamespace(cwd=tmp_path)))

        async def collect(run: str, relay: ModelRelay) -> list[Any]:
            return await _collect(run, relay, started if phase == 'text' else None)

        running = asyncio.create_task(collect('long', _relay(EPOCH + 3600)))
        admitted = asyncio.create_task(started.wait())
        await asyncio.wait([admitted, running], return_when=asyncio.FIRST_COMPLETED)
        admitted.cancel()
        assert started.is_set(), await running
        clock['seconds'] = advance
        events = await running
        assert cancelled == [True]
        assert events[-1].type == EventType.RUN_FINISHED
        assert not [event for event in events if event.type == EventType.RUN_ERROR]
        assert ''.join(event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT).endswith(
            'I ran out of time for this Turn. Send another message to continue.',
        )
        state = await graph.aget_state({'configurable': {'thread_id': 'session', 'actor_id': 'owner'}})
        assert state.values['messages'][-1].content == 'I ran out of time for this Turn. Send another message to continue.'
        assert [message.tool_call_id for message in state.values['messages'] if isinstance(message, ToolMessage)] == (
            ['slow-call'] if phase == 'tool' else []
        )
        _assert_closed_replies(events)
        assert not state.next
        following = await collect('next', _relay(EPOCH + 7201))
        assert following[-1].type == EventType.RUN_FINISHED
        assert ''.join(event.delta for event in following if event.type == EventType.TEXT_MESSAGE_CONTENT) == 'Done'
        print(f'{phase} at {advance} s: RUN_FINISHED; timeout answer persisted; next Turn succeeds')

    asyncio.run(exercise())


def test_an_expired_invocation_keeps_the_user_message_and_streams_a_complete_answer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr('time.time', lambda: EPOCH)
    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(
        skills=(), apply_session_id=lambda *args: None,
    ))
    graph = build_agent(model=StreamingToolModel(responses=[AIMessage('Unexpected model call')]),
                        backend=None, skills=(), checkpointer=MemorySaver())
    agent = serving._SessionAgent(name='test', graph=graph, config={'configurable': {'actor_id': 'owner'}})
    monkeypatch.setattr(serving, '_SESSION_TURNS', serving._SessionTurns())
    monkeypatch.setattr(serving, '_agent_and_backend', lambda **kwargs: (agent, SimpleNamespace(cwd=tmp_path)))

    async def exercise() -> None:
        events = [event async for event in serving._invoke_agent(
            _input('expired'), serving._RequestContext(None), {},
            InvocationAuth('owner', False, None, _relay(EPOCH - 1)), 'owner', None, None, False, None,
        )]
        assert events[0].type == EventType.RUN_STARTED
        assert events[-1].type == EventType.RUN_FINISHED
        state = await graph.aget_state({'configurable': {'thread_id': 'session', 'actor_id': 'owner'}})
        assert [message.content for message in state.values['messages']] == [
            'Continue the work', 'I ran out of time for this Turn. Send another message to continue.',
        ]

    asyncio.run(exercise())
