"""OpenAI, a plan provider: its Durable Credential is a Sign in with ChatGPT refresh token (ADR 0078)."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import anyio
import httpx
from fastapi import APIRouter, HTTPException, WebSocket
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .answer_boundary import CredentialAnswerBoundary
from .config import OpenAISettings
from .cookies import stateless_http_client
from .openai_errors import REVOKED, UNAVAILABLE, plan_usage_error, revoked, unavailable
from .rotating_access import (
    Grant,
    GrantedAccess,
    RefreshTimings,
    RotatingAccess,
)
from .rotating_vault import OPENAI_PROVIDER, OpenAIVaultAdapter

if TYPE_CHECKING:
    from fastapi import Request

    from .audit import CredentialAuditRecorder, _UpstreamContentEncoding
    from .invocation import CredentialServiceInvocation
    from .server import InvocationGuard
    from .vault import RotatingCredentialVault

# What one Sign in with ChatGPT leaves to vault: the identity, its dynamically registered client, and the refresh token.
_SIGN_IN_FIELDS = ('subject', 'clientId', 'refreshToken')
_RESPONSES_PATH = 'v1/responses'
# The only calls Plan Usage makes: the plan's model catalog and streaming Responses.
_RELAYED = {('GET', 'v1/models'), ('POST', _RESPONSES_PATH)}
_PROVIDER_TIMEOUT = ('MODEL_PROVIDER_TIMEOUT', 'OpenAI did not respond to the model call; try again')
# OpenAI's Plan Usage error codes, each with its classified error (ADR 0078 decision 7), from
# developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.
_PLAN_USAGE_ERRORS = {
    'subscription_sharing_usage_limit_exceeded': (
        'PLAN_USAGE_LIMIT_REACHED', "Your ChatGPT plan's usage limit is reached; wait, or check ChatGPT Settings > Usage",
    ),
    'subscription_sharing_usage_unavailable': UNAVAILABLE,
    'subscription_sharing_user_unavailable': UNAVAILABLE,
    'subscription_sharing_user_not_eligible': REVOKED,
    'subscription_sharing_invalid_user': REVOKED,
    'subscription_sharing_unsupported_capability': (
        'PLAN_USAGE_UNSUPPORTED', 'Your ChatGPT plan does not support part of this request',
    ),
}
# How long a relayed call waits on OpenAI between reads: Codex's stream idle timeout (DEFAULT_STREAM_IDLE_TIMEOUT_MS).
_READ_TIMEOUT_SECONDS = 300
_CONNECT_TIMEOUT_SECONDS = 30
# Request headers OpenAI gets from the Harness's call; the invocation's own headers stay here.
_FORWARDED_HEADERS = ('accept', 'content-type')
_UPSTREAM_TRACE_PHASES = {
    f'{operation}.{outcome}'
    for operation in (
        'connection.connect_tcp', 'connection.start_tls', 'proxy.start_tls',
        'http11.send_request_headers', 'http11.send_request_body', 'http11.receive_response_headers',
        'http2.send_request_headers', 'http2.send_request_body', 'http2.receive_response_headers',
    )
    for outcome in ('started', 'complete', 'failed')
}
_UPSTREAM_TRACE_LIMIT = 64
_UPSTREAM_CONTENT_ENCODINGS: dict[str, _UpstreamContentEncoding] = {
    'identity': 'identity', 'gzip': 'gzip', 'deflate': 'deflate', 'br': 'br', 'zstd': 'zstd',
}


@dataclass
class _ProviderTiming:
    audit: CredentialAuditRecorder
    account_id: str
    context: Mapping[str, str]
    dispatched_at: float
    started: float
    boundary: CredentialAnswerBoundary
    answer_observed: bool = False
    failed: bool = False
    phases: list[dict[str, str | float]] = field(default_factory=list)
    observed_phases: set[str] = field(default_factory=set)
    transport_phases: int = 0
    phases_truncated: bool = False
    upstream_content_encoding: _UpstreamContentEncoding = 'unavailable'

    def phase(self, name: str) -> None:
        self.phases.append({'phase': name, 'offsetMs': (time.monotonic() - self.started) * 1000})

    def first_phase(self, name: str) -> None:
        if name not in self.observed_phases:
            self.observed_phases.add(name)
            self.phase(name)

    async def trace(self, name: str, _info: Mapping[str, Any]) -> None:
        if name not in _UPSTREAM_TRACE_PHASES:
            return
        if self.transport_phases >= _UPSTREAM_TRACE_LIMIT:
            self.phases_truncated = True
            return
        self.transport_phases += 1
        self.phase(name)

    def observe(self, event: Any) -> None:
        self.boundary.observe(event)
        if not isinstance(event, Mapping):
            return
        self.first_phase('first_parsed_event')
        if event.get('type') == 'response.completed':
            self.first_phase('first_completed_event')
        if event.get('type') in {'error', 'response.failed', 'response.incomplete'}:
            self.failed = True
        delta = event.get('delta')
        if event.get('type') in {'response.reasoning_text.delta', 'response.reasoning_summary_text.delta'} and isinstance(delta, str) and delta.strip():
            self.first_phase('first_reasoning_delta')
        if (not self.answer_observed and event.get('type') == 'response.output_text.delta'
                and isinstance(delta, str) and delta.strip()):
            self.answer_observed = True
            self.first_phase('first_answer_delta')
            self.audit.record_provider_timing(
                self.account_id, self.context, event='provider_first_answer', result='answer',
                dispatched_at=self.dispatched_at, observed_at=time.time(),
                duration_ms=(time.monotonic() - self.started) * 1000, answer_observed=True,
            )

    def finish(self, result: str) -> None:
        self.first_phase('terminal')
        self.audit.record_provider_timing(
            self.account_id, self.context, event='provider_upstream_phases', result=result,
            dispatched_at=self.dispatched_at, observed_at=time.time(), answer_observed=self.answer_observed,
            phases=self.phases, phases_truncated=self.phases_truncated,
            upstream_content_encoding=self.upstream_content_encoding,
        )
        if not self.answer_observed:
            self.audit.record_provider_timing(
                self.account_id, self.context, event='provider_first_answer', result=result,
                dispatched_at=self.dispatched_at, observed_at=time.time(),
            )
        self.audit.record_provider_timing(
            self.account_id, self.context, event='provider_response_outcome', result=result,
            dispatched_at=self.dispatched_at, observed_at=time.time(), answer_observed=self.answer_observed,
        )
        self.boundary.record()


class OpenAIProvider:
    """The OpenAI plan-provider plug-in. The operator command stores the owner's Sign-in through ingest.

    The Harness's plan model calls the relay; the access token it attaches lives only in this
    process, refreshed from the vaulted refresh token when it is missing or expired.
    """

    name = OPENAI_PROVIDER
    upstream_scope = 'the OpenAI model calls Plan Usage makes'
    owner_only = True

    def __init__(
        self,
        vault: Callable[[], RotatingCredentialVault],
        *,
        audit: CredentialAuditRecorder,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        proxy: Callable[[], str] | None = None,
        settings: OpenAISettings | None = None,
        refresh_timings: RefreshTimings | None = None,
        grant: Grant | None = None,
    ) -> None:
        self._vault = vault
        self._proxy = proxy
        self._audit = audit
        self._settings = settings or OpenAISettings()
        self._read_timeout_seconds = _READ_TIMEOUT_SECONDS
        self._connect_timeout_seconds = _CONNECT_TIMEOUT_SECONDS
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._access = RotatingAccess(
            lambda: OpenAIVaultAdapter(vault()), audit=audit, grant=self._grant if grant is None else grant,
            clock=clock, timings=refresh_timings,
        )

    def _relay_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = stateless_http_client(
                transport=self._transport,
                proxy=self._proxy() if self._proxy else None,
                timeout=httpx.Timeout(self._read_timeout_seconds, connect=self._connect_timeout_seconds),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
        elif self._transport is not None:
            await self._transport.aclose()

    def ready(self) -> None:
        self._vault()

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> dict[str, str]:
        sign_in = {field: _required_text(payload, field) for field in _SIGN_IN_FIELDS}
        await self._access.store(invocation.account_id, sign_in)
        return {'status': 'stored', 'subject': sign_in['subject']}

    async def linked(self, account_id: str) -> bool:
        return False

    async def revoke(self, account_id: str) -> None:
        await self._access.revoke(account_id)

    def allows_upstream(self, method: str, path: str) -> bool:
        return (method, path) in _RELAYED

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> str:
        # Initialize the shared pool before taking a refresh lease.
        self._relay_client()
        return await self._access.get(account_id, request_context)

    async def _grant(self, sign_in: Mapping[str, str]) -> GrantedAccess:
        try:
            response = await self._relay_client().post(
                self._settings.token_url,
                headers={'accept': 'application/json'},
                data={
                    'grant_type': 'refresh_token',
                    'client_id': sign_in['clientId'],
                    'refresh_token': sign_in['refreshToken'],
                    'resource': self._settings.resource,
                },
            )
        except httpx.TransportError as error:
            raise unavailable(f'OpenAI could not be reached for the token refresh: {type(error).__name__}') from None
        if response.is_success:
            return response.json()
        code = _refresh_error_code(response)
        detail = f'HTTP {response.status_code}{f" {code}" if code else ""}'
        # OAuth refuses a grant with 400 (invalid_grant) or 401 (invalid_client); anything else is OpenAI failing.
        if response.status_code in (400, 401):
            raise revoked(f'OpenAI refused the token refresh with {detail}')
        raise unavailable(f'OpenAI failed the token refresh with {detail}')

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request | WebSocket, path: str) -> None:
        if isinstance(request, WebSocket) or request.method != 'POST':
            return
        if invocation.model_provider != OPENAI_PROVIDER or invocation.model_id is None:
            raise HTTPException(status_code=403, detail='This invocation is not authorized for an OpenAI model')
        try:
            payload = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise HTTPException(status_code=400, detail='The OpenAI model request must be a JSON object') from None
        if not isinstance(payload, dict) or payload.get('model') != invocation.model_id:
            raise HTTPException(status_code=403, detail='The requested model does not match the authorized invocation model')

    async def relay(
        self,
        request: Request | WebSocket,
        path: str,
        access: str,
        *,
        account_id: str,
        request_context: Mapping[str, str],
    ) -> Response:
        if isinstance(request, WebSocket):
            raise HTTPException(status_code=501, detail='The OpenAI relay relays HTTP only')
        context = _timing_context(request, request_context) if path == _RESPONSES_PATH else None
        self._audit.record_upstream_relay(
            account_id, OPENAI_PROVIDER, request_context if context is None else context,
        )
        headers = {name: request.headers[name] for name in _FORWARDED_HEADERS if name in request.headers}
        if context is not None:
            headers['session-id'] = account_id
        upstream_request = self._relay_client().build_request(
            request.method, f'{self._settings.api_origin}/{path}', params=request.url.query or None,
            headers={**headers, 'authorization': f'Bearer {access}'}, content=await request.body(),
        )
        started = time.monotonic()
        timing = None if context is None else _ProviderTiming(
            self._audit, account_id, context, time.time(), started,
            CredentialAnswerBoundary(
                self._audit, context, getattr(request.state, 'credential_received_at', None), started,
            ),
        )
        if timing is not None:
            upstream_request.extensions['trace'] = timing.trace
        upstream = await self._send(upstream_request, timing)
        if isinstance(upstream, Response):
            return upstream
        content_type = upstream.headers.get('content-type')
        if not upstream.is_success:
            try:
                content = await upstream.aread()
            finally:
                await _finish_relay(timing, 'failure', upstream)
            classified = _classified(_json_error(content_type, content))
            if classified is not None:
                return JSONResponse(classified, status_code=upstream.status_code)
            return Response(content, status_code=upstream.status_code, media_type=content_type)

        chunks = upstream.aiter_bytes()
        if timing is not None:
            chunks = _failures_as_errors(chunks, timing)

        return StreamingResponse(
            _relay_body(chunks, upstream, timing),
            headers={'content-type': content_type} if content_type else None,
        )

    async def _send(self, upstream_request: httpx.Request, timing: _ProviderTiming | None) -> httpx.Response | Response:
        try:
            upstream = await self._relay_client().send(upstream_request, stream=True)
            if timing is not None:
                encoding = upstream.headers.get('content-encoding')
                timing.upstream_content_encoding = 'absent' if encoding is None else _UPSTREAM_CONTENT_ENCODINGS.get(encoding.strip().lower(), 'other')
                timing.first_phase('headers_returned')
            return upstream
        except httpx.ReadTimeout:
            await _finish_relay(timing, 'failure', None)
            cause = f'no response within {self._read_timeout_seconds:g} s'
            return JSONResponse(plan_usage_error(_PROVIDER_TIMEOUT, cause), status_code=504)
        except BaseException as failure:
            await _finish_relay(timing, 'cancelled' if isinstance(failure, asyncio.CancelledError) else 'failure', None)
            raise

    def routes(self, guard: InvocationGuard) -> APIRouter:
        return APIRouter()


async def _relay_body(
    chunks: AsyncIterator[bytes], upstream: httpx.Response, timing: _ProviderTiming | None,
) -> AsyncIterator[bytes]:
    result = 'no_answer'
    try:
        async for chunk in chunks:
            yield chunk
        if timing is not None:
            result = 'failure' if timing.failed else ('answer' if timing.answer_observed else 'no_answer')
    except BaseException as failure:
        result = 'cancelled' if isinstance(failure, (asyncio.CancelledError, GeneratorExit)) else 'failure'
        raise
    finally:
        await _finish_relay(timing, result, upstream)


async def _finish_relay(
    timing: _ProviderTiming | None, result: str, upstream: httpx.Response | None,
) -> None:
    try:
        if timing is not None:
            timing.finish(result)
    finally:
        if upstream is not None:
            with anyio.CancelScope(shield=True):
                await upstream.aclose()


def _timing_context(request: Request, request_context: Mapping[str, str]) -> dict[str, str]:
    context = dict(request_context)
    for header, context_field in (('x-botcube-run-id', 'runId'), ('x-botcube-model-step-id', 'modelStepId')):
        value = request.headers.get(header)
        if value is not None and len(value) <= 128 and all(c.isalnum() or c in '-_' for c in value):
            context[context_field] = value
    traceparent = request.headers.get('traceparent', '').split('-')
    if len(traceparent) == 4 and len(traceparent[1]) == 32 and all(c in '0123456789abcdef' for c in traceparent[1]):
        context['traceId'] = traceparent[1]
    return context


def _classified(error: Any) -> dict[str, Any] | None:
    """OpenAI's error object as its classified Plan Usage error; None for an error Plan Usage does not name."""
    if not isinstance(error, Mapping) or error.get('code') not in _PLAN_USAGE_ERRORS:
        return None
    param = error.get('param')
    cause = f'OpenAI {error["code"]}{f": {param}" if param else ""}'
    return plan_usage_error(_PLAN_USAGE_ERRORS[error['code']], cause)


def _json_error(content_type: str | None, content: bytes) -> Any:
    """The `error` of an OpenAI error body; direct admission can answer one that is not JSON."""
    if not (content_type or '').startswith('application/json'):
        return None
    body = json.loads(content)
    return body.get('error') if isinstance(body, Mapping) else None


def _refresh_error_code(response: httpx.Response) -> str | None:
    """The OAuth error code of a refused refresh, such as invalid_grant, when it names one."""
    error = _json_error(response.headers.get('content-type'), response.content)
    if isinstance(error, Mapping):
        error = error.get('code')
    return error if isinstance(error, str) else None


async def _failures_as_errors(chunks: AsyncIterator[bytes], timing: _ProviderTiming) -> AsyncIterator[bytes]:
    """OpenAI's Responses stream frame by frame, each `response.failed` turned into an error frame.

    A failure can arrive after streaming has begun; the Harness's OpenAI client raises on an error
    frame, where it would pass over `response.failed` and end the Turn as if it had completed.
    """
    pending = b''
    async for chunk in chunks:
        if chunk:
            timing.first_phase('first_decoded_chunk')
        *parts, pending = re.split(rb'(\r?\n\r?\n)', pending + chunk)
        for frame, ending in zip(parts[::2], parts[1::2], strict=True):
            event = _frame_event(frame)
            timing.observe(event)
            output = _error_event(event) or frame + ending
            timing.boundary.emitted()
            yield output
    timing.first_phase('decoded_stream_eof')
    if pending.strip(b'\r\n'):
        event = {'type': 'error', **plan_usage_error(UNAVAILABLE, 'OpenAI returned an incomplete response stream frame')}
        timing.observe(event)
        yield f'event: error\ndata: {json.dumps(event)}\n\n'.encode()
    elif pending:
        yield pending


def _frame_event(frame: bytes) -> Any:
    data = [line.removeprefix(b'data:').removeprefix(b' ') for line in frame.split(b'\n') if line.startswith(b'data:')]
    return json.loads(b'\n'.join(data)) if data else None


def _error_event(event: Any) -> bytes | None:
    if not isinstance(event, Mapping) or event.get('type') != 'response.failed':
        return None
    error = event['response'].get('error')
    classified = _classified(error) or {'error': error or {'message': 'OpenAI failed the response without an error'}}
    return f'event: error\ndata: {json.dumps({"type": "error", **classified})}\n\n'.encode()


def _required_text(payload: Mapping[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value:
        raise HTTPException(status_code=400, detail=f'{field} is required')
    return value
