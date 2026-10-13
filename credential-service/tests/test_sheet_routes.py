from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

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
    SheetEntryRefused,
    SheetKey,
    sheet_routes,
)

SECRET = 'credential-service-secret'
KEY = SheetKey()


class Page:
    async def send(self, method: str, params: object) -> dict[str, object]:
        return {}


def _client(typed: list[tuple[str, str, str]], fails: Exception | None = None) -> TestClient:
    @asynccontextmanager
    async def open_page(browser_session_id: str) -> AsyncIterator[CdpPage]:
        typed.append(('open', browser_session_id, ''))
        yield Page()

    async def type_credentials(page: CdpPage, username: str, password: str) -> None:
        if fails is not None:
            raise fails
        typed.append(('type', username, password))

    app = FastAPI()
    app.include_router(sheet_routes(
        InvocationGuard(lambda: SECRET), account_header='X-Account', key=lambda: KEY,
        open_page=open_page, type_credentials=type_credentials,
    ))
    return TestClient(app)


def _sealed(credentials: object, key: SheetKey = KEY) -> str:
    public = serialization.load_der_public_key(base64.b64decode(key.public_key()))
    assert isinstance(public, rsa.RSAPublicKey)
    return base64.b64encode(public.encrypt(
        json.dumps(credentials).encode(),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )).decode()


def _headers(scope: str | None = CREDENTIAL_CAPTURE_SCOPE) -> dict[str, str]:
    token = sign_credential_service_invocation(SECRET, 'acct-1', 'run-1', scope=scope)
    return {'Authorization': f'Bearer {token}', 'X-Account': 'acct-1'}


def test_the_sheet_publishes_its_key_and_types_what_was_sealed_to_it_into_the_named_page() -> None:
    typed: list[tuple[str, str, str]] = []
    client = _client(typed)

    published = client.get('/auth/sheet/public-key').json()
    response = client.post('/auth/sheet/type', headers=_headers(), json={
        'browserSessionId': ' browser-1 ', 'credentials': _sealed({'username': 'person', 'password': 'secret'}),
    })

    assert published == {'algorithm': 'RSA-OAEP-256', 'publicKey': KEY.public_key()}
    assert (response.status_code, response.json()) == (200, {'status': 'typed'})
    assert typed == [('open', 'browser-1', ''), ('type', 'person', 'secret')]


def test_typing_needs_a_capture_scoped_invocation_for_the_named_account() -> None:
    typed: list[tuple[str, str, str]] = []
    body = {'browserSessionId': 'browser-1', 'credentials': _sealed({'username': 'person', 'password': 'secret'})}

    unscoped = _client(typed).post('/auth/sheet/type', headers=_headers(None), json=body)
    other_account = _client(typed).post(
        '/auth/sheet/type', headers={**_headers(), 'X-Account': 'acct-2'}, json=body,
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


@pytest.mark.parametrize(('body', 'detail'), [
    ({'credentials': 'sealed'}, 'browserSessionId is required'),
    ({'browserSessionId': '  ', 'credentials': 'sealed'}, 'browserSessionId is required'),
    ({'browserSessionId': 7, 'credentials': 'sealed'}, 'browserSessionId is required'),
    ({'browserSessionId': 'browser-1', 'credentials': '  '}, 'credentials is required'),
    ({'browserSessionId': 'browser-1', 'credentials': base64.b64encode(b'{"username":"a","password":"b"}').decode()}, _NOT_SEALED),
    ({'browserSessionId': 'browser-1', 'credentials': _sealed({'username': 'a', 'password': 'b'}, SheetKey())}, _NOT_SEALED),
    ({'browserSessionId': 'browser-1', 'credentials': f'{_SEALED[:8]}*{_SEALED[8:]}'}, _NOT_SEALED),
    *(({'browserSessionId': 'browser-1', 'credentials': _sealed(credentials)}, _INCOMPLETE) for credentials in (
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
        'browserSessionId': 'browser-1', 'credentials': _sealed({'username': 'person', 'password': 'secret'}),
    })

    assert (response.status_code, response.json()['detail']) == (status, detail)
    assert 'secret' not in caplog.text

