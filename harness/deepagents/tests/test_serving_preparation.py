from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from ag_ui.core import EventType, RunAgentInput, RunFinishedEvent
from ag_ui_langgraph import LangGraphAgent

from botcube_harness_deepagents import serving


def test_stop_joins_offloop_preparation_and_history_before_replacement(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    history_entered = threading.Event()
    history_release = threading.Event()
    calls: list[str] = []

    class Agent:
        async def run(self, inputs: RunAgentInput):
            calls.append(inputs.run_id)
            yield RunFinishedEvent(thread_id='session', run_id=inputs.run_id)

    def factory() -> Any:
        entered.set()
        assert release.wait(3)
        calls.append('prepared')
        return Agent()

    def replacement() -> Any:
        calls.append('replacement-prepared')
        return Agent()

    class Saver:
        async def aget_tuple(self, config: Any) -> None:
            history_entered.set()
            assert await asyncio.to_thread(history_release.wait, 3)
            calls.append('history')

    async def snapshot(*args: Any) -> None:
        pass

    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', Saver())
    monkeypatch.setattr(serving, '_DEFERRED_SAVER', None)
    monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))

    async def exercise() -> None:
        turns = serving._SessionTurns()
        inputs = RunAgentInput(thread_id='session', run_id='first', messages=[], tools=[], context=[], state={})
        events = asyncio.create_task(_collect(turns.stream(('owner', 'session'), factory, inputs, None, tmp_path, serving._RequestContext(None))))
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            assert await asyncio.to_thread(history_entered.wait, 3)
            turns.stop(('owner', 'session'), 'first')
            successor = asyncio.create_task(_collect(turns.stream(('owner', 'session'), replacement,
                inputs.model_copy(update={'run_id': 'next'}), None, tmp_path, serving._RequestContext(None))))
            await asyncio.sleep(0)
            assert not events.done()
            assert 'replacement-prepared' not in calls
            release.set()
            await asyncio.to_thread(entered.wait, 3)
            await asyncio.sleep(0)
            assert 'replacement-prepared' not in calls
        finally:
            release.set()
            history_release.set()
        result, next_result = await asyncio.gather(events, successor)
        assert result[-1].code == 'TURN_STOPPED'
        assert next_result[-1].type == EventType.RUN_FINISHED
        assert calls.index('prepared') < calls.index('replacement-prepared')
        assert calls.index('history') < calls.index('replacement-prepared')
        assert 'first' not in calls
        assert ('owner', 'session') not in turns._locks

    asyncio.run(exercise())


async def _collect(events: Any) -> list[Any]:
    return [event async for event in events]


@pytest.mark.parametrize('factory_fails,history_fails', [(True, False), (False, True), (True, True)])
def test_preparation_failures_join_and_report_each_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture,
    factory_fails: bool, history_fails: bool,
) -> None:
    def factory() -> Any:
        if factory_fails:
            raise ValueError('agent preparation failed')
        return SimpleNamespace()

    class Saver:
        async def aget_tuple(self, config: Any) -> None:
            if history_fails:
                raise RuntimeError('history preparation failed')

    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', Saver())

    async def exercise() -> None:
        inputs = RunAgentInput(thread_id='session', run_id='first', messages=[], tools=[], context=[], state={})
        turns = serving._SessionTurns()
        result = await _collect(turns.stream(('owner', 'session'), factory, inputs, None, tmp_path, serving._RequestContext(None)))
        async with asyncio.timeout(3):
            while ('owner', 'session') in turns._locks:
                await asyncio.sleep(0)
        failures = [record.exc_info[1] for record in caplog.records if record.exc_info and 'Harness preparation failed' in record.getMessage()]
        assert len(result) == 1
        assert result[0].message == str(failures[0])
        assert result[0].code == 'INTERNAL_ERROR'

    asyncio.run(exercise())
    if factory_fails:
        assert 'agent preparation failed' in caplog.text
    if history_fails:
        assert 'history preparation failed' in caplog.text
    assert 'Task exception was never retrieved' not in caplog.text


@pytest.mark.parametrize('recorded', [False, True])
def test_preparation_scopes_history_and_keeps_factory_off_loop(
    monkeypatch: pytest.MonkeyPatch, recorded: bool,
) -> None:
    calls: list[str] = []
    main_thread = threading.get_ident()

    def factory() -> Any:
        assert threading.get_ident() != main_thread
        calls.append('agent')
        return SimpleNamespace()

    class Saver:
        async def aget_tuple(self, config: Any) -> None:
            assert config['configurable'] == {'actor_id': 'owner', 'thread_id': 'session'}
            calls.append('history')

    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', Saver())
    asyncio.run(serving._prepare_agent(('owner', 'session'), factory, recorded=recorded))
    assert sorted(calls) == (['agent', 'history'] if recorded else ['agent'])


def test_failed_store_does_not_publish_partial_memory_backends(monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents.memory.agentcore.turn_saver import (
        TurnCheckpointSaver,
    )

    checkpointer = serving.agentcore_memory_backend.build_checkpointer('test-memory', region_name='us-east-1', wrapper=TurnCheckpointSaver, broker=True)
    store = SimpleNamespace()
    builds = 0

    def build_store() -> Any:
        nonlocal builds
        builds += 1
        if builds == 1:
            raise RuntimeError('store initialization failed')
        return store

    monkeypatch.setattr(serving, '_CHECKPOINTER', None)
    monkeypatch.setattr(serving, '_DEFERRED_SAVER', None)
    monkeypatch.setattr(serving, '_STORE', None)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', 'memory-test')
    monkeypatch.setattr(serving.agentcore_memory_backend, 'build_checkpointer', lambda *args, **kwargs: checkpointer)
    monkeypatch.setattr(serving, '_build_store', build_store)
    with pytest.raises(RuntimeError, match='store initialization failed'):
        serving._ensure_memory_backends()
    assert (serving._CHECKPOINTER, serving._STORE, serving._DEFERRED_SAVER) == (None, None, None)
    assert serving._ensure_memory_backends() is store
    assert (checkpointer, store, checkpointer) == (serving._CHECKPOINTER, serving._STORE, serving._DEFERRED_SAVER)


def test_stopping_singleton_preparation_does_not_start_other_workers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    entered = threading.Event()
    release = threading.Event()

    def ensure() -> None:
        entered.set()
        assert release.wait(3)

    def unexpected() -> Any:
        raise AssertionError('Stopped preparation dispatched another worker')

    monkeypatch.setattr(serving, '_ensure_memory_backends', ensure)
    monkeypatch.setattr(serving, '_CHECKPOINTER', SimpleNamespace(aget_tuple=unexpected))

    async def exercise() -> None:
        inputs = RunAgentInput(thread_id='session', run_id='first', messages=[], tools=[], context=[], state={})
        turns = serving._SessionTurns()
        events = asyncio.create_task(_collect(turns.stream(('owner', 'session'), unexpected, inputs, None, tmp_path, serving._RequestContext(None))))
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            turns.stop(('owner', 'session'), 'first')
        finally:
            release.set()
        assert (await events)[-1].code == 'TURN_STOPPED'

    asyncio.run(exercise())


@pytest.mark.parametrize('stage', ['singleton', 'workers'])
def test_cancelled_warmup_joins_started_preparation(
    monkeypatch: pytest.MonkeyPatch, stage: str,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    settled = threading.Event()

    def blocked() -> Any:
        entered.set()
        assert release.wait(3)
        settled.set()
        return SimpleNamespace()

    monkeypatch.setattr(serving, '_ensure_memory_backends', blocked if stage == 'singleton' else lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', None)

    async def exercise() -> None:
        task = asyncio.create_task(serving._prepare_agent(('owner', 'session'), blocked))
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert settled.is_set()

    asyncio.run(exercise())


def test_snapshot_prefetch_is_retained_for_graph_and_settlement(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    import boto3
    from langgraph.checkpoint.base import empty_checkpoint

    from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
    from botcube_harness_deepagents.memory.agentcore import build_checkpointer
    from botcube_harness_deepagents.memory.agentcore.turn_saver import (
        TurnCheckpointSaver,
    )

    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    stored = build_checkpointer(MEMORY_ID, region_name='us-east-1')
    config = serving._session_config(('owner', 'session'))
    stored.put(config, {**empty_checkpoint(), 'id': 'recorded-checkpoint',
                        'channel_values': {'value': 'recorded answer'},
                        'channel_versions': {'value': '1'}}, {}, {'value': '1'})
    saver = TurnCheckpointSaver(stored)
    graph_reads: list[int] = []

    class Agent:
        async def run(self, inputs: RunAgentInput):
            graph_reads.append(memory.list_events_calls)
            checkpoint = await saver.aget_tuple(config)
            assert checkpoint is not None
            assert checkpoint.checkpoint['channel_values'] == {'value': 'recorded answer'}
            yield RunFinishedEvent(thread_id='session', run_id=inputs.run_id)

    def factory() -> Any:
        checkpoint = saver.get_tuple(config)
        assert checkpoint is not None
        assert checkpoint.checkpoint['channel_values'] == {'value': 'recorded answer'}
        return Agent()

    async def snapshot(*args: Any) -> None:
        checkpoint = await saver.aget_tuple(config)
        assert checkpoint is not None
        assert checkpoint.checkpoint['channel_values'] == {'value': 'recorded answer'}

    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', saver)
    monkeypatch.setattr(serving, '_DEFERRED_SAVER', saver)
    monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))

    async def exercise() -> None:
        inputs = RunAgentInput(thread_id='session', run_id='first', messages=[], tools=[], context=[], state={})
        result = await _collect(serving._SessionTurns().stream(('owner', 'session'), factory, inputs, None, tmp_path, serving._RequestContext(None)))
        assert result[-1].type == EventType.RUN_FINISHED

    asyncio.run(exercise())
    assert memory.list_events_calls == 1
    assert graph_reads == [memory.list_events_calls]


def test_replacement_history_waits_for_previous_checkpoint_flush(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    async def exercise() -> None:
        flushing = asyncio.Event()
        release = asyncio.Event()
        reads = 0

        class Saver:
            async def aget_tuple(self, config: Any) -> None:
                nonlocal reads
                reads += 1

            async def aflush(self, session: Any) -> None:
                if not flushing.is_set():
                    flushing.set()
                    await release.wait()

        class Agent:
            async def run(self, inputs: RunAgentInput):
                yield RunFinishedEvent(thread_id='session', run_id=inputs.run_id)

        async def snapshot(*args: Any) -> None:
            pass

        saver = Saver()
        monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
        monkeypatch.setattr(serving, '_CHECKPOINTER', saver)
        monkeypatch.setattr(serving, '_DEFERRED_SAVER', saver)
        monkeypatch.setattr(serving, '_snapshot_messages', snapshot)
        monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
        inputs = RunAgentInput(thread_id='session', run_id='first', messages=[], tools=[], context=[], state={})
        turns = serving._SessionTurns()
        first = asyncio.create_task(_collect(turns.stream(('owner', 'session'), lambda: cast(LangGraphAgent, Agent()), inputs, None, tmp_path, serving._RequestContext(None))))
        async with asyncio.timeout(3):
            await flushing.wait()
            next_turn = asyncio.create_task(_collect(turns.stream(('owner', 'session'), lambda: cast(LangGraphAgent, Agent()),
                inputs.model_copy(update={'run_id': 'next'}), None, tmp_path, serving._RequestContext(None))))
            try:
                await asyncio.sleep(0)
                assert reads == 1
                assert not next_turn.done()
            finally:
                release.set()
            results = await asyncio.gather(first, next_turn)
        assert all(result[-1].type == EventType.RUN_FINISHED for result in results)
        assert reads == 2

    asyncio.run(exercise())


@pytest.mark.parametrize('failing_worker', ['agent', 'history'])
def test_preparation_failure_reports_before_the_other_started_worker_settles(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failing_worker: str,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    settled = threading.Event()

    def factory() -> Any:
        if failing_worker == 'agent':
            raise ValueError('agent failed')
        entered.set()
        assert release.wait(3)
        settled.set()
        return SimpleNamespace()

    class Saver:
        async def aget_tuple(self, config: Any) -> None:
            if failing_worker == 'history':
                raise RuntimeError('history failed')
            entered.set()
            assert await asyncio.to_thread(release.wait, 3)
            settled.set()

    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', Saver())

    async def exercise() -> None:
        inputs = RunAgentInput(thread_id='session', run_id='first', messages=[], tools=[], context=[], state={})
        turns = serving._SessionTurns()
        task = asyncio.create_task(_collect(turns.stream(('owner', 'session'), factory, inputs, None, tmp_path, serving._RequestContext(None))))
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            await asyncio.sleep(0)
            async with asyncio.timeout(3):
                result = await task
            assert len(result) == 1
            assert result[0].type == EventType.RUN_ERROR
            assert result[0].code == 'INTERNAL_ERROR'
            assert result[0].message == f'{failing_worker} failed'
            assert not settled.is_set()
            assert turns._locks[('owner', 'session')].locked()
        finally:
            release.set()
        async with asyncio.timeout(3):
            while ('owner', 'session') in turns._locks:
                await asyncio.sleep(0)
        assert settled.is_set()
        assert ('owner', 'session') not in turns._locks

    asyncio.run(exercise())


@pytest.mark.parametrize('stage', ['singleton', 'workers', 'restoration'])
def test_repeated_warmup_cancellation_holds_session_lock_until_thread_settles(
    monkeypatch: pytest.MonkeyPatch, stage: str,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    settled = threading.Event()
    turns = serving._SessionTurns()
    session = ('owner', 'session')

    def blocked(**kwargs: Any) -> Any:
        entered.set()
        assert release.wait(3)
        settled.set()
        return SimpleNamespace()

    monkeypatch.setattr(serving, '_SESSION_TURNS', turns)
    async def restore(config: Any) -> Any:
        return await asyncio.to_thread(blocked)

    agent = SimpleNamespace(graph=SimpleNamespace(aget_state=restore))
    monkeypatch.setattr(serving, '_get_agent', (lambda **kwargs: agent) if stage == 'restoration' else blocked)
    monkeypatch.setattr(serving, '_ensure_memory_backends', blocked if stage == 'singleton' else lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', None)
    auth = SimpleNamespace(actor_id='owner', persistent_memory=False, system_prompt='', environment={}, model_relay=None)
    inputs = RunAgentInput(thread_id='session', run_id='warmup', messages=[], tools=[], context=[], state={})

    async def exercise() -> None:
        task = asyncio.create_task(_collect(serving._invoke_agent(inputs, serving._RequestContext(None),
            {'preparationScope': 'recorded' if stage == 'restoration' else 'startup'},
            auth, 'owner', None, 0, None, True)))
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            for _ in range(3):
                task.cancel()
                await asyncio.sleep(0)
                assert turns._locks[session].locked()
                assert not task.done()
                assert not settled.is_set()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert settled.is_set()
        assert not turns._locks[session].locked()

    asyncio.run(exercise())


def test_history_rejection_is_retained_while_later_factory_failure_settles(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    settled = threading.Event()
    history_failed = asyncio.Event()

    def factory() -> Any:
        entered.set()
        assert release.wait(3)
        settled.set()
        raise ValueError('later agent rejection')

    class Saver:
        async def aget_tuple(self, config: Any) -> None:
            assert await asyncio.to_thread(entered.wait, 3)
            history_failed.set()
            raise RuntimeError('first history rejection')

    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', Saver())

    async def exercise() -> None:
        inputs = RunAgentInput(thread_id='session', run_id='first', messages=[], tools=[], context=[], state={})
        turns = serving._SessionTurns()
        task = asyncio.create_task(_collect(turns.stream(('owner', 'session'), factory, inputs, None, tmp_path, serving._RequestContext(None))))
        try:
            async with asyncio.timeout(3):
                await history_failed.wait()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert turns._locks[('owner', 'session')].locked()
            async with asyncio.timeout(3):
                result = await task
            assert len(result) == 1
            assert result[0].message == 'first history rejection'
            assert result[0].code == 'INTERNAL_ERROR'
            assert not settled.is_set()
            early_logs = list(caplog.records)
        finally:
            release.set()
        async with asyncio.timeout(3):
            while ('owner', 'session') in turns._locks:
                await asyncio.sleep(0)
        assert settled.is_set()
        assert ('owner', 'session') not in turns._locks
        assert any(record.exc_info and str(record.exc_info[1]) == 'first history rejection' and
                   'code=INTERNAL_ERROR' in record.getMessage() for record in early_logs)

    asyncio.run(exercise())
    failures = [record.exc_info[1] for record in caplog.records if record.exc_info and 'Harness preparation failed' in record.getMessage()]
    assert [str(error) for error in failures] == ['first history rejection', 'later agent rejection']
    assert 'Task exception was never retrieved' not in caplog.text


def test_warmup_reports_first_rejection_while_retaining_the_owned_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    entered, release, settled = threading.Event(), threading.Event(), threading.Event()

    def factory() -> Any:
        entered.set()
        assert release.wait(3)
        settled.set()
        return SimpleNamespace()

    class Saver:
        async def aget_tuple(self, config: Any) -> None:
            assert await asyncio.to_thread(entered.wait, 3)
            raise RuntimeError('warmup history failed')

    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, '_CHECKPOINTER', Saver())

    async def exercise() -> None:
        turns = serving._SessionTurns()
        session = ('owner', 'session')
        inputs = RunAgentInput(thread_id='session', run_id='warmup', messages=[], tools=[], context=[], state={})
        events = turns.warmup(session, factory, inputs, recorded=True)
        try:
            async with asyncio.timeout(3):
                error = await anext(events)
            assert error.type == EventType.RUN_ERROR
            assert error.message == 'warmup history failed'
            acknowledgement = asyncio.create_task(anext(events))
            await asyncio.sleep(0)
            assert not acknowledgement.done()
            assert turns._locks[session].locked()
            assert not settled.is_set()
        finally:
            release.set()
        async with asyncio.timeout(3):
            result = await acknowledgement
        assert result.type == EventType.CUSTOM
        assert result.value['outcome'] == 'failed'
        assert not turns._locks[session].locked()
        assert settled.is_set()
        await events.aclose()

    asyncio.run(exercise())
