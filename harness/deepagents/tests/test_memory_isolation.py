from __future__ import annotations

import asyncio
import json
import traceback
from collections.abc import Callable
from typing import Any
from uuid import UUID

import httpx
import pytest

from botcube_harness_deepagents import memory_broker
from botcube_harness_deepagents.memory_broker import (
    MemoryBrokerClient,
    MemoryCapability,
    MemoryIsolationCheckError,
    turn_memory,
)


def _responses(actor: str = 'account-a') -> list[httpx.Response]:
    return [
        httpx.Response(200, json={'events': [{'memoryId': 'memory', 'actorId': f'{actor}-filing',
                                               'sessionId': f'{actor}-session', 'eventId': 'private-event',
                                               'eventTimestamp': '2026-10-09T20:00:00.000Z'}]}),
        httpx.Response(403, json={'detail': 'Memory access is outside this Turn'}),
        httpx.Response(403, json={'detail': 'Memory access is outside this Turn'}),
        httpx.Response(200, json={'namespaces': [f'/strategies/semantic/actors/{actor}/']}),
        httpx.Response(403, json={'detail': 'Memory access is outside this Turn'}),
        httpx.Response(200, json={'events': []}),
    ]


def _transport(monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]) -> None:
    client = httpx.AsyncClient
    monkeypatch.setattr(memory_broker.httpx, 'AsyncClient', lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))


async def _check(actor: str = 'account-a', url: str = 'https://broker.test/memory') -> dict[str, str | int]:
    with turn_memory(MemoryCapability(url, f'{actor}-secret', actor)):
        return await MemoryBrokerClient().check_isolation(
            persistent_memory=True, memory_id='memory', filing_actor_id=f'{actor}-filing', session_id=f'{actor}-session', run_id=f'{actor}-run',
        )


def test_isolation_checks_exact_six_reads_without_returning_private_data(monkeypatch: pytest.MonkeyPatch) -> None:
    responses = _responses()
    requests: list[dict[str, Any]] = []
    monkeypatch.setattr(memory_broker, 'uuid4', lambda: UUID('00000000-0000-0000-0000-000000000001'))

    def post(request: httpx.Request) -> httpx.Response:
        assert request.headers['Authorization'] == 'Bearer account-a-secret'
        assert request.extensions['timeout'] == {'connect': 3, 'read': 3, 'write': 3, 'pool': 3}
        requests.append(json.loads(request.content))
        return responses.pop(0)

    _transport(monkeypatch, post)
    assert asyncio.run(_check()) == {
        'version': 1, 'runId': 'account-a-run', 'ownBefore': 200, 'foreignActor': 403,
        'foreignSession': 403, 'ownNamespaces': 200, 'foreignNamespaces': 403, 'ownAfter': 200,
    }
    assert requests == [
        {'operation': 'list_events', 'params': {'memoryId': 'memory', 'actorId': 'account-a-filing', 'sessionId': 'account-a-session', 'maxResults': 1, 'includePayloads': False}},
        {'operation': 'list_events', 'params': {'memoryId': 'memory', 'actorId': 'isolation-00000000000000000000000000000001', 'sessionId': 'account-a-session', 'maxResults': 1, 'includePayloads': False}},
        {'operation': 'list_events', 'params': {'memoryId': 'memory', 'actorId': 'account-a', 'sessionId': 'isolation-00000000000000000000000000000001', 'maxResults': 1, 'includePayloads': False}},
        {'operation': 'actor_namespaces', 'params': {'memoryId': 'memory', 'actorId': 'account-a'}},
        {'operation': 'actor_namespaces', 'params': {'memoryId': 'memory', 'actorId': 'isolation-00000000000000000000000000000001'}},
        {'operation': 'list_events', 'params': {'memoryId': 'memory', 'actorId': 'account-a-filing', 'sessionId': 'account-a-session', 'maxResults': 1, 'includePayloads': False}},
    ]
    assert memory_broker._CAPABILITY.get() is None


@pytest.mark.parametrize('allow_foreign_session', [False, True])
def test_isolation_checks_claimed_actor_foreign_session_after_account_claim(
    monkeypatch: pytest.MonkeyPatch, allow_foreign_session: bool,
) -> None:
    requests: list[dict[str, Any]] = []

    def post(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        params = body['params']
        if body['operation'] == 'actor_namespaces':
            if params['actorId'] == 'account-a':
                return httpx.Response(200, json={'namespaces': ['/strategies/semantic/actors/account-a/']})
        elif params['actorId'] == 'account-a-filing' and params['sessionId'] == 'account-a-session':
            return httpx.Response(200, json={'events': []})
        elif params['actorId'] == 'account-a' and params['sessionId'] != 'account-a-session' and allow_foreign_session:
            return httpx.Response(200, json={'events': [{'payload': 'private foreign-session history'}]})
        return httpx.Response(403, json={'detail': 'Memory access is outside this Turn'})

    _transport(monkeypatch, post)
    if allow_foreign_session:
        with pytest.raises(MemoryIsolationCheckError) as error:
            asyncio.run(_check())
        assert str(error.value) == 'Memory isolation check failed: foreignSession'
        assert error.value.code == 'MEMORY_ISOLATION_CHECK_FAILED'
        assert 'private foreign-session history' not in str(error.value)
        assert len(requests) == 3
    else:
        assert asyncio.run(_check()) == {
            'version': 1, 'runId': 'account-a-run', 'ownBefore': 200, 'foreignActor': 403,
            'foreignSession': 403, 'ownNamespaces': 200, 'foreignNamespaces': 403, 'ownAfter': 200,
        }
        assert len(requests) == 6
        assert requests[0]['params']['actorId'] == 'account-a-filing'
        assert requests[5]['params']['actorId'] == 'account-a-filing'
    assert requests[2]['params']['actorId'] == 'account-a'
    assert memory_broker._CAPABILITY.get() is None


@pytest.mark.parametrize(('index', 'response', 'case'), [
    (0, httpx.Response(403, json={'detail': 'Memory access is outside this Turn'}), 'ownBefore'),
    (0, httpx.Response(401, json={'detail': 'Invalid Turn Memory token'}), 'ownBefore'),
    (0, httpx.Response(200, json={'events': 'private malformed page'}), 'ownBefore'),
    (0, httpx.Response(200, json={'events': ['private malformed event']}), 'ownBefore'),
    (0, httpx.Response(200, json={'events': [{}]}), 'ownBefore'),
    (0, httpx.Response(200, json={'events': [{'code': 'ServiceError', 'detail': 'private error'}]}), 'ownBefore'),
    (0, httpx.Response(200, json={'events': [{}, {}]}), 'ownBefore'),
    (1, httpx.Response(200, json={'events': [{'payload': 'private'}]}), 'foreignActor'),
    (1, httpx.Response(403, json={'code': 'AccessDeniedException', 'detail': 'AgentCore Memory request failed'}), 'foreignActor'),
    (1, httpx.Response(400, json={'detail': 'Invalid Turn Memory operation'}), 'foreignActor'),
    (1, httpx.Response(404, json={'detail': 'private missing account'}), 'foreignActor'),
    (1, httpx.Response(500, json={'detail': 'private backend failure'}), 'foreignActor'),
    (2, httpx.Response(200, json={'events': []}), 'foreignSession'),
    (2, httpx.Response(403, json={'detail': 'private wrong refusal'}), 'foreignSession'),
    (3, httpx.Response(200, json={'namespaces': ['/strategies/semantic/actors/foreign/']}), 'ownNamespaces'),
    (3, httpx.Response(200, json={'namespaces': ['/strategies/semantic/actors/account-a/suffix']}), 'ownNamespaces'),
    (3, httpx.Response(200, json={'namespaces': []}), 'ownNamespaces'),
    (3, httpx.Response(200, json={'namespaces': 'private malformed namespace'}), 'ownNamespaces'),
    (4, httpx.Response(200, json={'namespaces': ['/strategies/semantic/actors/foreign/']}), 'foreignNamespaces'),
    (5, httpx.Response(403, json={'detail': 'Memory access is outside this Turn'}), 'ownAfter'),
    (0, httpx.Response(200, content='private non-json'), 'transport'),
    (0, httpx.Response(302, headers={'Location': 'https://secret.test/redirect'}), 'ownBefore'),
])
def test_isolation_rejects_inconclusive_results_without_disclosing_responses(
    monkeypatch: pytest.MonkeyPatch, index: int, response: httpx.Response, case: str,
) -> None:
    responses = _responses()
    responses[index] = response
    calls: list[httpx.Request] = []

    def post(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return responses.pop(0)

    _transport(monkeypatch, post)
    with pytest.raises(MemoryIsolationCheckError) as error:
        asyncio.run(_check())
    assert str(error.value) == f'Memory isolation check failed: {case}'
    assert error.value.code == 'MEMORY_ISOLATION_CHECK_FAILED'
    assert len(calls) == index + 1
    assert memory_broker._CAPABILITY.get() is None


def test_isolation_sanitizes_transport_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def post(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError('private bearer token and broker URL', request=request)

    _transport(monkeypatch, post)
    with pytest.raises(MemoryIsolationCheckError, match='^Memory isolation check failed: transport$') as error:
        asyncio.run(_check())
    assert error.value.__suppress_context__


def test_isolation_requires_the_active_turn_capability() -> None:
    with pytest.raises(MemoryIsolationCheckError, match='missing capability'):
        asyncio.run(MemoryBrokerClient().check_isolation(
            persistent_memory=True, memory_id='memory', filing_actor_id='filing', session_id='session', run_id='run',
        ))


@pytest.mark.parametrize('cancel', [False, True])
def test_isolation_cancellation_closes_actual_http_before_capability_scope_exits(
    monkeypatch: pytest.MonkeyPatch, cancel: bool,
) -> None:
    monkeypatch.setattr(memory_broker, '_ISOLATION_TIMEOUT', 0.2)

    async def run() -> None:
        started, disconnected = asyncio.Event(), asyncio.Event()
        requests: list[bytes] = []

        async def stalled(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            header = await reader.readuntil(b'\r\n\r\n')
            length = int(next(line.split(b':', 1)[1] for line in header.split(b'\r\n') if line.lower().startswith(b'content-length:')))
            requests.append(await reader.readexactly(length))
            started.set()
            assert await reader.read() == b''
            disconnected.set()
            writer.close()
            await writer.wait_closed()

        async with await asyncio.start_server(stalled, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            capability = MemoryCapability(f'http://127.0.0.1:{port}/memory', 'local-secret', 'account-a')
            with turn_memory(capability):
                task = asyncio.create_task(MemoryBrokerClient().check_isolation(
                    persistent_memory=True, memory_id='memory', filing_actor_id='filing-a', session_id='session-a', run_id='run-a',
                ))
                await asyncio.wait_for(started.wait(), 2)
                if cancel:
                    task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await task
                else:
                    with pytest.raises(MemoryIsolationCheckError, match='transport'):
                        await task
                await asyncio.wait_for(disconnected.wait(), 1)
                assert memory_broker._CAPABILITY.get() is capability
                assert len(requests) == 1
            assert memory_broker._CAPABILITY.get() is None

    asyncio.run(run())


def test_concurrent_isolation_checks_keep_their_own_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run() -> None:
        responses = {'account-a-secret': _responses('account-a'), 'account-b-secret': _responses('account-b')}
        requests: dict[str, list[dict[str, Any]]] = {'account-a-secret': [], 'account-b-secret': []}
        both_started = asyncio.Event()

        async def post(request: httpx.Request) -> httpx.Response:
            token = request.headers['Authorization'].removeprefix('Bearer ')
            requests[token].append(json.loads(request.content))
            if all(requests.values()):
                both_started.set()
            await asyncio.wait_for(both_started.wait(), 1)
            return responses[token].pop(0)

        client = httpx.AsyncClient
        monkeypatch.setattr(memory_broker.httpx, 'AsyncClient', lambda **kwargs: client(transport=httpx.MockTransport(post), **kwargs))
        a, b = await asyncio.gather(_check('account-a'), _check('account-b'))
        assert (a['runId'], b['runId']) == ('account-a-run', 'account-b-run')
        assert [request['params']['actorId'] for request in requests['account-a-secret']][::5] == ['account-a-filing', 'account-a-filing']
        assert [request['params']['actorId'] for request in requests['account-b-secret']][::5] == ['account-b-filing', 'account-b-filing']
        assert requests['account-a-secret'][3]['params'] == {'memoryId': 'memory', 'actorId': 'account-a'}
        assert requests['account-b-secret'][3]['params'] == {'memoryId': 'memory', 'actorId': 'account-b'}
        assert memory_broker._CAPABILITY.get() is None

    asyncio.run(run())


@pytest.mark.parametrize(('field', 'value'), [
    ('memoryId', 'foreign-memory'), ('actorId', 'account-a'), ('sessionId', 'foreign-session'),
    ('eventId', ''), ('eventId', 42), ('eventTimestamp', 'private invalid timestamp'),
    ('eventTimestamp', '2026-10-09'), ('eventTimestamp', None),
    ('payload', [{'blob': 'private history'}]), ('payload', None),
])
def test_isolation_rejects_wrong_event_scope_and_malformed_summaries(
    monkeypatch: pytest.MonkeyPatch, field: str, value: Any,
) -> None:
    responses = _responses()
    event = responses[0].json()['events'][0]
    event[field] = value
    responses[0] = httpx.Response(200, json={'events': [event]})
    _transport(monkeypatch, lambda request: responses.pop(0))
    case = 'malformed event timestamp' if value == 'private invalid timestamp' else 'ownBefore'
    with pytest.raises(MemoryIsolationCheckError) as error:
        asyncio.run(_check())
    assert str(error.value) == f'Memory isolation check failed: {case}'
    assert error.value.code == 'MEMORY_ISOLATION_CHECK_FAILED'
    if case == 'malformed event timestamp':
        assert error.value.__suppress_context__
        assert error.value.__cause__ is None
        assert 'private invalid timestamp' not in ''.join(traceback.format_exception(error.value))
    assert len(responses) == 5


def test_isolation_accepts_an_empty_payload_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    responses = _responses()
    event = responses[0].json()['events'][0]
    event['payload'] = []
    responses[0] = httpx.Response(200, json={'events': [event]})
    _transport(monkeypatch, lambda request: responses.pop(0))
    assert asyncio.run(_check()) == {
        'version': 1, 'runId': 'account-a-run', 'ownBefore': 200, 'foreignActor': 403,
        'foreignSession': 403, 'ownNamespaces': 200, 'foreignNamespaces': 403, 'ownAfter': 200,
    }
