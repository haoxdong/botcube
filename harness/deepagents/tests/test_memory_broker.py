from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import boto3
import httpx
import pytest
from botocore.exceptions import ClientError
from langchain_core.messages import HumanMessage

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents.memory.agentcore import build_checkpointer, build_store
from botcube_harness_deepagents.memory_broker import (
    MemoryBrokerClient,
    MemoryCapability,
    _timestamps,
    turn_memory,
)
from botcube_harness_deepagents.messages_snapshot import MessagesSnapshot
from botcube_harness_deepagents.turn_memory import TurnMemoryMiddleware


def test_official_store_and_checkpoint_snapshot_use_http_without_runtime_aws(monkeypatch: pytest.MonkeyPatch) -> None:
    memory = FakeAgentCoreMemory()
    wire: list[dict[str, Any]] = []

    def no_aws(*args: Any, **kwargs: Any) -> None:
        raise AssertionError('Runtime attempted AWS credential discovery')

    def post(url: str, *, headers: dict[str, str], content: str, timeout: int) -> httpx.Response:
        assert headers == {'Authorization': 'Bearer account-turn'}
        assert url == 'https://chat.test/internal/turn-memory'
        request = json.loads(content)
        wire.append(request)
        response = getattr(memory, request['operation'])(**_timestamps(request['params']))
        return httpx.Response(200, content=json.dumps(response, default=lambda value: value.isoformat()))

    monkeypatch.setattr(boto3, 'client', no_aws)
    monkeypatch.setattr(httpx, 'post', post)
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


def test_broker_restores_datetimes_and_modeled_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    responses = [httpx.Response(200, json={'events': [{'eventTimestamp': '2026-10-06T00:00:00Z'}]}),
                 httpx.Response(404, json={'code': 'ResourceNotFoundException', 'detail': 'Missing Session'})]
    monkeypatch.setattr(httpx, 'post', lambda *args, **kwargs: responses.pop(0))
    client = MemoryBrokerClient()
    with turn_memory(MemoryCapability('https://chat.test/memory', 'token', 'actor')):
        assert client.list_events(memoryId=MEMORY_ID, actorId='actor', sessionId='session') == {
            'events': [{'eventTimestamp': datetime(2026, 10, 6, tzinfo=UTC)}],
        }
        with pytest.raises(client.exceptions.ResourceNotFoundException) as failure:
            client.list_events(memoryId=MEMORY_ID, actorId='actor', sessionId='session')
        assert failure.value.response.get('Error') == {'Code': 'ResourceNotFoundException', 'Message': 'Missing Session'}
        assert isinstance(failure.value, ClientError)


def test_stop_waits_for_inflight_extraction_before_revoking_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    started, release = threading.Event(), threading.Event()
    saved: list[str] = []

    def post(url: str, *, headers: dict[str, str], content: str, timeout: int) -> httpx.Response:
        started.set()
        assert release.wait(2)
        saved.append(headers['Authorization'])
        return httpx.Response(200, json={'event': {}})

    monkeypatch.setattr(httpx, 'post', post)
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


def test_shared_client_keeps_overlapping_turn_capabilities_separate(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    rendezvous = threading.Barrier(2)

    def post(url: str, *, headers: dict[str, str], content: str, timeout: int) -> httpx.Response:
        params = json.loads(content)['params']
        rendezvous.wait(timeout=2)
        assert headers['Authorization'] == f'Bearer {params["actorId"]}-token'
        return httpx.Response(200, json={'events': [{'actorId': params['actorId']}]})

    monkeypatch.setattr(httpx, 'post', post)
    client = MemoryBrokerClient()

    async def read(actor: str) -> dict[str, Any]:
        with turn_memory(MemoryCapability('https://chat.test/memory', f'{actor}-token', actor)):
            return await asyncio.to_thread(client.list_events, memoryId=MEMORY_ID, actorId=actor, sessionId='session')

    async def both() -> list[dict[str, Any]]:
        return list(await asyncio.gather(read('account-a'), read('account-b')))

    assert asyncio.run(both()) == [{'events': [{'actorId': 'account-a'}]}, {'events': [{'actorId': 'account-b'}]}]


def test_checkpoint_flush_persists_only_its_bound_session(monkeypatch: pytest.MonkeyPatch) -> None:
    from langgraph.checkpoint.base import empty_checkpoint

    from botcube_harness_deepagents.memory.agentcore.turn_saver import (
        TurnCheckpointSaver,
    )
    memory = FakeAgentCoreMemory()

    def post(url: str, *, headers: dict[str, str], content: str, timeout: int) -> httpx.Response:
        params = _timestamps(json.loads(content)['params'])
        assert headers['Authorization'] == f'Bearer {params["sessionId"]}'
        response = getattr(memory, json.loads(content)['operation'])(**params)
        return httpx.Response(200, content=json.dumps(response, default=lambda value: value.isoformat()))

    monkeypatch.setattr(httpx, 'post', post)
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True, wrapper=TurnCheckpointSaver)
    for session in ['session-a', 'session-b']:
        config = {'configurable': {'thread_id': session, 'actor_id': session, 'checkpoint_ns': ''}}
        saver.put(config, {**empty_checkpoint(), 'id': session}, {'source': 'loop', 'step': 1, 'parents': {}}, {})
    for session in ['session-a', 'session-b']:
        with turn_memory(MemoryCapability('https://chat.test/memory', session, session)):
            asyncio.run(saver.aflush((session, session)))
    assert set(memory.events) == {('session-a', 'session-a'), ('session-b', 'session-b')}
    assert memory.create_event_calls == 2
