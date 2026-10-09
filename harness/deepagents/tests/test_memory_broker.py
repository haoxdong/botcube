from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import boto3
import httpx
import pytest
from botocore.exceptions import ClientError
from langchain_core.messages import HumanMessage

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents import memory_broker
from botcube_harness_deepagents.memory.agentcore import build_checkpointer, build_store
from botcube_harness_deepagents.memory_broker import (
    MemoryBrokerClient,
    MemoryCapability,
    _timestamps,
    turn_memory,
)
from botcube_harness_deepagents.messages_snapshot import MessagesSnapshot
from botcube_harness_deepagents.turn_memory import TurnMemoryMiddleware

BrokerHttp = Callable[[Callable[[httpx.Request], httpx.Response]], None]


@pytest.fixture
def broker_http(monkeypatch: pytest.MonkeyPatch) -> BrokerHttp:
    def install(handler: Callable[[httpx.Request], httpx.Response]) -> None:
        monkeypatch.setattr(memory_broker._http_client(), 'send', handler)
    return install


def test_official_store_and_checkpoint_snapshot_use_http_without_runtime_aws(monkeypatch: pytest.MonkeyPatch, broker_http: BrokerHttp) -> None:
    memory = FakeAgentCoreMemory()
    wire: list[dict[str, Any]] = []

    def no_aws(*args: Any, **kwargs: Any) -> None:
        raise AssertionError('Runtime attempted AWS credential discovery')

    def post(wire_request: httpx.Request) -> httpx.Response:
        assert wire_request.headers['Authorization'] == 'Bearer account-turn'
        assert str(wire_request.url) == 'https://chat.test/internal/turn-memory'
        request = json.loads(wire_request.content)
        wire.append(request)
        response = getattr(memory, request['operation'])(**_timestamps(request['params']))
        return httpx.Response(200, content=json.dumps(response, default=lambda value: value.isoformat()))

    monkeypatch.setattr(boto3, 'client', no_aws)
    broker_http(post)
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True)
    store = build_store(MEMORY_ID, region_name='us-east-1', broker=True)
    messages = [{'id': 'message', 'role': 'user', 'content': 'Remember copper'}]
    with turn_memory(MemoryCapability('https://chat.test/internal/turn-memory', 'account-turn', 'actor-a')):
        store.put(('actor-a', 'pending-memory-20261006'), 'message', {'message': HumanMessage(content='Prefers copper')})
        asyncio.run(saver.awrite_messages_snapshot('actor-a', 'session', MessagesSnapshot('checkpoint', messages, 'run')))
        restored = asyncio.run(saver.aread_messages_snapshot('actor-a', 'session'))
    assert restored == MessagesSnapshot('checkpoint', messages, 'run')
    assert memory.events[('actor-a', 'pending-memory-20261006')][0]['payload'] == [
        {'conversational': {'content': {'text': 'Prefers copper'}, 'role': 'USER'}},
    ]
    assert {request['operation'] for request in wire} == {'create_event', 'list_events'}
    assert isinstance(wire[0]['params']['eventTimestamp'], str)
    with pytest.raises(RuntimeError, match='active Turn capability'):
        store.client.list_events(memoryId=MEMORY_ID, actorId='actor-a', sessionId='session')


def test_broker_restores_datetimes_and_modeled_errors(broker_http: BrokerHttp) -> None:
    responses = [httpx.Response(200, json={'events': [{'eventTimestamp': '2026-10-06T00:00:00Z'}]}),
                 httpx.Response(404, json={'code': 'ResourceNotFoundException', 'detail': 'Missing Session'})]
    broker_http(lambda _request: responses.pop(0))
    client = MemoryBrokerClient()
    with turn_memory(MemoryCapability('https://chat.test/memory', 'token', 'actor')):
        assert client.list_events(memoryId=MEMORY_ID, actorId='actor', sessionId='session') == {
            'events': [{'eventTimestamp': datetime(2026, 10, 6, tzinfo=UTC)}],
        }
        with pytest.raises(client.exceptions.ResourceNotFoundException) as failure:
            client.list_events(memoryId=MEMORY_ID, actorId='actor', sessionId='session')
        assert failure.value.response.get('Error') == {'Code': 'ResourceNotFoundException', 'Message': 'Missing Session'}
        assert isinstance(failure.value, ClientError)


def test_startup_snapshot_preserves_memory_edits_order_and_pending_saves_in_one_request(monkeypatch: pytest.MonkeyPatch, broker_http: BrokerHttp) -> None:
    from botcube_harness_deepagents.memory_document import (
        actor_memory_records,
        startup_memory_records,
    )

    now = datetime(2026, 10, 6, 12, tzinfo=UTC)
    monkeypatch.setattr('botcube_harness_deepagents.memory_document.utc_now', lambda: now)
    previous = 'memory-saves-5970959'
    current = 'memory-saves-5970960'
    pending = 'pending-memory-20261006'
    records = [
        {'memoryRecordId': 'preference', 'memoryStrategyId': 'UserPreferences-1', 'namespaces': ['/strategies/preferences/actors/actor-a/'], 'createdAt': now, 'content': {'text': 'Prefers tea'}},
        {'memoryRecordId': 'old-fact', 'memoryStrategyId': 'SemanticFacts-1', 'namespaces': ['/strategies/facts/actors/actor-a/'], 'createdAt': datetime(2026, 10, 1, tzinfo=UTC), 'content': {'text': 'Lives in Paris'}},
        {'memoryRecordId': 'deleted', 'memoryStrategyId': 'SemanticFacts-1', 'namespaces': ['/strategies/facts/actors/actor-a/'], 'createdAt': now, 'content': {'text': 'Trades copper'}},
        {'memoryRecordId': 'new-fact', 'memoryStrategyId': 'SemanticFacts-1', 'namespaces': ['/strategies/facts/actors/actor-a/'], 'createdAt': now, 'content': {'text': 'Studies history'}},
        {'memoryRecordId': 'foreign', 'memoryStrategyId': 'SemanticFacts-1', 'namespaces': ['/strategies/facts/actors/actor-b/'], 'createdAt': now, 'content': {'text': 'Private'}},
    ]
    events = {
        previous: [{'eventTimestamp': datetime(2026, 10, 6, 11, 59, tzinfo=UTC), 'payload': [{'blob': json.dumps({'recordId': 'old-fact', 'text': 'Lives in Berlin'})}]}],
        current: [
            {'eventTimestamp': now, 'payload': [{'blob': json.dumps({'recordId': 'old-fact', 'text': 'Lives in London'})}]},
            {'eventTimestamp': now, 'payload': [{'blob': json.dumps({'recordId': 'deleted', 'text': None})}]},
        ],
        pending: [{'eventTimestamp': now, 'payload': [{'conversational': {'content': {'text': 'Remember silver'}, 'role': 'USER'}}]}],
    }
    wire: list[dict[str, Any]] = []

    def post(wire_request: httpx.Request) -> httpx.Response:
        request = json.loads(wire_request.content)
        wire.append(request)
        assert wire_request.headers['Authorization'] == 'Bearer account-turn'
        if request['operation'] == 'startup_snapshot':
            response = {'memoryRecordSummaries': records, 'eventsBySession': events}
        elif request['operation'] == 'actor_namespaces':
            response = {'namespaces': ['/strategies/owned/actors/actor-a/']}
        elif request['operation'] == 'list_memory_records':
            response = {'memoryRecordSummaries': records}
        else:
            response = {'events': events[request['params']['sessionId']]}
        return httpx.Response(200, content=json.dumps(response, default=lambda value: value.isoformat()))

    broker_http(post)
    client = MemoryBrokerClient()
    with turn_memory(MemoryCapability('https://chat.test/memory', 'account-turn', 'actor-a')):
        preferences, facts, pending_events = startup_memory_records(
            client, memory_id=MEMORY_ID, actor_id='actor-a', pending_session_ids=[pending], now=now,
        )
        assert wire == [{'operation': 'startup_snapshot', 'params': {
            'memoryId': MEMORY_ID, 'actorId': 'actor-a', 'sessionIds': [previous, current, pending],
        }}]
        assert [(r['memoryRecordId'], r['content'].get('text')) for r in preferences] == [('preference', 'Prefers tea')]
        assert [(r['memoryRecordId'], r['content'].get('text')) for r in facts] == [
            ('new-fact', 'Studies history'), ('old-fact', 'Lives in London'),
        ]
        assert pending_events == events[pending]
        assert (preferences, facts) == actor_memory_records(client, memory_id=MEMORY_ID, actor_id='actor-a')


def test_startup_snapshot_does_not_hide_a_broker_failure(broker_http: BrokerHttp) -> None:
    broker_http(lambda _request: httpx.Response(
        429, json={'code': 'ThrottlingException', 'detail': 'AgentCore Memory request failed'},
    ))
    client = MemoryBrokerClient()
    with turn_memory(MemoryCapability('https://chat.test/memory', 'account-turn', 'actor-a')), pytest.raises(ClientError, match='ThrottlingException'):
        client.startup_snapshot(MEMORY_ID, 'actor-a', ['pending-memory-20261006'])


def test_stop_waits_for_inflight_extraction_before_revoking_capability(broker_http: BrokerHttp) -> None:
    import threading
    started, release = threading.Event(), threading.Event()
    saved: list[str] = []

    def post(wire_request: httpx.Request) -> httpx.Response:
        started.set()
        assert release.wait(2)
        saved.append(wire_request.headers['Authorization'])
        return httpx.Response(200, json={'event': {}})

    broker_http(post)
    middleware = TurnMemoryMiddleware(memory_id=MEMORY_ID, actor_id='actor', session_id='session')
    store = build_store(MEMORY_ID, region_name='us-east-1', broker=True)

    async def stopped() -> None:
        with turn_memory(MemoryCapability('https://chat.test/memory', 'active-turn', 'actor')):
            task = asyncio.create_task(middleware.aafter_agent({'messages': [HumanMessage(content='Copper')]}, type('Runtime', (), {'store': store})()))
            from botcube_harness_deepagents.serving import _Turn
            turn = _Turn(run_id="run", work=task)
            assert await asyncio.to_thread(started.wait, 1)
            turn.stop()
            await asyncio.sleep(0)
            assert not task.done()
            turn.stop()
            await asyncio.sleep(0)
            assert not task.done()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert saved == ['Bearer active-turn']

    asyncio.run(stopped())


def test_shared_client_keeps_overlapping_turn_capabilities_separate(broker_http: BrokerHttp) -> None:
    import threading
    rendezvous = threading.Barrier(2)

    def post(wire_request: httpx.Request) -> httpx.Response:
        params = json.loads(wire_request.content)['params']
        rendezvous.wait(timeout=2)
        assert wire_request.headers['Authorization'] == f'Bearer {params["actorId"]}-token'
        return httpx.Response(200, json={'events': [{'actorId': params['actorId']}]})

    broker_http(post)
    client = MemoryBrokerClient()

    async def read(actor: str) -> dict[str, Any]:
        with turn_memory(MemoryCapability('https://chat.test/memory', f'{actor}-token', actor)):
            return await asyncio.to_thread(client.list_events, memoryId=MEMORY_ID, actorId=actor, sessionId='session')

    async def both() -> list[dict[str, Any]]:
        return list(await asyncio.gather(read('account-a'), read('account-b')))

    assert asyncio.run(both()) == [{'events': [{'actorId': 'account-a'}]}, {'events': [{'actorId': 'account-b'}]}]


def test_checkpoint_flush_persists_only_its_bound_session(broker_http: BrokerHttp) -> None:
    from langgraph.checkpoint.base import empty_checkpoint

    from botcube_harness_deepagents.memory.agentcore.turn_saver import (
        TurnCheckpointSaver,
    )
    memory = FakeAgentCoreMemory()

    def post(wire_request: httpx.Request) -> httpx.Response:
        params = _timestamps(json.loads(wire_request.content)['params'])
        assert wire_request.headers['Authorization'] == f'Bearer {params["sessionId"]}'
        response = getattr(memory, json.loads(wire_request.content)['operation'])(**params)
        return httpx.Response(200, content=json.dumps(response, default=lambda value: value.isoformat()))

    broker_http(post)
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True, wrapper=TurnCheckpointSaver)
    for session in ['session-a', 'session-b']:
        config = {'configurable': {'thread_id': session, 'actor_id': session, 'checkpoint_ns': ''}}
        saver.put(config, {**empty_checkpoint(), 'id': session}, {'source': 'loop', 'step': 1, 'parents': {}}, {})
    for session in ['session-a', 'session-b']:
        with turn_memory(MemoryCapability('https://chat.test/memory', session, session)):
            asyncio.run(saver.aflush((session, session)))
    assert set(memory.events) == {('session-a', 'session-a'), ('session-b', 'session-b')}
    assert memory.create_event_calls == 2

    async def listed(session: str) -> list[str]:
        with turn_memory(MemoryCapability('https://chat.test/memory', session, session)):
            config = {'configurable': {'thread_id': session, 'actor_id': session, 'checkpoint_ns': ''}}
            return [item.checkpoint['id'] async for item in saver.alist(config)]

    async def both() -> list[list[str]]:
        return list(await asyncio.gather(listed('session-a'), listed('session-b')))

    assert asyncio.run(both()) == [['session-a'], ['session-b']]
