from __future__ import annotations

import asyncio
import json
import socket
import socketserver
from collections.abc import Iterator
from pathlib import Path
from threading import Thread
from typing import Any, ClassVar

import httpx
import pytest
from starlette.requests import Request

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.proxy_relay import (
    proxy_url_from_config,
    relay_provider_proxy,
)

pytestmark = pytest.mark.integration


class _UpstreamProxy(socketserver.BaseRequestHandler):
    """An authenticating forward proxy: records each request head, then answers a CONNECT and echoes the tunnel."""

    heads: ClassVar[list[str]] = []

    def handle(self) -> None:
        buffered = b''
        while b'\r\n\r\n' not in buffered:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            buffered += chunk
        head, rest = buffered.split(b'\r\n\r\n', 1)
        type(self).heads.append(head.decode('latin-1'))
        if head.startswith(b'CONNECT '):
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n' + rest)
            while chunk := self.request.recv(4096):
                self.request.sendall(chunk)
        else:
            self.request.sendall(b'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok')


@pytest.fixture
def upstream() -> Iterator[tuple[str, list[str]]]:
    server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), _UpstreamProxy)
    server.daemon_threads = True
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _UpstreamProxy.heads = []
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}', _UpstreamProxy.heads
    finally:
        server.shutdown()
        server.server_close()


def _exchange(relay: str, head: str, tunnelled: bytes = b'') -> bytes:
    host, port = relay.removeprefix('http://').split(':')
    with socket.create_connection((host, int(port)), timeout=5) as client:
        client.sendall(head.encode('latin-1'))
        received = b''
        while b'\r\n\r\n' not in received:
            chunk = client.recv(4096)
            if not chunk:
                return received
            received += chunk
        if tunnelled:
            client.sendall(tunnelled)
            while not received.endswith(tunnelled):
                received += client.recv(4096)
            return received
        while chunk := client.recv(4096):
            received += chunk
        return received


def _header(head: str, name: str) -> list[str]:
    return [line.split(':', 1)[1].strip() for line in head.split('\r\n')[1:] if line.split(':', 1)[0].strip().lower() == name.lower()]


def _from_config(url: str, token: Path, **proxy: object) -> str:
    relay = proxy_url_from_config({'integrations': {'proxy': {'kind': 'forward', 'url': url, 'credential': {'kind': 'file', 'path': str(token)}, **proxy}}}, {})
    assert relay is not None
    return relay()


def test_relay_opens_each_tunnel_with_the_current_file_credential_and_headers(upstream: tuple[str, list[str]], tmp_path: Path) -> None:
    url, heads = upstream
    token = tmp_path / 'proxy-token'
    token.write_text('first\n')
    relay = _from_config(url, token, headers={'x-tenant': 'botcube-example'})

    answer = _exchange(relay, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\nProxy-Authorization: Basic stale\r\n\r\n', b'hello')
    token.write_text('rotated\n')
    _exchange(relay, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n', b'again')

    assert answer == b'HTTP/1.1 200 Connection Established\r\n\r\nhello'
    assert [head.split('\r\n')[0] for head in heads] == ['CONNECT api.example.com:443 HTTP/1.1'] * 2
    assert [_header(head, 'proxy-authorization') for head in heads] == [['Bearer first'], ['Bearer rotated']]
    assert [_header(head, 'x-tenant') for head in heads] == [['botcube-example']] * 2


def test_relay_authenticates_a_plain_http_request_one_to_a_connection(upstream: tuple[str, list[str]], tmp_path: Path) -> None:
    url, heads = upstream
    token = tmp_path / 'proxy-token'
    token.write_text('token')
    relay = _from_config(url, token)

    answer = _exchange(relay, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: keep-alive\r\n\r\n')

    assert b'HTTP/1.1 200 OK' in answer
    [head] = heads
    assert head.split('\r\n')[0] == 'GET http://example.com/ HTTP/1.1'
    assert [_header(head, 'proxy-authorization'), _header(head, 'connection')] == [['Bearer token'], ['close']]


def test_relay_answers_502_naming_the_credential_and_opens_nothing_when_it_fails(upstream: tuple[str, list[str]], tmp_path: Path) -> None:
    url, heads = upstream
    missing = tmp_path / 'proxy-token'
    relay = _from_config(url, missing)

    answer = _exchange(relay, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n').decode('latin-1')

    assert answer.split('\r\n')[0] == 'HTTP/1.1 502 Bad Gateway'
    assert f'proxy credential (file {missing}):' in answer
    assert 'No such file or directory' in answer
    assert heads == []


def test_relay_refuses_an_empty_credential_file_before_forwarding(upstream: tuple[str, list[str]], tmp_path: Path) -> None:
    url, heads = upstream
    token = tmp_path / 'proxy-token'
    token.write_text('')
    relay = _from_config(url, token)

    answer = _exchange(relay, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n').decode('latin-1')

    assert (answer.split('\r\n')[0], [_header(head, 'proxy-authorization') for head in heads]) == ('HTTP/1.1 502 Bad Gateway', [])
    assert f'proxy credential (file {token}): the file is empty' in answer


@pytest.mark.parametrize(('proxy', 'expected'), json.loads((Path(__file__).resolve().parents[2] / 'tests/fixtures/proxy-url.json').read_text()))
def test_proxy_url_and_reuse(proxy: dict[str, Any], expected: str | None) -> None:
    config = {'integrations': {'proxy': proxy}}
    first, second = proxy_url_from_config(config, {}), proxy_url_from_config(config, {})

    if expected is None:
        assert first is second is None
    else:
        assert first is not None and second is not None
        relay = first()
        assert relay == expected or (expected.endswith(':') and relay.startswith(expected) and relay[len(expected):].isdecimal())
        assert second() == relay


@pytest.mark.parametrize(('relay_providers', 'through'), [
    ({'openai': {'proxy': 'integrations.proxy'}}, 'http://proxy.example.com:3128'),
    ({'openai': {}}, None),
    ({'site': {'proxy': 'integrations.proxy'}}, None),
    (None, None),
])
def test_a_relay_provider_reaches_its_upstream_through_the_proxy_only_when_its_entry_names_it(
    relay_providers: dict[str, dict[str, str]] | None, through: str | None,
) -> None:
    proxy = {'kind': 'forward', 'url': 'http://proxy.example.com:3128'}
    config = {'integrations': {'proxy': proxy, **({} if relay_providers is None else {'relayProviders': relay_providers})}}

    url = relay_provider_proxy(config, 'openai', {})

    assert (url() if url else None) == through


def test_the_openai_relay_provider_calls_openai_through_the_proxy_it_is_given(upstream: tuple[str, list[str]]) -> None:
    url, heads = upstream
    provider = OpenAIProvider(lambda: pytest.fail('a relayed call reads no Vault'), audit=CredentialAuditRecorder(), proxy=lambda: url)

    async def receive() -> dict[str, Any]:
        return {'type': 'http.request', 'body': b'', 'more_body': False}

    async def relay() -> None:
        request = Request({'type': 'http', 'method': 'GET', 'path': '/v1/models', 'query_string': b'', 'headers': []}, receive)
        try:
            with pytest.raises(httpx.TransportError):
                await provider.relay(request, 'v1/models', 'access', account_id='acct-1', request_context={})
        finally:
            await provider.aclose()

    asyncio.run(relay())
    assert [head.split('\r\n')[0] for head in heads] == ['CONNECT api.openai.com:443 HTTP/1.1']
