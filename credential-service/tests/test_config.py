from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
from fastapi.testclient import TestClient

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.server import CredentialServiceSettings, create_app
from botcube_credential_service.vault import DynamoDbCredentialVault
from test_openai import SECRET, _stored, _turn
from test_openai import vault as vault


def test_openai_refresh_and_relay_reach_openai(vault: DynamoDbCredentialVault) -> None:
    _stored(vault)
    requests: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == '/api/accounts/oauth/token':
            return httpx.Response(200, json={'access_token': 'access', 'refresh_token': 'rotated', 'expires_in': 300})
        return httpx.Response(200, json={'data': []})

    provider = OpenAIProvider(
        lambda: vault, audit=CredentialAuditRecorder(), transport=httpx.MockTransport(answer), clock=lambda: 0,
    )
    settings = CredentialServiceSettings('test', lambda: SECRET, plan_usage_owner_account_id='acct-1')
    with TestClient(create_app(settings, [provider])) as client:
        response = client.get('/openai/v1/models', headers=_turn())
        assert response.status_code == 200
        assert response.json() == {'data': []}

    assert str(requests[0].url) == 'https://auth.openai.com/api/accounts/oauth/token'
    assert parse_qs(requests[0].content.decode())['resource'] == ['https://api.openai.com/v1']
    assert str(requests[1].url) == 'https://api.openai.com/v1/models'
    assert requests[1].headers['authorization'] == 'Bearer access'
    assert json.loads(vault.load_durable_credential('acct-1', 'openai'))['refreshToken'] == 'rotated'
