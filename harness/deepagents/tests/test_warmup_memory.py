from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from typing import Any

import pytest
from ag_ui.core import RunAgentInput

from agentcore_fake import another_microvm
from botcube_harness_deepagents import serving, session_memory
from botcube_harness_deepagents.lazy_files import TurnFiles
from botcube_harness_deepagents.memory import agentcore as memory_backend
from test_serving import _memory_block, _memory_record, _ScopedMemory, _Service
from test_serving import agentcore_memory as agentcore_memory
from test_serving import service as service


def test_completed_warmup_supplies_first_turn_memory_without_repeated_read_issue_3701(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    agentcore_memory.records.append(_memory_record('Prefers tea', 'UserPreferences-1', 'actor-1'))
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}
    prepared = service.turn('', warmup=True, **member)
    assert prepared[-1]['value']['outcome'] == 'prepared'
    agentcore_memory.sts.memory_calls.clear()

    events = service.turn('hello', **member)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'user preferences:\n- Prefers tea'
    assert not [operation for operation, _ in agentcore_memory.sts.memory_calls
                if operation == 'list_memory_records']


@pytest.mark.parametrize('reason', ['missing', 'startup', 'stale', 'actor', 'session', 'failed'])
def test_ineligible_warmup_keeps_first_turn_fresh_memory_read_issue_3701(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, reason: str,
) -> None:
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}
    agentcore_memory.records.append(_memory_record('Prefers tea', 'UserPreferences-1', 'actor-1'))
    if reason != 'missing':
        opening = memory_backend.opening
        if reason == 'failed':
            def failing(*args: Any) -> str:
                raise RuntimeError('Memory unavailable')
            monkeypatch.setattr(memory_backend, 'opening', failing)
        prepared = service.turn('', warmup=True,
                                preparationScope='startup' if reason == 'startup' else 'recorded', **member)
        assert prepared[-1]['value']['outcome'] == ('failed' if reason == 'failed' else 'prepared')
        if reason == 'failed':
            assert prepared[-1]['value']['error'] == {'code': 'INTERNAL_ERROR', 'message': 'Memory unavailable'}
            failed = service.turn('hello', **member)
            assert failed[-1] == {'type': 'RUN_ERROR', 'code': 'INTERNAL_ERROR', 'message': 'Memory unavailable'}
            assert service.recorder.prompts == []
        monkeypatch.setattr(memory_backend, 'opening', opening)
        if reason == 'stale':
            read = session_memory._warmups[('user-1', 'thread-1')]
            assert read.result is not None
            read.result = replace(read.result, completed_at=read.result.completed_at - 301)
    if reason == 'session':
        another_microvm()
    if reason == 'actor':
        member['actor'] = 'actor-2'
        agentcore_memory.records.append(_memory_record('Prefers coffee', 'UserPreferences-1', 'actor-2'))
    agentcore_memory.sts.memory_calls.clear()
    events = service.turn('hello', thread='other-session' if reason == 'session' else 'thread-1', **member)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n- Prefers coffee' if reason == 'actor' else 'user preferences:\n- Prefers tea')
    assert len([operation for operation, _ in agentcore_memory.sts.memory_calls
                if operation == 'list_memory_records']) == 2
    if reason == 'actor':
        assert ('user-1', 'thread-1') not in session_memory._warmups


def test_empty_warmup_is_consumed_once_and_later_empty_turn_refreshes_issue_3701(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}
    assert service.turn('', warmup=True, **member)[-1]['value']['outcome'] == 'prepared'
    agentcore_memory.sts.memory_calls.clear()
    assert service.turn('hello', **member)[-1]['type'] == 'RUN_FINISHED'
    assert '<agent_memory>' not in service.recorder.prompts[-1]
    assert not [operation for operation, _ in agentcore_memory.sts.memory_calls if operation == 'list_memory_records']
    agentcore_memory.records.append(_memory_record('Prefers tea', 'UserPreferences-1', 'actor-1'))
    assert service.turn('again', **member)[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'user preferences:\n- Prefers tea'
    assert len([operation for operation, _ in agentcore_memory.sts.memory_calls
                if operation == 'list_memory_records']) == 2


@pytest.mark.parametrize('stage', ['read', 'build'])
def test_turn_arriving_during_warmup_reads_fresh_and_invalidates_handoff_issue_3701(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, stage: str,
) -> None:
    reading, release, arrived = threading.Event(), threading.Event(), threading.Event()
    opening = memory_backend.opening
    take = session_memory.take_warmup
    def taking(*args: Any) -> str | None:
        block = take(*args)
        arrived.set()
        return block
    monkeypatch.setattr(session_memory, 'take_warmup', taking)
    calls = 0
    def held(*args: Any) -> str:
        nonlocal calls
        calls += 1
        if calls == 1 and stage == 'read':
            reading.set()
            assert release.wait(5), 'The warmup was never released'
            return 'semantic facts:\n- Obsolete warmup'
        return opening(*args)
    monkeypatch.setattr(memory_backend, 'opening', held)
    building = serving._turn_agent
    builds = 0
    async def build(*args: Any) -> Any:
        nonlocal builds
        builds += 1
        if builds == 1 and stage == 'build':
            reading.set()
            assert await asyncio.to_thread(release.wait, 5), 'The warmup build was never released'
        return await building(*args)
    monkeypatch.setattr(serving, '_turn_agent', build)
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}
    with ThreadPoolExecutor(max_workers=2) as pool:
        warmup = pool.submit(service.turn, '', warmup=True, **member)
        try:
            assert reading.wait(5), 'Warmup never read Memory'
            turn = pool.submit(service.turn, 'hello', **member)
            assert arrived.wait(5), 'Turn never arrived during warmup'
        finally:
            release.set()
        assert warmup.result(timeout=5)[-1]['value']['outcome'] == 'prepared'
        assert turn.result(timeout=5)[-1]['type'] == 'RUN_FINISHED'
        assert '<agent_memory>' not in service.recorder.prompts[-1]
    assert session_memory._warmups == {}
    agentcore_memory.records.append(_memory_record('New memory', 'SemanticFacts-1', 'actor-1'))
    assert service.turn('again', **member)[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- New memory'
    assert calls == 3


@pytest.mark.parametrize(('age', 'expected'), [(0, 'Memory'), (300, 'Memory'), (300.001, None), (-0.001, None)])
def test_warmup_eligibility_uses_turn_start_and_includes_five_minute_boundary(
    monkeypatch: pytest.MonkeyPatch, age: float, expected: str | None,
) -> None:
    monkeypatch.setattr(session_memory, '_warmups', {})
    monkeypatch.setattr(session_memory, 'perf_counter', lambda: 1000.0)
    session = ('filing', 'session')
    read = session_memory.begin_warmup(session, 'actor')
    session_memory.finish_warmup(session, read, session_memory.OpeningRead('Memory', 1000.0))
    assert session_memory.take_warmup(session, 'actor', 1000.0 + age) == expected
    assert session_memory.take_warmup(session, 'actor', 1000.0 + age) is None


def test_failed_cancelled_or_superseded_warmups_cannot_publish_late(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_memory, '_warmups', {})
    monkeypatch.setattr(session_memory, 'perf_counter', lambda: 1000.0)
    session = ('filing', 'session')
    cancelled = session_memory.begin_warmup(session, 'actor')
    session_memory.finish_warmup(session, cancelled, None)
    session_memory.finish_warmup(session, cancelled, session_memory.OpeningRead('Cancelled read', 1000.0))
    assert session_memory.take_warmup(session, 'actor', 1000.0) is None
    earlier = session_memory.begin_warmup(session, 'actor')
    later = session_memory.begin_warmup(session, 'actor')
    session_memory.finish_warmup(session, earlier, session_memory.OpeningRead('Earlier read', 1000.0))
    session_memory.finish_warmup(session, later, session_memory.OpeningRead('Latest read', 1000.0))
    assert session_memory.take_warmup(session, 'actor', 1000.0) == 'Latest read'


def test_warmup_retention_is_bounded_and_expired_results_are_removed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_memory, '_warmups', {})
    clock = [1000.0]
    monkeypatch.setattr(session_memory, 'perf_counter', lambda: clock[0])
    for n in range(session_memory.WARMUP_LIMIT + 1):
        session = ('filing', str(n))
        read = session_memory.begin_warmup(session, 'actor')
        session_memory.finish_warmup(session, read, session_memory.OpeningRead('Memory', 1000.0))
    assert len(session_memory._warmups) == session_memory.WARMUP_LIMIT
    assert session_memory.take_warmup(('filing', '0'), 'actor', clock[0]) is None
    clock[0] += 301
    session_memory.begin_warmup(('filing', 'new'), 'actor')
    assert list(session_memory._warmups) == [('filing', 'new')]


@pytest.mark.parametrize('delay', ['checkpoint', 'files'])
def test_memory_read_age_is_not_reset_when_warmup_preparation_finishes(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, delay: str,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(session_memory, 'perf_counter', lambda: clock[0])
    monkeypatch.setattr(serving, 'perf_counter', lambda: clock[0])
    completed = threading.Event()
    read_warmup = session_memory.read_warmup
    async def reading(load: Any) -> session_memory.OpeningRead:
        result = await read_warmup(load)
        completed.set()
        return result
    monkeypatch.setattr(session_memory, 'read_warmup', reading)
    from botcube_harness_deepagents.session_format import latest_checkpoint
    checkpoint, ensure = latest_checkpoint, TurnFiles.aensure
    delayed = False
    async def wait() -> None:
        nonlocal delayed
        if not delayed:
            delayed = True
            assert await asyncio.to_thread(completed.wait, 5)
            clock[0] += 301
    async def history(*args: Any) -> Any:
        await wait()
        return await checkpoint(*args)
    async def files(self: Any) -> None:
        await wait()
        await ensure(self)
    if delay == 'checkpoint':
        monkeypatch.setattr(serving, 'latest_checkpoint', history)
    else:
        monkeypatch.setattr(TurnFiles, 'aensure', files)
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}
    assert service.turn('', warmup=True, **member)[-1]['value']['outcome'] == 'prepared'
    agentcore_memory.records.append(_memory_record('New memory', 'SemanticFacts-1', 'actor-1'))
    agentcore_memory.sts.memory_calls.clear()
    assert service.turn('hello', **member)[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- New memory'
    assert len([operation for operation, _ in agentcore_memory.sts.memory_calls
                if operation == 'list_memory_records']) == 2


def test_cancelled_warmup_discards_completed_read_and_next_turn_loads_fresh(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    finish = serving._finish_preparation
    async def cancelled(work: Any) -> None:
        await finish(work)
        raise asyncio.CancelledError()
    monkeypatch.setattr(serving, '_finish_preparation', cancelled)
    async def run() -> None:
        from agentcore_fake import turn_identity
        run_input = RunAgentInput(
            thread_id='thread-1', run_id='cancelled-warmup', messages=[], tools=[], context=[], state={},
            forwarded_props={'actorId': 'actor-1', 'sessionUserId': 'user-1', 'memory': True, 'warmup': True,
                             'turnIdentity': turn_identity('actor-1', 'user-1', 'thread-1')},
        )
        with pytest.raises(asyncio.CancelledError):
            async for _ in serving.invoke(run_input, serving._RequestContext(None)):
                pass
    assert service.client.portal is not None
    service.client.portal.call(run)
    assert session_memory._warmups == {}
    monkeypatch.setattr(serving, '_finish_preparation', finish)
    agentcore_memory.records.append(_memory_record('New memory', 'SemanticFacts-1', 'actor-1'))
    agentcore_memory.sts.memory_calls.clear()
    assert service.turn('hello', actor='actor-1', user='user-1', memory=True)[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- New memory'
    assert len([operation for operation, _ in agentcore_memory.sts.memory_calls
                if operation == 'list_memory_records']) == 2


def test_warmup_valid_at_turn_receipt_survives_slow_turn_preparation(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(session_memory, 'perf_counter', lambda: clock[0])
    monkeypatch.setattr(serving, 'perf_counter', lambda: clock[0])
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}
    agentcore_memory.records.append(_memory_record('Prefers tea', 'UserPreferences-1', 'actor-1'))
    assert service.turn('', warmup=True, **member)[-1]['value']['outcome'] == 'prepared'
    clock[0] = 1300.0
    build = serving._turn_agent
    async def slow(*args: Any) -> Any:
        clock[0] = 1601.0
        return await build(*args)
    monkeypatch.setattr(serving, '_turn_agent', slow)
    agentcore_memory.sts.memory_calls.clear()
    assert service.turn('hello', **member)[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'user preferences:\n- Prefers tea'
    assert not [operation for operation, _ in agentcore_memory.sts.memory_calls if operation == 'list_memory_records']


def test_cancelled_first_turn_consumes_handoff_and_next_turn_loads_fresh(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}
    assert service.turn('', warmup=True, **member)[-1]['value']['outcome'] == 'prepared'
    build = serving._turn_agent
    async def cancelled(*args: Any) -> Any:
        await build(*args)
        raise asyncio.CancelledError()
    monkeypatch.setattr(serving, '_turn_agent', cancelled)
    async def run() -> None:
        from agentcore_fake import turn_identity
        run_input = RunAgentInput(
            thread_id='thread-1', run_id='cancelled-turn', messages=[], tools=[], context=[], state={},
            forwarded_props={'actorId': 'actor-1', 'sessionUserId': 'user-1', 'memory': True,
                             'turnIdentity': turn_identity('actor-1', 'user-1', 'thread-1')},
        )
        with pytest.raises(asyncio.CancelledError):
            async for _ in serving.invoke(run_input, serving._RequestContext(None)):
                pass
    assert service.client.portal is not None
    service.client.portal.call(run)
    assert session_memory._warmups == {}
    monkeypatch.setattr(serving, '_turn_agent', build)
    agentcore_memory.records.append(_memory_record('New memory', 'SemanticFacts-1', 'actor-1'))
    agentcore_memory.sts.memory_calls.clear()
    assert service.turn('hello', **member)[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- New memory'
    assert len([operation for operation, _ in agentcore_memory.sts.memory_calls
                if operation == 'list_memory_records']) == 2
