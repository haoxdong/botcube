from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import pytest
from fastapi import APIRouter, Header, HTTPException, Request, WebSocket
from fastapi.responses import Response
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse

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
        self.linked_accounts: set[str] = set()

    async def aclose(self) -> None:
        return None

    def ready(self) -> None:
        return None

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> Mapping[str, str]:
        self.calls.append(('ingest', (invocation.account_id, dict(payload))))
        return {'status': 'stored'}

    async def revoke(self, account_id: str) -> None:
        self.calls.append(('revoke', account_id))

    async def linked(self, account_id: str) -> bool:
        return account_id in self.linked_accounts

    def allows_upstream(self, method: str, path: str) -> bool:
        return (method, path) == ('GET', 'v1/items')

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request | WebSocket, path: str) -> None:
        return None

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> str:
        self.calls.append(('mint', (account_id, dict(request_context))))
        return f'access-for-{account_id}'

    async def relay(
        self, request: Request | WebSocket, path: str, access: str, *, account_id: str, request_context: Mapping[str, str],
    ) -> Response | None:
        if isinstance(request, WebSocket):
            self.calls.append(('relay', ('websocket', path, access, account_id)))
            await request.accept()
            await request.send_text(f'{await request.receive_text()} with {access}')
            await request.close()
            return None
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
        plan_usage_owner_account_id=owner,
    )
    return TestClient(create_app(settings, providers))


def _bearer(account_id: str = 'acct-1', session_id: str = 'run-1', scope: str | None = None) -> dict[str, str]:
    return {'Authorization': f'Bearer {sign_credential_service_invocation(SECRET, account_id, session_id, scope=scope)}'}


def test_non_ascii_bearer_signature_is_unauthorized_without_calling_the_provider() -> None:
    provider = FakeProvider()
    settings = CredentialServiceSettings(name='test-credential-service', invocation_secret=lambda: SECRET)
    client = TestClient(create_app(settings, [provider]), raise_server_exceptions=False)

    response = client.get('/site/v1/items', headers=[(b'authorization', b'Bearer v1.e30.\xe9')])

    assert response.status_code == 401
    assert response.json() == {'detail': 'Invalid Credential Service invocation token'}
    assert provider.calls == []


def test_an_allowed_upstream_call_is_relayed_with_access_minted_for_the_invoking_account() -> None:
    provider = FakeProvider()

    response = _client(provider).get('/site/v1/items', headers={**_bearer(), 'X-BotCube-Session-Id': 'run-1'})

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
        response = _client(provider).post('/site/v1/items?q=secret', headers={**_bearer(), 'X-BotCube-Session-Id': 'run-1'})

    assert response.status_code == 403
    assert response.json() == {'detail': {
        'code': 'gateway_refused',
        'message': 'Credential Service only allows site reads',
    }}
    assert provider.calls == []
    assert caplog.messages == ['Credential Service refused upstream POST v1/items']


def test_a_relay_needs_the_session_its_invocation_token_names() -> None:
    provider = FakeProvider()

    response = _client(provider).get('/site/v1/items', headers={**_bearer(), 'X-BotCube-Session-Id': 'run-2'})

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
    mismatched = client.post('/account/revoke', headers={**_bearer(scope='credential_revocation'), 'X-BotCube-Account-Id': 'acct-2'})
    revoked = client.post('/account/revoke', headers=_bearer(scope='credential_revocation'))

    assert (refused.status_code, mismatched.status_code) == (401, 401)
    assert refused.json() == {'detail': 'This call requires a credential_revocation-scoped Credential Service invocation token'}
    assert revoked.json() == {'status': 'revoked'}
    assert site.calls == [('revoke', 'acct-1')]
    assert plan.calls == [('revoke', 'acct-1')]


def test_linked_accounts_lists_the_providers_holding_the_accounts_linked_account_under_its_own_scope() -> None:
    site, other, plan = FakeProvider('site'), FakeProvider('other'), FakeProvider('plan')
    site.linked_accounts.add('acct-1')
    other.linked_accounts.add('acct-2')
    client = _client(site, other, plan)

    refused = client.post('/account/linked-accounts', headers=_bearer(scope='credential_revocation'))
    listed = client.post('/account/linked-accounts', headers=_bearer(scope='linked_accounts'))

    assert refused.json() == {'detail': 'This call requires a linked_accounts-scoped Credential Service invocation token'}
    assert listed.json() == {'linkedAccounts': ['site']}
    assert site.calls == other.calls == plan.calls == []


def test_provider_authorization_runs_before_any_access_is_minted() -> None:
    class RefusingProvider(FakeProvider):
        async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request | WebSocket, path: str) -> None:
            raise HTTPException(status_code=403, detail='Invocation cannot perform this upstream request')

    provider = RefusingProvider()
    response = _client(provider).get('/site/v1/items', headers={**_bearer(), 'X-BotCube-Session-Id': 'run-1'})

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


def test_shutdown_closes_every_provider_even_after_failure() -> None:
    closed: list[str] = []

    class ClosingProvider(FakeProvider):
        async def aclose(self) -> None:
            closed.append(self.name)
            if self.name == 'broken':
                raise RuntimeError('shutdown failed')

    app = create_app(CredentialServiceSettings('test', lambda: SECRET), [ClosingProvider('first'), ClosingProvider('broken')])
    with pytest.raises(RuntimeError, match='shutdown failed'), TestClient(app):
        pass
    assert closed == ['broken', 'first']


@pytest.mark.parametrize('method', ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'PROPFIND'])
def test_relay_accepts_any_method_without_a_transport_allowlist(method: str) -> None:
    class PassthroughProvider(FakeProvider):
        def allows_upstream(self, method: str, path: str) -> bool:
            return True

    provider = PassthroughProvider()
    response = _client(provider).request(method, '/site/arbitrary/action',
                                         headers={**_bearer(), 'X-BotCube-Session-Id': 'run-1'})

    assert response.status_code == 200
    assert provider.calls[-1] == ('relay', (method, 'arbitrary/action', 'access-for-acct-1', 'acct-1'))


def test_a_websocket_upgrade_on_the_relay_route_round_trips_through_the_provider_with_minted_access() -> None:
    provider = FakeProvider()

    with _client(provider).websocket_connect('/site/v1/items', headers={**_bearer(), 'X-BotCube-Session-Id': 'run-1'}) as socket:
        socket.send_text('hello')
        assert socket.receive_text() == 'hello with access-for-acct-1'

    assert provider.calls == [
        ('mint', ('acct-1', {'sessionId': 'run-1', 'method': 'GET', 'path': 'v1/items'})),
        ('relay', ('websocket', 'v1/items', 'access-for-acct-1', 'acct-1')),
    ]


@pytest.mark.parametrize(('session_id', 'path', 'status'), [('run-2', 'v1/items', 401), ('run-1', 'v1/other', 403)])
def test_a_websocket_upgrade_runs_the_relay_checks_before_any_access_is_minted(session_id: str, path: str, status: int) -> None:
    provider = FakeProvider()

    with pytest.raises(WebSocketDenialResponse) as denied, _client(provider).websocket_connect(
        f'/site/{path}', headers={**_bearer(), 'X-BotCube-Session-Id': session_id},
    ):
        pass

    assert denied.value.status_code == status
    assert provider.calls == []
