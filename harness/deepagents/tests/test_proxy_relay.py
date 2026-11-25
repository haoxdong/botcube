from __future__ import annotations

import json
import socket
import socketserver
from collections.abc import Iterator
from pathlib import Path
from threading import Thread
from typing import Any, ClassVar

import pytest
from botcube_credential_source import credential_source

from botcube_harness_deepagents import endpoint_tls, restore_prime
from botcube_harness_deepagents.proxy_relay import (
    proxy_url_from_config,
    shell_proxy_environment,
    start_proxy_relay,
)
from credential_service_fakes import mtls_fake

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
    relay = proxy_url_from_config({'integrations': {'proxy': {'kind': 'forward', 'url': url, 'credential': {'kind': 'file', 'path': str(missing)}}}}, {})
    assert relay is not None

    answer = _exchange(relay(), 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n').decode('latin-1')

    assert answer.split('\r\n')[0] == 'HTTP/1.1 502 Bad Gateway'
    assert f'proxy credential (file {missing})' in answer
    assert heads == []


@pytest.mark.parametrize(('proxy', 'expected'), json.loads((Path(__file__).resolve().parents[3] / 'tests/fixtures/proxy-url.json').read_text()))
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



def test_refuses_a_malformed_proxy_tls_block_naming_it() -> None:
    with pytest.raises(endpoint_tls.EndpointTlsError, match='^proxy TLS: '):
        proxy_url_from_config({'integrations': {'proxy': {'kind': 'forward', 'url': 'https://proxy.example.com:3129', 'tls': {}}}}, {})


FORWARD = {'kind': 'forward', 'url': 'http://proxy.example.com:3128'}


def test_the_agents_commands_go_direct_without_a_proxy() -> None:
    assert shell_proxy_environment({'integrations': {'proxy': {'kind': 'none'}}, 'network': {}}, {}) == {}


@pytest.mark.parametrize('network', [{}, {'openEgress': {}}])
def test_the_agents_commands_go_direct_when_open_egress_names_no_proxy(network: dict[str, Any]) -> None:
    assert shell_proxy_environment({'integrations': {'proxy': FORWARD}, 'network': network}, {}) == {}


def test_the_agents_commands_reach_every_destination_but_loopback_and_the_metadata_addresses_through_the_proxy_open_egress_names() -> None:
    assert shell_proxy_environment({'integrations': {'proxy': FORWARD}, 'network': {'openEgress': {'proxy': 'integrations.proxy'}}}, {}) == {
        'HTTP_PROXY': 'http://proxy.example.com:3128',
        'HTTPS_PROXY': 'http://proxy.example.com:3128',
        'NO_PROXY': 'localhost,127.0.0.1,::1,169.254.169.254,169.254.170.2',
        'NODE_USE_ENV_PROXY': '1',
    }


def test_an_unreachable_proxy_drops_the_client_with_no_answer() -> None:
    with socket.socket() as closed:
        closed.bind(('127.0.0.1', 0))
        port = closed.getsockname()[1]
    relay = start_proxy_relay(upstream=f'http://127.0.0.1:{port}', listen=('127.0.0.1', 0), credential=None, headers={})

    assert _exchange(relay, 'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\n\r\n') == b''


def test_relay_reaches_a_proxy_signed_by_the_ca_bundle_after_the_snapshot_prime_too(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    certs = mtls_fake.certificates(tmp_path)
    for variable in ('AWS_CA_BUNDLE', 'SSL_CERT_DIR'):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv('SSL_CERT_FILE', str(certs.authority))
    restore_prime.hold_in_memory(tmp_path / 'restore')

    with mtls_fake.mtls_proxy(certs, 'localhost', client_certificate=False) as proxy:
        relay = start_proxy_relay(upstream=proxy.url, listen=('127.0.0.1', 0), credential=None, headers={'x-egress-route': 'botcube'})

        assert mtls_fake.tunnel(relay) == b'HTTP/1.1 200 Connection Established\r\n\r\nhello'


def test_endpoint_tls_is_byte_identical_to_the_credential_services_which_tests_it() -> None:
    twin = Path(__file__).resolve().parents[3] / 'credential-service/src/botcube_credential_service/endpoint_tls.py'

    assert Path(endpoint_tls.__file__).read_bytes() == twin.read_bytes()
