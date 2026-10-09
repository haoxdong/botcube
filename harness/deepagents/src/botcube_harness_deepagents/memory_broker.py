from __future__ import annotations

import atexit
import contextlib
import json
import threading
from collections.abc import Iterator, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any

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


class MemoryBrokerClient:
    class exceptions:
        class ResourceNotFoundException(ClientError):
            pass

    def _request(self, operation: str, params: dict[str, Any]) -> dict[str, Any]:
        capability = _CAPABILITY.get()
        if capability is None:
            raise RuntimeError('AgentCore Memory requires an active Turn capability')
        client = _http_client()
        response = client.send(httpx.Request(
            'POST', capability.url,
            headers={**client.headers, 'Authorization': f'Bearer {capability.token}'},
            content=json.dumps({'operation': operation, 'params': params}, default=_json_default),
        ))
        if response.is_error:
            error = response.json()
            code = error.get('code', 'MemoryBrokerError')
            error_type = self.exceptions.ResourceNotFoundException if code == 'ResourceNotFoundException' else ClientError
            raise error_type({'Error': {'Code': code, 'Message': error.get('detail', 'Memory broker request failed')},
                              'ResponseMetadata': {'HTTPStatusCode': response.status_code, 'RequestId': response.headers.get('x-amzn-requestid', ''),
                                                   'HostId': '', 'HTTPHeaders': dict(response.headers), 'RetryAttempts': 0}}, operation)
        return _timestamps(response.json())

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
