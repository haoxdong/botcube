from __future__ import annotations

import asyncio
import json
import sys
import time
from collections.abc import Callable, Iterator, Mapping
from decimal import Decimal
from pathlib import Path
from threading import Event, Lock
from typing import Any
from urllib.parse import parse_qs

import boto3
import httpx
import pytest
from botocore.client import BaseClient
from fastapi import FastAPI
from fastapi.testclient import TestClient
from moto import mock_aws

from botcube_credential_service import openai as openai_module
from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.invocation import sign_credential_service_invocation
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.server import CredentialServiceSettings, create_app
from botcube_credential_service.vault import (
    Boto3KmsDataKeyProvider,
    CredentialNotFound,
    DynamoDbCredentialVault,
    RotationLost,
)

SECRET = 'credential-service-secret'
SIGN_IN = {'subject': 'user-AbC123', 'clientId': 'app_dyn_1', 'refreshToken': 'rt_first'}
# Recorded from live calls on the owner's plan; tokens and the user's identity are replaced.
RECORDED = Path(__file__).parent / 'fixtures' / 'openai'


@pytest.fixture
def vault(monkeypatch: pytest.MonkeyPatch) -> Iterator[DynamoDbCredentialVault]:
    # DynamoDB applies each request atomically; moto checks a condition and then writes, which the
    # tasks' Vault threads can interleave. One request at a time keeps the fake as atomic as DynamoDB.
    request, one_at_a_time = BaseClient.__dict__['_make_api_call'], Lock()

    def atomic(client: BaseClient, operation: str, params: Mapping[str, Any]) -> Any:
        with one_at_a_time:
            return request(client, operation, params)

    monkeypatch.setattr(BaseClient, '_make_api_call', atomic)
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
        key_id = kms.create_key()['KeyMetadata']['KeyId']
        yield DynamoDbCredentialVault(table, Boto3KmsDataKeyProvider(key_id=key_id, client=kms))


class FakeOpenAI:
    """OpenAI at the outer edge: its token endpoint and API, answering recorded responses."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.refresh_tokens = iter(['rt_second', 'rt_third'])
        self.access_tokens = iter(['at_1', 'at_2'])
        self.refresh_status = 200
        self.refresh_error = 'invalid_grant'
        # How long a refresh takes to answer, so concurrent tasks overlap.
        self.refresh_seconds = 0.0
        # A refresh token rotates on use: OpenAI refuses one already spent.
        self.spent: set[str] = set()
        # Runs as a refresh is answered, as another Credential Service task would meanwhile.
        self.during_refresh: Callable[[], None] = lambda: None
        # What POST /v1/responses answers; the recorded stream unless a test sets it.
        self.responses: Callable[[], httpx.Response] = lambda: httpx.Response(
            # The recorded stream came with no content type.
            200, stream=httpx.ByteStream((RECORDED / 'responses-stream.sse').read_bytes()),
        )

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url == 'https://auth.openai.com/api/accounts/oauth/token':
            await asyncio.sleep(self.refresh_seconds)
            return self._refresh(parse_qs(request.content.decode())['refresh_token'][0])
        if request.method == 'GET' and request.url.path == '/v1/models':
            return httpx.Response(200, content=(RECORDED / 'models.json').read_bytes(), headers={'content-type': 'application/json'})
        if request.method == 'POST' and request.url.path == '/v1/responses':
            return self.responses()
        return httpx.Response(404)

    def _refresh(self, refresh_token: str) -> httpx.Response:
        if refresh_token in self.spent:
            return httpx.Response(400, json={'error': 'invalid_grant'})
        if self.refresh_status != 200:
            return httpx.Response(self.refresh_status, json={'error': self.refresh_error})
        self.spent.add(refresh_token)
        self.during_refresh()
        recorded = json.loads((RECORDED / 'refresh.json').read_text())
        return httpx.Response(200, json={
            **recorded, 'access_token': next(self.access_tokens), 'refresh_token': next(self.refresh_tokens),
        })

    def refreshes(self) -> list[dict[str, list[str]]]:
        return [parse_qs(r.content.decode()) for r in self.requests if r.url.host == 'auth.openai.com']

    def api_calls(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.host == 'api.openai.com']


class ListSink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, event: Mapping[str, Any]) -> None:
        self.events.append(dict(event))


class Clock:
    def __init__(self) -> None:
        self.now = 1_790_965_829.0

    def __call__(self) -> float:
        return self.now


class RealClock(Clock):
    def __call__(self) -> float:
        return time.time()


def _client(
    vault: DynamoDbCredentialVault,
    openai: FakeOpenAI | None = None,
    *,
    sink: ListSink | None = None,
    clock: Clock | None = None,
    owner_account_id: str = 'acct-1',
) -> TestClient:
    return TestClient(_app(vault, openai, sink=sink, clock=clock, owner_account_id=owner_account_id))


def _app(
    vault: DynamoDbCredentialVault,
    openai: FakeOpenAI | None = None,
    *,
    sink: ListSink | None = None,
    clock: Clock | None = None,
    owner_account_id: str = 'acct-1',
) -> FastAPI:
    settings = CredentialServiceSettings(
        name='test-credential-service',
        invocation_secret=lambda: SECRET,
        account_header='X-Account-Id',
        session_header='X-Session-Id',
        plan_usage_owner_account_id=owner_account_id,
    )
    clock = clock or Clock()
    provider = OpenAIProvider(
        lambda: vault,
        audit=CredentialAuditRecorder(sink=sink, clock=clock),
        transport=httpx.MockTransport((openai or FakeOpenAI()).handle),
        clock=clock,
    )
    return create_app(settings, [provider])


def _turn(account_id: str = 'acct-1', session_id: str = 'thread-1') -> dict[str, str]:
    """What a Harness's plan model sends: the Turn's invocation token and its Session."""
    token = sign_credential_service_invocation(SECRET, account_id, session_id)
    return {'Authorization': f'Bearer {token}', 'X-Account-Id': account_id, 'X-Session-Id': session_id}


def _bound_turn(
    provider: str | None, model: str | None, *, session_id: str = 'thread-1',
) -> dict[str, str]:
    token = sign_credential_service_invocation(
        SECRET, 'acct-1', session_id, model_provider=provider, model_id=model,
    )
    return {'Authorization': f'Bearer {token}', 'X-Account-Id': 'acct-1', 'X-Session-Id': session_id}


@pytest.mark.parametrize('provider,approved_model,requested_model,expected_status', [
    (None, None, 'gpt-6-astra', 403),
    ('anthropic', 'claude-sonnet-4-5', 'gpt-6-astra', 403),
    ('openai', 'gpt-6-astra', 'arbitrary-model', 403),
    ('openai', 'gpt-6-astra', 'gpt-6-astra', 200),
])
def test_responses_spends_only_the_signed_openai_model(
    vault: DynamoDbCredentialVault,
    provider: str | None, approved_model: str | None, requested_model: str, expected_status: int,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    response = _client(vault, upstream).post(
        '/openai/v1/responses', json={'model': requested_model, 'input': 'hello', 'stream': True},
        headers=_bound_turn(provider, approved_model),
    )

    assert response.status_code == expected_status
    if expected_status == 403:
        assert upstream.requests == []
        assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN
    else:
        assert json.loads(upstream.api_calls()[0].content)['model'] == requested_model


@pytest.mark.parametrize('body,status', [(b'{', 400), (b'{}', 403), (b'[]', 403)])
def test_invalid_model_requests_are_rejected_before_refresh_or_relay(
    vault: DynamoDbCredentialVault, body: bytes, status: int,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    response = _client(vault, upstream).post(
        '/openai/v1/responses', content=body,
        headers={**_bound_turn('openai', 'gpt-6-astra'), 'content-type': 'application/json'},
    )

    assert response.status_code == status
    assert upstream.requests == []
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN


def _bearer(scope: str, account_id: str = 'acct-1') -> dict[str, str]:
    token = sign_credential_service_invocation(SECRET, account_id, 'operator-1', scope=scope)
    return {'Authorization': f'Bearer {token}'}


def test_ingest_vaults_the_sign_in_durable_credential_under_the_account_and_openai(
    vault: DynamoDbCredentialVault,
) -> None:
    response = _client(vault).post('/openai/auth/link/ingest', json=SIGN_IN, headers=_bearer('credential_capture'))

    assert response.status_code == 200
    assert response.json() == {'status': 'stored', 'subject': 'user-AbC123'}
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == {
        'subject': 'user-AbC123',
        'clientId': 'app_dyn_1',
        'refreshToken': 'rt_first',
    }


def test_signed_non_owner_cannot_grant_plan_usage_directly(vault: DynamoDbCredentialVault) -> None:
    response = _client(vault).post(
        '/openai/auth/link/ingest', json=SIGN_IN, headers=_bearer('credential_capture', 'acct-other'),
    )

    assert response.status_code == 403
    with pytest.raises(CredentialNotFound):
        vault.load_durable_credential('acct-other', 'openai')


def test_signed_non_owner_cannot_revoke_plan_usage_directly(vault: DynamoDbCredentialVault) -> None:
    _stored(vault, 'acct-other')
    before = vault.load_durable_credential('acct-other', 'openai')

    response = _client(vault).post('/openai/auth/link/revoke', headers=_bearer('credential_revocation', 'acct-other'))

    assert response.status_code == 403
    assert vault.load_durable_credential('acct-other', 'openai') == before


@pytest.mark.parametrize('owner', ['', '   '])
@pytest.mark.parametrize('operation,scope', [('ingest', 'credential_capture'), ('revoke', 'credential_revocation')])
def test_unconfigured_owner_fails_closed_without_affecting_health(
    vault: DynamoDbCredentialVault, owner: str, operation: str, scope: str,
) -> None:
    _stored(vault)
    before = vault.load_durable_credential('acct-1', 'openai')
    client = _client(vault, owner_account_id=owner)

    response = client.post(f'/openai/auth/link/{operation}', json=SIGN_IN, headers=_bearer(scope))

    assert response.status_code == 503
    assert response.json() == {'detail': 'Plan Usage owner account is not configured'}
    assert vault.load_durable_credential('acct-1', 'openai') == before
    assert client.get('/health').status_code == 200


def test_account_deletion_still_cleans_legacy_non_owner_plan_usage(vault: DynamoDbCredentialVault) -> None:
    _stored(vault, 'acct-other')

    response = _client(vault).post('/account/revoke', headers=_bearer('credential_revocation', 'acct-other'))

    assert response.status_code == 200
    with pytest.raises(CredentialNotFound):
        vault.load_durable_credential('acct-other', 'openai')


def test_ingesting_again_replaces_the_stored_durable_credential(vault: DynamoDbCredentialVault) -> None:
    client = _client(vault)
    client.post('/openai/auth/link/ingest', json=SIGN_IN, headers=_bearer('credential_capture'))

    again = client.post(
        '/openai/auth/link/ingest',
        json={**SIGN_IN, 'clientId': 'app_dyn_2', 'refreshToken': 'rt_second'},
        headers=_bearer('credential_capture'),
    )

    assert again.json() == {'status': 'stored', 'subject': 'user-AbC123'}
    assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_second'


@pytest.mark.parametrize('field', ['subject', 'clientId', 'refreshToken'])
@pytest.mark.parametrize('value', [None, '', 7])
def test_ingest_refuses_a_sign_in_missing_a_field_and_stores_nothing(
    vault: DynamoDbCredentialVault, field: str, value: object,
) -> None:
    payload = {**SIGN_IN, field: value}

    response = _client(vault).post('/openai/auth/link/ingest', json=payload, headers=_bearer('credential_capture'))

    assert response.status_code == 400
    assert response.json() == {'detail': f'{field} is required'}
    with pytest.raises(CredentialNotFound):
        vault.load_durable_credential('acct-1', 'openai')


def test_revoke_deletes_only_the_account_openai_row(vault: DynamoDbCredentialVault) -> None:
    client = _client(vault)
    client.post('/openai/auth/link/ingest', json=SIGN_IN, headers=_bearer('credential_capture'))
    _stored(vault, 'acct-2')
    vault.store_durable_credential('acct-1', 'site', 'site-secret')

    response = client.post('/openai/auth/link/revoke', headers=_bearer('credential_revocation'))

    assert response.json() == {'status': 'revoked'}
    with pytest.raises(CredentialNotFound):
        vault.load_durable_credential('acct-1', 'openai')
    assert vault.load_durable_credential('acct-1', 'site') == 'site-secret'
    assert json.loads(vault.load_durable_credential('acct-2', 'openai'))['subject'] == 'user-AbC123'


def test_account_deletion_deletes_the_account_openai_row(vault: DynamoDbCredentialVault) -> None:
    client = _client(vault)
    client.post('/openai/auth/link/ingest', json=SIGN_IN, headers=_bearer('credential_capture'))

    response = client.post('/account/revoke', headers=_bearer('credential_revocation'))

    assert response.json() == {'status': 'revoked'}
    with pytest.raises(CredentialNotFound):
        vault.load_durable_credential('acct-1', 'openai')


def test_an_unconfigured_vault_reports_the_service_unhealthy() -> None:
    def unconfigured() -> DynamoDbCredentialVault:
        raise ValueError('Vault table and KMS key are required')

    settings = CredentialServiceSettings(
        name='test-credential-service',
        invocation_secret=lambda: SECRET,
        account_header='X-Account-Id',
        session_header='X-Session-Id',
    )

    response = TestClient(create_app(settings, [OpenAIProvider(unconfigured, audit=CredentialAuditRecorder())])).get('/health')

    assert response.status_code == 503
    assert response.json()['detail']['component'] == 'vault'


def _stored(vault: DynamoDbCredentialVault, account_id: str = 'acct-1') -> None:
    vault.store_durable_credential(account_id, 'openai', json.dumps(SIGN_IN))


def test_the_plan_catalog_is_relayed_with_an_access_token_refreshed_from_the_vaulted_sign_in(
    vault: DynamoDbCredentialVault,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()

    response = _client(vault, openai).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 200
    assert response.json() == json.loads((RECORDED / 'models.json').read_text())
    assert openai.refreshes() == [{
        'grant_type': ['refresh_token'],
        'client_id': ['app_dyn_1'],
        'refresh_token': ['rt_first'],
        'resource': ['https://api.openai.com/v1'],
    }]
    [call] = openai.api_calls()
    assert str(call.url) == 'https://api.openai.com/v1/models'
    assert call.headers['authorization'] == 'Bearer at_1'


def test_a_refresh_writes_the_rotated_refresh_token_back_to_the_vault(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)

    _client(vault).get('/openai/v1/models', headers=_turn())

    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == {
        'subject': 'user-AbC123',
        'clientId': 'app_dyn_1',
        'refreshToken': 'rt_second',
    }


def test_an_unexpired_access_token_is_reused_and_an_expired_one_is_refreshed(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    clock = Clock()
    client = _client(vault, openai, clock=clock)

    client.get('/openai/v1/models', headers=_turn())
    clock.now += 3000
    client.get('/openai/v1/models', headers=_turn())
    clock.now += 600
    client.get('/openai/v1/models', headers=_turn())

    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_second']]
    assert [call.headers['authorization'] for call in openai.api_calls()] == ['Bearer at_1', 'Bearer at_1', 'Bearer at_2']
    assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_third'


def test_a_streaming_response_is_relayed_through_as_openai_sent_it(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    body = b'{"model":"gpt-6-astra","input":[{"role":"user","content":"Say exactly: hello"}],"stream":true,"store":false}'

    response = _client(vault, openai).post(
        '/openai/v1/responses', content=body, headers={**_bound_turn('openai', 'gpt-6-astra'), 'content-type': 'application/json'},
    )

    assert response.status_code == 200
    assert response.content == (RECORDED / 'responses-stream.sse').read_bytes()
    [call] = openai.api_calls()
    assert (call.method, str(call.url)) == ('POST', 'https://api.openai.com/v1/responses')
    assert call.content == body
    assert call.headers['content-type'] == 'application/json'


def test_openai_sees_the_access_token_and_none_of_the_invocation(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()

    _client(vault, openai).get('/openai/v1/models', headers=_turn())

    [call] = openai.api_calls()
    assert call.headers['authorization'] == 'Bearer at_1'
    assert 'x-account-id' not in call.headers
    assert 'x-session-id' not in call.headers


@pytest.mark.parametrize(('method', 'path'), [
    ('GET', '/openai/v1/responses'),
    ('POST', '/openai/v1/models'),
    ('GET', '/openai/v1/files'),
    ('DELETE', '/openai/v1/responses'),
    ('GET', '/openai/v1/models/gpt-6-astra'),
    ('POST', '/openai/v1/chat/completions'),
])
def test_no_other_openai_call_is_relayed(vault: DynamoDbCredentialVault, method: str, path: str) -> None:
    _stored(vault)
    openai = FakeOpenAI()

    response = _client(vault, openai).request(method, path, headers=_turn())

    assert response.status_code == 403
    assert response.json() == {'detail': 'Credential Service only allows the OpenAI model calls Plan Usage makes'}
    assert openai.requests == []


def test_each_relayed_call_is_in_the_audit_trail(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    sink = ListSink()
    client = _client(vault, sink=sink)

    client.get('/openai/v1/models', headers=_turn())
    client.post('/openai/v1/responses', json={'model': 'gpt-6-astra'},
                headers=_bound_turn('openai', 'gpt-6-astra', session_id='thread-2'))

    assert [event for event in sink.events if event['event'] in {'kms_decrypt', 'upstream_relay'}] == [
        {'event': 'kms_decrypt', 'accountId': 'acct-1', 'sessionId': 'thread-1', 'method': 'GET', 'path': 'v1/models',
         'timestamp': 1_790_965_829.0},
        {'event': 'upstream_relay', 'accountId': 'acct-1', 'provider': 'openai', 'sessionId': 'thread-1',
         'method': 'GET', 'path': 'v1/models', 'timestamp': 1_790_965_829.0},
        {'event': 'upstream_relay', 'accountId': 'acct-1', 'provider': 'openai', 'sessionId': 'thread-2',
         'method': 'POST', 'path': 'v1/responses', 'modelId': 'gpt-6-astra', 'timestamp': 1_790_965_829.0},
    ]


def test_an_account_without_plan_usage_is_refused_without_calling_openai(vault: DynamoDbCredentialVault) -> None:
    openai = FakeOpenAI()

    response = _client(vault, openai).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 401
    assert response.json() == _plan_usage_error(
        'PLAN_USAGE_REVOKED', REVOKED.format(cause='no ChatGPT credential is stored for this account'),
    )
    assert openai.requests == []


@pytest.mark.parametrize('status', [400, 401])
def test_a_failed_refresh_is_the_revoked_error_and_keeps_the_vaulted_sign_in(
    vault: DynamoDbCredentialVault, status: int,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    openai.refresh_status = status

    response = _client(vault, openai).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 401
    assert response.json() == _plan_usage_error(
        'PLAN_USAGE_REVOKED', REVOKED.format(cause=f'OpenAI refused the token refresh with HTTP {status} invalid_grant'),
    )
    assert openai.api_calls() == []
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN


UNAVAILABLE = "ChatGPT could not check your plan's usage; try again later ({cause})."
REVOKED = (
    'Your ChatGPT plan cannot be used: it is not eligible, or its credential was revoked or can no longer refresh. '
    'Re-run the botcube-openai-plan-usage operator command to sign in to ChatGPT again ({cause}).'
)
# OpenAI's Plan Usage error codes and statuses, as its errors-and-recovery guide names them
# (developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), and each one's classified error.
PLAN_USAGE_ERRORS = [
    pytest.param(
        'subscription_sharing_usage_limit_exceeded', 429, None, 'PLAN_USAGE_LIMIT_REACHED',
        "Your ChatGPT plan's usage limit is reached; wait, or check ChatGPT Settings > Usage "
        '(OpenAI subscription_sharing_usage_limit_exceeded).',
        id='usage limit',
    ),
    pytest.param(
        'subscription_sharing_usage_unavailable', 503, None, 'PLAN_USAGE_UNAVAILABLE',
        "ChatGPT could not check your plan's usage; try again later (OpenAI subscription_sharing_usage_unavailable).",
        id='usage unavailable',
    ),
    pytest.param(
        'subscription_sharing_user_unavailable', 503, None, 'PLAN_USAGE_UNAVAILABLE',
        "ChatGPT could not check your plan's usage; try again later (OpenAI subscription_sharing_user_unavailable).",
        id='user unavailable',
    ),
    pytest.param(
        'subscription_sharing_user_not_eligible', 403, None, 'PLAN_USAGE_REVOKED',
        REVOKED.format(cause='OpenAI subscription_sharing_user_not_eligible'),
        id='not eligible',
    ),
    pytest.param(
        'subscription_sharing_invalid_user', 401, None, 'PLAN_USAGE_REVOKED',
        REVOKED.format(cause='OpenAI subscription_sharing_invalid_user'),
        id='revoked',
    ),
    pytest.param(
        'subscription_sharing_unsupported_capability', 400, 'tools', 'PLAN_USAGE_UNSUPPORTED',
        'Your ChatGPT plan does not support part of this request (OpenAI subscription_sharing_unsupported_capability: tools).',
        id='unsupported capability',
    ),
]


def _plan_usage_error(code: str, message: str) -> dict[str, Any]:
    """The classified Plan Usage error the relay answers in OpenAI's error shape (ADR 0030)."""
    return {'error': {'type': 'plan_usage', 'code': code, 'message': message}}


def _openai_error(code: str, param: str | None) -> dict[str, Any]:
    """OpenAI's standard API error object, which carries its error.code and error.param."""
    return {'error': {'message': f'Shaped like OpenAI {code}', 'type': 'invalid_request_error', 'param': param, 'code': code}}


def _sse(*events: tuple[str, Mapping[str, Any]]) -> bytes:
    return b''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n'.encode() for name, data in events)


def _frames(body: bytes) -> list[tuple[str, dict[str, Any]]]:
    frames = []
    for frame in body.decode().split('\n\n'):
        if frame:
            event, data = frame.split('\n')
            frames.append((event.removeprefix('event: '), json.loads(data.removeprefix('data: '))))
    return frames


def _responses(client: TestClient) -> httpx.Response:
    return client.post('/openai/v1/responses', content=b'{"model":"gpt-6-astra","stream":true}',
                       headers={**_bound_turn('openai', 'gpt-6-astra'), 'content-type': 'application/json'})


@pytest.mark.parametrize(('openai_code', 'status', 'param', 'code', 'message'), PLAN_USAGE_ERRORS)
def test_an_openai_plan_usage_error_is_answered_as_its_classified_error(
    vault: DynamoDbCredentialVault, openai_code: str, status: int, param: str | None, code: str, message: str,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    openai.responses = lambda: httpx.Response(status, json=_openai_error(openai_code, param))

    response = _responses(_client(vault, openai))

    assert response.status_code == status
    assert response.json() == _plan_usage_error(code, message)


@pytest.mark.parametrize(('openai_code', 'status', 'param', 'code', 'message'), PLAN_USAGE_ERRORS)
def test_a_plan_usage_error_mid_stream_ends_the_stream_with_its_classified_error(
    vault: DynamoDbCredentialVault, openai_code: str, status: int, param: str | None, code: str, message: str,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    created = {'type': 'response.created', 'response': {'id': 'resp_1', 'status': 'in_progress'}, 'sequence_number': 0}
    failed = {
        'type': 'response.failed',
        'response': {'id': 'resp_1', 'status': 'failed', 'error': {'code': openai_code, 'message': 'Shaped like OpenAI', 'param': param}},
        'sequence_number': 1,
    }
    openai.responses = lambda: httpx.Response(
        200, stream=httpx.ByteStream(_sse(('response.created', created), ('response.failed', failed))),
    )

    response = _responses(_client(vault, openai))

    assert response.status_code == 200
    assert _frames(response.content) == [
        ('response.created', created),
        ('error', {'type': 'error', **_plan_usage_error(code, message)}),
    ]


def test_another_openai_error_is_relayed_as_openai_sent_it(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    openai.responses = lambda: httpx.Response(403, json={'detail': 'Direct routing is not permitted in this region'})

    response = _responses(_client(vault, openai))

    assert response.status_code == 403
    assert response.json() == {'detail': 'Direct routing is not permitted in this region'}


def test_another_failure_mid_stream_ends_the_stream_with_openais_error(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    error = {'code': 'server_error', 'message': 'The server had an error'}
    failed = {'type': 'response.failed', 'response': {'id': 'resp_1', 'status': 'failed', 'error': error}}
    openai.responses = lambda: httpx.Response(200, stream=httpx.ByteStream(_sse(('response.failed', failed))))

    response = _responses(_client(vault, openai))

    assert _frames(response.content) == [('error', {'type': 'error', 'error': error})]


def test_openai_not_answering_is_the_classified_provider_timeout_issue_3284(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()

    def no_answer() -> httpx.Response:
        raise httpx.ReadTimeout('timed out')

    openai.responses = no_answer

    response = _responses(_client(vault, openai))

    assert response.status_code == 504
    assert response.json() == _plan_usage_error(
        'MODEL_PROVIDER_TIMEOUT', 'OpenAI did not respond to the model call; try again (no response within 300 s).',
    )


def test_revoking_drops_the_cached_access_token(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    client = _client(vault, openai)
    client.get('/openai/v1/models', headers=_turn())

    client.post('/openai/auth/link/revoke', headers=_bearer('credential_revocation'))
    response = client.get('/openai/v1/models', headers=_turn())

    assert response.status_code == 401
    assert len(openai.api_calls()) == 1


def test_a_new_sign_in_replaces_the_cached_access_token(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    client = _client(vault, openai)
    client.get('/openai/v1/models', headers=_turn())

    client.post(
        '/openai/auth/link/ingest', json={**SIGN_IN, 'refreshToken': 'rt_new'}, headers=_bearer('credential_capture'),
    )
    client.get('/openai/v1/models', headers=_turn())

    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_new']]


def test_another_task_revoking_prevents_cached_access_from_relaying(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    first, other = _client(vault, openai), _client(vault, openai)
    assert first.get('/openai/v1/models', headers=_turn()).status_code == 200
    assert other.post('/openai/auth/link/revoke', headers=_bearer('credential_revocation')).status_code == 200

    response = first.get('/openai/v1/models', headers=_turn())

    assert response.status_code == 401
    assert response.json()['error']['code'] == 'PLAN_USAGE_REVOKED'
    assert len(openai.api_calls()) == 1
    assert len(openai.refreshes()) == 1


def test_another_task_replacing_a_sign_in_invalidates_cached_access(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    first, other = _client(vault, openai), _client(vault, openai)
    assert first.get('/openai/v1/models', headers=_turn()).status_code == 200
    assert other.post('/openai/auth/link/ingest',
        json={**SIGN_IN, 'refreshToken': 'rt_new'}, headers=_bearer('credential_capture'),
    ).status_code == 200

    response = first.get('/openai/v1/models', headers=_turn())

    assert response.status_code == 200
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_new']]
    assert [call.headers['authorization'] for call in openai.api_calls()] == ['Bearer at_1', 'Bearer at_2']


@pytest.mark.parametrize('change', ['revoke', 'replace'])
def test_a_write_after_rotation_cannot_be_mistaken_for_the_cached_tokens_revision(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, change: str,
) -> None:
    _stored(vault)
    rotate = vault.replace_durable_credential

    def rotate_then_change(account: str, provider: str, value: str, *, revision: str, lease: str) -> str:
        written = rotate(account, provider, value, revision=revision, lease=lease)
        monkeypatch.setattr(vault, 'replace_durable_credential', rotate)
        # Another task changes the row after this task's conditional rotation, before it caches its token.
        if change == 'revoke':
            vault.delete_durable_credential(account, provider)
        else:
            vault.store_durable_credential(account, provider, json.dumps({**SIGN_IN, 'refreshToken': 'rt_new'}))
        return written

    monkeypatch.setattr(vault, 'replace_durable_credential', rotate_then_change)
    openai = FakeOpenAI()
    client = _client(vault, openai)
    # The first call already minted its token; subsequent calls must see the changed row.
    assert client.get('/openai/v1/models', headers=_turn()).status_code == 200

    response = client.get('/openai/v1/models', headers=_turn())

    if change == 'revoke':
        assert response.status_code == 401
        assert response.json()['error']['code'] == 'PLAN_USAGE_REVOKED'
        assert len(openai.api_calls()) == 1
    else:
        assert response.status_code == 200
        assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_new']]
        assert [call.headers['authorization'] for call in openai.api_calls()] == ['Bearer at_1', 'Bearer at_2']


def test_the_query_reaches_openai_as_sent(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()

    _client(vault, openai).get('/openai/v1/models?client_version=0.153.0', headers=_turn())

    [call] = openai.api_calls()
    assert str(call.url) == 'https://api.openai.com/v1/models?client_version=0.153.0'


def test_a_turn_relays_only_for_its_own_account(vault: DynamoDbCredentialVault) -> None:
    _stored(vault, 'acct-2')
    openai = FakeOpenAI()

    response = _client(vault, openai).get('/openai/v1/models', headers=_turn('acct-1'))

    assert response.status_code == 401
    assert openai.requests == []


def test_two_concurrent_refreshes_settle_on_one_rotated_refresh_token(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    app = _app(vault, openai)

    async def both() -> list[httpx.Response]:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://service') as client:
            return list(await asyncio.gather(
                client.get('/openai/v1/models', headers=_turn(session_id='thread-1')),
                client.get('/openai/v1/models', headers=_turn(session_id='thread-2')),
            ))

    responses = asyncio.run(both())

    assert [response.status_code for response in responses] == [200, 200]
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first']]
    assert [call.headers['authorization'] for call in openai.api_calls()] == ['Bearer at_1', 'Bearer at_1']
    assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_second'


def test_a_refresh_whose_write_back_loses_fails_loud_and_keeps_the_credential_another_write_stored(
    vault: DynamoDbCredentialVault,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    new_sign_in = {**SIGN_IN, 'refreshToken': 'rt_from_a_new_sign_in'}
    def replace_sign_in() -> None:
        vault.store_durable_credential('acct-1', 'openai', json.dumps(new_sign_in))

    openai.during_refresh = replace_sign_in

    response = _client(vault, openai).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 503
    assert response.json() == _plan_usage_error(
        'PLAN_USAGE_UNAVAILABLE', UNAVAILABLE.format(cause='another write replaced the ChatGPT credential during its refresh'),
    )
    assert openai.api_calls() == []
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == new_sign_in


def _apps_sharing(vault: DynamoDbCredentialVault, openai: FakeOpenAI) -> list[FastAPI]:
    """Two Credential Service tasks: their own processes and caches, one Vault and one OpenAI."""
    return [_app(vault, openai), _app(vault, openai)]


def _models_from_each(apps: list[FastAPI]) -> list[httpx.Response]:
    async def each() -> list[httpx.Response]:
        clients = [httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://service') for app in apps]
        try:
            return list(await asyncio.gather(*(
                client.get('/openai/v1/models', headers=_turn(session_id=f'thread-{index}'))
                for index, client in enumerate(clients)
            )))
        finally:
            for client in clients:
                await client.aclose()

    return asyncio.run(each())


@pytest.fixture
def frequent_thread_switches() -> Iterator[None]:
    """Switch threads every microsecond, so a race between the tasks' Vault threads surfaces on every run."""
    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        yield
    finally:
        sys.setswitchinterval(interval)


@pytest.mark.usefixtures('frequent_thread_switches')
def test_two_tasks_refreshing_at_once_refresh_one_after_another_and_never_reuse_a_refresh_token(
    vault: DynamoDbCredentialVault,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    openai.refresh_seconds = 0.3

    responses = _models_from_each(_apps_sharing(vault, openai))

    assert [response.status_code for response in responses] == [200, 200]
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_second']]
    assert sorted(call.headers['authorization'] for call in openai.api_calls()) == ['Bearer at_1', 'Bearer at_2']
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == {**SIGN_IN, 'refreshToken': 'rt_third'}


@pytest.mark.parametrize('write_back', ['kms', 'dynamodb', 'dynamodb_response'])
@pytest.mark.parametrize('cancel_request', [False, True])
def test_two_tasks_do_not_spend_the_same_refresh_token_during_slow_write_back(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, write_back: str, cancel_request: bool,
) -> None:
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.5)
    monkeypatch.setattr(openai_module, '_LEASE_POLL_SECONDS', 0.005)
    _stored(vault)
    entered, release = Event(), Event()
    generate = vault.kms.generate_data_key

    def slow_generate(context: dict[str, str]) -> tuple[bytes, bytes]:
        monkeypatch.setattr(vault.kms, 'generate_data_key', generate)
        entered.set()
        if not release.wait(2):
            raise TimeoutError('test did not release KMS write-back')
        return generate(context)

    def slow_put(**kwargs: Any) -> Mapping[str, Any]:
        monkeypatch.setattr(vault.table, 'put_item', put)
        response = put(**kwargs) if write_back == 'dynamodb_response' else None
        entered.set()
        if not release.wait(2):
            raise TimeoutError('test did not release DynamoDB write-back')
        return response if response is not None else put(**kwargs)

    put = vault.table.put_item
    if write_back == 'kms':
        monkeypatch.setattr(vault.kms, 'generate_data_key', slow_generate)
    else:
        monkeypatch.setattr(vault.table, 'put_item', slow_put)

    clock = RealClock()
    openai = FakeOpenAI()
    apps = [_app(vault, openai, clock=clock), _app(vault, openai, clock=clock)]

    async def requests() -> list[httpx.Response | BaseException]:
        async with (
            httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[0]), base_url='http://service') as first,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[1]), base_url='http://service') as second,
        ):
            initial = asyncio.create_task(first.get('/openai/v1/models', headers=_turn()))
            assert await asyncio.to_thread(entered.wait, 1)
            if cancel_request:
                initial.cancel()
            # Persistence has the rotated credential while the original lease expires.
            await asyncio.sleep(0.75)
            waiting = asyncio.create_task(second.get('/openai/v1/models', headers=_turn()))
            await asyncio.sleep(0.2)
            release.set()
            return list(await asyncio.gather(initial, waiting, return_exceptions=True))

    responses = asyncio.run(requests())
    if cancel_request:
        assert isinstance(responses[0], asyncio.CancelledError)
    else:
        assert isinstance(responses[0], httpx.Response)
        assert responses[0].status_code == 200
    assert isinstance(responses[1], httpx.Response)
    assert responses[1].status_code == 200
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_second']]
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == {**SIGN_IN, 'refreshToken': 'rt_third'}


def test_a_refresh_slower_than_the_first_lease_is_kept_alive_by_its_renewals(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.3)
    _stored(vault)
    openai = FakeOpenAI()
    # OpenAI spends the refresh token, then answers after the first lease would have expired.
    openai.refresh_seconds = 0.5

    response = _client(vault, openai, clock=RealClock()).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 200
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == {**SIGN_IN, 'refreshToken': 'rt_second'}


def test_a_write_back_the_sdk_resends_after_it_landed_keeps_the_rotated_refresh_token(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stored(vault)
    put = vault.table.put_item

    def resent_put(**kwargs: Any) -> Mapping[str, Any]:
        monkeypatch.setattr(vault.table, 'put_item', put)
        # The write lands but its answer is lost, so the SDK resends the same request.
        put(**kwargs)
        return put(**kwargs)

    monkeypatch.setattr(vault.table, 'put_item', resent_put)
    openai = FakeOpenAI()

    client = _client(vault, openai)
    response = client.get('/openai/v1/models', headers=_turn())

    assert response.status_code == 503
    assert response.json()['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
    assert openai.api_calls() == []
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first']]
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == {**SIGN_IN, 'refreshToken': 'rt_second'}

    recovered = client.get('/openai/v1/models', headers=_turn())
    assert recovered.status_code == 200
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first'], ['rt_second']]


def test_a_stale_holder_cannot_renew_after_another_holders_lease_expires(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    revision = vault.load_credential_revision('acct-1', 'openai')
    vault.take_refresh_lease('acct-1', 'openai', revision=revision, lease='A', now=0, expires_at=30)
    vault.take_refresh_lease('acct-1', 'openai', revision=revision, lease='B', now=31, expires_at=61)

    with pytest.raises(RotationLost):
        vault.renew_refresh_lease('acct-1', 'openai', revision=revision, lease='A', expires_at=92)

    item = vault.table.get_item(Key={'accountId': 'acct-1', 'provider': 'openai'}).get('Item')
    assert item is not None
    assert item['refreshLease'] == 'B'
    assert item['refreshLeaseExpiresAt'] == 61


def _lease(vault: DynamoDbCredentialVault, expires_at: float) -> None:
    """Another task's refresh lease on the account's OpenAI item."""
    vault.table.update_item(
        Key={'accountId': 'acct-1', 'provider': 'openai'},
        UpdateExpression='SET refreshLease = :lease, refreshLeaseExpiresAt = :expires',
        ExpressionAttributeValues={':lease': 'another-task', ':expires': Decimal(str(expires_at))},
    )


def test_a_task_that_cannot_get_the_refresh_lease_in_time_fails_loud_without_refreshing(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(openai_module, '_LEASE_WAIT_SECONDS', 0.5)
    _stored(vault)
    clock = Clock()
    _lease(vault, clock.now + 30)
    openai = FakeOpenAI()

    response = _client(vault, openai, clock=clock).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 503
    assert response.json() == _plan_usage_error(
        'PLAN_USAGE_UNAVAILABLE', UNAVAILABLE.format(cause='another Credential Service task is still refreshing the ChatGPT credential'),
    )
    assert openai.requests == []
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN


def test_an_expired_refresh_lease_is_taken_over(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    clock = Clock()
    _lease(vault, clock.now - 1)
    openai = FakeOpenAI()

    response = _client(vault, openai, clock=clock).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 200
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first']]
    item = vault.table.get_item(Key={'accountId': 'acct-1', 'provider': 'openai'}).get('Item')
    assert item is not None
    assert 'refreshLease' not in item


@pytest.mark.parametrize('status', [429, 500, 503])
def test_a_token_endpoint_failure_that_is_not_a_refused_grant_is_the_unavailable_error(
    vault: DynamoDbCredentialVault, status: int,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    openai.refresh_status = status
    openai.refresh_error = 'server_error'

    response = _client(vault, openai).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 503
    assert response.json() == _plan_usage_error(
        'PLAN_USAGE_UNAVAILABLE', UNAVAILABLE.format(cause=f'OpenAI failed the token refresh with HTTP {status} server_error'),
    )
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN


def test_an_unreachable_token_endpoint_is_the_unavailable_error(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    openai = FakeOpenAI()

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError('connection refused', request=request)

    clock = Clock()
    provider = OpenAIProvider(
        lambda: vault, audit=CredentialAuditRecorder(clock=clock), transport=httpx.MockTransport(unreachable), clock=clock,
    )
    settings = CredentialServiceSettings(
        name='test-credential-service', invocation_secret=lambda: SECRET, account_header='X-Account-Id', session_header='X-Session-Id',
    )

    response = TestClient(create_app(settings, [provider])).get('/openai/v1/models', headers=_turn())

    assert response.status_code == 503
    assert response.json() == _plan_usage_error(
        'PLAN_USAGE_UNAVAILABLE', UNAVAILABLE.format(cause='OpenAI could not be reached for the token refresh: ConnectError'),
    )
    assert openai.requests == []


@pytest.mark.parametrize('landed', [False, True])
def test_a_transient_vault_failure_during_write_back_keeps_the_rotated_refresh_token(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, landed: bool,
) -> None:
    from botocore.exceptions import ClientError

    _stored(vault)
    put = vault.table.put_item

    def failing_put(**kwargs: Any) -> Mapping[str, Any]:
        monkeypatch.setattr(vault.table, 'put_item', put)
        # OpenAI has spent rt_first; the write either never lands or lands and answers with an error.
        if landed:
            put(**kwargs)
        raise ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'Internal server error'}}, 'PutItem')

    monkeypatch.setattr(vault.table, 'put_item', failing_put)
    openai = FakeOpenAI()

    client = TestClient(_app(vault, openai), raise_server_exceptions=False)
    response = client.get('/openai/v1/models', headers=_turn())

    assert response.status_code == 503
    assert response.json() == _plan_usage_error(
        'PLAN_USAGE_UNAVAILABLE', UNAVAILABLE.format(cause='the Vault failed to store the rotated ChatGPT credential'),
    )
    assert openai.api_calls() == []
    assert [refresh['refresh_token'] for refresh in openai.refreshes()] == [['rt_first']]
    # The Vault's AWS clients already retried, so nothing here resends: only a write that landed kept rt_second.
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == (
        {**SIGN_IN, 'refreshToken': 'rt_second'} if landed else SIGN_IN
    )


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
        time.sleep(renewal_delay)
        if renewal_fails:
            raise RotationLost('The active lease could not be renewed')
        original_renew(account_id, provider, revision=revision, lease=lease, expires_at=expires_at)

    monkeypatch.setattr(vault, 'renew_refresh_lease', renew)
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.5)
    _stored(vault)
    upstream = SlowRefresh()
    clock = RealClock()
    response = _client(vault, upstream, clock=clock).get('/openai/v1/models', headers=_turn())

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
        next_call = _client(vault, upstream, clock=clock).get('/openai/v1/models', headers=_turn())
        assert next_call.status_code == 200
        assert [refresh['refresh_token'] for refresh in upstream.refreshes()] == [['rt_first'], ['rt_second']]
        assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_third'



def test_stalled_renewal_does_not_delay_the_confirmed_lease_failure(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from concurrent.futures import ThreadPoolExecutor, wait

    consumed, http_cancelled, renewal_started, release_renewal = Event(), Event(), Event(), Event()

    class ConsumedBeforeDelay(FakeOpenAI):
        async def handle(self, request: httpx.Request) -> httpx.Response:
            if request.url == 'https://auth.openai.com/api/accounts/oauth/token':
                self.requests.append(request)
                token = parse_qs(request.content.decode())['refresh_token'][0]
                already_spent = token in self.spent
                response = self._refresh(token)
                if not already_spent:
                    consumed.set()
                    try:
                        await asyncio.sleep(2)
                    except asyncio.CancelledError:
                        http_cancelled.set()
                        raise
                return response
            return await super().handle(request)

    original_renew = vault.renew_refresh_lease
    renewal_finished = Event()
    late_failures: list[RotationLost] = []
    refused_requests: list[UpstreamRefusal] = []
    original_mint = OpenAIProvider.mint_access

    async def mint(self: OpenAIProvider, account_id: str, request_context: Mapping[str, str]) -> str:
        try:
            return await original_mint(self, account_id, request_context)
        except UpstreamRefusal as refused:
            refused_requests.append(refused)
            raise

    monkeypatch.setattr(OpenAIProvider, 'mint_access', mint)
    stalled_holder: list[str] = []

    def renew(account_id: str, provider: str, *, revision: str, lease: str, expires_at: float) -> None:
        if not stalled_holder:
            stalled_holder.append(lease)
            renewal_started.set()
            assert release_renewal.wait(5)
        try:
            original_renew(account_id, provider, revision=revision, lease=lease, expires_at=expires_at)
        except RotationLost as failed:
            late_failures.append(failed)
            raise
        finally:
            renewal_finished.set()

    monkeypatch.setattr(vault, 'renew_refresh_lease', renew)
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.5)
    _stored(vault)
    upstream = ConsumedBeforeDelay()
    clients = [_client(vault, upstream, clock=RealClock()) for _ in range(2)]
    with clients[0], clients[1], ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(clients[0].get, '/openai/v1/models', headers=_turn())
        try:
            assert consumed.wait(5)
            assert renewal_started.wait(5)
            assert http_cancelled.wait(2), 'the HTTP worker itself must obey the confirmed lease deadline'
            first_reported_before_renewal_release = bool(wait({first}, timeout=0.5).done)
            second = pool.submit(clients[1].get, '/openai/v1/models', headers=_turn())
            second_response = second.result(timeout=3)
        finally:
            release_renewal.set()
        first_response = first.result(timeout=3)
        assert renewal_finished.wait(3)
    assert first_response.status_code == 503
    assert second_response.status_code == 401
    assert first_reported_before_renewal_release, 'completed HTTP failure waits on an unbounded renewal RPC'
    assert first_response.json()['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
    assert [item['refresh_token'] for item in upstream.refreshes()] == [['rt_first'], ['rt_first']]
    assert json.loads(vault.load_durable_credential('acct-1', 'openai')) == SIGN_IN
    assert upstream.api_calls() == []
    assert len(late_failures) == 1, 'the late RPC cannot renew after the peer has taken custody'
    cause = refused_requests[0].__cause__
    assert isinstance(cause, BaseExceptionGroup)
    assert len(cause.exceptions) == 2
    assert isinstance(cause.exceptions[0], UpstreamRefusal)
    assert cause.exceptions[0].status_code == 503
    assert isinstance(cause.exceptions[0].__cause__, TimeoutError)
    assert isinstance(cause.exceptions[1], UpstreamRefusal)
    assert cause.exceptions[1].status_code == 503


def test_renewal_timeout_after_successful_rotation_is_a_classified_public_failure(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from concurrent.futures import ThreadPoolExecutor

    write_started, release_write, renewal_started, release_renewal = Event(), Event(), Event(), Event()
    replace = vault.replace_durable_credential
    renew = vault.renew_refresh_lease

    def blocked_replace(account_id: str, provider: str, value: str, *, revision: str, lease: str) -> str:
        write_started.set()
        assert release_write.wait(5)
        return replace(account_id, provider, value, revision=revision, lease=lease)

    def blocked_renew(account_id: str, provider: str, *, revision: str, lease: str, expires_at: float) -> None:
        renewal_started.set()
        assert release_renewal.wait(5)
        renew(account_id, provider, revision=revision, lease=lease, expires_at=expires_at)

    monkeypatch.setattr(vault, 'replace_durable_credential', blocked_replace)
    monkeypatch.setattr(vault, 'renew_refresh_lease', blocked_renew)
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.5)
    _stored(vault)
    upstream = FakeOpenAI()
    provider = OpenAIProvider(
        lambda: vault, audit=CredentialAuditRecorder(), transport=httpx.MockTransport(upstream.handle), clock=RealClock(),
    )
    settings = CredentialServiceSettings(
        name='test-credential-service', invocation_secret=lambda: SECRET,
        account_header='X-Account-Id', session_header='X-Session-Id', plan_usage_owner_account_id='acct-1',
    )
    with TestClient(create_app(settings, [provider]), raise_server_exceptions=False) as client, ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.get, '/openai/v1/models', headers=_turn())
        try:
            assert write_started.wait(5)
            assert renewal_started.wait(5)
            time.sleep(0.6)
            release_write.set()
            response = pending.result(timeout=2)
            stored = json.loads(vault.load_durable_credential('acct-1', 'openai'))
            assert stored == {**SIGN_IN, 'refreshToken': 'rt_second'}
            assert upstream.api_calls() == []
            assert provider._access == {}
            assert response.status_code == 503
            assert response.json()['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
            assert response.json()['error']['message'] == UNAVAILABLE.format(
                cause='the Vault did not confirm refresh lease renewal before its expiry',
            )
            release_renewal.set()
            recovered = client.get('/openai/v1/models', headers=_turn())
            assert recovered.status_code == 200
            assert [item['refresh_token'] for item in upstream.refreshes()] == [['rt_first'], ['rt_second']]
        finally:
            release_write.set()
            release_renewal.set()


@pytest.mark.parametrize('cancellations', [0, 1, 2])
def test_repeated_request_cancellation_keeps_custody_of_a_consumed_refresh(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, cancellations: int,
) -> None:
    # Cancellation must not strand a consumed Durable Credential.
    monkeypatch.setattr(openai_module, '_REFRESH_LEASE_SECONDS', 0.6)
    _stored(vault)

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
                # Renewal must retain custody after OpenAI spends the token and before it answers.
                await asyncio.sleep(1.1)
                return response

        upstream = SlowConsumedResponse()
        apps = [_app(vault, upstream, clock=RealClock()), _app(vault, upstream, clock=RealClock())]
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
            # A cancelled caller must not leave a supervisor or worker spending the old credential.
            await asyncio.sleep(1.3 if cancellations else 0)
            recovered = await second.get('/openai/v1/models', headers=_turn(session_id='recovery'))
            assert recovered.status_code == 200, recovered.text
            assert [refresh['refresh_token'] for refresh in upstream.refreshes()] == [['rt_first'], ['rt_second']]
            assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rt_third'

    asyncio.run(requests())


@pytest.mark.parametrize('cancellations', [1, 2])
def test_cancelled_refresh_propagates_a_custody_failure_with_its_cause(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, cancellations: int,
) -> None:
    _stored(vault)

    def refused(*args: Any, **kwargs: Any) -> str:
        raise RuntimeError('synthetic persistence refusal')

    monkeypatch.setattr(vault, 'replace_durable_credential', refused)

    async def request() -> None:
        consumed = asyncio.Event()
        upstream = FakeOpenAI()
        upstream.refresh_seconds = 0.15
        upstream.during_refresh = consumed.set
        provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(), transport=httpx.MockTransport(upstream.handle),
        )
        initial = asyncio.create_task(provider.mint_access('acct-1', {}))
        await asyncio.wait_for(consumed.wait(), 2)
        for _ in range(cancellations):
            initial.cancel()
            await asyncio.sleep(0)
        [failure] = await asyncio.gather(initial, return_exceptions=True)
        assert isinstance(failure, UpstreamRefusal)
        assert 'Vault failed to store the rotated ChatGPT credential' in str(failure)
        assert isinstance(failure.__cause__, RuntimeError)
        assert str(failure.__cause__) == 'synthetic persistence refusal'

    asyncio.run(request())


def _multiline_failed_response(error: Mapping[str, Any], prefix: str) -> bytes:
    """A complete recorded Response, formatted as a multiline failed SSE event."""
    first = next(line[6:] for line in (RECORDED / 'responses-stream.sse').read_bytes().splitlines()
                 if line.startswith(b'data: '))
    failed = {'type': 'response.failed', 'sequence_number': 1, 'response': {
        **json.loads(first)['response'], 'status': 'failed', 'error': error,
    }}
    return ('event: response.failed\n' + '\n'.join(
        prefix + line for line in json.dumps(failed, indent=2).splitlines()
    ) + '\n\n').encode()


@pytest.mark.parametrize('prefix', ['data: ', 'data:'])
def test_multiline_response_event_preserves_the_recorded_success_stream(
    vault: DynamoDbCredentialVault, prefix: str,
) -> None:
    """SSE joins data fields; whitespace changes no recorded event content."""
    _stored(vault)
    openai = FakeOpenAI()
    original = (RECORDED / 'responses-stream.sse').read_bytes()
    first = next(line for line in original.splitlines() if line.startswith(b'data: '))
    event = json.loads(first[6:])
    multiline = '\n'.join(prefix + line for line in json.dumps(event, indent=2).splitlines()).encode()
    wire = original.replace(first, multiline, 1)
    openai.responses = lambda: httpx.Response(200, stream=httpx.ByteStream(wire))

    response = _responses(_client(vault, openai))

    assert response.status_code == 200
    assert response.content == wire


@pytest.mark.parametrize('prefix', ['data: ', 'data:'])
@pytest.mark.parametrize(('openai_code', 'status', 'param', 'code', 'message'), PLAN_USAGE_ERRORS)
def test_multiline_failed_event_preserves_plan_usage_classification(
    vault: DynamoDbCredentialVault, prefix: str, openai_code: str, status: int,
    param: str | None, code: str, message: str,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    wire = _multiline_failed_response(
        {'code': openai_code, 'message': 'Fixture upstream refusal', 'param': param}, prefix,
    )
    openai.responses = lambda: httpx.Response(200, stream=httpx.ByteStream(wire))

    response = _responses(_client(vault, openai))

    assert response.status_code == 200
    assert b'event: error\n' in response.content
    assert _frames(response.content) == [('error', {'type': 'error', **_plan_usage_error(code, message)})]


@pytest.mark.parametrize('prefix', ['data: ', 'data:'])
def test_multiline_failed_event_preserves_the_upstream_error(
    vault: DynamoDbCredentialVault, prefix: str,
) -> None:
    _stored(vault)
    openai = FakeOpenAI()
    error = {'code': 'server_error', 'message': 'Fixture upstream failure'}
    wire = _multiline_failed_response(error, prefix)
    openai.responses = lambda: httpx.Response(200, stream=httpx.ByteStream(wire))

    response = _responses(_client(vault, openai))

    assert b'event: error\n' in response.content
    assert _frames(response.content) == [('error', {'type': 'error', 'error': error})]


def test_credential_receipt_precedes_authenticated_access_and_upstream_dispatch(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stored(vault)
    sink = ListSink()
    clock = [100.0]
    monkeypatch.setattr('botcube_credential_service.openai.time.monotonic', lambda: clock[0])
    original = OpenAIProvider.mint_access

    async def delayed_access(self: OpenAIProvider, account_id: str, request_context: Mapping[str, str]) -> str:
        clock[0] = 100.3
        return await original(self, account_id, request_context)

    monkeypatch.setattr(OpenAIProvider, 'mint_access', delayed_access)
    upstream = FakeOpenAI()
    upstream.responses = lambda: httpx.Response(200, content=(
        b'data: {"type":"response.created","response":{"id":"resp-safe"}}\n\n'
        b'data: {"type":"response.output_text.delta","item_id":"msg-safe","delta":"answer"}\n\n'
    ))
    response = _client(vault, upstream, sink=sink).post(
        '/openai/v1/responses', json={'model': 'gpt-6-astra'},
        headers={**_bound_turn('openai', 'gpt-6-astra'), 'x-botcube-run-id': 'run-safe',
                 'x-botcube-model-step-id': 'step-safe',
                 'traceparent': '00-' + 'a' * 32 + '-' + 'b' * 16 + '-01'},
    )
    assert response.status_code == 200
    [boundary] = [event for event in sink.events if event['event'] == 'credential_first_answer_boundary']
    assert boundary['status'] == 'complete'
    assert boundary['offsetsMs'] == pytest.approx({
        'receipt': 0, 'upstreamDispatch': 300, 'answerReceived': 300, 'answerEmitted': 300,
    })
