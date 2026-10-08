from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import boto3
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from moto import mock_aws

import botcube_credential_service.openai_sign_in as sign_in
from botcube_credential_service.invocation import verify_credential_service_invocation
from botcube_credential_service.openai_sign_in import main

SECRET = 'credential-service-secret'
SECRET_ID = 'credential-service-invocation'
PLAN_USAGE_URL = 'https://chat.example/account/plan-usage/openai'
ISSUER = 'https://auth.openai.com'
FULL_PLAN_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
OPENAI_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


@dataclass
class FakeOpenAI:
    """auth.openai.com's discovery, JWKS and token endpoints, and the Chat Service's Plan Usage route."""

    signing_key: rsa.RSAPrivateKey = OPENAI_KEY
    plan_usage_status: int = 200
    authorize: dict[str, str] = field(default_factory=dict)
    token_requests: list[dict[str, str]] = field(default_factory=list)
    plan_usage_requests: list[httpx.Request] = field(default_factory=list)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f'{ISSUER}/.well-known/openid-configuration':
            return httpx.Response(200, json={'issuer': ISSUER, 'jwks_uri': f'{ISSUER}/.well-known/jwks.json'})
        if url == f'{ISSUER}/.well-known/jwks.json':
            public = json.loads(RSAAlgorithm.to_jwk(OPENAI_KEY.public_key()))
            return httpx.Response(200, json={'keys': [{**public, 'kid': 'key-1', 'alg': 'RS256', 'use': 'sig'}]})
        if url == f'{ISSUER}/api/accounts/oauth/token':
            form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            return httpx.Response(200, json=self._tokens(form))
        if url == PLAN_USAGE_URL:
            self.plan_usage_requests.append(request)
            if request.method == 'DELETE':
                return httpx.Response(self.plan_usage_status, json={'status': 'removed'})
            return httpx.Response(self.plan_usage_status, json={'status': 'stored', 'subject': 'user-AbC123'})
        return httpx.Response(404)

    def _tokens(self, form: dict[str, str]) -> dict[str, Any]:
        challenge = base64.urlsafe_b64encode(hashlib.sha256(form['code_verifier'].encode()).digest()).rstrip(b'=')
        assert challenge.decode() == self.authorize['code_challenge']
        claims = {
            'iss': ISSUER,
            'aud': [form['client_id']],
            'sub': 'user-AbC123',
            'nonce': self.authorize['nonce'],
            'exp': int(time.time()) + 3600,
        }
        id_token = jwt.encode(claims, self.signing_key, algorithm='RS256', headers={'kid': 'key-1'})
        return {
            'id_token': id_token,
            'access_token': 'at_first',
            'refresh_token': 'rt_first',
            'scope': FULL_PLAN_SCOPES,
            'expires_in': 3600,
        }

    def browser(self, url: str) -> None:
        """The owner signing in: OpenAI redirects to the loopback callback with a code and the client it registered."""
        self.authorize = {key: values[0] for key, values in parse_qs(urlsplit(url).query).items()}
        callback = httpx.URL(self.authorize['redirect_uri'], params={
            'code': 'auth-code-1', 'state': self.authorize['state'], 'client_id': 'app_dyn_1',
        })
        threading.Thread(target=httpx.get, args=(callback,), daemon=True).start()


@pytest.fixture
def secret() -> Iterator[None]:
    with mock_aws():
        boto3.client('secretsmanager', region_name='us-east-1').create_secret(Name=SECRET_ID, SecretString=SECRET)
        yield


def _run(openai: FakeOpenAI, *args: str) -> int:
    return main(
        ['--account', 'acct_owner123', '--url', PLAN_USAGE_URL, '--secret-id', SECRET_ID, '--region', 'us-east-1', *args],
        http=httpx.Client(transport=httpx.MockTransport(openai.handle)),
        open_browser=openai.browser,
        port=0,
    )


def _invocation(request: httpx.Request) -> tuple[str, str | None]:
    token = request.headers['authorization'].removeprefix('Bearer ')
    invocation = verify_credential_service_invocation(SECRET, token)
    assert invocation is not None
    return invocation.account_id, invocation.scope


@pytest.mark.usefixtures('secret')
def test_storing_signs_in_with_chatgpt_and_ingests_the_sign_in_for_the_named_account() -> None:
    openai = FakeOpenAI()

    assert _run(openai) == 0

    assert openai.authorize['client_id'] == 'dynamic_agent_client'
    assert openai.authorize['scope'] == FULL_PLAN_SCOPES
    assert openai.authorize['code_challenge_method'] == 'S256'
    assert openai.token_requests[0]['grant_type'] == 'authorization_code'
    assert openai.token_requests[0]['client_id'] == 'app_dyn_1'
    [ingest] = openai.plan_usage_requests
    assert ingest.method == 'POST'
    assert _invocation(ingest) == ('acct_owner123', 'credential_capture')
    assert json.loads(ingest.content) == {'subject': 'user-AbC123', 'clientId': 'app_dyn_1', 'refreshToken': 'rt_first'}


@pytest.mark.usefixtures('secret')
@pytest.mark.parametrize('remove', [False, True])
def test_operator_command_reports_the_account_result_after_real_sign_in_or_revocation(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], remove: bool,
) -> None:
    openai = FakeOpenAI()

    def client_factory(*, timeout: httpx.Timeout) -> httpx.Client:
        return httpx.Client(timeout=timeout, transport=httpx.MockTransport(openai.handle))

    # Replace only the command's outbound transport; the browser still reaches
    # the real loopback callback, and the command reads its secret through Moto.
    monkeypatch.setattr(sign_in, 'httpx', SimpleNamespace(Client=client_factory, Timeout=httpx.Timeout))
    argv = ['--account', 'acct_owner123', '--url', PLAN_USAGE_URL,
            '--secret-id', SECRET_ID, '--region', 'us-east-1']
    if remove:
        argv.append('--remove')
    assert main(argv, open_browser=openai.browser, port=0) == 0
    [request] = openai.plan_usage_requests
    assert request.extensions['timeout'] == {'connect': 30, 'read': 30, 'write': 30, 'pool': 30}
    assert request.method == ('DELETE' if remove else 'POST')
    assert _invocation(request) == ('acct_owner123', 'credential_revocation' if remove else 'credential_capture')
    if remove:
        assert openai.authorize == {}
        assert openai.token_requests == []
        expected_output = "Removed Plan Usage from acct_owner123: {'status': 'removed'}\n"
    else:
        assert openai.authorize['agent_name_hint'] == 'BotCube Plan Usage'
        assert openai.token_requests[0]['code'] == 'auth-code-1'
        assert json.loads(request.content) == {
            'subject': 'user-AbC123', 'clientId': 'app_dyn_1', 'refreshToken': 'rt_first',
        }
        expected_output = "Stored Plan Usage for acct_owner123: {'status': 'stored', 'subject': 'user-AbC123'}\n"
    assert capsys.readouterr().out == expected_output


@pytest.mark.usefixtures('secret')
def test_remove_revokes_without_signing_in() -> None:
    openai = FakeOpenAI()

    assert _run(openai, '--remove') == 0

    assert openai.authorize == {}
    [revoke] = openai.plan_usage_requests
    assert revoke.method == 'DELETE'
    assert _invocation(revoke) == ('acct_owner123', 'credential_revocation')


def test_remove_signs_with_the_secret_from_the_requested_region(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    requested_secret = 'credential-service-secret-west'
    openai = FakeOpenAI()
    with mock_aws():
        boto3.client('secretsmanager', region_name='us-east-1').create_secret(Name=SECRET_ID, SecretString=SECRET)
        boto3.client('secretsmanager', region_name='us-west-2').create_secret(Name=SECRET_ID, SecretString=requested_secret)
        assert main(
            ['--account', 'acct_owner123', '--url', PLAN_USAGE_URL, '--secret-id', SECRET_ID,
             '--region', 'us-west-2', '--remove'],
            http=httpx.Client(transport=httpx.MockTransport(openai.handle)),
            open_browser=openai.browser,
        ) == 0

    assert openai.authorize == {}
    assert openai.token_requests == []
    [revoke] = openai.plan_usage_requests
    assert revoke.method == 'DELETE'
    token = revoke.headers['authorization'].removeprefix('Bearer ')
    invocation = verify_credential_service_invocation(requested_secret, token)
    assert invocation is not None
    assert (invocation.account_id, invocation.scope) == ('acct_owner123', 'credential_revocation')
    assert verify_credential_service_invocation(SECRET, token) is None


def test_without_the_signing_secret_the_command_refuses_before_any_sign_in() -> None:
    openai = FakeOpenAI()

    with mock_aws(), pytest.raises(SystemExit, match='Could not read the Credential Service invocation secret'):
        _run(openai)

    assert openai.authorize == {}
    assert openai.plan_usage_requests == []


@pytest.mark.usefixtures('secret')
def test_an_id_token_openai_did_not_sign_is_refused_before_ingest() -> None:
    openai = FakeOpenAI(signing_key=OTHER_KEY)

    with pytest.raises(SystemExit, match='ID token'):
        _run(openai)

    assert openai.plan_usage_requests == []


@pytest.mark.usefixtures('secret')
def test_a_refused_ingest_fails_the_command() -> None:
    openai = FakeOpenAI(plan_usage_status=409)

    with pytest.raises(SystemExit, match='HTTP 409'):
        _run(openai)
