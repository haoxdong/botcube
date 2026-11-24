from __future__ import annotations

import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from typing import Any

import pytest

from botcube_harness_deepagents import serving, session_memory
from botcube_harness_deepagents.memory import agentcore
from test_serving import _Member, _memory_block, _ScopedMemory, _Service

pytest_plugins = ('test_serving',)
MEMBER: _Member = {'actor': 'actor-1', 'user': 'filing-1', 'memory': True}


def test_personal_memory_starts_before_graph_finishes_and_reaches_model_once(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_timing')
    started = threading.Event()
    calls = []
    build = serving.build_agent

    def opening(store: Any, actor: str) -> str:
        calls.append((store, actor))
        started.set()
        return 'semantic facts:\n- Overlapped memory'

    def held_graph(**kwargs: Any) -> Any:
        assert started.wait(2), 'Personal Memory waited for the graph'
        return build(**kwargs)

    monkeypatch.setattr(agentcore, 'opening', opening)
    monkeypatch.setattr(serving, 'build_agent', held_graph)
    events = service.turn('hello', **MEMBER)
    assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
    steps = [json.loads(record.message)['step'] for record in caplog.records
             if record.message.startswith('{"event":"harness_graph_substep"')]
    assert steps == ['restore_hooks', 'profile_checks', 'route_skills', 'subagent_specs',
                     'middleware', 'create_agent', 'validate_graph']
    assert len(calls) == 1
    assert calls[0][1] == 'actor-1'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- Overlapped memory'


@pytest.mark.parametrize('read_fails', [False, True])
@pytest.mark.parametrize('failure', ['graph', 'checkpoint', 'validation'])
def test_failed_preparation_joins_personal_memory_before_eof(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, failure: str,
    read_fails: bool, caplog: pytest.LogCaptureFixture,
) -> None:
    started, release, ended, failed = (threading.Event() for _ in range(4))
    build, validate = serving.build_agent, serving.validate_checkpoint
    read = serving._SESSION_TURNS.read_checkpoint

    def opening(store: Any, actor: str) -> str:
        started.set()
        assert release.wait(5)
        ended.set()
        if read_fails:
            raise ConnectionError('Personal Memory unavailable')
        return 'memory'

    def graph(**kwargs: Any) -> Any:
        assert started.wait(2)
        if failure == 'graph':
            failed.set()
            raise RuntimeError('Graph unavailable')
        return build(**kwargs)

    async def checkpoint(*args: Any, **kwargs: Any) -> Any:
        if failure == 'checkpoint':
            failed.set()
            raise RuntimeError('Checkpoint unavailable')
        return await read(*args, **kwargs)

    def validation(*args: Any, **kwargs: Any) -> Any:
        if failure == 'validation':
            failed.set()
            raise RuntimeError('Validation unavailable')
        return validate(*args, **kwargs)

    monkeypatch.setattr(agentcore, 'opening', opening)
    monkeypatch.setattr(serving, 'build_agent', graph)
    monkeypatch.setattr(serving._SESSION_TURNS, 'read_checkpoint', checkpoint)
    monkeypatch.setattr(serving, 'validate_checkpoint', validation)
    with ThreadPoolExecutor() as pool:
        result = pool.submit(service.turn, 'never execute', **MEMBER)
        try:
            assert started.wait(2)
            assert failed.wait(2)
            with pytest.raises(TimeoutError):
                result.result(timeout=0.1)
        finally:
            release.set()
        events = result.result(5)
    assert ended.is_set()
    assert events[-1]['type'] == 'RUN_ERROR'
    assert service.recorder.prompts == []
    warnings = [record for record in caplog.records if record.name == session_memory.__name__]
    assert len(warnings) == int(read_fails)


def test_stop_joins_taken_memory_before_eof(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    started, release, ended, waiting = (threading.Event() for _ in range(4))
    before = session_memory.SessionMemoryMiddleware.abefore_agent

    async def before_memory(self: Any, state: Any, runtime: Any) -> Any:
        waiting.set()
        return await before(self, state, runtime)

    def opening(store: Any, actor: str) -> str:
        started.set()
        assert release.wait(5)
        ended.set()
        return 'memory'

    monkeypatch.setattr(agentcore, 'opening', opening)
    monkeypatch.setattr(session_memory.SessionMemoryMiddleware, 'abefore_agent', before_memory)
    with ThreadPoolExecutor() as pool:
        result = pool.submit(service.turn, 'never execute', **MEMBER)
        try:
            assert started.wait(2)
            assert waiting.wait(3)
            stopped = service.turn('', stop=True, **MEMBER)
            with pytest.raises(TimeoutError):
                result.result(timeout=0.1)
        finally:
            release.set()
        events = result.result(5)
    assert ended.is_set()
    assert service.recorder.prompts == []
    assert any(event.get('code') == 'TURN_STOPPED' for event in events), (events, stopped)
