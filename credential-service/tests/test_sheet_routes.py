from __future__ import annotations

import base64
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from botcube_credential_service.invocation import sign_credential_service_invocation
from botcube_credential_service.server import CREDENTIAL_CAPTURE_SCOPE, InvocationGuard
from botcube_credential_service.sign_in import (
    CdpError,
    CdpPage,
    KmsSheetKey,
    SheetEntryRefused,
    SheetKey,
    sheet_routes,
)
from kms_stand_in import REGION_ACCOUNT, KmsStandIn

SECRET = 'credential-service-secret'
KEY = SheetKey()


class Page:
    async def send(self, method: str, params: object) -> dict[str, object]:
        return {}


def _client(typed: list[tuple[str, str, str]], fails: Exception | None = None, key: SheetKey = KEY) -> TestClient:
    @asynccontextmanager
    async def open_page(browser_session_id: str) -> AsyncGenerator[CdpPage, None]:
        typed.append(('open', browser_session_id, ''))
        yield Page()

    async def type_credentials(page: CdpPage, username: str, password: str) -> None:
        if fails is not None:
            raise fails
        typed.append(('type', username, password))

    app = FastAPI()
    app.include_router(sheet_routes(
        InvocationGuard(lambda: SECRET), key=lambda: key,
        open_page=open_page, type_credentials=type_credentials,
    ))
    return TestClient(app)


def _sealed(credentials: object, key: SheetKey = KEY) -> str:
    return _seal_to(key.public_key().public_key, credentials)


def _seal_to(public_key: str, credentials: object) -> str:
    public = serialization.load_der_public_key(base64.b64decode(public_key))
    assert isinstance(public, rsa.RSAPublicKey)
    return base64.b64encode(public.encrypt(
        json.dumps(credentials).encode(),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )).decode()


def _headers(scope: str | None = CREDENTIAL_CAPTURE_SCOPE) -> dict[str, str]:
    token = sign_credential_service_invocation(SECRET, 'acct-1', 'run-1', scope=scope)
    return {'Authorization': f'Bearer {token}', 'X-BotCube-Account-Id': 'acct-1'}


def test_the_sheet_publishes_its_key_and_types_what_was_sealed_to_it_into_the_named_page() -> None:
    typed: list[tuple[str, str, str]] = []
    client = _client(typed)

    published = client.get('/auth/sheet/public-key').json()
    response = client.post('/auth/sheet/type', headers=_headers(), json={
        'browserSessionId': ' browser-1 ', 'keyId': published['keyId'],
        'credentials': _seal_to(published['publicKey'], {'username': 'person', 'password': 'secret'}),
    })

    assert published == {'algorithm': 'RSA-OAEP-256', 'keyId': KEY.public_key().key_id, 'publicKey': KEY.public_key().public_key}
    assert (response.status_code, response.json()) == (200, {'status': 'typed'})
    assert typed == [('open', 'browser-1', ''), ('type', 'person', 'secret')]


def test_typing_needs_a_capture_scoped_invocation_for_the_named_account() -> None:
    typed: list[tuple[str, str, str]] = []
    body = {'browserSessionId': 'browser-1', 'keyId': KEY_ID, 'credentials': _sealed({'username': 'person', 'password': 'secret'})}

    unscoped = _client(typed).post('/auth/sheet/type', headers=_headers(None), json=body)
    other_account = _client(typed).post(
        '/auth/sheet/type', headers={**_headers(), 'X-BotCube-Account-Id': 'acct-2'}, json=body,
    )

    assert (unscoped.status_code, other_account.status_code) == (401, 401)
    assert typed == []


_NOT_SEALED = {
    'code': 'not_encrypted_to_credential_service',
    'message': 'Credentials are not encrypted to the Credential Service',
}
_INCOMPLETE = {
    'code': 'not_encrypted_to_credential_service',
    'message': 'Sealed credentials need a username and a password',
}
_SEALED = _sealed({'username': 'person', 'password': 'secret'})
KEY_ID = KEY.public_key().key_id
_ROTATED = {
    'code': 'sheet_key_rotated',
    'message': "The Sign-in Sheet's encryption key changed while this sheet was open. Close it and open the Sign-in Sheet again to sign in.",
}


@pytest.mark.parametrize(('body', 'detail'), [
    ({'keyId': KEY_ID, 'credentials': 'sealed'}, 'browserSessionId is required'),
    ({'browserSessionId': '  ', 'keyId': KEY_ID, 'credentials': 'sealed'}, 'browserSessionId is required'),
    ({'browserSessionId': 7, 'keyId': KEY_ID, 'credentials': 'sealed'}, 'browserSessionId is required'),
    ({'browserSessionId': 'browser-1', 'keyId': KEY_ID, 'credentials': '  '}, 'credentials is required'),
    ({'browserSessionId': 'browser-1', 'keyId': KEY_ID, 'credentials': base64.b64encode(b'{"username":"a","password":"b"}').decode()}, _NOT_SEALED),
    ({'browserSessionId': 'browser-1', 'keyId': KEY_ID, 'credentials': _sealed({'username': 'a', 'password': 'b'}, SheetKey())}, _NOT_SEALED),
    ({'browserSessionId': 'browser-1', 'keyId': SheetKey().public_key().key_id, 'credentials': _SEALED}, _ROTATED),
    ({'browserSessionId': 'browser-1', 'keyId': KEY_ID, 'credentials': f'{_SEALED[:8]}*{_SEALED[8:]}'}, _NOT_SEALED),
    *(({'browserSessionId': 'browser-1', 'keyId': KEY_ID, 'credentials': _sealed(credentials)}, _INCOMPLETE) for credentials in (
        ['person', 'secret'],
        {'password': 'secret'},
        {'username': '', 'password': 'secret'},
        {'username': 7, 'password': 'secret'},
        {'username': 'person'},
        {'username': 'person', 'password': ''},
        {'username': 'person', 'password': 7},
    )),
])
def test_a_missing_field_or_unsealed_credentials_are_a_bad_request(body: dict[str, object], detail: object) -> None:
    typed: list[tuple[str, str, str]] = []

    response = _client(typed).post('/auth/sheet/type', headers=_headers(), json=body)

    assert (response.status_code, response.json()['detail']) == (400, detail)
    assert typed == []


@pytest.mark.parametrize(('failure', 'status', 'detail'), [
    (SheetEntryRefused('The field is not a password field'), 409, {
        'code': 'sheet_entry_refused', 'message': 'The field is not a password field',
    }),
    (CdpError('stream closed'), 502, 'Sign-in page could not be reached: CdpError: stream closed'),
    (TimeoutError(), 502, 'Sign-in page could not be reached: TimeoutError'),
])
def test_a_refused_entry_conflicts_and_an_unreachable_page_is_a_bad_gateway(
    failure: Exception, status: int, detail: object, caplog: pytest.LogCaptureFixture,
) -> None:
    typed: list[tuple[str, str, str]] = []

    response = _client(typed, failure).post('/auth/sheet/type', headers=_headers(), json={
        'browserSessionId': 'browser-1', 'keyId': KEY_ID, 'credentials': _sealed({'username': 'person', 'password': 'secret'}),
    })

    assert (response.status_code, response.json()['detail']) == (status, detail)
    assert 'secret' not in caplog.text


def test_a_sheet_opened_before_its_alias_moves_is_told_to_re_open_and_one_opened_after_types() -> None:
    kms = KmsStandIn()
    alias = f'{REGION_ACCOUNT}:alias/sign-in-sheet'
    old, new = kms.create_key(), kms.create_key()
    kms.point_alias(alias, old)
    typed: list[tuple[str, str, str]] = []
    client = _client(typed, key=KmsSheetKey(alias, kms))
    before = client.get('/auth/sheet/public-key').json()

    def type_sealed(key_id: str, public_key: str, password: str) -> httpx.Response:
        return client.post('/auth/sheet/type', headers=_headers(), json={
            'browserSessionId': 'browser-1', 'keyId': key_id,
            'credentials': _seal_to(public_key, {'username': 'person', 'password': password}),
        })

    kms.point_alias(alias, new)
    after = client.get('/auth/sheet/public-key').json()
    stale = type_sealed(before['keyId'], before['publicKey'], 'before')
    misnamed = type_sealed(before['keyId'], after['publicKey'], 'misnamed')
    reopened = type_sealed(after['keyId'], after['publicKey'], 'after')

    assert (before['keyId'], after['keyId']) == (old, new)
    assert [(response.status_code, response.json()) for response in (stale, misnamed, reopened)] == [
        (400, {'detail': _ROTATED}), (400, {'detail': _ROTATED}), (200, {'status': 'typed'}),
    ]
    assert typed == [('open', 'browser-1', ''), ('type', 'person', 'after')]


def test_a_sheet_from_before_key_ids_types_what_was_sealed_to_the_current_key_and_nothing_else() -> None:
    kms = KmsStandIn()
    alias = f'{REGION_ACCOUNT}:alias/sign-in-sheet'
    old, new = kms.create_key(), kms.create_key()
    kms.point_alias(alias, old)
    typed: list[tuple[str, str, str]] = []
    client = _client(typed, key=KmsSheetKey(alias, kms))
    before = client.get('/auth/sheet/public-key').json()
    kms.point_alias(alias, new)
    after = client.get('/auth/sheet/public-key').json()

    def type_without_key_id(public_key: str, password: str) -> httpx.Response:
        return client.post('/auth/sheet/type', headers=_headers(), json={
            'browserSessionId': 'browser-1', 'credentials': _seal_to(public_key, {'username': 'person', 'password': password}),
        })

    responses = [type_without_key_id(before['publicKey'], 'before'), type_without_key_id(after['publicKey'], 'after')]

    assert [(response.status_code, response.json()) for response in responses] == [
        (400, {'detail': _NOT_SEALED}), (200, {'status': 'typed'}),
    ]
    assert typed == [('open', 'browser-1', ''), ('type', 'person', 'after')]
