"""Refresh completion and renewal failure race on the actual asyncio scheduler."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest

from botcube_credential_service import openai as openai_module
from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.vault import DynamoDbCredentialVault, RotationLost
from test_openai import SIGN_IN, Clock, FakeOpenAI, _app, _stored, _turn
from test_openai import vault as vault
from test_relay_network_timeouts import PacketClockLoop


@pytest.mark.parametrize(('response_delay', 'fails'), [(9, False), (12, True)])
def test_refresh_completion_observes_only_a_renewal_failure_that_has_started(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
    response_delay: float, fails: bool,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    upstream.refresh_seconds = response_delay

    def refused_renewal(*args: Any, **kwargs: Any) -> None:
        raise RotationLost('The active lease could not be renewed')

    async def in_memory_vault_rpc(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        # Moto's Vault completes in memory. Keep its synchronous boundary on the
        # replay loop so thread scheduling cannot advance the virtual deadline.
        return function(*args, **kwargs)

    monkeypatch.setattr(vault, 'renew_refresh_lease', refused_renewal)
    monkeypatch.setattr(asyncio, 'to_thread', in_memory_vault_rpc)
    with asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(),
            transport=httpx.MockTransport(upstream.handle), clock=runner.get_loop().time,
        )
        if fails:
            with pytest.raises(UpstreamRefusal) as failure:
                runner.run(provider.mint_access('acct-1', {}))
            assert failure.value.status_code == 503
        else:
            assert runner.run(provider.mint_access('acct-1', {})) == 'at_1'
    assert upstream.spent == {SIGN_IN['refreshToken']}


@pytest.mark.parametrize(('renewal_fails', 'renewal_delay'), [(False, 0), (False, 0.1), (True, 0)])
def test_slow_consumed_refresh_response_obeys_the_active_lease(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, renewal_fails: bool, renewal_delay: float,
) -> None:
    class SlowRefresh(FakeOpenAI):
        async def handle(self, request: httpx.Request) -> httpx.Response:
            if request.url == 'https://auth.openai.com/api/accounts/oauth/token':
                self.requests.append(request)
                response = self._refresh(parse_qs(request.content.decode())['refresh_token'][0])
                await asyncio.sleep(0.75)
                return response
            return await super().handle(request)

    original_renew = vault.renew_refresh_lease
    renewals: list[float] = []

    def renew(account_id: str, provider: str, *, revision: str, lease: str, expires_at: float) -> None:
        renewals.append(expires_at)
        if renewal_fails:
            raise RotationLost('The active lease could not be renewed')
        original_renew(account_id, provider, revision=revision, lease=lease, expires_at=expires_at)

    async def in_memory_vault_rpc(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        if function is renew:
            await asyncio.sleep(renewal_delay)
        return function(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'to_thread', in_memory_vault_rpc)
    monkeypatch.setattr(vault, 'renew_refresh_lease', renew)
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.5)
    _stored(vault)
    upstream = SlowRefresh()
    with asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        class LeaseClock(Clock):
            def __call__(self) -> float:
                return runner.get_loop().time()

        clock = LeaseClock()

        async def models() -> httpx.Response:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=_app(vault, upstream, clock=clock)),
                base_url='http://credential-service',
            ) as client:
                return await client.get('/openai/v1/models', headers=_turn())

        response = runner.run(models())

        assert renewals
        assert upstream.spent == {'rt_first'}
        if renewal_fails:
            assert response.status_code == 503
            assert response.json()['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
            assert upstream.api_calls() == []
            assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN
        else:
            assert response.status_code == 200
            assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_second'
            next_call = runner.run(models())
            assert next_call.status_code == 200
            assert [refresh['refresh_token'] for refresh in upstream.refreshes()] == [['rt_first'], ['rt_second']]
            assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_third'


@pytest.mark.parametrize('write_back', ['kms', 'dynamodb', 'dynamodb_response'])
@pytest.mark.parametrize('cancel_request', [False, True])
def test_two_tasks_do_not_spend_the_same_refresh_token_during_slow_write_back(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, write_back: str, cancel_request: bool,
) -> None:
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.5)
    monkeypatch.setattr(openai_module, '_LEASE_POLL_SECONDS', 0.005)
    _stored(vault)
    entered, release = Event(), Event()
    target, method, write_before_release = {
        'kms': (vault.kms, 'generate_data_key', False),
        'dynamodb': (vault.table, 'put_item', False),
        'dynamodb_response': (vault.table, 'put_item', True),
    }[write_back]
    write = getattr(target, method)

    def slow_write(*args: Any, **kwargs: Any) -> Any:
        monkeypatch.setattr(target, method, write)
        response = write(*args, **kwargs) if write_before_release else None
        entered.set()
        release.wait()
        return response if write_before_release else write(*args, **kwargs)

    monkeypatch.setattr(target, method, slow_write)

    openai = FakeOpenAI()
    entered_async, release_async = asyncio.Event(), asyncio.Event()
    replace = vault.replace_durable_credential
    replacement_started = False

    async def in_memory_vault_rpc(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        nonlocal replacement_started
        if function == replace and not replacement_started:
            replacement_started = True
            future = executor.submit(function, *args, **kwargs)
            try:
                assert entered.wait(1)
                entered_async.set()
                await release_async.wait()
            finally:
                release.set()
                result = future.result(timeout=2)
            return result
        return function(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'to_thread', in_memory_vault_rpc)

    async def requests() -> list[httpx.Response | BaseException]:
        async with (
            httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[0]), base_url='http://service') as first,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[1]), base_url='http://service') as second,
        ):
            initial = asyncio.create_task(first.get('/openai/v1/models', headers=_turn()))
            await asyncio.wait_for(entered_async.wait(), 1)
            if cancel_request:
                initial.cancel()
            await asyncio.sleep(0.75)
            waiting = asyncio.create_task(second.get('/openai/v1/models', headers=_turn()))
            await asyncio.sleep(0.2)
            release_async.set()
            return list(await asyncio.gather(initial, waiting, return_exceptions=True))

    with ThreadPoolExecutor(max_workers=1) as executor, asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        class LeaseClock(Clock):
            def __call__(self) -> float:
                return runner.get_loop().time()

        clock = LeaseClock()
        apps = [_app(vault, openai, clock=clock), _app(vault, openai, clock=clock)]
        try:
            responses = runner.run(requests())
        finally:
            release_async.set()
            release.set()
    if cancel_request:
        assert isinstance(responses[0], asyncio.CancelledError)
    else:
        assert isinstance(responses[0], httpx.Response)
        assert responses[0].status_code == 200
    assert isinstance(responses[1], httpx.Response)
    assert responses[1].status_code == 200
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_second']]
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == {**SIGN_IN, 'refreshToken': 'rt_third'}


@pytest.mark.parametrize('cancellations', [0, 1, 2])
def test_repeated_request_cancellation_keeps_custody_of_a_consumed_refresh(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, cancellations: int,
) -> None:
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.6)
    _stored(vault)

    async def in_memory_vault_rpc(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        return function(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'to_thread', in_memory_vault_rpc)

    async def requests() -> None:
        consumed = asyncio.Event()

        class SlowConsumedResponse(FakeOpenAI):
            async def handle(self, request: httpx.Request) -> httpx.Response:
                if request.url.host != 'auth.openai.com':
                    return await super().handle(request)
                self.requests.append(request)
                token = parse_qs(request.content.decode())['refresh_token'][0]
                response = self._refresh(token)
                consumed.set()
                await asyncio.sleep(1.1)
                return response

        upstream = SlowConsumedResponse()
        apps = [_app(vault, upstream, clock=clock), _app(vault, upstream, clock=clock)]
        async with (
            httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[0]), base_url='http://service') as first,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[1]), base_url='http://service') as second,
        ):
            initial = asyncio.create_task(first.get('/openai/v1/models', headers=_turn()))
            await asyncio.wait_for(consumed.wait(), 2)
            for _ in range(cancellations):
                initial.cancel()
                await asyncio.sleep(0)
            [outcome] = await asyncio.gather(initial, return_exceptions=True)
            if cancellations:
                assert isinstance(outcome, asyncio.CancelledError)
            else:
                assert isinstance(outcome, httpx.Response)
                assert outcome.status_code == 200
            await asyncio.sleep(1.3 if cancellations else 0)
            recovered = await second.get('/openai/v1/models', headers=_turn(session_id='recovery'))
            assert recovered.status_code == 200, recovered.text
            assert [refresh['refresh_token'] for refresh in upstream.refreshes()] == [['rt_first'], ['rt_second']]
            assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_third'

    with asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        class LeaseClock(Clock):
            def __call__(self) -> float:
                return runner.get_loop().time()

        clock = LeaseClock()
        runner.run(requests())
