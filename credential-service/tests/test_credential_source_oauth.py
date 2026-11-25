from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl

import pytest

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.models import models_provider_from_config
from required_keys import resolved_sections

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


def test_models_endpoint_gets_its_token_through_its_named_proxy(endpoint: TokenEndpoint, secret_file: str) -> None:
    with ThreadingHTTPServer(('127.0.0.1', 0), endpoint.server.RequestHandlerClass) as proxy:
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            config = {'integrations': {
                'proxy': {'kind': 'forward', 'url': f'http://127.0.0.1:{proxy.server_port}'},
                'modelGateway': {'kind': 'openai-compatible', 'url': 'https://models.example/v1',
                                 'credential': oauth(endpoint.url, secret_file), 'proxy': 'integrations.proxy'},
            }}
            provider = models_provider_from_config(CredentialAuditRecorder(), resolved_sections(config), {})
            assert provider is not None
            asyncio.run(provider.aclose())
            assert [request['path'] for request in endpoint.requests] == [endpoint.url]
        finally:
            proxy.shutdown()
