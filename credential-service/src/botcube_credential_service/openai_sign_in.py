"""The operator command that stores or removes the owner's Plan Usage (ADR 0078 decision 5).

It runs Sign in with ChatGPT's open-source flow on loopback (dynamic client registration,
PKCE, the full plan scopes, a verified ID token), then hands the Sign-in to the Credential
Service under an ingest token it signs with the invocation secret, which only the operator's
AWS access can read. `--remove` revokes it under a revocation token instead.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import secrets
import sys
import uuid
import webbrowser
from collections.abc import Callable, Sequence
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import jwt

from .config import OpenAISettings, positive_seconds
from .invocation import sign_credential_service_invocation
from .server import CREDENTIAL_CAPTURE_SCOPE, CREDENTIAL_REVOCATION_SCOPE

PLAN_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
LOOPBACK_PORT = 1455


class SignInFailed(SystemExit):
    """The command stops, naming why; nothing more is stored."""

    def __init__(self, message: str) -> None:
        super().__init__(f'botcube-openai-plan-usage: {message}')


def main(
    argv: Sequence[str] | None = None,
    *,
    http: httpx.Client | None = None,
    open_browser: Callable[[str], object] = webbrowser.open,
    port: int | None = None,
) -> int:
    args = _parser().parse_args(argv)
    configured_port = int(os.environ.get('BOTCUBE_OPENAI_LOOPBACK_PORT', str(LOOPBACK_PORT))) if port is None else port
    if not 0 <= configured_port <= 65535:
        raise ValueError('BOTCUBE_OPENAI_LOOPBACK_PORT must be between 0 and 65535')
    OpenAISettings.from_env()
    timeout = httpx.Timeout(positive_seconds('BOTCUBE_OPENAI_SIGN_IN_TIMEOUT_SECONDS', 30))
    secret = _invocation_secret(args.secret_id, args.region)
    with http or httpx.Client(timeout=timeout) as client:
        session_id = f'operator_{uuid.uuid4().hex}'
        if args.remove:
            token = sign_credential_service_invocation(secret, args.account, session_id, scope=CREDENTIAL_REVOCATION_SCOPE)
            body = _answer(client.delete(args.url, headers=_bearer(token)))
            print(f'Removed Plan Usage from {args.account}: {body}')
            return 0
        sign_in = _sign_in(client, open_browser, configured_port, args.agent_name)
        token = sign_credential_service_invocation(secret, args.account, session_id, scope=CREDENTIAL_CAPTURE_SCOPE)
        body = _answer(client.post(args.url, json=sign_in, headers=_bearer(token)))
        print(f'Stored Plan Usage for {args.account}: {body}')
        return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='botcube-openai-plan-usage', description=__doc__)
    parser.add_argument('--account', required=True, help='The Account to give Plan Usage: the owner\'s.')
    parser.add_argument('--url', required=True, help='The Chat Service\'s Plan Usage route.')
    parser.add_argument('--secret-id', required=True, help='The Secrets Manager secret holding the invocation secret.')
    parser.add_argument('--region', help='The secret\'s AWS region; defaults to the AWS profile\'s.')
    parser.add_argument('--agent-name', default=os.environ.get('BOTCUBE_OPENAI_AGENT_NAME', 'BotCube Plan Usage'), help='The app name ChatGPT shows at sign-in.')
    parser.add_argument('--remove', action='store_true', help='Revoke the Account\'s Plan Usage instead.')
    return parser


def _invocation_secret(secret_id: str, region: str | None) -> str:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError

    try:
        value = boto3.client('secretsmanager', region_name=region).get_secret_value(SecretId=secret_id)['SecretString']
    except (BotoCoreError, ClientError, KeyError) as exc:
        raise SignInFailed(f'Could not read the Credential Service invocation secret: {exc}') from exc
    if not value.strip():
        raise SignInFailed('Could not read the Credential Service invocation secret: it is empty')
    return value


def _sign_in(client: httpx.Client, open_browser: Callable[[str], object], port: int, agent_name: str) -> dict[str, str]:
    settings = OpenAISettings.from_env()
    discovery = _answer(client.get(f'{settings.issuer}/.well-known/openid-configuration'))
    state, nonce, verifier = (secrets.token_urlsafe() for _ in range(3))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    with _CallbackServer(port) as server:
        redirect_uri = f'http://127.0.0.1:{server.server_address[1]}/auth/callback'
        authorize = f'{settings.issuer}/api/accounts/authorize?' + urlencode({
            'client_id': settings.dynamic_client_id,
            'agent_name_hint': agent_name,
            'ext_agent_host_id': f'urn:uuid:{uuid.uuid4()}',
            'response_type': 'code',
            'redirect_uri': redirect_uri,
            'scope': PLAN_SCOPES,
            'resource': settings.resource,
            'state': state,
            'nonce': nonce,
            'code_challenge_method': 'S256',
            'code_challenge': challenge,
        })
        print(f'Sign in to ChatGPT to continue:\n{authorize}', file=sys.stderr)
        open_browser(authorize)
        callback = _await_callback(server)
    if callback.get('error'):
        raise SignInFailed(f'ChatGPT refused the sign-in: {callback["error"]}')
    if callback.get('state') != state:
        raise SignInFailed('The sign-in callback carried another state')
    client_id, code = callback.get('client_id'), callback.get('code')
    if not client_id or not code:
        raise SignInFailed('The sign-in callback carried no registered client or code')
    tokens = _answer(client.post(settings.token_url, headers={'accept': 'application/json'}, data={
        'grant_type': 'authorization_code',
        'client_id': client_id,
        'code': code,
        'code_verifier': verifier,
        'redirect_uri': redirect_uri,
        'resource': settings.resource,
    }))
    subject = _verified_subject(client, discovery, tokens.get('id_token'), client_id, nonce)
    refresh_token = tokens.get('refresh_token')
    if not isinstance(refresh_token, str) or not refresh_token:
        raise SignInFailed('ChatGPT issued no refresh token; the plan scopes were not granted')
    return {'subject': subject, 'clientId': client_id, 'refreshToken': refresh_token}


def _verified_subject(
    client: httpx.Client, discovery: dict[str, Any], id_token: object, client_id: str, nonce: str,
) -> str:
    if not isinstance(id_token, str):
        raise SignInFailed('ChatGPT issued no ID token')
    try:
        keys = jwt.PyJWKSet.from_dict(_answer(client.get(str(discovery['jwks_uri']))))
        kid = jwt.get_unverified_header(id_token).get('kid')
        key = next((candidate for candidate in keys.keys if candidate.key_id == kid), None)
        if key is None:
            raise SignInFailed(f'The ID token names an unknown signing key {kid!r}')
        claims = jwt.decode(
            id_token, key=key, algorithms=['RS256'], audience=client_id, issuer=str(discovery['issuer']),
            options={'require': ['exp', 'iss', 'aud', 'sub', 'nonce']},
        )
    except (jwt.PyJWTError, KeyError) as exc:
        raise SignInFailed(f'The ID token did not verify: {exc}') from exc
    if claims['nonce'] != nonce:
        raise SignInFailed('The ID token carried another nonce')
    return str(claims['sub'])


def _await_callback(server: _CallbackServer) -> dict[str, str]:
    """Serve requests until the callback arrives; answers its query."""
    while server.callback is None:
        server.handle_request()
    return server.callback


class _CallbackServer(HTTPServer):
    """The loopback redirect target; it listens on 127.0.0.1 only."""

    def __init__(self, port: int) -> None:
        super().__init__(('127.0.0.1', port), _CallbackHandler)
        self.callback: dict[str, str] | None = None


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        url = urlsplit(self.path)
        if url.path != '/auth/callback' or not isinstance(self.server, _CallbackServer):
            self.send_error(404)
            return
        self.server.callback = {key: values[0] for key, values in parse_qs(url.query).items()}
        self.send_response(200)
        self.send_header('content-type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'Signed in. You can close this tab and return to the terminal.')

    def log_message(self, format: str, *args: Any) -> None:
        return None


def _answer(response: httpx.Response) -> dict[str, Any]:
    if not response.is_success:
        raise SignInFailed(f'{response.request.method} {response.request.url} answered HTTP {response.status_code}: {response.text}')
    body = response.json()
    if not isinstance(body, dict):
        raise SignInFailed(f'{response.request.url} answered a non-object body')
    return body


def _bearer(token: str) -> dict[str, str]:
    return {'authorization': f'Bearer {token}'}
