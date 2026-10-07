"""Observable Plan Usage boundaries not covered by the recorded happy path."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest
from starlette.requests import Request
from starlette.responses import StreamingResponse

from botcube_credential_service import openai as openai_module
from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.invocation import sign_credential_service_invocation
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.vault import (
    DynamoDbCredentialVault,
    RefreshLeaseHeld,
    RotationLost,
)
from test_openai import (
    RECORDED,
    Clock,
    FakeOpenAI,
    ListSink,
    RealClock,
    _bound_turn,
    _client,
    _frames,
    _responses,
    _sse,
    _stored,
    _turn,
)
from test_openai import (
    vault as openai_vault,
)
from test_relay_network_timeouts import PacketClockLoop

vault = openai_vault


@pytest.mark.parametrize('claims', [{'model_provider': 'openai'}, {'model_id': 'gpt-6-astra'}])
def test_signing_an_incomplete_model_authorization_fails(claims: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match='payload missing model_'):
        sign_credential_service_invocation('test-secret', 'acct-1', 'thread-1', **claims)


def test_signing_a_nonpositive_lifetime_names_the_failure() -> None:
    with pytest.raises(ValueError, match='ttl must be positive'):
        sign_credential_service_invocation('test-secret', 'acct-1', 'thread-1', ttl_seconds=0)


def test_access_is_refreshed_at_the_safety_margin_boundary(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    clock = Clock()
    upstream = FakeOpenAI()
    client = _client(vault, upstream, clock=clock)
    assert client.get('/openai/v1/models', headers=_turn()).status_code == 200

    # The recording expires in 3600 seconds; the relay reserves the last minute.
    clock.now += 3540
    assert client.get('/openai/v1/models', headers=_turn()).status_code == 200
    assert [request.headers['authorization'] for request in upstream.api_calls()] == ['Bearer at_1', 'Bearer at_2']
    assert [body['refresh_token'] for body in upstream.refreshes()] == [['rt_first'], ['rt_second']]


def test_reloading_after_a_concurrent_sign_in_keeps_the_invocations_audit_context(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stored(vault)
    original_take = vault.take_refresh_lease
    replaced = False

    def replace_before_taking(
        account_id: str, provider: str, *, revision: str, lease: str, now: float, expires_at: float,
    ) -> None:
        nonlocal replaced
        if not replaced:
            replaced = True
            vault.store_durable_credential(account_id, provider, json.dumps({
                'subject': 'user-AbC123', 'clientId': 'app_dyn_1', 'refreshToken': 'new-sign-in',
            }))
        original_take(account_id, provider, revision=revision, lease=lease, now=now, expires_at=expires_at)

    monkeypatch.setattr(vault, 'take_refresh_lease', replace_before_taking)
    sink = ListSink()
    upstream = FakeOpenAI()
    response = _client(vault, upstream, sink=sink).get('/openai/v1/models', headers=_turn())
    assert response.status_code == 200
    assert [body['refresh_token'] for body in upstream.refreshes()] == [['new-sign-in']]
    decrypts = [event for event in sink.events if event['event'] == 'kms_decrypt']
    assert len(decrypts) == 2
    for event in decrypts:
        assert event['accountId'] == 'acct-1'
        assert event['sessionId'] == 'thread-1'
        assert event['method'] == 'GET'
        assert event['path'] == 'v1/models'


def test_a_slow_refresh_for_one_account_does_not_block_another_accounts_access(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def in_memory_vault_rpc(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        # Moto completes in memory; keep its RPC boundary on the virtual scheduler.
        return function(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'to_thread', in_memory_vault_rpc)

    async def run() -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        class WaitingOpenAI(FakeOpenAI):
            async def handle(self, request: httpx.Request) -> httpx.Response:
                if request.url.host == 'auth.openai.com' and b'refresh_token=rt_first&' in request.content:
                    entered.set()
                    await release.wait()
                return await super().handle(request)

        _stored(vault)
        vault.store_durable_credential('acct-2', 'openai', json.dumps({
            'subject': 'user-other', 'clientId': 'app_dyn_2', 'refreshToken': 'rt_other',
        }))
        upstream = WaitingOpenAI()
        loop = asyncio.get_running_loop()
        provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(), clock=loop.time,
            transport=httpx.MockTransport(upstream.handle),
        )
        first = asyncio.create_task(provider.mint_access('acct-1', {'sessionId': 'thread-1'}))
        refresh_started = asyncio.create_task(entered.wait())
        second: asyncio.Task[str] | None = None
        release_first: asyncio.TimerHandle | None = None
        try:
            completed, _ = await asyncio.wait({refresh_started, first}, return_when=asyncio.FIRST_COMPLETED)
            if first in completed:
                await first
                pytest.fail('the first refresh completed before reaching the token endpoint')
            second = asyncio.create_task(provider.mint_access('acct-2', {'sessionId': 'thread-2'}))
            # Release the first response on the domain clock, then inspect both
            # actual tokens. A shared account lock reverses their return values.
            release_first = loop.call_later(1, release.set)
            first_access, second_access = await asyncio.gather(first, second)
            assert second_access == 'at_1'
            assert first_access == 'at_2'
            assert upstream.spent == {'rt_first', 'rt_other'}
        finally:
            if release_first is not None:
                release_first.cancel()
            release.set()
            refresh_started.cancel()
            await asyncio.gather(first, refresh_started, *([second] if second is not None else []), return_exceptions=True)

    with asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        runner.run(run())


def test_a_held_lease_fails_loud_within_the_lease_wait_instead_of_waiting_forever(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stored(vault)
    def held(
        account_id: str, provider: str, *, revision: str, lease: str, now: float, expires_at: float,
    ) -> None:
        raise RefreshLeaseHeld(revision)

    monkeypatch.setattr(vault, 'take_refresh_lease', held)
    monkeypatch.setattr(openai_module, '_LEASE_WAIT_SECONDS', 0.03)
    monkeypatch.setattr(openai_module, '_LEASE_POLL_SECONDS', 0.005)
    upstream = FakeOpenAI()
    provider = OpenAIProvider(
        lambda: vault, audit=CredentialAuditRecorder(), clock=RealClock(),
        transport=httpx.MockTransport(upstream.handle),
    )

    async def run() -> None:
        with pytest.raises(UpstreamRefusal) as refused:
            await asyncio.wait_for(provider.mint_access('acct-1', {'sessionId': 'thread-1'}), timeout=0.5)
        assert refused.value.status_code == 503
        assert 'another Credential Service task is still refreshing' in refused.value.body['error']['message']

    asyncio.run(run())
    assert upstream.requests == []


@pytest.mark.parametrize('provider,model,body,status,detail', [
    (None, None, b'{"model":"gpt-6-astra"}', 403, 'This invocation is not authorized for an OpenAI model'),
    ('openai', 'gpt-6-astra', b'{', 400, 'The OpenAI model request must be a JSON object'),
    ('openai', 'gpt-6-astra', b'{"model":"other-model"}', 403,
     'The requested model does not match the authorized invocation model'),
])
def test_model_authorization_failures_explain_the_refusal_without_spending_access(
    vault: DynamoDbCredentialVault, provider: str | None, model: str | None, body: bytes,
    status: int, detail: str,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    response = _client(vault, upstream).post(
        '/openai/v1/responses', content=body,
        headers={**_bound_turn(provider, model), 'content-type': 'application/json'},
    )
    assert response.status_code == status
    assert response.json() == {'detail': detail}
    assert upstream.requests == []


@pytest.mark.parametrize('status,content_type,body,expected_cause', [
    (401, 'application/json', b'{"error":{"code":"invalid_client"}}', 'HTTP 401 invalid_client'),
    (503, 'text/plain', b'unavailable', 'HTTP 503'),
    (503, 'application/json', b'{"error":{"code":503}}', 'HTTP 503'),
])
def test_refresh_refusals_name_only_a_valid_oauth_error_code(
    vault: DynamoDbCredentialVault, status: int, content_type: str, body: bytes, expected_cause: str,
) -> None:
    class RefusedOpenAI(FakeOpenAI):
        async def handle(self, request: httpx.Request) -> httpx.Response:
            if request.url.host == 'auth.openai.com':
                self.requests.append(request)
                assert request.headers['accept'] == 'application/json'
                return httpx.Response(status, content=body, headers={'content-type': content_type})
            return await super().handle(request)

    _stored(vault)
    upstream = RefusedOpenAI()
    response = _client(vault, upstream).get('/openai/v1/models', headers=_turn())
    assert response.status_code == (401 if status == 401 else 503)
    assert response.json()['error']['message'].endswith(f'with {expected_cause}).')
    assert upstream.api_calls() == []


@pytest.mark.parametrize('status,content_type,body', [
    (403, 'application/json', b'{"detail":"Direct routing is not permitted in this region"}'),
    (503, 'text/plain', b'Upstream unavailable'),
    (403, 'application/json', b'[]'),
])
def test_unclassified_refusals_preserve_status_body_and_media_type(
    vault: DynamoDbCredentialVault, status: int, content_type: str, body: bytes,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    upstream.responses = lambda: httpx.Response(status, content=body, headers={'content-type': content_type})
    response = _responses(_client(vault, upstream))
    assert response.status_code == status
    assert response.content == body
    assert response.headers['content-type'].split(';')[0] == content_type


@pytest.mark.parametrize('prefix', [b': heartbeat\n\n', b'\n\n', b'event: response.created\n\n'])
def test_sse_blocks_without_data_do_not_interrupt_the_recorded_responses_stream(
    vault: DynamoDbCredentialVault, prefix: bytes,
) -> None:
    # WHATWG permits comment/empty blocks and events without data; these dispatch no event.
    # https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
    body = prefix + (RECORDED / 'responses-stream.sse').read_bytes()
    _stored(vault)
    upstream = FakeOpenAI()
    upstream.responses = lambda: httpx.Response(
        200, stream=httpx.ByteStream(body), headers={'content-type': 'text/event-stream'},
    )
    response = _responses(_client(vault, upstream))
    assert response.status_code == 200
    assert response.headers['content-type'] == 'text/event-stream'
    assert response.content == body


def test_sse_data_without_an_event_field_preserves_the_recorded_responses(
    vault: DynamoDbCredentialVault,
) -> None:
    # An SSE event field is optional; OpenAI's typed JSON data remains untouched.
    # https://html.spec.whatwg.org/multipage/server-sent-events.html#server-sent-events
    body = b'\n'.join(
        line for line in (RECORDED / 'responses-stream.sse').read_bytes().split(b'\n')
        if not line.startswith(b'event:')
    )
    _stored(vault)
    upstream = FakeOpenAI()
    upstream.responses = lambda: httpx.Response(200, stream=httpx.ByteStream(body))
    response = _responses(_client(vault, upstream))
    assert response.status_code == 200
    assert response.content == body


def test_a_failed_response_with_no_error_still_ends_with_an_error_frame(
    vault: DynamoDbCredentialVault,
) -> None:
    # The installed OpenAI SDK's ResponseFailedEvent requires a Response, whose error is optional.
    # https://github.com/openai/openai-python/blob/v2.41.1/src/openai/types/responses/response_failed_event.py
    # https://github.com/openai/openai-python/blob/v2.41.1/src/openai/types/responses/response.py
    first_data = next(
        line.removeprefix(b'data: ') for line in (RECORDED / 'responses-stream.sse').read_bytes().splitlines()
        if line.startswith(b'data: ')
    )
    response_body = {**json.loads(first_data)['response'], 'status': 'failed', 'error': None}
    failed = {'type': 'response.failed', 'response': response_body, 'sequence_number': 1}
    _stored(vault)
    upstream = FakeOpenAI()
    upstream.responses = lambda: httpx.Response(200, stream=httpx.ByteStream(_sse(('response.failed', failed))))
    response = _responses(_client(vault, upstream))
    assert response.status_code == 200
    assert _frames(response.content) == [('error', {
        'type': 'error', 'error': {'message': 'OpenAI failed the response without an error'},
    })]


def test_the_relay_returns_before_the_upstream_body_is_consumed_and_closes_it_afterwards(
    vault: DynamoDbCredentialVault,
) -> None:
    class UpstreamBody(httpx.AsyncByteStream):
        def __init__(self) -> None:
            self.started = False
            self.closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            self.started = True
            yield b'first catalog fragment'
            yield b'last catalog fragment'

        async def aclose(self) -> None:
            self.closed = True

    async def run() -> None:
        stream = UpstreamBody()
        provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(),
            transport=httpx.MockTransport(lambda request: httpx.Response(
                200, stream=stream, headers={'content-type': 'application/json'},
            )),
        )
        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'', 'more_body': False}

        request = Request(
            {'type': 'http', 'method': 'GET', 'path': '/openai/v1/models', 'query_string': b'', 'headers': []},
            receive,
        )
        response = await provider.relay(request, 'v1/models', 'access', account_id='acct-1', request_context={})
        assert isinstance(response, StreamingResponse)
        assert not stream.started
        assert not stream.closed
        assert response.headers['content-type'] == 'application/json'
        chunks = [chunk async for chunk in response.body_iterator]
        assert chunks == [b'first catalog fragment', b'last catalog fragment']
        assert stream.closed

    asyncio.run(run())


async def _mint_after_failed_renewal(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, *, worker_refused: bool, renewed_once: bool,
) -> tuple[UpstreamRefusal, FakeOpenAI, RotationLost]:
    release = asyncio.Event()
    loop = asyncio.get_running_loop()
    renewal_failure = RotationLost('another holder owns the lease', current_revision='unrelated-revision')
    original_renewal = vault.renew_refresh_lease
    renewals = 0

    def refuse_renewal(
        account_id: str, provider: str, *, revision: str, lease: str, expires_at: float,
    ) -> None:
        nonlocal renewals
        renewals += 1
        if renewed_once and renewals == 1:
            original_renewal(account_id, provider, revision=revision, lease=lease, expires_at=expires_at)
            return
        loop.call_soon_threadsafe(release.set)
        raise renewal_failure

    class WaitingOpenAI(FakeOpenAI):
        async def handle(self, request: httpx.Request) -> httpx.Response:
            if request.url.host == 'auth.openai.com':
                await release.wait()
                if renewed_once:
                    # OpenAI keeps answering after custody is lost. The last successful renewal
                    # bounds the request; it must not disable its deadline or add wall-clock epoch time.
                    await asyncio.sleep(0.2)
                if worker_refused:
                    return httpx.Response(503, json={'error': 'temporarily_unavailable'})
            return await super().handle(request)

    _stored(vault)
    upstream = WaitingOpenAI()
    monkeypatch.setattr(vault, 'renew_refresh_lease', refuse_renewal)
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.06)
    provider = OpenAIProvider(
        lambda: vault, audit=CredentialAuditRecorder(), clock=RealClock(),
        transport=httpx.MockTransport(upstream.handle),
    )
    with pytest.raises(UpstreamRefusal) as refused:
        await provider.mint_access('acct-1', {'sessionId': 'thread-1'})
    return refused.value, upstream, renewal_failure


@pytest.mark.parametrize('worker_refused,renewed_once', [(False, False), (True, False), (False, True)])
def test_a_failed_lease_renewal_cannot_accept_an_unrelated_write_or_hide_a_refresh_failure(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, worker_refused: bool, renewed_once: bool,
) -> None:
    refusal, upstream, renewal_failure = asyncio.run(_mint_after_failed_renewal(
        vault, monkeypatch, worker_refused=worker_refused, renewed_once=renewed_once,
    ))
    assert refusal.status_code == 503
    assert refusal.body['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
    if worker_refused or renewed_once:
        assert 'refresh lease renewal and credential write-back failed' in refusal.body['error']['message']
        assert isinstance(refusal.__cause__, BaseExceptionGroup)
        assert refusal.__cause__.exceptions[0] is renewal_failure
        assert isinstance(refusal.__cause__.exceptions[1], UpstreamRefusal)
        if renewed_once:
            assert 'TimeoutError' in str(refusal.__cause__.exceptions[1])
            assert upstream.spent == set()
    else:
        assert 'another write replaced the ChatGPT credential during its refresh' in refusal.body['error']['message']
        assert refusal.__cause__ is renewal_failure
        assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_second'
    assert upstream.api_calls() == []
