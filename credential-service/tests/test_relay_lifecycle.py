"""Credential custody, cache-validation races, and stale refresh leases."""

from __future__ import annotations

import asyncio
import gc
import json
import weakref
from threading import Event
from typing import Any

import httpx
import pytest

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.invocation import CredentialServiceInvocation
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.vault import (
    DynamoDbCredentialVault,
    RotationStoredButRefused,
)
from test_openai import SIGN_IN, Clock, FakeOpenAI, _bound_turn, _client, _stored, _turn
from test_openai import vault as vault


class EphemeralAccess(str):
    """A transparent token string whose retention can be observed without inspecting the cache."""


class TrackedOpenAI(FakeOpenAI):
    def __init__(self) -> None:
        super().__init__()
        self.tokens: list[weakref.ReferenceType[EphemeralAccess]] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        response = await super().handle(request)
        if request.url.host != 'auth.openai.com' or not response.is_success:
            return response
        references = self.tokens

        class TokenResponse(httpx.Response):
            def json(self, **kwargs: Any) -> Any:
                data = super().json(**kwargs)
                token = EphemeralAccess(data['access_token'])
                references.append(weakref.ref(token))
                return {**data, 'access_token': token}

        return TokenResponse(response.status_code, content=response.content, headers=response.headers)


@pytest.mark.parametrize('operation', ['ingest', 'revoke', 'deleted', 'replaced'])
def test_invalidating_a_sign_in_releases_its_ephemeral_access_token(
    vault: DynamoDbCredentialVault, operation: str,
) -> None:
    async def run() -> None:
        _stored(vault)
        upstream = TrackedOpenAI()
        provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(), transport=httpx.MockTransport(upstream.handle),
        )
        assert await provider.mint_access('acct-1', {'sessionId': 'thread-1'}) == 'at_1'
        assert upstream.tokens[0]() is not None
        if operation == 'ingest':
            await provider.ingest(CredentialServiceInvocation('acct-1', 'thread-1'), {
                **SIGN_IN, 'refreshToken': 'new-sign-in',
            })
        elif operation == 'revoke':
            await provider.revoke('acct-1')
        else:
            if operation == 'deleted':
                vault.delete_durable_credential('acct-1', 'openai')
            else:
                vault.store_durable_credential('acct-1', 'openai', json.dumps({
                    **SIGN_IN, 'refreshToken': 'new-sign-in',
                }))
                upstream.refresh_status = 503
            try:
                await provider.mint_access('acct-1', {'sessionId': 'thread-2'})
            except UpstreamRefusal:
                pass
            else:
                pytest.fail('invalidated access must not be returned')
        # This is the explicit ephemeral-token custody/lifetime contract, not a private-cache assertion.
        # Let completed-task callbacks and exception frames release their references before observing it.
        await asyncio.sleep(0)
        gc.collect()
        assert upstream.tokens[0]() is None

    asyncio.run(run())


@pytest.mark.parametrize('read_before_revoke', [False, True])
def test_concurrent_revocation_returns_a_classified_refusal_during_cache_validation(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, read_before_revoke: bool,
) -> None:
    async def run() -> None:
        _stored(vault)
        upstream = FakeOpenAI()
        provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(), transport=httpx.MockTransport(upstream.handle),
        )
        assert await provider.mint_access('acct-1', {'sessionId': 'thread-1'}) == 'at_1'
        # The cached credential is now stale. A revision read may finish before or after revocation.
        vault.store_durable_credential('acct-1', 'openai', json.dumps({**SIGN_IN, 'refreshToken': 'new-sign-in'}))
        original_revision = vault.load_credential_revision
        entered = asyncio.Event()
        release = Event()
        loop = asyncio.get_running_loop()

        def revision_read(account_id: str, provider_name: str) -> str:
            revision = original_revision(account_id, provider_name) if read_before_revoke else None
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(2):
                raise TimeoutError('revocation did not release the revision read')
            return revision if revision is not None else original_revision(account_id, provider_name)

        monkeypatch.setattr(vault, 'load_credential_revision', revision_read)
        validating = asyncio.create_task(provider.mint_access('acct-1', {'sessionId': 'thread-2'}))
        revision_started = asyncio.create_task(entered.wait())
        try:
            completed, _ = await asyncio.wait(
                {revision_started, validating}, timeout=2, return_when=asyncio.FIRST_COMPLETED,
            )
            if validating in completed:
                # Observe a premature public result or failure instead of timing out
                # while waiting for a revision read that the implementation skipped.
                await validating
                pytest.fail('cached access returned before its credential revision was validated')
            assert revision_started in completed, 'credential revision validation did not start'
            await provider.revoke('acct-1')
        finally:
            release.set()
            revision_started.cancel()
            await asyncio.gather(revision_started, return_exceptions=True)
        with pytest.raises(UpstreamRefusal) as refused:
            await validating
        assert refused.value.status_code == 401
        assert refused.value.body['error']['code'] == 'PLAN_USAGE_REVOKED'
        assert 'no ChatGPT credential is stored' in refused.value.body['error']['message']
        assert upstream.spent == {'rt_first'}

    asyncio.run(run())


def test_a_refused_write_that_stored_the_rotation_names_that_exact_failure(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stored(vault)
    original_replace = vault.replace_durable_credential

    def store_then_refuse(
        account_id: str, provider: str, durable_credential: str, *, revision: str, lease: str,
    ) -> str:
        written = original_replace(account_id, provider, durable_credential, revision=revision, lease=lease)
        raise RotationStoredButRefused(written)

    monkeypatch.setattr(vault, 'replace_durable_credential', store_then_refuse)
    upstream = FakeOpenAI()
    response = _client(vault, upstream).get('/openai/v1/models', headers=_turn())
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
    assert 'the Vault refused a write whose rotated ChatGPT credential was already stored' in response.json()['error']['message']
    assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_second'
    assert upstream.api_calls() == []


def test_a_matching_model_name_does_not_authorize_a_different_provider(
    vault: DynamoDbCredentialVault,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    response = _client(vault, upstream).post(
        '/openai/v1/responses', json={'model': 'claude-sonnet-4-5', 'input': 'hello', 'stream': True},
        headers=_bound_turn('anthropic', 'claude-sonnet-4-5'),
    )
    assert response.status_code == 403
    assert response.json() == {'detail': 'This invocation is not authorized for an OpenAI model'}
    assert upstream.requests == []


def test_a_stale_refresh_cannot_write_after_another_task_takes_its_expired_lease(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        _stored(vault)
        clock = Clock()
        write_started = asyncio.Event()
        release_write = Event()
        successor_started = asyncio.Event()
        release_successor = asyncio.Event()
        loop = asyncio.get_running_loop()
        original_replace = vault.replace_durable_credential

        def paused_write(
            account_id: str, provider: str, durable_credential: str, *, revision: str, lease: str,
        ) -> str:
            loop.call_soon_threadsafe(write_started.set)
            if not release_write.wait(2):
                raise TimeoutError('successor task did not release the stale write')
            return original_replace(account_id, provider, durable_credential, revision=revision, lease=lease)

        monkeypatch.setattr(vault, 'replace_durable_credential', paused_write)
        first_upstream = FakeOpenAI()

        class SuccessorOpenAI(FakeOpenAI):
            async def handle(self, request: httpx.Request) -> httpx.Response:
                if request.url.host == 'auth.openai.com':
                    successor_started.set()
                    await release_successor.wait()
                    # The previous task already spent the token before its write became stale.
                    return httpx.Response(400, json={'error': 'invalid_grant'})
                return await super().handle(request)

        first_provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(), clock=clock,
            transport=httpx.MockTransport(first_upstream.handle),
        )
        successor_provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(), clock=clock,
            transport=httpx.MockTransport(SuccessorOpenAI().handle),
        )
        first = asyncio.create_task(first_provider.mint_access('acct-1', {'sessionId': 'thread-1'}))
        successor: asyncio.Task[str] | None = None
        try:
            await asyncio.wait_for(write_started.wait(), timeout=2)
            # Advance the domain clock beyond the first 30-second lease while its holder's write is paused.
            # The successor has a real Vault lease before the stale conditional write is allowed to finish.
            clock.now += 31
            successor = asyncio.create_task(successor_provider.mint_access('acct-1', {'sessionId': 'thread-2'}))
            await asyncio.wait_for(successor_started.wait(), timeout=2)
            release_write.set()
            with pytest.raises(UpstreamRefusal) as refused:
                await first
            assert refused.value.status_code == 503
            assert 'another write replaced the ChatGPT credential' in refused.value.body['error']['message']
            assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN
        finally:
            release_write.set()
            release_successor.set()
            await asyncio.gather(first, *([successor] if successor is not None else []), return_exceptions=True)

    asyncio.run(run())
