"""A Turn ends at the checkpoint of its answering model step, which is the Session's whole record."""
from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from agentcore_fake import FakeAgentCoreMemory, another_microvm, fresh_warm_sessions
from botcube_harness_deepagents import serving, session_api
from botcube_harness_deepagents.memory.agentcore import warm_session
from test_finished_session_reuse import _turn
from test_serving import _replay, _ScriptedModel, _Service

pytest_plugins = ('test_serving', 'test_finished_session_reuse')

V1_CREATE_EVENT_SECONDS = 0.075


def _tool_ids(messages: list[Any]) -> list[str]:
    return [message.tool_call_id for message in messages if isinstance(message, ToolMessage)]


def _memory_read(user: str, thread: str) -> Any:
    session_api._GRAPH = None
    graph = session_api._graph()
    return asyncio.run(graph.aget_state(session_api._config(user, thread)))


def _fed_answers(memory: FakeAgentCoreMemory) -> list[str]:
    return [item['conversational']['content']['text'] for events in memory.events.values() for event in events
            for item in event['payload'] if item.get('conversational', {}).get('role') == 'ASSISTANT']


def test_the_memory_a_turn_leaves_when_its_stream_ends_is_its_finished_record(
    service: _Service, memory: FakeAgentCoreMemory,
) -> None:
    memory.latency = V1_CREATE_EVENT_SECONDS
    before = time.time()
    assert _turn(service, 'first', memory=True)[-1]['type'] == 'RUN_FINISHED'
    read = _memory_read('user-1', 'thread-1')
    assert read.next == ()
    assert [message.text for message in read.values['messages']] == ['first', 'Echo: first']
    assert read.values['last_model_call_at'] >= before


def test_a_next_turn_sent_as_the_stream_ends_hears_the_finished_turn(
    service: _Service, memory: FakeAgentCoreMemory,
) -> None:
    memory.latency = V1_CREATE_EVENT_SECONDS
    assert _turn(service, 'first', memory=True)[-1]['type'] == 'RUN_FINISHED'
    assert _turn(service, 'second', memory=True)[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    assert service.recorder.heard[-1] == ['first', 'second']
    assert _replay('user-1', 'thread-1') == [
        ('user', 'first'), ('assistant', 'Echo: first'), ('user', 'second'), ('assistant', 'Echo: second'),
    ]


def test_a_stop_after_the_stream_ends_keeps_the_finished_turn(
    service: _Service, memory: FakeAgentCoreMemory,
) -> None:
    memory.latency = V1_CREATE_EVENT_SECONDS
    _turn(service, 'first', memory=True)
    stopped = service.client.post('/invocations', json={
        'threadId': 'thread-1', 'runId': 'run-0', 'messages': [], 'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'stop': True, 'sessionUserId': 'user-1'},
    })
    assert stopped.status_code == 200
    _turn(service, 'second', memory=True)
    service.fed()
    assert service.recorder.heard[-1] == ['first', 'second']
    assert _replay('user-1', 'thread-1')[-2:] == [('user', 'second'), ('assistant', 'Echo: second')]


def test_a_restarted_microvm_resumes_from_the_record_the_finished_stream_left(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory.latency = V1_CREATE_EVENT_SECONDS
    _turn(service, 'first', memory=True)
    another_microvm()
    fresh_warm_sessions(monkeypatch)
    _turn(service, 'second', memory=True)
    service.fed()
    assert service.recorder.heard[-1] == ['first', 'second']
    assert _replay('user-1', 'thread-1') == [
        ('user', 'first'), ('assistant', 'Echo: first'), ('user', 'second'), ('assistant', 'Echo: second'),
    ]


@pytest.mark.parametrize('persistent_memory', [False, True], ids=['guest', 'member'])
@pytest.mark.parametrize('steps', [0, 1, 3])
def test_a_turn_saves_each_model_and_tool_step(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, steps: int, persistent_memory: bool,
) -> None:
    saved: list[tuple[int, int]] = []
    store = warm_session.WarmSessionSaver.put_with_writes

    def stored(self: Any, config: Any, checkpoint: Any, *args: Any, **kwargs: Any) -> Any:
        result = store(self, config, checkpoint, *args, **kwargs)
        messages = checkpoint['channel_values'].get('messages', [])
        saved.append((sum(isinstance(m, AIMessage) for m in messages),
                      len(_tool_ids(messages))))
        return result

    monkeypatch.setattr(warm_session.WarmSessionSaver, 'put_with_writes', stored)
    assert _turn(service, f'steps: {steps}', memory=persistent_memory)[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    assert _fed_answers(memory) == ([f'Done after {steps} steps'] if persistent_memory else [])
    assert _memory_read('user-1', 'thread-1').next == ()
    for step in range(1, steps + 1):
        assert (step, step - 1) in saved
        assert (step, step) in saved
    assert saved[-1] == (steps + 1, steps)


def test_a_failed_turn_resumes_after_its_completed_tool_step(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _ScriptedModel._step_reply
    stored = warm_session.WarmSessionSaver.put_with_writes
    completed = threading.Event()
    before_crash: list[str] = []

    def checkpointed(self: Any, config: Any, checkpoint: Any, *args: Any, **kwargs: Any) -> Any:
        result = stored(self, config, checkpoint, *args, **kwargs)
        if len(_tool_ids(checkpoint['channel_values'].get('messages', []))) == 2:
            completed.set()
        return result

    monkeypatch.setattr(warm_session.WarmSessionSaver, 'put_with_writes', checkpointed)

    def crash(self: Any, messages: Any, turn_start: int, steps: int) -> Any:
        if len(_tool_ids(messages[turn_start:])) == 2:
            assert completed.wait(5), 'Tool step 2 was not persisted while the next model step ran'
            before_crash.extend(_tool_ids(_memory_read('user-1', 'thread-1').values['messages']))
            raise RuntimeError('crash after tool step 2')
        return reply(self, messages, turn_start, steps)

    with monkeypatch.context() as patch:
        patch.setattr(_ScriptedModel, '_step_reply', crash)
        assert _turn(service, 'steps: 3')[-1]['type'] == 'RUN_ERROR'
    assert len(before_crash) == 2
    another_microvm()
    fresh_warm_sessions(monkeypatch)
    state = _memory_read('user-1', 'thread-1')
    assert len(_tool_ids(state.values['messages'])) == 2
    assert state.next == ('model',)
    graph = serving.build_agent(
        model=_ScriptedModel(recorder=service.recorder), backend=None, skills=[],
        checkpointer=warm_session.WarmSessionSaver(
            session_api.AGENTCORE_MEMORY_ID, memory,
        ),
    )

    async def resume() -> Any:
        config = {'configurable': {'thread_id': 'thread-1', 'actor_id': 'user-1'}}
        async for _ in graph.astream(None, config, stream_mode='messages'):
            pass
        return await graph.aget_state(config)

    resumed = asyncio.run(resume())
    assert resumed.next == ()
    assert resumed.values['messages'][-1].text == 'Done after 3 steps'
    assert _tool_ids(resumed.values['messages'])[:2] == _tool_ids(state.values['messages'])
    assert len(_tool_ids(resumed.values['messages'])) == 3
