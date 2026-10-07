from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TypedDict

_TOKEN_PREFIX = 'v1'
_DEFAULT_TTL_SECONDS = 10 * 60


class _InvocationPayload(TypedDict, total=False):
    account_id: object
    session_id: object
    expires_at: object
    scope: object
    model_provider: str
    model_id: str


@dataclass(frozen=True)
class CredentialServiceInvocation:
    account_id: str
    session_id: str
    scope: str | None = None
    model_provider: str | None = None
    model_id: str | None = None


def sign_credential_service_invocation(
    secret: str,
    account_id: str,
    session_id: str,
    *,
    scope: str | None = None,
    model_provider: str | None = None,
    model_id: str | None = None,
    now: float | None = None,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> str:
    secret = secret.strip()
    account_id = account_id.strip()
    session_id = session_id.strip()
    if not secret:
        raise ValueError('CredentialService invocation secret is required')
    if not account_id:
        raise ValueError('Account id is required')
    if not session_id:
        raise ValueError('CredentialService invocation session id is required')
    if ttl_seconds <= 0:
        raise ValueError('CredentialService invocation ttl must be positive')
    scoped = scope.strip() if scope is not None else None
    if scope is not None and not scoped:
        raise ValueError('CredentialService invocation scope must not be empty')
    issued_at = int(now if now is not None else time.time())
    body = {
        'account_id': account_id,
        'session_id': session_id,
        'expires_at': issued_at + ttl_seconds,
    }
    if scoped is not None:
        body['scope'] = scoped
    if model_provider is not None or model_id is not None:
        body['model_provider'] = _required_payload_string({'model_provider': model_provider}, 'model_provider')
        body['model_id'] = _required_payload_string({'model_id': model_id}, 'model_id')
    payload = _encode_json(body)
    return f'{_TOKEN_PREFIX}.{payload}.{_sign_payload(secret, payload)}'


def verify_credential_service_invocation(
    secret: str,
    token: str,
    *,
    now: float | None = None,
) -> CredentialServiceInvocation | None:
    try:
        prefix, payload, signature = token.strip().split('.', 2)
        if prefix != _TOKEN_PREFIX:
            return None
        if not hmac.compare_digest(signature, _sign_payload(secret, payload)):
            return None
        body = _decode_json(payload)
        account_id = _required_payload_string(body, 'account_id')
        session_id = _required_payload_string(body, 'session_id')
        scope_value = body.get('scope')
        if scope_value is not None and (not isinstance(scope_value, str) or not scope_value.strip()):
            return None
        scope = scope_value.strip() if isinstance(scope_value, str) else None
        expires_at = body.get('expires_at')
        if not isinstance(expires_at, int):
            return None
        current = int(now if now is not None else time.time())
        if expires_at < current:
            return None
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error):
        return None
    return CredentialServiceInvocation(
        account_id=account_id, session_id=session_id, scope=scope,
        model_provider=body.get('model_provider'),
        model_id=body.get('model_id'),
    )


def _sign_payload(secret: str, payload: str) -> str:
    digest = hmac.new(secret.strip().encode('utf-8'), payload.encode('ascii'), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')


def _encode_json(payload: dict[str, object]) -> str:
    raw = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _decode_json(payload: str) -> _InvocationPayload:
    padding = '=' * (-len(payload) % 4)
    value: _InvocationPayload = json.loads(base64.urlsafe_b64decode(f'{payload}{padding}'))
    if not isinstance(value, dict):
        raise ValueError('CredentialService invocation payload must be a JSON object')
    if 'model_provider' in value or 'model_id' in value:
        value['model_provider'] = _required_payload_string(value, 'model_provider')
        value['model_id'] = _required_payload_string(value, 'model_id')
    return value


def _required_payload_string(payload: Mapping[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'CredentialService invocation payload missing {key}')
    return value.strip()
