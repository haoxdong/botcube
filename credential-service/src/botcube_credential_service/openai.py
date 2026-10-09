"""OpenAI, a plan provider: its Durable Credential is a Sign in with ChatGPT refresh token (ADR 0078)."""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .answer_boundary import CredentialAnswerBoundary
from .config import OpenAISettings, positive_seconds
from .provider import UpstreamRefusal
from .vault import (
    CredentialNotFound,
    RefreshLeaseHeld,
    RotationLost,
    RotationStoredButRefused,
)

if TYPE_CHECKING:
    from fastapi import Request

    from .audit import CredentialAuditRecorder, _UpstreamContentEncoding
    from .invocation import CredentialServiceInvocation
    from .server import InvocationGuard
    from .vault import RevisedCredential, RotatingCredentialVault

OPENAI_PROVIDER = 'openai'
# What one Sign in with ChatGPT leaves to vault: the identity, its dynamically registered client, and the refresh token.
_SIGN_IN_FIELDS = ('subject', 'clientId', 'refreshToken')
_RESPONSES_PATH = 'v1/responses'
# The only calls Plan Usage makes: the plan's model catalog and streaming Responses.
_RELAYED = {('GET', 'v1/models'), ('POST', _RESPONSES_PATH)}
# The `type` of a classified Plan Usage error, in OpenAI's error shape so the Harness's client raises it.
PLAN_USAGE_ERROR_TYPE = 'plan_usage'
_REVOKED = (
    'PLAN_USAGE_REVOKED',
    'Your ChatGPT plan cannot be used: it is not eligible, or its credential was revoked or can no longer refresh. '
    'Re-run the botcube-openai-plan-usage operator command to sign in to ChatGPT again',
)
_UNAVAILABLE = ('PLAN_USAGE_UNAVAILABLE', "ChatGPT could not check your plan's usage; try again later")
_PROVIDER_TIMEOUT = ('MODEL_PROVIDER_TIMEOUT', 'OpenAI did not respond to the model call; try again')
# OpenAI's Plan Usage error codes, each with its classified error (ADR 0078 decision 7), from
# developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.
_PLAN_USAGE_ERRORS = {
    'subscription_sharing_usage_limit_exceeded': (
        'PLAN_USAGE_LIMIT_REACHED', "Your ChatGPT plan's usage limit is reached; wait, or check ChatGPT Settings > Usage",
    ),
    'subscription_sharing_usage_unavailable': _UNAVAILABLE,
    'subscription_sharing_user_unavailable': _UNAVAILABLE,
    'subscription_sharing_user_not_eligible': _REVOKED,
    'subscription_sharing_invalid_user': _REVOKED,
    'subscription_sharing_unsupported_capability': (
        'PLAN_USAGE_UNSUPPORTED', 'Your ChatGPT plan does not support part of this request',
    ),
}
# Refresh this long before the access token expires, so no relayed stream outlives it.
_EXPIRY_MARGIN_SECONDS = 60
# A live task renews this lease through write-back; a dead holder expires so another task may take over.
_REFRESH_LEASE_SECONDS = 30
# How long a task waits on another task's lease before failing loud; past one lease, so a dead holder's expires.
_LEASE_WAIT_SECONDS = 45
_LEASE_POLL_SECONDS = 0.2
# How long a relayed call waits on OpenAI between reads: Codex's stream idle timeout (DEFAULT_STREAM_IDLE_TIMEOUT_MS).
_READ_TIMEOUT_SECONDS = 300
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
class _RefreshLease:
    expires_at: float
    request_deadline: asyncio.Timeout | None = None


@dataclass
class _ProviderTiming:
    audit: CredentialAuditRecorder
    account_id: str
    context: Mapping[str, str]
    dispatched_at: float
    started: float
    boundary: CredentialAnswerBoundary | None = None
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
        if self.boundary is not None:
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
        if self.boundary is not None:
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
    ) -> None:
        # Raises ValueError while the Vault is unconfigured.
        self._vault = vault
        self._audit = audit
        self._transport = transport
        self._clock = clock
        self._settings = OpenAISettings.from_env()
        self._expiry_margin_seconds = positive_seconds('BOTCUBE_OPENAI_EXPIRY_MARGIN_SECONDS', _EXPIRY_MARGIN_SECONDS)
        self._refresh_lease_seconds = positive_seconds('BOTCUBE_OPENAI_REFRESH_LEASE_SECONDS', _REFRESH_LEASE_SECONDS)
        self._lease_wait_seconds = positive_seconds('BOTCUBE_OPENAI_LEASE_WAIT_SECONDS', _LEASE_WAIT_SECONDS)
        self._lease_poll_seconds = positive_seconds('BOTCUBE_OPENAI_LEASE_POLL_SECONDS', _LEASE_POLL_SECONDS)
        self._read_timeout_seconds = positive_seconds('BOTCUBE_OPENAI_READ_TIMEOUT_SECONDS', _READ_TIMEOUT_SECONDS)
        self._connect_timeout_seconds = positive_seconds('BOTCUBE_OPENAI_CONNECT_TIMEOUT_SECONDS', 30)
        # Access tokens, expiry and the Vault revision they came from; memory only.
        self._access: dict[str, tuple[str, float, str]] = {}
        self._refreshing: dict[str, asyncio.Lock] = {}

    def ready(self) -> None:
        self._vault()

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> dict[str, str]:
        sign_in = {field: _required_text(payload, field) for field in _SIGN_IN_FIELDS}
        await asyncio.to_thread(
            self._vault().store_durable_credential, invocation.account_id, OPENAI_PROVIDER, json.dumps(sign_in),
        )
        self._access.pop(invocation.account_id, None)
        return {'status': 'stored', 'subject': sign_in['subject']}

    async def revoke(self, account_id: str) -> None:
        self._access.pop(account_id, None)
        await asyncio.to_thread(self._vault().delete_durable_credential, account_id, OPENAI_PROVIDER)

    def allows_upstream(self, method: str, path: str) -> bool:
        return (method, path) in _RELAYED

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> str:
        # One refresh per account at a time: a second would spend the refresh token the first just rotated.
        # A call that waited finds the first one's access token cached.
        async with self._refreshing.setdefault(account_id, asyncio.Lock()):
            cached = self._access.get(account_id)
            if cached is not None and self._clock() < cached[1]:
                try:
                    revision = await asyncio.to_thread(self._vault().load_credential_revision, account_id, OPENAI_PROVIDER)
                except CredentialNotFound:
                    self._access.pop(account_id, None)
                    raise _no_credential() from None
                if revision == cached[2]:
                    return cached[0]
                self._access.pop(account_id, None)
            return await self._refresh(account_id, request_context)

    async def _refresh(self, account_id: str, request_context: Mapping[str, str]) -> str:
        vault = self._vault()
        lease = secrets.token_urlsafe()
        try:
            async with asyncio.timeout(self._lease_wait_seconds):
                stored, lease_expires_at = await self._leased(vault, account_id, lease, request_context)
        except TimeoutError:
            raise _unavailable('another Credential Service task is still refreshing the ChatGPT credential') from None
        operation = asyncio.create_task(self._rotate_under_lease(vault, account_id, stored, lease, lease_expires_at))
        try:
            tokens, revision = await asyncio.shield(operation)
        except asyncio.CancelledError as cancelled:
            # Cancellation cannot abandon a thread holding a rotated token: retain custody until it settles.
            while not operation.done():
                try:
                    await asyncio.shield(operation)
                except asyncio.CancelledError:
                    continue
            raise (failure := operation.exception() or cancelled) from failure.__cause__
        except RotationStoredButRefused as error:
            raise _unavailable('the Vault refused a write whose rotated ChatGPT credential was already stored') from error
        except RotationLost as error:
            raise _unavailable('another write replaced the ChatGPT credential during its refresh') from error
        expires_at = self._clock() + tokens['expires_in'] - self._expiry_margin_seconds
        self._access[account_id] = (tokens['access_token'], expires_at, revision)
        return tokens['access_token']

    async def _rotate_under_lease(
        self, vault: RotatingCredentialVault, account_id: str, stored: RevisedCredential,
        lease: str, lease_expires_at: float,
    ) -> tuple[dict[str, Any], str]:
        active_lease = _RefreshLease(lease_expires_at)
        worker = asyncio.create_task(self._rotate(vault, account_id, stored, lease, active_lease))
        while True:
            await asyncio.wait({worker}, timeout=self._refresh_lease_seconds / 3)
            if worker.done():
                return await worker
            # Conditional renewal and write-back can complete in either order. Observe both outcomes.
            renewal = await asyncio.gather(
                self._renew_under_lease(vault, account_id, stored.revision, lease, active_lease),
                return_exceptions=True,
            )
            failure = renewal[0]
            if isinstance(failure, BaseException):
                written = (await asyncio.gather(worker, return_exceptions=True))[0]
                if isinstance(written, BaseException):
                    raise _unavailable('refresh lease renewal and credential write-back failed') from BaseExceptionGroup(
                        'Refresh renewal and write-back failed', [failure, written],
                    )
                if isinstance(failure, RotationLost) and failure.current_revision == written[1]:
                    # The conditional miss observed this exact successful write, which already cleared the lease.
                    return written
                raise failure
            expires_at = failure
            active_lease.expires_at = expires_at
            if active_lease.request_deadline is not None:
                active_lease.request_deadline.reschedule(asyncio.get_running_loop().time() + expires_at - self._clock())

    async def _renew_under_lease(
        self, vault: RotatingCredentialVault, account_id: str, revision: str,
        lease: str, active_lease: _RefreshLease,
    ) -> float:
        expires_at = self._clock() + self._refresh_lease_seconds
        # Only confirmation before the current expiry can extend the HTTP deadline.
        # A timed-out synchronous RPC may still finish; its owner/revision condition remains authoritative.
        try:
            async with asyncio.timeout(active_lease.expires_at - self._clock()):
                await asyncio.to_thread(
                    vault.renew_refresh_lease, account_id, OPENAI_PROVIDER,
                    revision=revision, lease=lease, expires_at=expires_at,
                )
        except TimeoutError as error:
            raise _unavailable('the Vault did not confirm refresh lease renewal before its expiry') from error
        return expires_at

    async def _rotate(
        self, vault: RotatingCredentialVault, account_id: str, stored: RevisedCredential,
        lease: str, active_lease: _RefreshLease,
    ) -> tuple[dict[str, Any], str]:
        sign_in = json.loads(stored.value)
        tokens = await self._token_refresh(sign_in, active_lease)
        rotated = json.dumps({**sign_in, 'refreshToken': tokens['refresh_token']})
        # The Vault's AWS clients retry transient failures (ADR 0030's transport choke point); none is retried here.
        try:
            revision = await asyncio.to_thread(
                vault.replace_durable_credential, account_id, OPENAI_PROVIDER, rotated,
                revision=stored.revision, lease=lease,
            )
        except (RotationLost, RotationStoredButRefused):
            raise
        except Exception as error:
            raise _unavailable('the Vault failed to store the rotated ChatGPT credential') from error
        return tokens, revision

    async def _leased(
        self, vault: RotatingCredentialVault, account_id: str, lease: str, request_context: Mapping[str, str],
    ) -> tuple[RevisedCredential, float]:
        """The credential under this refresh's lease, and when the lease expires (ADR 0078 decision 4).

        Only the lease holder spends the refresh token, so no refresh token is sent twice. A task that
        finds another lease waits for that lease's rotation, which it then refreshes in turn: access
        tokens stay in each task's memory, so it cannot use the other task's.
        """
        stored = await self._load(vault, account_id, request_context)
        while True:
            now = self._clock()
            expires_at = now + self._refresh_lease_seconds
            try:
                await asyncio.to_thread(
                    vault.take_refresh_lease,
                    account_id,
                    OPENAI_PROVIDER,
                    revision=stored.revision,
                    lease=lease,
                    now=now,
                    expires_at=expires_at,
                )
            except CredentialNotFound:
                raise _no_credential() from None
            except RefreshLeaseHeld as held:
                if held.revision != stored.revision:
                    stored = await self._load(vault, account_id, request_context)
                else:
                    await asyncio.sleep(self._lease_poll_seconds)
                continue
            return stored, expires_at

    async def _load(
        self, vault: RotatingCredentialVault, account_id: str, request_context: Mapping[str, str],
    ) -> RevisedCredential:
        try:
            return await asyncio.to_thread(
                vault.load_revised_credential,
                account_id,
                OPENAI_PROVIDER,
                audit=self._audit,
                request_context=request_context,
            )
        except CredentialNotFound:
            raise _no_credential() from None

    async def _token_refresh(self, sign_in: Mapping[str, str], active_lease: _RefreshLease) -> dict[str, Any]:
        """Spend the refresh token at OpenAI's token endpoint, within the lease that lets this task spend it."""
        try:
            async with asyncio.timeout(active_lease.expires_at - self._clock()) as deadline, self._client() as client:
                active_lease.request_deadline = deadline
                response = await client.post(
                    self._settings.token_url,
                    headers={'accept': 'application/json'},
                    data={
                        'grant_type': 'refresh_token',
                        'client_id': sign_in['clientId'],
                        'refresh_token': sign_in['refreshToken'],
                        'resource': self._settings.resource,
                    },
                )
        except (httpx.TransportError, TimeoutError) as error:
            raise _unavailable(f'OpenAI could not be reached for the token refresh: {type(error).__name__}') from None
        finally:
            active_lease.request_deadline = None
        if response.is_success:
            return response.json()
        code = _refresh_error_code(response)
        detail = f'HTTP {response.status_code}{f" {code}" if code else ""}'
        # OAuth refuses a grant with 400 (invalid_grant) or 401 (invalid_client); anything else is OpenAI failing.
        if response.status_code in (400, 401):
            raise _revoked(f'OpenAI refused the token refresh with {detail}')
        raise _unavailable(f'OpenAI failed the token refresh with {detail}')

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request, path: str) -> None:
        if request.method != 'POST':
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
        request: Request,
        path: str,
        access: str,
        *,
        account_id: str,
        request_context: Mapping[str, str],
    ) -> Response:
        context = _timing_context(request, request_context) if path == _RESPONSES_PATH else None
        self._audit.record_upstream_relay(
            account_id, OPENAI_PROVIDER, request_context if context is None else context,
        )
        headers = {name: request.headers[name] for name in _FORWARDED_HEADERS if name in request.headers}
        client = self._client()
        upstream_request = client.build_request(
            request.method, f'{self._settings.api_origin}/{path}', params=request.url.query or None,
            headers={**headers, 'authorization': f'Bearer {access}'}, content=await request.body(),
        )
        timing = None if context is None else _ProviderTiming(
            self._audit, account_id, context, time.time(), time.monotonic(),
        )
        if timing is not None:
            timing.boundary = CredentialAnswerBoundary(
                self._audit, timing.context, getattr(request.state, 'credential_received_at', None), timing.started,
            )
            upstream_request.extensions['trace'] = timing.trace
        upstream = await self._send(client, upstream_request, timing)
        if isinstance(upstream, Response):
            return upstream
        content_type = upstream.headers.get('content-type')
        if not upstream.is_success:
            try:
                content = await upstream.aread()
            finally:
                await _finish_relay(timing, 'failure', upstream, client)
            classified = _classified(_json_error(content_type, content))
            if classified is not None:
                return JSONResponse(classified, status_code=upstream.status_code)
            return Response(content, status_code=upstream.status_code, media_type=content_type)

        chunks = upstream.aiter_bytes()
        if path == _RESPONSES_PATH:
            chunks = _observed_chunks(chunks, timing)

        return StreamingResponse(
            _relay_body(chunks, upstream, client, timing),
            headers={'content-type': content_type} if content_type else None,
        )

    async def _send(
        self, client: httpx.AsyncClient, upstream_request: httpx.Request, timing: _ProviderTiming | None,
    ) -> httpx.Response | Response:
        try:
            upstream = await client.send(upstream_request, stream=True)
            if timing is not None:
                encoding = upstream.headers.get('content-encoding')
                timing.upstream_content_encoding = 'absent' if encoding is None else _UPSTREAM_CONTENT_ENCODINGS.get(encoding.strip().lower(), 'other')
                timing.first_phase('headers_returned')
            return upstream
        except httpx.ReadTimeout:
            await _finish_relay(timing, 'failure', None, client)
            cause = f'no response within {self._read_timeout_seconds:g} s'
            return JSONResponse(_plan_usage_error(_PROVIDER_TIMEOUT, cause), status_code=504)
        except BaseException as failure:
            await _finish_relay(timing, 'cancelled' if isinstance(failure, asyncio.CancelledError) else 'failure', None, client)
            raise

    def routes(self, guard: InvocationGuard) -> APIRouter:
        return APIRouter()

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=httpx.Timeout(self._read_timeout_seconds, connect=self._connect_timeout_seconds))


def _observed_chunks(chunks: AsyncIterator[bytes], timing: _ProviderTiming | None) -> AsyncIterator[bytes]:
    if timing is None:
        return _failures_as_errors(chunks)
    return _failures_as_errors(chunks, timing.observe, timing.first_phase,
                               None if timing.boundary is None else timing.boundary.emitted)


async def _relay_body(
    chunks: AsyncIterator[bytes], upstream: httpx.Response, client: httpx.AsyncClient, timing: _ProviderTiming | None,
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
        await _finish_relay(timing, result, upstream, client)


async def _finish_relay(
    timing: _ProviderTiming | None, result: str, upstream: httpx.Response | None, client: httpx.AsyncClient,
) -> None:
    try:
        if timing is not None:
            timing.finish(result)
    finally:
        try:
            if upstream is not None:
                await upstream.aclose()
        finally:
            await client.aclose()


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


def _plan_usage_error(classification: tuple[str, str], cause: str) -> dict[str, Any]:
    code, message = classification
    return {'error': {'type': PLAN_USAGE_ERROR_TYPE, 'code': code, 'message': f'{message} ({cause}).'}}


def _revoked(cause: str) -> UpstreamRefusal:
    return UpstreamRefusal(401, _plan_usage_error(_REVOKED, cause))


def _no_credential() -> UpstreamRefusal:
    return _revoked('no ChatGPT credential is stored for this account')


def _unavailable(cause: str) -> UpstreamRefusal:
    return UpstreamRefusal(503, _plan_usage_error(_UNAVAILABLE, cause))


def _classified(error: Any) -> dict[str, Any] | None:
    """OpenAI's error object as its classified Plan Usage error; None for an error Plan Usage does not name."""
    if not isinstance(error, Mapping) or error.get('code') not in _PLAN_USAGE_ERRORS:
        return None
    param = error.get('param')
    cause = f'OpenAI {error["code"]}{f": {param}" if param else ""}'
    return _plan_usage_error(_PLAN_USAGE_ERRORS[error['code']], cause)


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


async def _failures_as_errors(
    chunks: AsyncIterator[bytes], observe: Callable[[Any], None] | None = None,
    observe_stream_phase: Callable[[str], None] | None = None,
    emitted: Callable[[], None] | None = None,
) -> AsyncIterator[bytes]:
    """OpenAI's Responses stream frame by frame, each `response.failed` turned into an error frame.

    A failure can arrive after streaming has begun; the Harness's OpenAI client raises on an error
    frame, where it would pass over `response.failed` and end the Turn as if it had completed.
    """
    pending = b''
    async for chunk in chunks:
        if chunk and observe_stream_phase is not None:
            observe_stream_phase('first_decoded_chunk')
        *frames, pending = (pending + chunk).split(b'\n\n')
        for frame in frames:
            event = _frame_event(frame)
            if observe is not None:
                observe(event)
            output = _error_event(event) or frame + b'\n\n'
            if emitted is not None:
                emitted()
            yield output
    if observe_stream_phase is not None:
        observe_stream_phase('decoded_stream_eof')
    if pending:
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
