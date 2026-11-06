from __future__ import annotations

import pytest

from botcube_credential_service.config import OpenAISettings, positive_seconds


def test_openai_defaults() -> None:
    settings = OpenAISettings.from_env()
    assert settings.issuer == 'https://auth.openai.com'
    assert settings.resource == 'https://api.openai.com/v1'
    assert settings.api_origin == 'https://api.openai.com'
    assert settings.dynamic_client_id == 'dynamic_agent_client'
    assert settings.token_url == 'https://auth.openai.com/api/accounts/oauth/token'


def test_openai_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_OPENAI_ISSUER', 'https://auth.example.com/')
    monkeypatch.setenv('BOTCUBE_OPENAI_RESOURCE', 'https://api.example.com/v1')
    monkeypatch.setenv('BOTCUBE_OPENAI_API_ORIGIN', 'https://api.example.com')
    monkeypatch.setenv('BOTCUBE_OPENAI_DYNAMIC_CLIENT_ID', 'corporate-client')
    settings = OpenAISettings.from_env()
    assert settings.token_url == 'https://auth.example.com/api/accounts/oauth/token'
    assert settings.resource == 'https://api.example.com/v1'
    assert settings.api_origin == 'https://api.example.com'
    assert settings.dynamic_client_id == 'corporate-client'


@pytest.mark.parametrize('value', ['http://auth.example.com', 'https://a:b@auth.example.com',
                                   'https://auth.example.com/path', 'https://auth.example.com?q=1', ''])
def test_issuer_rejects_unsafe_urls(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv('BOTCUBE_OPENAI_ISSUER', value)
    with pytest.raises(ValueError, match='BOTCUBE_OPENAI_ISSUER'):
        OpenAISettings.from_env()


@pytest.mark.parametrize('value', ['0', '-1', 'nan', 'inf', 'invalid'])
def test_timeouts_reject_invalid_values(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv('BOTCUBE_OPENAI_READ_TIMEOUT_SECONDS', value)
    with pytest.raises(ValueError):
        positive_seconds('BOTCUBE_OPENAI_READ_TIMEOUT_SECONDS', 300)


def test_timeout_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_OPENAI_READ_TIMEOUT_SECONDS', '12.5')
    assert positive_seconds('BOTCUBE_OPENAI_READ_TIMEOUT_SECONDS', 300) == 12.5


def test_configured_openai_refresh_and_relay(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    from typing import NoReturn
    from urllib.parse import parse_qs

    import httpx
    from fastapi import Request
    from fastapi.responses import StreamingResponse

    from botcube_credential_service.audit import CredentialAuditRecorder
    from botcube_credential_service.openai import OpenAIProvider, _RefreshLease

    monkeypatch.setenv('BOTCUBE_OPENAI_ISSUER', 'https://auth.example.com')
    monkeypatch.setenv('BOTCUBE_OPENAI_RESOURCE', 'https://api.example.com/v1')
    monkeypatch.setenv('BOTCUBE_OPENAI_API_ORIGIN', 'https://api.example.com')
    requests: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == '/api/accounts/oauth/token':
            return httpx.Response(200, json={'access_token': 'access', 'refresh_token': 'rotated', 'expires_in': 300})
        return httpx.Response(200, json={'data': []})

    def unused_vault() -> NoReturn:
        raise AssertionError('the transport test must not read the Vault')

    provider = OpenAIProvider(
        unused_vault, audit=CredentialAuditRecorder(), transport=httpx.MockTransport(answer), clock=lambda: 0,
    )

    async def run() -> None:
        tokens = await provider._token_refresh({'clientId': 'client', 'refreshToken': 'refresh'}, _RefreshLease(30))
        assert tokens['access_token'] == 'access'
        request = Request({'type': 'http', 'method': 'GET', 'path': '/openai/v1/models',
                           'query_string': b'', 'headers': []})
        request._body = b''
        response = await provider.relay(request, 'v1/models', 'access', account_id='account', request_context={})
        assert response.status_code == 200
        assert isinstance(response, StreamingResponse)
        chunks = [chunk async for chunk in response.body_iterator]
        assert chunks == [b'{"data":[]}']

    asyncio.run(run())
    assert str(requests[0].url) == 'https://auth.example.com/api/accounts/oauth/token'
    assert parse_qs(requests[0].content.decode())['resource'] == ['https://api.example.com/v1']
    assert str(requests[1].url) == 'https://api.example.com/v1/models'
    assert requests[1].headers['authorization'] == 'Bearer access'
