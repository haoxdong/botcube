from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import AsyncIterator, Callable, Mapping
from typing import TYPE_CHECKING, Any

import anyio
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .credential_source import (
    CredentialSource,
    CredentialSourceError,
    credential_source,
)
from .provider import UpstreamRefusal

if TYPE_CHECKING:
    from fastapi import Request

    from .audit import CredentialAuditRecorder
    from .invocation import CredentialServiceInvocation
    from .server import InvocationGuard

MODELS_PROVIDER = 'models'
MODELS_ENDPOINT_ENV = 'BOTCUBE_MODELS_ENDPOINT'
# The relay reads url, credential and headers; the rest of the Deployment Config's models Endpoint is the Chat Service's and the Harness's.
_ENDPOINT_FIELDS = frozenset({'url', 'credential', 'headers', 'kind', 'turnSummaryModel', 'cacheMarkers'})
_NOT_FORWARDED = frozenset({'authorization', 'host', 'content-length', 'connection', 'transfer-encoding', 'x-botcube-account-id', 'x-botcube-session-id'})
_READ_TIMEOUT_SECONDS = 300
_CONNECT_TIMEOUT_SECONDS = 30
_HOP_BY_HOP = frozenset({'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'})


def models_provider_from_env(
    audit: CredentialAuditRecorder,
    env: Mapping[str, str] = os.environ,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    now: Callable[[], float] = time.time,
) -> ModelsEndpointProvider | None:
    raw = env.get(MODELS_ENDPOINT_ENV, '').strip()
    if not raw:
        return None
    try:
        config = json.loads(raw)
    except ValueError:
        raise RuntimeError(f'{MODELS_ENDPOINT_ENV}: not JSON') from None
    if unknown := sorted(set(config) - _ENDPOINT_FIELDS):
        raise RuntimeError(f'{MODELS_ENDPOINT_ENV}: unknown field {", ".join(unknown)}')
    if missing := sorted({'url', 'credential'} - set(config)):
        raise RuntimeError(f'{MODELS_ENDPOINT_ENV}: missing field {", ".join(missing)}')
    credential = credential_source('models', config['credential'], env=env, now=now)
    credential.get()
    return ModelsEndpointProvider(
        config['url'].rstrip('/'), dict(config.get('headers') or {}), credential, audit=audit, transport=transport,
    )


class ModelsEndpointProvider:
    name = MODELS_PROVIDER
    upstream_scope = 'the models Endpoint'
    owner_only = False

    def __init__(
        self,
        url: str,
        headers: Mapping[str, str],
        credential: CredentialSource,
        *,
        audit: CredentialAuditRecorder,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._url = url
        self._headers = headers
        self._credential = credential
        self._audit = audit
        self._client = httpx.AsyncClient(
            transport=transport, timeout=httpx.Timeout(_READ_TIMEOUT_SECONDS, connect=_CONNECT_TIMEOUT_SECONDS),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def ready(self) -> None:
        return

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> Mapping[str, str]:
        raise HTTPException(status_code=404, detail='The models Endpoint takes its credential from the Deployment Config, not a Sign-in')

    async def revoke(self, account_id: str) -> None:
        return

    async def linked(self, account_id: str) -> bool:
        return False

    def allows_upstream(self, method: str, path: str) -> bool:
        return True

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request, path: str) -> None:
        return

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> str:
        try:
            return (await asyncio.to_thread(self._credential.get)).value
        except CredentialSourceError as error:
            raise UpstreamRefusal(500, {'error': {'message': str(error), 'type': 'models_credential'}}) from None

    async def relay(
        self, request: Request, path: str, access: str, *, account_id: str, request_context: Mapping[str, str],
    ) -> Response:
        self._audit.record_upstream_relay(account_id, MODELS_PROVIDER, request_context)
        forwarded = {name: value for name, value in request.headers.items() if name not in _NOT_FORWARDED}
        upstream_request = self._client.build_request(
            request.method, f'{self._url}/{path}', params=request.url.query or None,
            headers={**forwarded, **self._headers, 'authorization': f'Bearer {access}'}, content=await request.body(),
        )
        try:
            upstream = await self._client.send(upstream_request, stream=True)
        except httpx.TransportError as error:
            message = f'The models Endpoint {self._url} did not answer: {error!r}'
            if _dropped_before_response(error):
                return JSONResponse({'error': {'message': message, 'type': 'models_endpoint'}}, status_code=502)
            return JSONResponse({'error': {'message': message, 'type': 'models_endpoint'}}, status_code=500)
        headers = {name: value for name, value in upstream.headers.items() if name not in _HOP_BY_HOP}
        return StreamingResponse(_relayed(upstream), status_code=upstream.status_code, headers=headers)

    def routes(self, guard: InvocationGuard) -> APIRouter:
        return APIRouter()


async def _relayed(upstream: httpx.Response) -> AsyncIterator[bytes]:
    try:
        async for chunk in upstream.aiter_raw():
            yield chunk
    finally:
        with anyio.CancelScope(shield=True):
            await upstream.aclose()


def _dropped_before_response(error: BaseException | None) -> bool:
    if isinstance(error, (httpx.ConnectTimeout, ConnectionResetError, ConnectionRefusedError)):
        return True
    if isinstance(error, BaseExceptionGroup):
        return all(_dropped_before_response(each) for each in error.exceptions)
    return error is not None and _dropped_before_response(error.__cause__ or error.__context__)
