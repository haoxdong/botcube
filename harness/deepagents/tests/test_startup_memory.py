from __future__ import annotations

import asyncio
from typing import Any

import pytest

from botcube_harness_deepagents import serving
from test_serving import (
    _memory_record,
    _RegionalMemory,
    _Service,
    _sse_events,
)
from test_serving import (
    agentcore_memory as agentcore_memory,
)
from test_serving import (
    service as service,
)


def test_startup_snapshot_refreshes_on_a_new_conversation_or_memory_revision(
    service: _Service, agentcore_memory: _RegionalMemory,
) -> None:
    preference = _memory_record('Prefers tea', 'UserPreferences-1', 'actor-1')
    agentcore_memory.records += [preference, _memory_record('Private preference', 'UserPreferences-1', 'actor-2')]
    member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}

    first = service.turn('hello', thread='thread-a', **member)
    preference['content'] = {'text': 'Prefers coffee'}
    warm = service.turn('hello again', thread='thread-a', **member)
    fresh = service.turn('hello', thread='thread-b', **member)
    edited = service.turn('hello after editing Memory', thread='thread-a', memoryRevision=1, **member)

    assert all(events[-1]['type'] == 'RUN_FINISHED' for events in [first, warm, fresh, edited])
    assert agentcore_memory.startup_snapshot_calls == 3
    assert ['Prefers tea' in prompt for prompt in service.recorder.prompts] == [True, True, False, False]
    assert ['Prefers coffee' in prompt for prompt in service.recorder.prompts] == [False, False, True, True]
    assert all('Private preference' not in prompt for prompt in service.recorder.prompts)


@pytest.mark.parametrize('scope', ['startup', 'recorded', None])
def test_authorized_warmup_prepares_memory_without_model_execution_or_writes(
    service: _Service, agentcore_memory: _RegionalMemory, scope: str | None,
) -> None:
    agentcore_memory.records.append(_memory_record('Prefers tea', 'UserPreferences-1', 'actor-1'))
    member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}

    props = {'preparationScope': scope} if scope is not None else {}
    assert service.turn('', warmup=True, **props, **member) == [_ack('run-0', 'prepared')]
    assert agentcore_memory.listed.get('thread-1', 0) == (0 if scope == 'startup' else 1)
    assert agentcore_memory.startup_snapshot_calls == 1
    assert agentcore_memory.create_event_calls == 0
    assert service.recorder.prompts == []

    answer = service.turn('hello', **member)
    assert answer[-1]['type'] == 'RUN_FINISHED'
    assert agentcore_memory.startup_snapshot_calls == 1
    assert 'Prefers tea' in service.recorder.prompts[-1]


def test_authorized_warmup_restores_an_existing_conversation_before_the_next_turn(
    service: _Service, agentcore_memory: _RegionalMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
    assert service.turn('first message', **member)[-1]['type'] == 'RUN_FINISHED'
    for name in ('_AGENTS', '_BACKENDS', '_AGENT_BACKENDS', '_BACKEND_BY_AGENT', '_THREAD_LTM_CONTEXTS'):
        monkeypatch.setattr(serving, name, {})
    for name in ('_CHECKPOINTER', '_STORE', '_DEFERRED_SAVER'):
        monkeypatch.setattr(serving, name, None)
    writes = agentcore_memory.create_event_calls
    prompts = len(service.recorder.prompts)
    reads = agentcore_memory.listed['thread-1']

    assert service.turn('', warmup=True, preparationScope='recorded', **member) == [_ack('run-1', 'prepared')]
    assert agentcore_memory.listed['thread-1'] == reads + 1
    assert agentcore_memory.create_event_calls == writes
    assert len(service.recorder.prompts) == prompts

    answer = service.turn('second message', **member)
    assert answer[-1]['type'] == 'RUN_FINISHED'
    assert agentcore_memory.listed['thread-1'] == reads + 1


@pytest.mark.parametrize('busy', [False, True])
def test_warmup_without_a_capability_or_during_session_work_does_not_read_memory(
    service: _Service, agentcore_memory: _RegionalMemory, busy: bool,
) -> None:
    props: dict[str, object] = {
        'actorId': 'actor-1', 'sessionUserId': 'actor-1', 'memory': True, 'warmup': True,
        'preparationScope': 'startup',
    }
    lock = asyncio.Lock()
    assert service.client.portal is not None
    if busy:
        props['turnMemory'] = {'url': 'https://chat.test/internal/turn-memory',
                               'token': '{"actor":"actor-1","filing":"actor-1","thread":"thread-1"}'}
        serving._SESSION_TURNS._locks[('actor-1', 'thread-1')] = lock
        service.client.portal.call(lock.acquire)
    try:
        response = service.client.post('/invocations', json={
            'threadId': 'thread-1', 'runId': 'warmup', 'messages': [],
            'tools': [], 'context': [], 'state': {}, 'forwardedProps': props,
        })
        assert response.status_code == 200
        events = _sse_events(response.text)
        if busy:
            assert events == [_ack('warmup', 'skipped-busy')]
        else:
            error = {'code': 'MISSING_USER_ID', 'message': 'Invocation carries no Turn Memory capability'}
            assert events == [{'type': 'RUN_ERROR', **error}, _ack('warmup', 'failed', **error)]
        assert agentcore_memory.startup_snapshot_calls == 0
        assert agentcore_memory.create_event_calls == 0
        assert service.recorder.prompts == []
        assert service.recorder.builds == []
    finally:
        if busy:
            service.client.portal.call(lock.release)


def _ack(run_id: str, outcome: str, **error: str) -> dict[str, Any]:
    return {'type': 'CUSTOM', 'name': 'SESSION_PREPARATION', 'value': {
        'runId': run_id, 'sessionId': 'thread-1', 'outcome': outcome,
        **({'error': error} if error else {}),
    }}


@pytest.mark.parametrize('failure_at', [None, 'authentication', 'build', 'history'])
def test_preparation_ack_follows_lock_release_even_when_preparation_fails(
    service: _Service, monkeypatch: pytest.MonkeyPatch, failure_at: str | None,
) -> None:
    encoded: list[dict[str, Any]] = []
    encode = serving.EventEncoder.encode
    get_agent = serving._get_agent

    async def fail_history(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError('history unavailable')

    def build(**kwargs: Any) -> Any:
        if failure_at == 'build':
            raise RuntimeError('build unavailable')
        agent = get_agent(**kwargs)
        if failure_at == 'history':
            monkeypatch.setattr(agent.graph, 'aget_state', fail_history)
        return agent

    def observe(encoder: Any, event: Any) -> str:
        if event.type == 'CUSTOM' and event.name == 'SESSION_PREPARATION':
            lock = serving._SESSION_TURNS._locks.get(('user-1', 'thread-1'))
            assert lock is None or not lock.locked(), 'ACK was published before releasing preparation'
            encoded.append(event.value)
        return encode(encoder, event)

    monkeypatch.setattr(serving, '_get_agent', build)
    monkeypatch.setattr(serving.EventEncoder, 'encode', observe)
    events = service.turn('', warmup=True, preparationScope='recorded',
                          actor=None if failure_at == 'authentication' else 'actor-1')
    if failure_at is None:
        expected = _ack('run-0', 'prepared')
        assert events == [expected]
    else:
        error = {
            'code': 'MISSING_USER_ID' if failure_at == 'authentication' else 'INTERNAL_ERROR',
            'message': ('Invocation carries no user ID; the Chat Service must forward the account ID'
                        if failure_at == 'authentication' else f'{failure_at} unavailable'),
        }
        expected = _ack('run-0', 'failed', **error)
        assert events == [{'type': 'RUN_ERROR', **error}, expected]
    assert encoded == [expected['value']]
    assert service.recorder.prompts == []


def test_scoped_preparation_requires_its_session_filing_id(service: _Service) -> None:
    events = service.turn('', user=None, warmup=True, preparationScope='startup')
    error = {
        'code': 'MISSING_USER_ID',
        'message': 'Invocation carries no Session filing ID; the Chat Service must forward sessionUserId',
    }
    assert events == [{'type': 'RUN_ERROR', **error}, _ack('run-0', 'failed', **error)]
    assert service.recorder.builds == []
