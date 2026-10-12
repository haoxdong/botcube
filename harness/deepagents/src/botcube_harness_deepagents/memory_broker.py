from __future__ import annotations

import asyncio
import atexit
import contextlib
import json
import re
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import uuid4

import httpx
from botocore.exceptions import ClientError


@dataclass(frozen=True)
class MemoryCapability:
    url: str
    token: str
    actor_id: str


_CAPABILITY: ContextVar[MemoryCapability | None] = ContextVar('turn_memory_capability', default=None)
_HTTP: httpx.Client | None = None
_HTTP_LOCK = threading.Lock()
_ISOLATION_TIMEOUT = 12
_TIMESTAMP_KEYS = {'eventTimestamp', 'createdAt', 'updatedAt', 'timestamp', 'lastUpdatedAt'}
_OPERATIONS = {
    'list_events', 'get_event', 'create_event', 'delete_event',
    'list_memory_records', 'retrieve_memory_records', 'get_memory_record',
    'delete_memory_record', 'batch_update_memory_records', 'actor_namespaces',
}


def _http_client() -> httpx.Client:
    global _HTTP
    with _HTTP_LOCK:
        if _HTTP is None:
            _HTTP = httpx.Client(timeout=60, limits=httpx.Limits(keepalive_expiry=60))
            atexit.register(_HTTP.close)
        return _HTTP


@contextlib.contextmanager
def turn_memory(capability: MemoryCapability | None) -> Iterator[None]:
    token = _CAPABILITY.set(capability)
    try:
        yield
    finally:
        _CAPABILITY.reset(token)


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f'Cannot serialize Memory value {type(value).__name__}')


def _timestamps(value: Any) -> Any:
    if isinstance(value, list):
        return [_timestamps(item) for item in value]
    if isinstance(value, dict):
        return {
            key: datetime.fromisoformat(item.replace('Z', '+00:00'))
            if key in _TIMESTAMP_KEYS and isinstance(item, str) else _timestamps(item)
            for key, item in value.items()
        }
    return value


class MemoryIsolationCheckError(RuntimeError):
    code = 'MEMORY_ISOLATION_CHECK_FAILED'

    def __init__(self, case: str) -> None:
        super().__init__(f'Memory isolation check failed: {case}')


def take_isolation_request(forwarded: dict[str, Any]) -> bool:
    if 'memoryIsolationCheck' not in forwarded:
        return False
    if forwarded.pop('memoryIsolationCheck') != 'v1':
        raise MemoryIsolationCheckError('invalid request')
    if forwarded.get('warmup') or forwarded.get('stop'):
        raise MemoryIsolationCheckError('requires a normal Turn')
    return True


def _signed_request(operation: str, params: dict[str, Any], headers: Mapping[str, str]) -> httpx.Request:
    capability = _CAPABILITY.get()
    if capability is None:
        raise RuntimeError('AgentCore Memory requires an active Turn capability')
    return httpx.Request(
        'POST', capability.url,
        headers={**headers, 'Authorization': f'Bearer {capability.token}'},
        content=json.dumps({'operation': operation, 'params': params}, default=_json_default),
    )


def _isolation_response(response: httpx.Response, operation: str, status: int, params: dict[str, Any]) -> bool:
    if response.status_code != status:
        return False
    body = response.json()
    if status == 403:
        return body == {'detail': 'Memory access is outside this Turn'}
    if not isinstance(body, dict):
        return False
    if operation == 'actor_namespaces':
        namespaces = body.get('namespaces')
        return isinstance(namespaces, list) and bool(namespaces) and all(
            isinstance(path, str) and re.fullmatch(r'/strategies/[a-zA-Z0-9_-]+/actors/' + re.escape(params['actorId']) + '/', path)
            for path in namespaces
        )
    events = body.get('events')
    return isinstance(events, list) and len(events) <= 1 and all(
        isinstance(event, dict)
        and all(event.get(key) == params[key] for key in ('memoryId', 'actorId', 'sessionId'))
        and isinstance(event.get('eventId'), str) and bool(event['eventId'])
        and _event_timestamp(event.get('eventTimestamp'))
        and event.get('payload', []) == []
        for event in events
    )


def _event_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        raise MemoryIsolationCheckError('malformed event timestamp') from None


class MemoryBrokerClient:
    class exceptions:
        class ResourceNotFoundException(ClientError):
            pass

    def _request(self, operation: str, params: dict[str, Any]) -> dict[str, Any]:
        client = _http_client()
        response = client.send(_signed_request(operation, params, client.headers))
        if response.is_error:
            error = response.json()
            code = error.get('code', 'MemoryBrokerError')
            error_type = self.exceptions.ResourceNotFoundException if code == 'ResourceNotFoundException' else ClientError
            raise error_type({'Error': {'Code': code, 'Message': error.get('detail', 'Memory broker request failed')},
                              'ResponseMetadata': {'HTTPStatusCode': response.status_code, 'RequestId': response.headers.get('x-amzn-requestid', ''),
                                                   'HostId': '', 'HTTPHeaders': dict(response.headers), 'RetryAttempts': 0}}, operation)
        return _timestamps(response.json())

    async def check_isolation(self, *, persistent_memory: bool, memory_id: str, filing_actor_id: str, session_id: str,
                              run_id: str) -> dict[str, str | int]:
        if not persistent_memory:
            raise MemoryIsolationCheckError('requires linked Memory')
        capability = _CAPABILITY.get()
        if capability is None or not memory_id:
            raise MemoryIsolationCheckError('missing capability')
        foreign_actor = 'isolation-' + uuid4().hex
        while foreign_actor in {capability.actor_id, filing_actor_id}:
            foreign_actor = 'isolation-' + uuid4().hex
        foreign_session = 'isolation-' + uuid4().hex
        while foreign_session in {session_id, session_id + '-messages'}:
            foreign_session = 'isolation-' + uuid4().hex
        own = {'memoryId': memory_id, 'actorId': filing_actor_id, 'sessionId': session_id,
               'maxResults': 1, 'includePayloads': False}
        namespaces = {'memoryId': memory_id, 'actorId': capability.actor_id}
        cases = (
            ('ownBefore', 'list_events', own, 200),
            ('foreignActor', 'list_events', {**own, 'actorId': foreign_actor}, 403),
            ('foreignSession', 'list_events', {**own, 'actorId': capability.actor_id, 'sessionId': foreign_session}, 403),
            ('ownNamespaces', 'actor_namespaces', namespaces, 200),
            ('foreignNamespaces', 'actor_namespaces', {**namespaces, 'actorId': foreign_actor}, 403),
            ('ownAfter', 'list_events', own, 200),
        )
        receipt: dict[str, str | int] = {'version': 1, 'runId': run_id}
        try:
            async with asyncio.timeout(_ISOLATION_TIMEOUT), httpx.AsyncClient(timeout=3, follow_redirects=False) as client:
                for case, operation, params, status in cases:
                    response = await client.send(_signed_request(operation, params, client.headers))
                    if not _isolation_response(response, operation, status, params):
                        raise MemoryIsolationCheckError(case)
                    receipt[case] = status
        except MemoryIsolationCheckError:
            raise
        except Exception:
            raise MemoryIsolationCheckError('transport') from None
        return receipt

    def __getattr__(self, operation: str) -> Any:
        if operation not in _OPERATIONS:
            raise AttributeError(operation)
        return lambda **params: self._request(operation, params)

    def get_paginator(self, operation: str) -> Any:
        if operation not in {'list_events', 'list_memory_records'}:
            raise ValueError(f'Unsupported Memory paginator {operation}')
        client = self

        class Paginator:
            def paginate(self, **params: Any) -> Iterator[dict[str, Any]]:
                params.pop('PaginationConfig', None)
                while True:
                    response = client._request(operation, params)
                    yield response
                    if not response.get('nextToken'):
                        return
                    params = {**params, 'nextToken': response['nextToken']}

        return Paginator()

    def actor_namespace_paths(self, memory_id: str, actor_id: str) -> list[str]:
        return self._request('actor_namespaces', {'memoryId': memory_id, 'actorId': actor_id})['namespaces']

    def startup_snapshot(self, memory_id: str, actor_id: str, session_ids: Sequence[str]) -> dict[str, Any]:
        return self._request('startup_snapshot', {
            'memoryId': memory_id, 'actorId': actor_id, 'sessionIds': list(session_ids),
        })
