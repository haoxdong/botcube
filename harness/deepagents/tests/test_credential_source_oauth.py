from __future__ import annotations

import base64
import json
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl

import pytest

from botcube_harness_deepagents.credential_source import (
    Credential,
    CredentialSourceError,
    credential_source,
)

START = 1_795_000_000.0
CLIENT_SECRET = 's3cret-client-value'

Answer = Callable[[int], tuple[int, dict[str, Any]]]


def issuing(expires_in: int | None = None) -> Answer:
    return lambda issued: (200, {'access_token': f'idp-token-{issued}', 'token_type': 'Bearer', **({} if expires_in is None else {'expires_in': expires_in})})


class TokenEndpoint:
    """A stand-in OAuth token endpoint that records each request and answers it with `answer`."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.answer: Answer = issuing(3600)
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers['content-length'])).decode()
                endpoint.requests.append({'path': self.path, 'authorization': self.headers.get('authorization'), 'form': dict(parse_qsl(body))})
                status, reply = endpoint.answer(len(endpoint.requests))
                payload = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}/oauth2/token'


@pytest.fixture
def endpoint() -> Iterator[TokenEndpoint]:
    server = TokenEndpoint()
    thread = threading.Thread(target=server.server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.server.shutdown()


@pytest.fixture
def secret_file(tmp_path: Path) -> str:
    path = tmp_path / 'client-secret'
    path.write_text(CLIENT_SECRET)
    return str(path)


def oauth(url: str, secret_path: str, **extra: object) -> dict[str, object]:
    return {'kind': 'oauth-client-credentials', 'tokenEndpoint': url, 'clientId': 'botcube-models', 'clientSecret': {'kind': 'file', 'path': secret_path}, **extra}


def test_gives_the_endpoints_access_token_until_it_expires_asking_with_the_clients_id_secret_and_scopes(endpoint: TokenEndpoint, secret_file: str) -> None:
    source = credential_source('models', oauth(endpoint.url, secret_file, scopes=['models.invoke', 'api://botcube/.default']), now=lambda: START)

    assert source.get() == Credential(value='idp-token-1', expires_at=START + 3600)
    [request] = endpoint.requests
    assert request['path'] == '/oauth2/token'
    assert request['authorization'] == 'Basic ' + base64.b64encode(f'botcube-models:{CLIENT_SECRET}'.encode()).decode()
    assert request['form'] == {'grant_type': 'client_credentials', 'scope': 'models.invoke api://botcube/.default'}


def test_asks_for_no_scope_when_it_names_none(endpoint: TokenEndpoint, secret_file: str) -> None:
    credential_source('models', oauth(endpoint.url, secret_file), now=lambda: START).get()
    assert endpoint.requests[0]['form'] == {'grant_type': 'client_credentials'}


def test_asks_for_a_new_token_a_minute_before_the_last_one_expires(endpoint: TokenEndpoint, secret_file: str) -> None:
    endpoint.answer = issuing(600)
    clock = [START]
    source = credential_source('models', oauth(endpoint.url, secret_file), now=lambda: clock[0])

    assert source.get().value == 'idp-token-1'
    clock[0] = START + 240
    assert source.get().value == 'idp-token-1'
    clock[0] = START + 541
    assert source.get().value == 'idp-token-2'
    assert len(endpoint.requests) == 2


def test_reads_an_opaque_token_the_endpoint_gave_no_expiry_again_after_five_minutes(endpoint: TokenEndpoint, secret_file: str) -> None:
    endpoint.answer = issuing()
    source = credential_source('models', oauth(endpoint.url, secret_file), now=lambda: START)
    assert source.get() == Credential(value='idp-token-1', expires_at=START + 300)


def test_keeps_a_jwt_the_endpoint_gave_no_expiry_until_the_jwts_own_exp(endpoint: TokenEndpoint, secret_file: str) -> None:
    def segment(value: object) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')

    jwt = f'{segment({"alg": "RS256"})}.{segment({"exp": START + 1800})}.signature'
    endpoint.answer = lambda issued: (200, {'access_token': jwt, 'token_type': 'Bearer'})
    source = credential_source('models', oauth(endpoint.url, secret_file), now=lambda: START)
    assert source.get() == Credential(value=jwt, expires_at=START + 1800)


def test_fails_naming_its_seam_its_endpoint_and_the_oauth_error_without_the_secret(endpoint: TokenEndpoint, secret_file: str) -> None:
    endpoint.answer = lambda _: (401, {'error': 'invalid_client', 'error_description': f'client secret {CLIENT_SECRET} is wrong'})
    source = credential_source('models', oauth(endpoint.url, secret_file))

    with pytest.raises(CredentialSourceError) as failure:
        source.get()
    assert str(failure.value) == f'models credential (oauth-client-credentials {endpoint.url}): the token endpoint answered 401 invalid_client'
    with pytest.raises(CredentialSourceError, match='^models credential'):
        source.get()
    assert len(endpoint.requests) == 2


def test_fails_on_a_reply_without_an_access_token_without_echoing_it(endpoint: TokenEndpoint, secret_file: str) -> None:
    endpoint.answer = lambda _: (200, {'token': CLIENT_SECRET})
    with pytest.raises(CredentialSourceError) as failure:
        credential_source('models', oauth(endpoint.url, secret_file)).get()
    assert str(failure.value).endswith(': the token endpoint did not answer with an access_token')
    assert CLIENT_SECRET not in str(failure.value)


def test_fails_naming_the_client_secret_source_before_asking_the_endpoint(endpoint: TokenEndpoint) -> None:
    with pytest.raises(CredentialSourceError, match=r'^models credential \(oauth-client-credentials .*\): client secret \(file /absent/client-secret\): .*No such file'):
        credential_source('models', oauth(endpoint.url, '/absent/client-secret')).get()
    assert endpoint.requests == []


def test_is_refused_when_its_client_secret_is_a_command_the_deploy_did_not_opt_in_to() -> None:
    source = {**oauth('https://login.example.com/oauth2/token', '/unread'), 'clientSecret': {'kind': 'command', 'command': ['/usr/local/bin/secret'], 'timeoutSeconds': 30}}
    with pytest.raises(
        CredentialSourceError,
        match=r'^models credential \(oauth-client-credentials https://login\.example\.com/oauth2/token\): client secret \(command /usr/local/bin/secret\): '
        r'a command credential runs only when BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1$',
    ):
        credential_source('models', source, env={})


@pytest.mark.parametrize(('field', 'issue'), [
    ('tokenEndpoint', 'oauth-client-credentials.tokenEndpoint'),
    ('clientId', 'oauth-client-credentials.clientId'),
    ('clientSecret', 'oauth-client-credentials.clientSecret'),
])
def test_refuses_an_incomplete_source_naming_the_field(field: str, issue: str) -> None:
    source = {key: value for key, value in oauth('https://login.example.com/oauth2/token', '/unread').items() if key != field}
    with pytest.raises(CredentialSourceError, match=rf'^models credential: {issue}: '):
        credential_source('models', source)
