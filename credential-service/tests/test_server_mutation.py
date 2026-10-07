from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from botcube_credential_service.invocation import (
    CredentialServiceInvocation,
    sign_credential_service_invocation,
)
from botcube_credential_service.server import (
    CredentialServiceSettings,
    InvocationGuard,
    create_app,
    request_context,
)
from test_server import FakeProvider

SECRET = 'credential-service-secret'


def test_an_unconfigured_invocation_guard_refuses_calls_with_a_service_unavailable_error() -> None:
    with pytest.raises(HTTPException) as refused:
        InvocationGuard(lambda: ' ').verify(None)

    assert refused.value.status_code == 503
    assert refused.value.detail == 'CredentialService invocation token is not configured'


@pytest.mark.parametrize('authorization', [None, '', 'Basic not-a-token', 'Bearer invalid'])
def test_missing_or_invalid_bearer_authentication_is_a_classified_refusal(authorization: str | None) -> None:
    with pytest.raises(HTTPException) as refused:
        InvocationGuard(lambda: SECRET).verify(authorization)

    assert refused.value.status_code == 401
    assert refused.value.detail == 'Invalid Credential Service invocation token'


def test_a_capture_token_cannot_authorize_an_unscoped_upstream_call() -> None:
    token = sign_credential_service_invocation(SECRET, 'acct-1', 'run-1', scope='credential_capture')
    with pytest.raises(HTTPException) as refused:
        InvocationGuard(lambda: SECRET).verify(f'Bearer {token}')

    assert refused.value.status_code == 401
    assert refused.value.detail == 'Invalid Credential Service invocation token'


def test_a_signed_invocation_cannot_be_used_with_another_account_header() -> None:
    token = sign_credential_service_invocation(SECRET, 'acct-1', 'run-1')
    with pytest.raises(HTTPException) as refused:
        InvocationGuard(lambda: SECRET).verify_account(f'Bearer {token}', 'acct-2', None)

    assert refused.value.status_code == 401
    assert refused.value.detail == 'Invalid Credential Service invocation token'


def test_request_audit_context_preserves_scope_and_a_trailing_path_slash() -> None:
    invocation = CredentialServiceInvocation(account_id='acct-1', session_id='run-1', scope='credential_capture')

    assert request_context(invocation, 'post', '/auth/link/ingest/') == {
        'sessionId': 'run-1', 'method': 'POST', 'path': 'auth/link/ingest/', 'scope': 'credential_capture',
    }


def test_plan_usage_ingest_refuses_a_non_owner_before_the_provider_sees_the_credential() -> None:
    provider = FakeProvider('openai', owner_only=True)
    settings = CredentialServiceSettings(
        name='test-credential-service', invocation_secret=lambda: SECRET,
        account_header='X-Account-Id', session_header='X-Session-Id', plan_usage_owner_account_id='owner',
    )
    client = TestClient(create_app(settings, [provider]))
    token = sign_credential_service_invocation(SECRET, 'other-account', 'run-1', scope='credential_capture')

    response = client.post('/openai/auth/link/ingest', json={'durable': 'refresh-token'}, headers={
        'Authorization': f'Bearer {token}',
    })

    assert response.status_code == 403
    assert response.json() == {'detail': 'Plan Usage is only available to the configured owner account'}
    assert provider.calls == []
