from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import pytest
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response
from fastapi.testclient import TestClient

from botcube_credential_service.invocation import (
    CredentialServiceInvocation,
    sign_credential_service_invocation,
)
from botcube_credential_service.server import (
    CredentialServiceSettings,
    InvocationGuard,
    create_app,
)

SECRET = 'credential-service-secret'


class FakeProvider:
    """A site provider whose access is a string minted from the account id."""

    upstream_scope = 'site reads'

    def __init__(self, name: str = 'site', *, owner_only: bool = False) -> None:
        self.name = name
        self.owner_only = owner_only
        self.calls: list[tuple[str, object]] = []

    def ready(self) -> None:
        return None

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> Mapping[str, str]:
        self.calls.append(('ingest', (invocation.account_id, dict(payload))))
        return {'status': 'stored'}

    async def revoke(self, account_id: str) -> None:
        self.calls.append(('revoke', account_id))

    def allows_upstream(self, method: str, path: str) -> bool:
        return (method, path) == ('GET', 'v1/items')

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request, path: str) -> None:
        return None

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> str:
        self.calls.append(('mint', (account_id, dict(request_context))))
        return f'access-for-{account_id}'

    async def relay(
        self, request: Request, path: str, access: str, *, account_id: str, request_context: Mapping[str, str],
    ) -> Response:
        self.calls.append(('relay', (request.method, path, access, account_id)))
        return Response(content=b'relayed', status_code=200)

    def routes(self, guard: InvocationGuard) -> APIRouter:
        router = APIRouter()

        @router.get('/extra')
        def extra(authorization: str | None = Header(None)) -> dict[str, str]:
            return {'account': guard.verify(authorization).account_id}

        return router


def _client(*providers: FakeProvider, owner: str = '') -> TestClient:
    settings = CredentialServiceSettings(
        name='test-credential-service',
        invocation_secret=lambda: SECRET,
        account_header='X-Account-Id',
        session_header='X-Session-Id',
        plan_usage_owner_account_id=owner,
    )
    return TestClient(create_app(settings, providers))


def _bearer(account_id: str = 'acct-1', session_id: str = 'run-1', scope: str | None = None) -> dict[str, str]:
    return {'Authorization': f'Bearer {sign_credential_service_invocation(SECRET, account_id, session_id, scope=scope)}'}


def test_an_allowed_upstream_call_is_relayed_with_access_minted_for_the_invoking_account() -> None:
    provider = FakeProvider()

    response = _client(provider).get('/site/v1/items', headers={**_bearer(), 'X-Session-Id': 'run-1'})

    assert response.status_code == 200
    assert response.content == b'relayed'
    assert provider.calls == [
        ('mint', ('acct-1', {'sessionId': 'run-1', 'method': 'GET', 'path': 'v1/items'})),
        ('relay', ('GET', 'v1/items', 'access-for-acct-1', 'acct-1')),
    ]


def test_an_upstream_call_the_provider_does_not_allow_is_refused_before_any_access_is_minted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider = FakeProvider()

    with caplog.at_level(logging.WARNING, logger='botcube_credential_service.server'):
        response = _client(provider).post('/site/v1/items?q=secret', headers={**_bearer(), 'X-Session-Id': 'run-1'})

    assert response.status_code == 403
    assert response.json() == {'detail': 'Credential Service only allows site reads'}
    assert provider.calls == []
    assert caplog.messages == ['Credential Service refused upstream POST v1/items']


def test_a_relay_needs_the_session_its_invocation_token_names() -> None:
    provider = FakeProvider()

    response = _client(provider).get('/site/v1/items', headers={**_bearer(), 'X-Session-Id': 'run-2'})

    assert response.status_code == 401
    assert provider.calls == []


def test_ingest_and_revoke_reach_the_provider_only_under_their_own_scopes() -> None:
    provider = FakeProvider()
    client = _client(provider)

    refused = client.post('/site/auth/link/ingest', json={'durable': 'x'}, headers=_bearer(scope='credential_revocation'))
    stored = client.post('/site/auth/link/ingest', json={'durable': 'x'}, headers=_bearer(scope='credential_capture'))
    revoked = client.post('/site/auth/link/revoke', headers=_bearer(scope='credential_revocation'))

    assert refused.status_code == 401
    assert refused.json() == {'detail': 'This call requires a credential_capture-scoped Credential Service invocation token'}
    assert stored.json() == {'status': 'stored'}
    assert revoked.json() == {'status': 'revoked'}
    assert provider.calls == [('ingest', ('acct-1', {'durable': 'x'})), ('revoke', 'acct-1')]


def test_a_provider_routes_are_served_under_its_name() -> None:
    response = _client(FakeProvider()).get('/site/extra', headers=_bearer())

    assert response.json() == {'account': 'acct-1'}


def test_revoking_an_account_revokes_it_at_every_provider() -> None:
    site, plan = FakeProvider('site'), FakeProvider('plan')
    client = _client(site, plan)

    refused = client.post('/account/revoke', headers=_bearer(scope='credential_capture'))
    mismatched = client.post('/account/revoke', headers={**_bearer(scope='credential_revocation'), 'X-Account-Id': 'acct-2'})
    revoked = client.post('/account/revoke', headers=_bearer(scope='credential_revocation'))

    assert (refused.status_code, mismatched.status_code) == (401, 401)
    assert refused.json() == {'detail': 'This call requires a credential_revocation-scoped Credential Service invocation token'}
    assert revoked.json() == {'status': 'revoked'}
    assert site.calls == [('revoke', 'acct-1')]
    assert plan.calls == [('revoke', 'acct-1')]


def test_provider_authorization_runs_before_any_access_is_minted() -> None:
    class RefusingProvider(FakeProvider):
        async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request, path: str) -> None:
            raise HTTPException(status_code=403, detail='Invocation cannot perform this upstream request')

    provider = RefusingProvider()
    response = _client(provider).get('/site/v1/items', headers={**_bearer(), 'X-Session-Id': 'run-1'})

    assert response.status_code == 403
    assert provider.calls == []


def test_an_owner_only_provider_ingests_only_for_the_owner_whatever_its_name() -> None:
    provider = FakeProvider('site', owner_only=True)
    client = _client(provider, owner='owner')

    refused = client.post('/site/auth/link/ingest', json={'durable': 'x'}, headers=_bearer('acct-1', scope='credential_capture'))
    stored = client.post('/site/auth/link/ingest', json={'durable': 'x'}, headers=_bearer('owner', scope='credential_capture'))

    assert refused.status_code == 403
    assert stored.json() == {'status': 'stored'}
    assert provider.calls == [('ingest', ('owner', {'durable': 'x'}))]


def test_a_provider_that_is_not_owner_only_needs_no_owner_whatever_its_name() -> None:
    provider = FakeProvider('openai')

    response = _client(provider).post('/openai/auth/link/ingest', json={'durable': 'x'}, headers=_bearer(scope='credential_capture'))

    assert response.json() == {'status': 'stored'}
