from __future__ import annotations

import base64
import hashlib
import json
import string
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit

import boto3
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from moto import mock_aws

import botcube_credential_service.openai_sign_in as sign_in
from botcube_credential_service.provider import UpstreamRefusal


@pytest.mark.parametrize('missing', ['--account', '--url', '--secret-id'])
def test_missing_required_operator_option_refuses_before_aws(
    missing: str, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    options = {'--account': 'acct_owner123', '--url': 'https://chat.example/plan', '--secret-id': 'invocation'}
    argv = [part for option, value in options.items() if option != missing for part in (option, value)]
    aws_calls: list[str] = []
    browser_urls: list[str] = []
    requests: list[httpx.Request] = []
    actual_client = boto3.client

    def observed_client(service_name: Literal['secretsmanager'], *args: Any, **kwargs: Any) -> Any:
        aws_calls.append(service_name)
        return actual_client(service_name, *args, **kwargs)

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(404)

    # If invalid arguments reach AWS, let the actual SDK finish against Moto;
    # the assertion observes that forbidden side effect independently of networking.
    with mock_aws(), httpx.Client(transport=httpx.MockTransport(answer)) as client:
        monkeypatch.setattr(boto3, 'client', observed_client)
        with pytest.raises(SystemExit) as refused:
            sign_in.main(argv, http=client, open_browser=browser_urls.append, port=0)
    assert aws_calls == []
    assert browser_urls == []
    assert requests == []
    assert refused.value.code == 2
    assert missing in capsys.readouterr().err


def test_help_explains_operator_options_and_command(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as finished:
        sign_in.main(['--help'])
    assert finished.value.code == 0
    help_text = ' '.join(capsys.readouterr().out.split())
    for expected in (
        'usage: botcube-openai-plan-usage', "The operator command that stores or removes",
        "The Account to give Plan Usage", "The Chat Service's Plan Usage route",
        'Secrets Manager secret holding the invocation secret', "AWS region", 'AWS profile',
        'app name ChatGPT shows at sign-in', "Revoke the Account's Plan Usage instead",
    ):
        assert expected in help_text


def test_blank_invocation_secret_refuses_with_the_reason() -> None:
    import boto3

    with mock_aws():
        boto3.client('secretsmanager', region_name='us-east-1').create_secret(Name='blank', SecretString='   ')
        with pytest.raises(sign_in.SignInFailed, match='invocation secret: it is empty'):
            sign_in._invocation_secret('blank', 'us-east-1')


class SignInExchange:
    def __init__(self, callback: dict[str, str] | None = None, refresh_token: object = 'rt_new') -> None:
        self.callback = callback
        self.refresh_token = refresh_token
        self.authorize: dict[str, str] = {}
        self.requests: list[httpx.Request] = []

    def browser(self, url: str) -> None:
        self.authorize = {key: values[0] for key, values in parse_qs(urlsplit(url).query).items()}

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == 'GET':
            return httpx.Response(200, json={'issuer': 'https://auth.openai.com', 'jwks_uri': 'https://auth.openai.com/keys'})
        return httpx.Response(200, json={'id_token': 'verified-by-separate-tests', 'refresh_token': self.refresh_token})

    def await_callback(self, server: sign_in._CallbackServer) -> dict[str, str]:
        if self.callback is not None:
            return {'state': self.authorize['state'], **self.callback}
        return {'state': self.authorize['state'], 'client_id': 'registered-client', 'code': 'auth-code'}


def _exchange(monkeypatch: pytest.MonkeyPatch, exchange: SignInExchange) -> dict[str, str]:
    monkeypatch.setattr(sign_in, '_await_callback', exchange.await_callback)
    def verified(
        client: httpx.Client, discovery: dict[str, Any], token: object, client_id: str, nonce: str,
    ) -> str:
        return 'user-123'

    monkeypatch.setattr(sign_in, '_verified_subject', verified)
    with httpx.Client(transport=httpx.MockTransport(exchange.handle)) as client:
        return sign_in._sign_in(client, exchange.browser, 0, 'Owner Plan')


def test_sign_in_reports_the_browser_url_and_exchanges_the_same_redirect(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    exchange = SignInExchange()
    assert _exchange(monkeypatch, exchange) == {
        'subject': 'user-123', 'clientId': 'registered-client', 'refreshToken': 'rt_new',
    }
    assert exchange.authorize['agent_name_hint'] == 'Owner Plan'
    redirect = urlsplit(exchange.authorize['redirect_uri'])
    assert redirect.hostname == '127.0.0.1'
    assert redirect.port is not None and redirect.port > 0
    assert redirect.path == '/auth/callback'
    token_request = exchange.requests[-1]
    assert token_request.headers['accept'] == 'application/json'
    form = parse_qs(token_request.content.decode())
    assert form['redirect_uri'] == [exchange.authorize['redirect_uri']]
    [verifier] = form['code_verifier']
    assert 43 <= len(verifier) <= 128
    assert set(verifier) <= set(string.ascii_letters + string.digits + '-._~')
    assert exchange.authorize['code_challenge_method'] == 'S256'
    expected_challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).rstrip(b'=').decode('ascii')
    assert exchange.authorize['code_challenge'] == expected_challenge
    output = capsys.readouterr()
    assert output.out == ''
    assert 'Sign in to ChatGPT to continue:' in output.err
    assert 'https://auth.openai.com/api/accounts/authorize?' in output.err


@pytest.mark.parametrize(('callback', 'reason'), [
    ({'error': 'access_denied'}, 'ChatGPT refused the sign-in: access_denied'),
    ({'state': 'another-state', 'client_id': 'client', 'code': 'code'}, 'callback carried another state'),
    ({'client_id': 'client'}, 'callback carried no registered client or code'),
    ({'code': 'code'}, 'callback carried no registered client or code'),
])
def test_refused_or_incomplete_callback_never_exchanges_a_code(
    monkeypatch: pytest.MonkeyPatch, callback: dict[str, str], reason: str,
) -> None:
    exchange = SignInExchange(callback)
    with pytest.raises(sign_in.SignInFailed, match=reason):
        _exchange(monkeypatch, exchange)
    assert [request.method for request in exchange.requests] == ['GET']


@pytest.mark.parametrize('refresh_token', [None, '', 123])
def test_sign_in_refuses_missing_or_non_text_refresh_tokens(
    monkeypatch: pytest.MonkeyPatch, refresh_token: object,
) -> None:
    with pytest.raises(sign_in.SignInFailed, match='ChatGPT issued no refresh token'):
        _exchange(monkeypatch, SignInExchange(refresh_token=refresh_token))


@pytest.fixture(scope='module')
def signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _verify_claims(
    signing_key: rsa.RSAPrivateKey, change: Callable[[dict[str, Any]], None], *, kid: str = 'known-key',
) -> str:
    claims: dict[str, Any] = {
        'iss': 'https://auth.openai.com', 'aud': 'registered-client', 'sub': 'user-123',
        'nonce': 'requested-nonce', 'exp': int(time.time()) + 3600,
    }
    change(claims)
    token = jwt.encode(claims, signing_key, algorithm='RS256', headers={'kid': kid})
    public = json.loads(RSAAlgorithm.to_jwk(signing_key.public_key()))
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        'keys': [{**public, 'kid': 'known-key', 'alg': 'RS256', 'use': 'sig'}],
    }))) as client:
        return sign_in._verified_subject(client, {
            'issuer': 'https://auth.openai.com', 'jwks_uri': 'https://auth.openai.com/keys',
        }, token, 'registered-client', 'requested-nonce')


@pytest.mark.parametrize('claim', ['exp', 'iss', 'aud', 'sub', 'nonce'])
def test_signed_identity_requires_every_identity_claim(signing_key: rsa.RSAPrivateKey, claim: str) -> None:
    with pytest.raises(sign_in.SignInFailed, match='ID token did not verify'):
        _verify_claims(signing_key, lambda claims: claims.pop(claim))


@pytest.mark.parametrize(('claim', 'value', 'reason'), [
    ('iss', 'https://another-issuer.example', 'ID token did not verify'),
    ('aud', 'another-client', 'ID token did not verify'),
    ('nonce', 'another-nonce', 'ID token carried another nonce'),
    ('exp', 1, 'ID token did not verify'),
])
def test_signed_identity_is_bound_to_issuer_client_nonce_and_expiry(
    signing_key: rsa.RSAPrivateKey, claim: str, value: object, reason: str,
) -> None:
    with pytest.raises(sign_in.SignInFailed, match=reason):
        _verify_claims(signing_key, lambda claims: claims.__setitem__(claim, value))


def test_unknown_id_token_signing_key_is_a_named_refusal(signing_key: rsa.RSAPrivateKey) -> None:
    with pytest.raises(sign_in.SignInFailed, match="unknown signing key 'unknown-key'"):
        _verify_claims(signing_key, lambda claims: None, kid='unknown-key')


@pytest.mark.parametrize('token', [None, 123])
def test_missing_id_token_is_a_named_refusal(token: object) -> None:
    with httpx.Client() as client, pytest.raises(sign_in.SignInFailed, match='ChatGPT issued no ID token'):
        sign_in._verified_subject(client, {}, token, 'client', 'nonce')


@pytest.mark.parametrize(('path', 'status', 'callback'), [
    ('/favicon.ico', 404, None),
    ('/auth/callback?state=first&state=second&code=code&client_id=registered', 200,
     {'state': 'first', 'code': 'code', 'client_id': 'registered'}),
])
def test_loopback_callback_answers_the_browser_and_captures_the_first_query_values(
    path: str, status: int, callback: dict[str, str] | None,
) -> None:
    with sign_in._CallbackServer(0) as server, ThreadPoolExecutor(max_workers=1) as executor:
        server.timeout = 2
        response_future = executor.submit(httpx.get, f'http://127.0.0.1:{server.server_address[1]}{path}', timeout=2)
        # Run the handler in the test thread, where mutmut records coverage.
        server.handle_request()
        response = response_future.result(timeout=3)
        assert response.status_code == status
        assert server.callback == callback
        if status == 200:
            assert response.headers['content-type'] == 'text/plain'
            assert response.text == 'Signed in. You can close this tab and return to the terminal.'


def test_non_object_endpoint_response_is_a_named_failure() -> None:
    response = httpx.Response(200, json=[], request=httpx.Request('GET', 'https://auth.example/discovery'))
    with pytest.raises(sign_in.SignInFailed, match='answered a non-object body'):
        sign_in._answer(response)


def test_provider_refusal_keeps_the_upstream_body_status_and_diagnostic() -> None:
    body = {'error': {'code': 'plan_usage_revoked'}}
    refusal = UpstreamRefusal(401, body)
    assert refusal.status_code == 401
    assert refusal.body == {'error': {'code': 'plan_usage_revoked'}}
    assert str(refusal) == "HTTP 401: {'error': {'code': 'plan_usage_revoked'}}"


def test_identity_algorithm_stays_pinned_when_the_issuer_key_advertises_another_algorithm(
    signing_key: rsa.RSAPrivateKey,
) -> None:
    claims = {
        'iss': 'https://auth.openai.com', 'aud': 'registered-client', 'sub': 'user-123',
        'nonce': 'requested-nonce', 'exp': int(time.time()) + 3600,
    }
    token = jwt.encode(claims, signing_key, algorithm='RS384', headers={'kid': 'known-key'})
    public = json.loads(RSAAlgorithm.to_jwk(signing_key.public_key()))
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        'keys': [{**public, 'kid': 'known-key', 'alg': 'RS384', 'use': 'sig'}],
    }))) as client, pytest.raises(sign_in.SignInFailed, match='ID token did not verify'):
        sign_in._verified_subject(client, {
            'issuer': 'https://auth.openai.com', 'jwks_uri': 'https://auth.openai.com/keys',
        }, token, 'registered-client', 'requested-nonce')
