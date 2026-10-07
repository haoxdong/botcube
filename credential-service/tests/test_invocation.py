from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest

from botcube_credential_service.invocation import (
    sign_credential_service_invocation,
    verify_credential_service_invocation,
)


def test_verify_credential_service_invocation_rejects_other_account() -> None:
    token = sign_credential_service_invocation('credential-service-secret', 'acct-1', 'run-1')

    invocation = verify_credential_service_invocation('credential-service-secret', token)

    assert invocation is not None
    assert invocation.account_id == 'acct-1'
    assert invocation.session_id == 'run-1'
    assert invocation.scope is None


def test_verify_credential_service_invocation_round_trips_scope() -> None:
    token = sign_credential_service_invocation(
        'credential-service-secret',
        'acct-1',
        'run-1',
        scope='credential_capture',
    )

    invocation = verify_credential_service_invocation('credential-service-secret', token)

    assert invocation is not None
    assert invocation.account_id == 'acct-1'
    assert invocation.session_id == 'run-1'
    assert invocation.scope == 'credential_capture'


def test_verify_credential_service_invocation_rejects_other_session() -> None:
    token = sign_credential_service_invocation('credential-service-secret', 'acct-1', 'run-1')
    other_session_prefix = sign_credential_service_invocation('credential-service-secret', 'acct-1', 'run-2').rsplit('.', 1)[0]
    signature = token.rsplit('.', 1)[1]

    tampered = f'{other_session_prefix}.{signature}'

    assert verify_credential_service_invocation('credential-service-secret', token) is not None
    assert verify_credential_service_invocation('credential-service-secret', tampered) is None


def test_verify_credential_service_invocation_rejects_expired_token() -> None:
    token = sign_credential_service_invocation('credential-service-secret', 'acct-1', 'run-1', now=100, ttl_seconds=60)

    assert verify_credential_service_invocation('credential-service-secret', token, now=160) is not None
    assert verify_credential_service_invocation('credential-service-secret', token, now=161) is None


def test_verify_credential_service_invocation_rejects_malformed_payload() -> None:
    assert verify_credential_service_invocation('credential-service-secret', 'v1.not-base64.signature') is None


def test_model_authorization_round_trips_in_the_signed_invocation() -> None:
    token = sign_credential_service_invocation(
        'credential-service-secret', 'acct-1', 'run-1', model_provider='openai', model_id='gpt-6-astra',
    )

    invocation = verify_credential_service_invocation('credential-service-secret', token)

    assert invocation is not None
    assert invocation.model_provider == 'openai'
    assert invocation.model_id == 'gpt-6-astra'


@pytest.mark.parametrize('claims', [
    {'model_provider': 'openai'}, {'model_id': 'gpt-6-astra'},
    {'model_provider': 'openai', 'model_id': ''}, {'model_provider': [], 'model_id': 'gpt-6-astra'},
])
def test_invalid_signed_model_claims_are_rejected(claims: dict[str, object]) -> None:
    secret = 'credential-service-secret'
    body = {'account_id': 'acct-1', 'session_id': 'run-1', 'expires_at': 200, **claims}
    payload = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip('=')
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()).decode().rstrip('=')

    assert verify_credential_service_invocation(secret, f'v1.{payload}.{signature}', now=100) is None


def test_model_authorization_cannot_be_changed_without_resigning() -> None:
    secret = 'credential-service-secret'
    approved = sign_credential_service_invocation(secret, 'acct-1', 'run-1', model_provider='openai', model_id='gpt-6-astra')
    other = sign_credential_service_invocation(secret, 'acct-1', 'run-1', model_provider='openai', model_id='other-model')
    payload = other.rsplit('.', 1)[0]
    signature = approved.rsplit('.', 1)[1]

    assert verify_credential_service_invocation(secret, f'{payload}.{signature}') is None


def test_signing_a_blank_account_reports_the_missing_account() -> None:
    with pytest.raises(ValueError, match='Account id is required'):
        sign_credential_service_invocation('local-test-secret', '   ', 'operator-session')
