"""A Turn ends at the checkpoint of its answering model step, which is the Session's whole record."""
from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from langchain_core.messages import AIMessage

from agentcore_fake import FakeAgentCoreMemory, another_microvm, fresh_warm_sessions
from botcube_harness_deepagents import session_api
from botcube_harness_deepagents.memory.agentcore import warm_session
from test_finished_session_reuse import _turn
from test_serving import _replay, _Service

pytest_plugins = ('test_serving', 'test_finished_session_reuse')

V1_CREATE_EVENT_SECONDS = 0.075


@pytest.fixture
def answered_checkpoints(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Stored checkpoints whose messages end in each answer, by answer text."""
    counts: dict[str, int] = {}
    store = warm_session.WarmSessionSaver.put_with_writes

    def stored(self: warm_session.WarmSessionSaver, config: Any, checkpoint: Any, *args: Any, **kwargs: Any) -> Any:
        last = (checkpoint['channel_values'].get('messages') or [None])[-1]
        if isinstance(last, AIMessage) and not last.tool_calls:
            counts[last.text] = counts.get(last.text, 0) + 1
        return store(self, config, checkpoint, *args, **kwargs)

    monkeypatch.setattr(warm_session.WarmSessionSaver, 'put_with_writes', stored)
    return counts


def _memory_read(user: str, thread: str) -> Any:
    session_api._GRAPH = None
    graph = session_api._graph()
    return asyncio.run(graph.aget_state(session_api._config(user, thread)))


def _fed_answers(memory: FakeAgentCoreMemory) -> list[str]:
    return [item['conversational']['content']['text'] for events in memory.events.values() for event in events
            for item in event['payload'] if item.get('conversational', {}).get('role') == 'ASSISTANT']


@pytest.mark.parametrize('persistent_memory', [False, True], ids=['guest', 'member'])
@pytest.mark.parametrize(('ask', 'answer'), [('first', 'Echo: first'), ('steps: 2', 'Done after 2 steps')],
                         ids=['answer', 'tools'])
def test_a_turn_stores_its_answer_in_one_checkpoint_its_last(
    service: _Service, memory: FakeAgentCoreMemory, answered_checkpoints: dict[str, int],
    persistent_memory: bool, ask: str, answer: str,
) -> None:
    assert _turn(service, ask, memory=persistent_memory)[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    assert answered_checkpoints == {answer: 1}
    assert _memory_read('user-1', 'thread-1').next == ()
    assert _fed_answers(memory) == ([answer] if persistent_memory else [])


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
