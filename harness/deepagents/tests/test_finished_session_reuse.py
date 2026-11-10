"""Finished Runtime Turns reuse their own snapshot only with registered writer proof."""
from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from langchain_core.messages import HumanMessage

from agentcore_fake import (
    MEMORY_ID,
    FakeAgentCoreMemory,
    another_microvm,
    fresh_warm_sessions,
    install_tagged_memory,
    turn_identity,
)
from botcube_harness_deepagents import serving, session_api
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore import warm_session
from test_serving import _files, _replay, _Service

pytest_plugins = ('test_serving',)


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    client = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, client)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    return client


def _turn(service: _Service, text: str, epoch: Any = 'epoch-1', **props: Any) -> list[dict[str, Any]]:
    token = props.setdefault('turnIdentity', turn_identity(
        props.get('actor', 'actor-1'), props.get('user', 'user-1'), props.get('thread', 'thread-1'),
    ))
    marker = {'epoch': epoch, 'turnId': agentcore._claims(token).get('jti')}
    return service.turn(text, sessionSnapshotEpoch=marker, **props)


@pytest.fixture(params=['natural', 'late-pending'])
def checkpoint_completion(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    if request.param == 'natural':
        return
    saver = warm_session.WarmSessionSaver
    store = saver.put_with_writes
    finish = saver.finish_run
    written: dict[warm_session.WarmSessionSaver, list[Any]] = {}

    def stored(self: warm_session.WarmSessionSaver, *args: Any, **kwargs: Any) -> Any:
        config = store(self, *args, **kwargs)
        written.setdefault(self, []).append(config)
        return config

    def finished(self: warm_session.WarmSessionSaver) -> None:
        checkpoints = written[self]
        assert len(checkpoints) >= 2
        self.put_writes(checkpoints[-2], [('messages', [HumanMessage('Older pending question')])], 'late-task')
        finish(self)

    monkeypatch.setattr(saver, 'put_with_writes', stored)
    monkeypatch.setattr(saver, 'finish_run', finished)


def test_finished_turn_reads_latest_memory_with_bounded_reads(
    service: _Service, memory: FakeAgentCoreMemory, checkpoint_completion: None,
) -> None:
    assert _turn(service, 'first')[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    memory.listed.clear()
    assert _turn(service, 'second')[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    assert sum(memory.listed.values()) <= 2
    assert service.recorder.heard[-1] == ['first', 'second']
    assert _replay('user-1', 'thread-1') == [
        ('user', 'first'), ('assistant', 'Echo: first'),
        ('user', 'second'), ('assistant', 'Echo: second'),
    ]


@pytest.mark.parametrize('epoch', [None, '', 1, 'epoch-2'])
def test_missing_or_changed_writer_proof_reads_memory(
    service: _Service, memory: FakeAgentCoreMemory, epoch: Any,
) -> None:
    _turn(service, 'first')
    service.fed()
    memory.listed.clear()
    assert _turn(service, 'second', epoch)[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert service.recorder.heard[-1] == ['first', 'second']


@pytest.mark.parametrize('epoch', [None, 'external-epoch'])
def test_external_post_is_loaded_when_writer_proof_is_absent_or_changed(
    service: _Service, memory: FakeAgentCoreMemory, epoch: str | None,
) -> None:
    _turn(service, 'first')
    service.fed()
    asyncio.run(session_api.post_message('user-1', 'thread-1', 'Scheduled result', 'scheduled-message'))
    memory.listed.clear()
    assert _turn(service, 'second', epoch)[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert _replay('user-1', 'thread-1') == [
        ('user', 'first'), ('assistant', 'Echo: first'), ('assistant', 'Scheduled result'),
        ('user', 'second'), ('assistant', 'Echo: second'),
    ]


@pytest.mark.parametrize('loss', ['restart', 'eviction'])
def test_lost_process_snapshot_loads_memory_even_with_same_epoch(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, loss: str,
) -> None:
    if loss == 'eviction':
        monkeypatch.setattr(warm_session, '_SESSIONS', warm_session._WarmSessions(1))
    _turn(service, 'first')
    service.fed()
    if loss == 'restart':
        fresh_warm_sessions(monkeypatch)
    else:
        another_microvm()
        assert _turn(service, 'other', thread='other-thread')[-1]['type'] == 'RUN_FINISHED'
        assert all(key[2] != 'thread-1' for key in warm_session._SESSIONS._snapshots)
        another_microvm()
    memory.listed.clear()
    assert _turn(service, 'second')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert service.recorder.heard[-1] == ['first', 'second']


def test_checkpoint_failure_never_promotes_finished_reuse(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _turn(service, 'first')
    service.fed()
    create = memory.create_event

    def lose_reply(**params: Any) -> Any:
        result = create(**params)
        if params.get('metadata', {}).get('lc_kind') == {'stringValue': 'checkpoint'}:
            raise ConnectionError('checkpoint reply lost')
        return result

    monkeypatch.setattr(memory, 'create_event', lose_reply)
    assert _turn(service, 'failed')[-1]['type'] == 'RUN_ERROR'
    monkeypatch.setattr(memory, 'create_event', create)
    memory.listed.clear()
    assert _turn(service, 'recovered')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert _replay('user-1', 'thread-1')[-2:] == [('user', 'recovered'), ('assistant', 'Echo: recovered')]


def test_interrupted_graph_does_not_promote_even_when_protocol_finishes(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    build = serving.build_agent
    graphs: list[Any] = []

    def interrupted(**kwargs: Any) -> Any:
        graph = build(**kwargs)
        graph.interrupt_after_nodes = ['model']
        graphs.append(graph)
        return graph

    monkeypatch.setattr(serving, 'build_agent', interrupted)
    events = _turn(service, 'interrupted')
    assert events[-1]['type'] == 'RUN_FINISHED'
    for graph in graphs:
        graph.interrupt_after_nodes = []
    memory.listed.clear()

    assert _turn(service, 'resumed')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0


def test_changed_invoking_actor_does_not_reuse_same_filing_snapshot(
    service: _Service, memory: FakeAgentCoreMemory,
) -> None:
    _turn(service, 'first')
    service.fed()
    memory.listed.clear()
    assert _turn(service, 'claimed', actor='new-owner')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert service.recorder.heard[-1] == ['first', 'claimed']


def test_failed_files_publication_does_not_promote_finished_snapshot(
    service: _Service, memory: FakeAgentCoreMemory, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish = serving.publish_finished_files

    async def fail_publish(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError('Files publication failed')

    monkeypatch.setattr(serving, 'publish_finished_files', fail_publish)
    assert _turn(service, 'write: /proof.txt: result', files=_files())[-1]['type'] == 'RUN_ERROR'
    monkeypatch.setattr(serving, 'publish_finished_files', publish)
    memory.listed.clear()
    assert _turn(service, 'failure-acknowledged')[-1]['type'] == 'RUN_ERROR'
    memory.listed.clear()
    assert _turn(service, 'second')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0


def test_unregistered_warmup_load_does_not_promote_finished_snapshot(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _turn(service, 'first')
    service.fed()
    fresh_warm_sessions(monkeypatch)
    assert service.turn('', warmup=True, preparationScope='recorded')[-1]['type'] == 'CUSTOM'
    memory.listed.clear()
    assert _turn(service, 'second')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert service.recorder.heard[-1] == ['first', 'second']


def test_deleted_session_does_not_restore_cached_conversation(
    service: _Service, memory: FakeAgentCoreMemory,
) -> None:
    _turn(service, 'first')
    service.fed()
    asyncio.run(session_api._graph().checkpointer.adelete_thread('thread-1', 'user-1'))
    memory.listed.clear()
    assert _turn(service, 'second', 'after-deletion')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert service.recorder.heard[-1] == ['second']
    assert _replay('user-1', 'thread-1') == [('user', 'second'), ('assistant', 'Echo: second')]


def test_stop_during_checkpoint_read_never_starts_model(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _turn(service, 'first')
    service.fed()
    read = memory.list_events
    entered = threading.Event()
    released = threading.Event()
    heard = len(service.recorder.heard)
    run_id = f'run-{len(service.recorder.prompts)}'

    def blocked(**params: Any) -> Any:
        if params['sessionId'] == 'thread-1':
            entered.set()
            assert released.wait(10), 'checkpoint read was never released'
        return read(**params)

    monkeypatch.setattr(memory, 'list_events', blocked)
    with ThreadPoolExecutor(max_workers=1) as pool:
        stopped = pool.submit(_turn, service, 'must not reach model', 'changed-epoch')
        try:
            assert entered.wait(10), 'checkpoint read never started'
            acknowledgement = service.client.post('/invocations', json={
                'threadId': 'thread-1', 'runId': run_id, 'messages': [],
                'tools': [], 'context': [], 'state': {},
                'forwardedProps': {'stop': True, 'sessionUserId': 'user-1'},
            })
            assert acknowledgement.status_code == 200
        finally:
            released.set()
        assert stopped.result(timeout=10)[-1]['code'] == 'TURN_STOPPED'
    assert len(service.recorder.heard) == heard
    monkeypatch.setattr(memory, 'list_events', read)
    memory.listed.clear()
    assert _turn(service, 'next', 'changed-epoch')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert service.recorder.heard[-1] == ['first', 'next']


def test_legacy_client_marker_cannot_hide_an_external_message(
    service: _Service, memory: FakeAgentCoreMemory,
) -> None:
    _turn(service, 'first')
    service.fed()
    asyncio.run(session_api.post_message('user-1', 'thread-1', 'Scheduled result', 'scheduled-message'))
    memory.listed.clear()

    assert service.turn('second', sessionSnapshotEpoch='epoch-1')[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert _replay('user-1', 'thread-1') == [
        ('user', 'first'), ('assistant', 'Echo: first'), ('assistant', 'Scheduled result'),
        ('user', 'second'), ('assistant', 'Echo: second'),
    ]


@pytest.mark.parametrize('marker,include_jti', [
    ({'epoch': 'epoch-1', 'turnId': 'first-turn'}, True),
    ({'epoch': 'epoch-1', 'turnId': 'forged-turn'}, True),
    ({'epoch': 'epoch-1', 'turnId': 'second-turn'}, False),
    ({'epoch': 'epoch-1', 'turnId': ''}, True),
    ({'epoch': 1, 'turnId': 'second-turn'}, True),
    ({'epoch': 'epoch-1'}, True),
])
def test_unbound_marker_cannot_hide_external_message(
    service: _Service, memory: FakeAgentCoreMemory, marker: Any, include_jti: bool,
) -> None:
    first = turn_identity('actor-1', 'user-1', nonce='first-turn')
    _turn(service, 'first', turnIdentity=first)
    service.fed()
    asyncio.run(session_api.post_message('user-1', 'thread-1', 'Scheduled result', 'scheduled-message'))
    memory.listed.clear()
    second = turn_identity('actor-1', 'user-1', nonce='second-turn', include_jti=include_jti)

    assert service.turn('second', turnIdentity=second, sessionSnapshotEpoch=marker)[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) > 0
    assert _replay('user-1', 'thread-1') == [
        ('user', 'first'), ('assistant', 'Echo: first'), ('assistant', 'Scheduled result'),
        ('user', 'second'), ('assistant', 'Echo: second'),
    ]


def test_fresh_invocation_nonces_reuse_snapshot_and_session_credentials(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, checkpoint_completion: None,
) -> None:
    sts = install_tagged_memory(monkeypatch, memory)
    first = turn_identity('actor-1', 'user-1', nonce='first-turn')
    second = turn_identity('actor-1', 'user-1', nonce='second-turn')
    assert first != second
    assert _turn(service, 'first', turnIdentity=first)[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    memory.listed.clear()

    assert _turn(service, 'second', turnIdentity=second)[-1]['type'] == 'RUN_FINISHED'
    assert sum(memory.listed.values()) <= 2
    assert len(sts.calls) == 1
    assert service.recorder.heard[-1] == ['first', 'second']
    assert _replay('user-1', 'thread-1') == [
        ('user', 'first'), ('assistant', 'Echo: first'),
        ('user', 'second'), ('assistant', 'Echo: second'),
    ]


@pytest.mark.parametrize('existing', [False, True])
def test_completed_recorded_warmup_moves_checkpoint_reads_before_send(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, existing: bool,
) -> None:
    if existing:
        _turn(service, 'first')
        service.fed()
        fresh_warm_sessions(monkeypatch)
    assert _turn(service, '', warmup=True)[-1]['value']['outcome'] == 'prepared'
    memory.listed.clear()
    reads_at_dispatch: list[int] = []
    read = serving._read_turn_checkpoint

    async def reading(*args: Any, **kwargs: Any) -> None:
        await read(*args, **kwargs)
        reads_at_dispatch.append(sum(memory.listed.values()))

    monkeypatch.setattr(serving, '_read_turn_checkpoint', reading)
    assert _turn(service, 'second')[-1]['type'] == 'RUN_FINISHED'
    assert reads_at_dispatch == [0]
    assert service.recorder.heard[-1] == (['first', 'second'] if existing else ['second'])


@pytest.mark.parametrize('reason', ['epoch', 'actor', 'write', 'failed', 'startup'])
def test_ineligible_preparation_reads_current_checkpoint(
    service: _Service, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, reason: str,
) -> None:
    _turn(service, 'first')
    service.fed()
    fresh_warm_sessions(monkeypatch)
    finish = serving._finish_preparation

    async def failing(work: Any) -> None:
        await finish(work)
        raise RuntimeError('preparation failed')

    if reason == 'failed':
        monkeypatch.setattr(serving, '_finish_preparation', failing)
    prepared = _turn(service, '', warmup=True, preparationScope='startup' if reason == 'startup' else 'recorded')
    assert prepared[-1]['value']['outcome'] == ('failed' if reason == 'failed' else 'prepared')
    monkeypatch.setattr(serving, '_finish_preparation', finish)
    if reason == 'write':
        asyncio.run(session_api.post_message('user-1', 'thread-1', 'New result', 'post-after-warmup'))
    memory.listed.clear()
    reads_at_dispatch: list[int] = []
    read = serving._read_turn_checkpoint

    async def reading(*args: Any, **kwargs: Any) -> None:
        await read(*args, **kwargs)
        reads_at_dispatch.append(sum(memory.listed.values()))

    monkeypatch.setattr(serving, '_read_turn_checkpoint', reading)
    props = {'actor': 'new-owner'} if reason == 'actor' else {}
    assert _turn(service, 'second', 'epoch-2' if reason in {'epoch', 'write'} else 'epoch-1', **props)[-1]['type'] == 'RUN_FINISHED'
    assert reads_at_dispatch[0] > 0
    assert _replay('user-1', 'thread-1')[-2:] == [('user', 'second'), ('assistant', 'Echo: second')]
    if reason == 'write':
        assert ('assistant', 'New result') in _replay('user-1', 'thread-1')
