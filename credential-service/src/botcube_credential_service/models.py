from __future__ import annotations

import asyncio
import contextlib
import os
import ssl
import time
from collections.abc import AsyncIterator, Callable, Generator, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import anyio
import httpcore
import httpx
from fastapi import APIRouter, HTTPException, WebSocket
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .credential_source import (
    CredentialSource,
    CredentialSourceError,
    credential_source,
)
from .endpoint_tls import EndpointTls, EndpointTlsError, endpoint_tls
from .proxy_relay import proxy_url_from_config

if TYPE_CHECKING:
    from fastapi import Request

    from .audit import CredentialAuditRecorder
    from .generated.resolved_config_types import ResolvedConfig
    from .invocation import CredentialServiceInvocation
    from .server import InvocationGuard

MODELS_PROVIDER = 'models'
_NOT_FORWARDED = frozenset({'authorization', 'x-api-key', 'host', 'content-length', 'connection', 'transfer-encoding', 'x-botcube-account-id', 'x-botcube-session-id'})
_READ_TIMEOUT_SECONDS = 300
_CONNECT_TIMEOUT_SECONDS = 30
_HOP_BY_HOP = frozenset({'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'})


def models_provider_from_config(
    audit: CredentialAuditRecorder,
    resolved: ResolvedConfig,
    env: Mapping[str, str] = os.environ,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    now: Callable[[], float] = time.time,
) -> ModelsEndpointProvider | None:
    """The relay to the BotCube Config's model gateway, each provider at its own URL, or None on Bedrock."""
    config = resolved['config']
    models = config['integrations']['modelGateway']
    if models['kind'] != 'openai-compatible':
        return None
    through = proxy_url_from_config(config, env) if models.get('proxy') else None
    proxy = through() if through else None
    providers = models.get('providers', {})
    overrides = {'anthropic': providers.get('anthropic'), 'openai': providers.get('openai')}
    credentials: dict[str, CredentialSource] = {}
    routes: dict[str, ProviderRoute] = {}
    for provider, reach in resolved['modelGateway'].items():
        route = reach['route']
        if route is None:
            continue
        override = overrides.get(provider)
        seam = f'models {provider}' if override and 'credential' in override else 'models'
        if seam not in credentials:
            credentials[seam] = credential_source(seam, route['credential'], env=env, now=now, proxy=proxy)
            credentials[seam].get()
        routes[provider] = ProviderRoute(route['url'], route['headers'], credentials[seam])
    tls = endpoint_tls('models', models['tls'], env=env) if 'tls' in models else None
    if tls is not None:
        tls.context()
    return ModelsEndpointProvider(routes, audit=audit, transport=transport, tls=tls, proxy=proxy)


@dataclass(frozen=True)
class ProviderRoute:
    """Where the gateway serves one provider's own API, and the credential and headers sent there."""

    url: str
    headers: Mapping[str, str]
    credential: CredentialSource


class ModelsEndpointProvider:
    name = MODELS_PROVIDER
    upstream_scope = 'the models Endpoint'
    owner_only = False

    def __init__(
        self,
        routes: Mapping[str, ProviderRoute],
        *,
        audit: CredentialAuditRecorder,
        transport: httpx.AsyncBaseTransport | None = None,
        tls: EndpointTls | None = None,
        proxy: str | None = None,
    ) -> None:
        self._routes = routes
        self._audit = audit
        self._clients = {
            provider: httpx.AsyncClient(
                transport=_EndpointTransport(route.url, tls, proxy) if tls is not None else transport,
                proxy=None if tls is not None else proxy,
                timeout=httpx.Timeout(_READ_TIMEOUT_SECONDS, connect=_CONNECT_TIMEOUT_SECONDS),
            )
            for provider, route in routes.items()
        }

    async def aclose(self) -> None:
        for client in self._clients.values():
            await client.aclose()

    def ready(self) -> None:
        return

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> Mapping[str, str]:
        raise HTTPException(status_code=404, detail='The models Endpoint takes its credential from the BotCube Config, not a Sign-in')

    async def revoke(self, account_id: str) -> None:
        return

    async def linked(self, account_id: str) -> bool:
        return False

    def allows_upstream(self, method: str, path: str) -> bool:
        return True

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request | WebSocket, path: str) -> None:
        if path.split('/', 1)[0] not in self._routes:
            raise HTTPException(status_code=404, detail=f'The model gateway serves the providers {" and ".join(self._routes)}, under their names')

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> str:
        """No access of its own: `relay` reads the credential of the provider the call names."""
        return ''

    async def relay(
        self, request: Request | WebSocket, path: str, access: str, *, account_id: str, request_context: Mapping[str, str],
    ) -> Response:
        if isinstance(request, WebSocket):
            raise HTTPException(status_code=501, detail='The models Endpoint relays HTTP only')
        provider, _, rest = path.partition('/')
        route = self._routes[provider]
        try:
            bearer = (await asyncio.to_thread(route.credential.get)).value
        except CredentialSourceError as error:
            return JSONResponse({'error': {'message': str(error), 'type': 'models_credential'}}, status_code=500)
        self._audit.record_upstream_relay(account_id, MODELS_PROVIDER, request_context)
        forwarded = {name: value for name, value in request.headers.items() if name not in _NOT_FORWARDED}
        client = self._clients[provider]
        upstream_request = client.build_request(
            request.method, f'{route.url}/{rest}', params=request.url.query or None,
            headers={**forwarded, **route.headers, 'authorization': f'Bearer {bearer}'}, content=await request.body(),
        )
        try:
            upstream = await client.send(upstream_request, stream=True)
        except httpx.TransportError as error:
            message = f'The models Endpoint {route.url} did not answer: {error!r}'
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


class _EndpointTransport(httpx.AsyncBaseTransport):
    """
    httpx's transport for an Endpoint with TLS: httpx reads one SSL context per client, so this owns the httpcore pool
    and gives it a network backend that opens each Endpoint handshake with the certificate as read now. Trust roots
    are the system's and SSL_CERT_FILE's; the handshake runs through the tunnel of `proxy` when given.
    """

    def __init__(self, url: str, tls: EndpointTls, proxy: str | None = None) -> None:
        origin = httpx.URL(url)
        if origin.scheme != 'https':
            raise EndpointTlsError(f'models TLS: the Endpoint {url} is not https')
        endpoint_context = ssl.create_default_context()
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=endpoint_context,
            proxy=_proxy(proxy),
            network_backend=_TlsBackend(_anyio_backend(), tls, endpoint_context),
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        with _httpx_errors():
            response = await self._pool.handle_async_request(httpcore.Request(
                method=request.method,
                url=httpcore.URL(scheme=request.url.raw_scheme, host=request.url.raw_host, port=request.url.port, target=request.url.raw_path),
                headers=request.headers.raw,
                content=request.stream,
                extensions=request.extensions,
            ))
        return httpx.Response(status_code=response.status, headers=response.headers, stream=_ResponseStream(response), extensions=response.extensions)

    async def aclose(self) -> None:
        await self._pool.aclose()


def _anyio_backend() -> httpcore.AsyncNetworkBackend:
    backend = httpcore.AnyIOBackend()
    if not isinstance(backend, httpcore.AsyncNetworkBackend):
        raise RuntimeError('httpcore has no anyio backend')
    return backend


def _proxy(address: str | None) -> httpcore.Proxy | None:
    if address is None:
        return None
    proxy = httpx.Proxy(address)
    return httpcore.Proxy(
        url=httpcore.URL(scheme=proxy.url.raw_scheme, host=proxy.url.raw_host, port=proxy.url.port, target=proxy.url.raw_path),
        auth=proxy.auth, headers=proxy.headers.raw, ssl_context=ssl.create_default_context(),
    )


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self, response: httpcore.Response) -> None:
        self._response = response

    async def __aiter__(self) -> AsyncIterator[bytes]:
        with _httpx_errors():
            async for chunk in self._response.aiter_stream():
                yield chunk

    async def aclose(self) -> None:
        await self._response.aclose()


_HTTPX_ERRORS: tuple[tuple[type[Exception], type[httpx.TransportError]], ...] = (
    (httpcore.ConnectTimeout, httpx.ConnectTimeout),
    (httpcore.ReadTimeout, httpx.ReadTimeout),
    (httpcore.WriteTimeout, httpx.WriteTimeout),
    (httpcore.PoolTimeout, httpx.PoolTimeout),
    (httpcore.TimeoutException, httpx.TimeoutException),
    (httpcore.ConnectError, httpx.ConnectError),
    (httpcore.ReadError, httpx.ReadError),
    (httpcore.WriteError, httpx.WriteError),
    (httpcore.NetworkError, httpx.NetworkError),
    (httpcore.ProxyError, httpx.ProxyError),
    (httpcore.UnsupportedProtocol, httpx.UnsupportedProtocol),
    (httpcore.RemoteProtocolError, httpx.RemoteProtocolError),
    (httpcore.LocalProtocolError, httpx.LocalProtocolError),
    (httpcore.ProtocolError, httpx.ProtocolError),
)


@contextlib.contextmanager
def _httpx_errors() -> Generator[None]:
    """httpcore's errors as the httpx errors `relay` handles, each keeping its cause."""
    try:
        yield
    except Exception as error:
        mapped = next((target for source, target in _HTTPX_ERRORS if isinstance(error, source)), None)
        if mapped is None:
            raise
        raise mapped(str(error)) from error


class _TlsBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, inner: httpcore.AsyncNetworkBackend, tls: EndpointTls, endpoint_context: ssl.SSLContext) -> None:
        self._inner = inner
        self._tls = tls
        self._endpoint_context = endpoint_context

    async def connect_tcp(
        self, host: str, port: int, timeout: float | None = None, local_address: str | None = None, socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        stream = await self._inner.connect_tcp(host, port, timeout=timeout, local_address=local_address, socket_options=socket_options)
        return _TlsStream(stream, self._tls, self._endpoint_context)

    async def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: Any = None) -> httpcore.AsyncNetworkStream:
        return await self._inner.connect_unix_socket(path, timeout=timeout, socket_options=socket_options)

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class _TlsStream(httpcore.AsyncNetworkStream):
    """A connection whose handshake with the Endpoint presents the certificate as read now and checks the identity, before any request byte."""

    def __init__(self, inner: httpcore.AsyncNetworkStream, tls: EndpointTls, endpoint_context: ssl.SSLContext) -> None:
        self._inner = inner
        self._tls = tls
        self._endpoint_context = endpoint_context

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return await self._inner.read(max_bytes, timeout)

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        await self._inner.write(buffer, timeout)

    async def aclose(self) -> None:
        await self._inner.aclose()

    def get_extra_info(self, info: str) -> Any:
        return self._inner.get_extra_info(info)

    async def start_tls(self, ssl_context: ssl.SSLContext, server_hostname: str | None = None, timeout: float | None = None) -> httpcore.AsyncNetworkStream:
        if ssl_context is not self._endpoint_context:
            return _TlsStream(await self._inner.start_tls(ssl_context, server_hostname, timeout), self._tls, self._endpoint_context)
        try:
            context = await anyio.to_thread.run_sync(self._tls.context)
        except EndpointTlsError as error:
            await self._inner.aclose()
            raise httpcore.ConnectError(str(error)) from error
        context.set_alpn_protocols(['http/1.1'])
        stream = await self._inner.start_tls(context, server_hostname, timeout)
        try:
            self._tls.check(stream.get_extra_info('ssl_object'))
        except EndpointTlsError as error:
            await stream.aclose()
            raise httpcore.ConnectError(str(error)) from error
        return stream
