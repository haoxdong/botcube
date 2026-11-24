from __future__ import annotations

import threading
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.base import empty_checkpoint

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory, fresh_warm_sessions
from botcube_harness_deepagents import serving
from botcube_harness_deepagents.memory.agentcore.warm_session import WarmSessionSaver
from test_finished_session_reuse import _turn
from test_serving import _replay, _Service

pytest_plugins = ('test_serving', 'test_finished_session_reuse')


@pytest.mark.parametrize('populated', [False, True])
def test_scoped_history_is_available_while_graph_builds(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, populated: bool,
) -> None:
    questions = [f'Past question {i}: ' + 'history ' * 200 for i in range(100)] if populated else []
    if populated:
        checkpoint = empty_checkpoint()
        checkpoint['channel_values'] = {'messages': [
            message for i, question in enumerate(questions)
            for message in (HumanMessage(question, id=f'q-{i}'), AIMessage(f'Answer {i}', id=f'a-{i}'))
        ]}
        checkpoint['channel_versions'] = {'messages': '1'}
        WarmSessionSaver(MEMORY_ID, memory).put(
            {'configurable': {'thread_id': 'thread-1', 'actor_id': 'user-1'}},
            checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'},
        )
        fresh_warm_sessions(monkeypatch)
    reading = threading.Event()
    read = memory.list_events
    build = serving.build_agent

    def observed(**params: Any) -> Any:
        result = read(**params)
        if params['sessionId'] == 'thread-1':
            reading.set()
        return result

    def needs_history(**kwargs: Any) -> Any:
        assert reading.wait(2), 'Scoped checkpoint read waited for graph construction'
        return build(**kwargs)

    monkeypatch.setattr(memory, 'list_events', observed)
    monkeypatch.setattr(serving, 'build_agent', needs_history)
    events = _turn(service, 'continue')
    assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
    assert service.recorder.heard[-1] == [*questions, 'continue']
    assert _replay('user-1', 'thread-1')[-2:] == [('user', 'continue'), ('assistant', 'Echo: continue')]


@pytest.mark.parametrize('failure', ['read', 'graph'])
def test_failed_overlapped_preparation_never_calls_model_and_next_turn_recovers(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, failure: str,
) -> None:
    reading, building = threading.Event(), threading.Event()
    read, build = memory.list_events, serving.build_agent

    def failing_read(**params: Any) -> Any:
        reading.set()
        assert building.wait(2), 'Graph construction never started'
        if failure == 'read':
            raise ConnectionError('Initial checkpoint unavailable')
        return read(**params)

    def failing_graph(**kwargs: Any) -> Any:
        building.set()
        assert reading.wait(2), 'Scoped read waited for graph construction'
        if failure == 'graph':
            raise RuntimeError('Graph unavailable')
        return build(**kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(memory, 'list_events', failing_read)
        patch.setattr(serving, 'build_agent', failing_graph)
        failed = _turn(service, 'never execute')
    assert failed[-1]['type'] == 'RUN_ERROR'
    assert failed[-1]['message'] == ('Initial checkpoint unavailable' if failure == 'read' else 'Graph unavailable')
    assert service.recorder.heard == []
    assert _turn(service, 'recover', 'epoch-2')[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.heard == [['recover']]


def test_superseded_credential_worker_cannot_read_or_revoke_newer_snapshot(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from botcube_harness_deepagents.memory import agentcore

    waiting, release = threading.Event(), threading.Event()
    exchange = agentcore.turn_memory
    calls = 0

    def held(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 1:
            waiting.set()
            assert release.wait(5), 'The superseded credential worker was never released'
        return exchange(*args, **kwargs)

    monkeypatch.setattr(agentcore, 'turn_memory', held)
    with ThreadPoolExecutor(max_workers=1) as pool:
        older = pool.submit(_turn, service, 'obsolete')
        try:
            assert waiting.wait(5)
            assert _turn(service, 'replacement')[-1]['type'] == 'RUN_FINISHED'
            service.fed()
            with monkeypatch.context() as patch:
                def late_read(**params: Any) -> Any:
                    raise ConnectionError('A superseded Turn attempted a checkpoint read')
                patch.setattr(memory, 'list_events', late_read)
                release.set()
                assert older.result(timeout=5)[-1]['code'] == 'TURN_STOPPED'
        finally:
            release.set()
    memory.listed.clear()
    assert _turn(service, 'continue')[-1]['type'] == 'RUN_FINISHED'
    assert memory.listed['thread-1'] == 0
    assert service.recorder.heard == [['replacement'], ['replacement', 'continue']]


def test_superseded_graph_failure_cannot_revoke_replacement_snapshot(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from concurrent.futures import ThreadPoolExecutor

    built, read, release = threading.Event(), threading.Event(), threading.Event()
    build, initial = serving._agent_and_backend, serving._SESSION_TURNS.read_checkpoint
    calls = 0

    def held_build(**kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        first = calls == 1
        result = build(**kwargs)
        if first:
            built.set()
            assert release.wait(5), 'The failed graph build was never released'
            raise RuntimeError('Graph failed after initial read')
        return result

    async def observed_read(*args: Any, **kwargs: Any) -> Any:
        saved = await initial(*args, **kwargs)
        read.set()
        return saved

    monkeypatch.setattr(serving, '_agent_and_backend', held_build)
    monkeypatch.setattr(serving._SESSION_TURNS, 'read_checkpoint', observed_read)
    with ThreadPoolExecutor(max_workers=1) as pool:
        older = pool.submit(_turn, service, 'obsolete')
        try:
            assert built.wait(5) and read.wait(5)
            assert _turn(service, 'replacement')[-1]['type'] == 'RUN_FINISHED'
            service.fed()
        finally:
            release.set()
        assert older.result(timeout=5)[-1]['message'] == 'Graph failed after initial read'
    memory.listed.clear()
    assert _turn(service, 'continue')[-1]['type'] == 'RUN_FINISHED'
    assert memory.listed['thread-1'] == 0
    assert service.recorder.heard == [['replacement'], ['replacement', 'continue']]
