from __future__ import annotations

import json
import socket
import socketserver
from collections.abc import Iterator
from pathlib import Path
from threading import Thread
from typing import ClassVar

import pytest

from botcube_harness_deepagents.credential_source import credential_source
from botcube_harness_deepagents.proxy_relay import (
    start_proxy_relay,
    start_proxy_relay_from_env,
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


def test_relay_opens_each_tunnel_with_the_credentials_current_value_and_the_headers(upstream: tuple[str, list[str]], tmp_path: Path) -> None:
    url, heads = upstream
    token = tmp_path / 'proxy-token'
    token.write_text('first\n')
    clock = [0.0]
    source = credential_source('proxy', {'kind': 'file', 'path': str(token)}, now=lambda: clock[0])
    relay = start_proxy_relay(upstream=url, listen=('127.0.0.1', 0), credential=source, headers={'x-tenant': 'botcube-example'})

    answer = _exchange(relay, 'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\nProxy-Authorization: Basic stale\r\n\r\n', b'hello')
    token.write_text('rotated\n')
    clock[0] = 300.0
    _exchange(relay, 'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\n\r\n', b'again')

    assert answer == b'HTTP/1.1 200 Connection Established\r\n\r\nhello'
    assert [head.split('\r\n')[0] for head in heads] == ['CONNECT models.example.com:443 HTTP/1.1'] * 2
    assert [_header(head, 'proxy-authorization') for head in heads] == [['Bearer first'], ['Bearer rotated']]
    assert [_header(head, 'x-tenant') for head in heads] == [['botcube-example']] * 2


def test_relay_authenticates_a_plain_http_request_one_to_a_connection(upstream: tuple[str, list[str]], tmp_path: Path) -> None:
    url, heads = upstream
    token = tmp_path / 'proxy-token'
    token.write_text('token')
    relay = start_proxy_relay(upstream=url, listen=('127.0.0.1', 0), credential=credential_source('proxy', {'kind': 'file', 'path': str(token)}), headers={})

    answer = _exchange(relay, 'POST http://collector.example.com:4318/v1/traces HTTP/1.1\r\nHost: collector.example.com:4318\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n')

    assert b'HTTP/1.1 200 OK' in answer
    [head] = heads
    assert head.split('\r\n')[0] == 'POST http://collector.example.com:4318/v1/traces HTTP/1.1'
    assert [_header(head, 'proxy-authorization'), _header(head, 'connection')] == [['Bearer token'], ['close']]


def test_relay_answers_502_naming_the_credential_and_opens_nothing_when_it_fails(upstream: tuple[str, list[str]], tmp_path: Path) -> None:
    url, heads = upstream
    missing = tmp_path / 'proxy-token'
    relay = start_proxy_relay_from_env({
        'BOTCUBE_PROXY_URL': url,
        'HTTPS_PROXY': 'http://127.0.0.1:0',
        'BOTCUBE_PROXY_CREDENTIAL': json.dumps({'kind': 'file', 'path': str(missing)}),
    })
    assert relay is not None

    answer = _exchange(relay, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n').decode('latin-1')

    assert answer.split('\r\n')[0] == 'HTTP/1.1 502 Bad Gateway'
    assert f'proxy credential (file {missing})' in answer
    assert heads == []


def test_no_relay_without_the_deploys_proxy_url() -> None:
    assert start_proxy_relay_from_env({'HTTPS_PROXY': 'http://proxy.example.com:3128'}) is None


@pytest.mark.parametrize(('env', 'error'), [
    ({'BOTCUBE_PROXY_CREDENTIAL': '{not json'}, 'BOTCUBE_PROXY_CREDENTIAL: not JSON'),
    ({'BOTCUBE_PROXY_CREDENTIAL': json.dumps({'kind': 'secret'})}, 'proxy credential: secret.secretArn: '),
    ({'BOTCUBE_PROXY_HEADERS': json.dumps({'x-tenant': 1})}, 'BOTCUBE_PROXY_HEADERS: expected an object of header values'),
])
def test_refuses_a_malformed_relay_setting_naming_it(env: dict[str, str], error: str) -> None:
    with pytest.raises(RuntimeError, match=f'^{error}'):
        start_proxy_relay_from_env({'BOTCUBE_PROXY_URL': 'http://proxy.example.com:3128', 'HTTPS_PROXY': 'http://127.0.0.1:0', **env})
