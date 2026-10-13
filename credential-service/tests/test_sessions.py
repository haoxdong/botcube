from __future__ import annotations

import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Semaphore
from typing import Any

import boto3
import pytest
from moto import mock_aws

from botcube_credential_service.sessions import SessionCache
from botcube_credential_service.vault import (
    Boto3KmsDataKeyProvider,
    CredentialNotFound,
    CredentialServiceError,
    DynamoDbCredentialVault,
)


@pytest.fixture
def vault() -> Iterator[DynamoDbCredentialVault]:
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='vault',
            KeySchema=[
                {'AttributeName': 'accountId', 'KeyType': 'HASH'},
                {'AttributeName': 'provider', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'accountId', 'AttributeType': 'S'},
                {'AttributeName': 'provider', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        kms = boto3.client('kms', region_name='us-east-1')
        yield DynamoDbCredentialVault(table, Boto3KmsDataKeyProvider(key_id=kms.create_key()['KeyMetadata']['KeyId'], client=kms))


def _live(cookies: Sequence[object], now: float) -> bool:
    return any(isinstance(cookie, Mapping) and cookie.get('name') == 'session' and cookie['expires'] > now for cookie in cookies)


def _session(value: str, expires: float | None = None) -> dict[str, object]:
    return {'name': 'session', 'value': value, 'expires': time.time() + 600 if expires is None else expires}


def _cache(vault: DynamoDbCredentialVault, reminter: Callable[[str], Mapping[str, Any]]) -> SessionCache:
    return SessionCache(
        vault=vault, reminter=reminter, provider='site', site='Example', live=_live,
        durable=lambda cookie: cookie.get('name') == 'durable',
    )


def test_a_cold_cache_re_mints_from_the_vaulted_credential_once_and_never_hands_out_the_durable_cookie(
    vault: DynamoDbCredentialVault,
) -> None:
    mints: list[str] = []

    def remint(credential: str) -> Mapping[str, Any]:
        mints.append(credential)
        return {'cookies': [_session(f'from-{credential}'), {'name': 'durable', 'value': credential}]}

    cache = _cache(vault, remint)
    cache.store_linked_credential('acct-1', 'durable-1', [])

    first = cache.session_cookie_jar('acct-1')
    second = cache.session_cookie_jar('acct-1')

    assert [cookie['value'] for cookie in first['cookies']] == ['from-durable-1']
    assert second == first
    assert mints == ['durable-1']
    assert cache.has_live_session('acct-1')


def test_a_sign_in_with_a_live_session_warms_the_cache_without_a_re_mint(vault: DynamoDbCredentialVault) -> None:
    cache = _cache(vault, lambda credential: pytest.fail('re-minted a warm session'))

    cache.store_linked_credential('acct-1', 'durable-1', [_session('signed-in'), {'name': 'durable', 'value': 'x'}])

    assert [cookie['value'] for cookie in cache.session_cookie_jar('acct-1')['cookies']] == ['signed-in']


@pytest.mark.parametrize('fails', [False, True])
def test_parallel_requests_on_a_cold_cache_share_one_re_mint_and_its_failure(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, fails: bool,
) -> None:
    # A cold cache once launched one browser per parallel request, and they starved each other.
    vault.store_durable_credential('acct-1', 'site', 'durable-1')
    entered = Semaphore(0)
    revision = vault.credential_revision

    def entering_revision(account_id: str, provider: str) -> str | None:
        entered.release()
        return revision(account_id, provider)

    monkeypatch.setattr(vault, 'credential_revision', entering_revision)
    mints: list[str] = []

    def remint(credential: str) -> Mapping[str, Any]:
        mints.append(credential)
        for _ in range(4):
            assert entered.acquire(timeout=5)
        if fails:
            raise CredentialServiceError('Session re-mint failed: REMINT_TIMEOUT')
        return {'cookies': [_session('shared')]}

    cache = _cache(vault, remint)
    with ThreadPoolExecutor(4) as pool:
        pending = [pool.submit(cache.session_cookie_jar, 'acct-1') for _ in range(4)]
        for request in pending:
            if fails:
                with pytest.raises(CredentialServiceError, match='REMINT_TIMEOUT'):
                    request.result(timeout=5)
            else:
                assert request.result(timeout=5)['cookies'][0]['value'] == 'shared'
    assert mints == ['durable-1']


def test_a_request_after_an_invalidation_starts_its_own_re_mint(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'site', 'durable-1')
    first_started, release_first = Event(), Event()
    mints: list[str] = []

    def remint(credential: str) -> Mapping[str, Any]:
        mints.append(credential)
        if len(mints) == 1:
            first_started.set()
            assert release_first.wait(5)
        return {'cookies': [_session(f'session-{len(mints)}')]}

    cache = _cache(vault, remint)
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(cache.session_cookie_jar, 'acct-1')
        try:
            assert first_started.wait(5)
            cache.invalidate_session('acct-1')
            second = pool.submit(cache.session_cookie_jar, 'acct-1')
            assert second.result(timeout=5)['cookies'][0]['value'] == 'session-2'
        finally:
            release_first.set()
        with pytest.raises(CredentialServiceError, match='Credential changed during session re-mint'):
            first.result(timeout=5)
    assert mints == ['durable-1', 'durable-1']


def test_an_invalidation_naming_another_session_leaves_the_cached_one(vault: DynamoDbCredentialVault) -> None:
    values = iter(['first', 'second'])
    cache = _cache(vault, lambda credential: {'cookies': [_session(next(values))]})
    cache.store_linked_credential('acct-1', 'durable-1', [])
    first = cache.session_cookie_jar('acct-1')['cookies']

    cache.invalidate_session('acct-1', expected_cookies=[_session('someone-else')])
    assert cache.session_cookie_jar('acct-1')['cookies'] == first
    cache.invalidate_session('acct-1', expected_cookies=first)

    assert cache.session_cookie_jar('acct-1')['cookies'][0]['value'] == 'second'


def test_a_re_mint_finishing_during_a_new_sign_in_cannot_publish_the_previous_session(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault.store_durable_credential('acct-1', 'site', 'old')
    mint_started, mint_release, store_started, store_release, finished = (Event() for _ in range(5))

    def remint(credential: str) -> Mapping[str, Any]:
        if credential == 'old':
            mint_started.set()
            assert mint_release.wait(5)
        return {'cookies': [_session(credential)]}

    cache = _cache(vault, remint)
    store = vault.store_durable_credential

    def slow_store(account: str, provider: str, credential: str) -> str:
        store_started.set()
        assert store_release.wait(5)
        return store(account, provider, credential)

    def read() -> dict[str, Any]:
        try:
            return cache.session_cookie_jar('acct-1')
        finally:
            finished.set()

    monkeypatch.setattr(vault, 'store_durable_credential', slow_store)
    with ThreadPoolExecutor(2) as pool:
        pending = pool.submit(read)
        try:
            assert mint_started.wait(5)
            relink = pool.submit(cache.store_linked_credential, 'acct-1', 'new', [_session('new')])
            assert store_started.wait(5)
            mint_release.set()
            finished.wait(0.2)
        finally:
            mint_release.set()
            store_release.set()
        relink.result(timeout=5)
        with pytest.raises(CredentialServiceError, match='Credential changed during session re-mint'):
            pending.result(timeout=5)
    assert cache.session_cookie_jar('acct-1')['cookies'][0]['value'] == 'new'


def test_a_re_mint_without_a_live_session_names_the_site(vault: DynamoDbCredentialVault) -> None:
    cache = _cache(vault, lambda credential: {'cookies': [_session('stale', expires=0)]})
    cache.store_linked_credential('acct-1', 'durable-1', [])

    with pytest.raises(CredentialServiceError, match='Session re-mint returned no usable Example session'):
        cache.session_cookie_jar('acct-1')


def test_a_refresh_replaces_the_cookie_of_its_name_until_a_new_sign_in_fences_it(vault: DynamoDbCredentialVault) -> None:
    cache = _cache(vault, lambda credential: pytest.fail('re-minted a warm session'))
    cache.store_linked_credential('acct-1', 'durable-1', [_session('old'), {'name': 'pref', 'value': 'dark'}])
    jar, revision = cache.session_cookie_snapshot('acct-1')

    cache.update_session_cookies('acct-1', [_session('new'), {'name': 'durable', 'value': 'x'}], expected_generation=revision)
    refreshed = cache.session_cookie_jar('acct-1')['cookies']
    cache.store_linked_credential('acct-1', 'durable-2', [])

    assert [cookie['value'] for cookie in jar['cookies']] == ['old', 'dark']
    assert [cookie['value'] for cookie in refreshed] == ['new', 'dark']
    with pytest.raises(CredentialServiceError, match='Credential changed during session refresh; retry the request'):
        cache.update_session_cookies('acct-1', [_session('late')], expected_generation=revision)


def test_an_unlinked_account_has_no_session(vault: DynamoDbCredentialVault) -> None:
    cache = _cache(vault, lambda credential: {'cookies': [_session('live')]})
    cache.store_linked_credential('acct-1', 'durable-1', [_session('live')])

    cache.delete_linked_credential('acct-1')

    assert not cache.has_live_session('acct-1')
    with pytest.raises(CredentialNotFound):
        cache.session_cookie_jar('acct-1')
