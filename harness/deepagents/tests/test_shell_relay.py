"""A stock CLI in the agent's shell reaches a Credential Service Relay provider through the agent's loopback origin."""

from __future__ import annotations

import gc
import shlex
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import suppress
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, TypedDict
from urllib.parse import urlsplit

import pytest

from botcube_harness_deepagents import serving, shell_relay
from credential_service_fakes import mtls_fake
from deployment_fixture import deploy
from test_bot_settings import bot_service as bot_service
from test_bot_settings import start as start
from test_serving import _Service, _tool_output

PRODUCT = {'environment': {'PRODUCT_URL': '${BOTCUBE_RELAY_URL}/product/v1'}}


@dataclass
class FakeRelay:
    url: str
    calls: list[dict[str, Any]] = field(default_factory=list)


def _fake_relay(scheme: str = 'http', context: ssl.SSLContext | None = None) -> Iterator[FakeRelay]:
    """The Credential Service Relay: `relayed` to each request, and to a WebSocket Upgrade a 101 that echoes what follows."""
    calls: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self) -> None:
            length = int(self.headers.get('content-length') or 0)
            calls.append({
                'method': self.command,
                'path': self.path,
                'authorization': self.headers.get('authorization'),
                'session': self.headers.get('x-botcube-session-id'),
                'body': self.rfile.read(length),
            })
            if self.headers.get('upgrade') == 'websocket' and self.headers.get('connection', '').lower() == 'upgrade':
                self.send_response(101)
                self.send_header('upgrade', 'websocket')
                self.send_header('connection', 'Upgrade')
                self.end_headers()
                self.wfile.flush()
                self.wfile.write(self.rfile.read(5))
                self.wfile.flush()
                return
            body = b'relayed'
            self.send_response(200)
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = _answer

        def log_message(self, format: str, *args: Any) -> None:
            return None

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    if context is not None:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield FakeRelay(f'{scheme}://127.0.0.1:{server.server_address[1]}/openai/v1', calls)
    server.shutdown()


@pytest.fixture
def relay() -> Iterator[FakeRelay]:
    yield from _fake_relay()


class _Binding(TypedDict):
    credentialServiceUrl: str
    credentialServiceInvocationToken: str


def _bound(relay: FakeRelay, token: str) -> _Binding:
    return {'credentialServiceUrl': relay.url, 'credentialServiceInvocationToken': token}


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
def test_a_stock_cli_reaches_a_named_provider_under_the_turns_credential_which_its_shell_never_holds(
    bot_service: _Service, relay: FakeRelay,
) -> None:
    events = bot_service.turn(
        'run: curl -sS -H "Authorization: Bearer shell" -d hi "$PRODUCT_URL/items?page=2"; echo; env',
        **_bound(relay, 'invocation-1'),
    )

    output = _tool_output(events)
    assert output.startswith('relayed\n')
    assert 'invocation-1' not in output
    assert relay.calls == [{
        'method': 'POST', 'path': '/product/v1/items?page=2', 'authorization': 'Bearer invocation-1', 'session': 'thread-1', 'body': b'hi',
    }]


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
@pytest.mark.parametrize('path', ['/openai/v1/responses', '/', '/productx/v1'])
def test_the_loopback_refuses_a_provider_the_bot_settings_do_not_name(bot_service: _Service, relay: FakeRelay, path: str) -> None:
    events = bot_service.turn(f'run: curl -sS -w " %{{http_code}}" "$BOTCUBE_RELAY_URL{path}"', **_bound(relay, 'invocation-1'))

    assert ' 403\n' in _tool_output(events)
    assert relay.calls == []


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
@pytest.mark.parametrize('path', [
    '/product/../models/anthropic/v1/messages', '/product/./v1', '/product/%2e%2e/models', '/product/.%2E/models',
    '/product%2F..%2Fmodels', '/product/v1%2fitems',
])
def test_the_loopback_refuses_a_path_a_later_hop_could_resolve_elsewhere(bot_service: _Service, relay: FakeRelay, path: str) -> None:
    events = bot_service.turn(f'run: curl -sS --path-as-is -w " %{{http_code}}" "$BOTCUBE_RELAY_URL{path}"', **_bound(relay, 'invocation-1'))

    assert ' 400\n' in _tool_output(events)
    assert relay.calls == []


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
def test_a_url_the_shell_took_in_an_earlier_turn_reaches_the_relay_under_the_current_turns_credential(
    bot_service: _Service, relay: FakeRelay,
) -> None:
    bot_service.turn('run: printf %s "$PRODUCT_URL" > url', **_bound(relay, 'invocation-1'))

    bot_service.turn('run: curl -sS "$(cat url)/items"', **_bound(relay, 'invocation-2'))

    assert [(call['path'], call['authorization']) for call in relay.calls] == [('/product/v1/items', 'Bearer invocation-2')]
    assert len(serving._AGENTS) == 1


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
def test_the_loopback_refuses_requests_between_turns(bot_service: _Service, relay: FakeRelay) -> None:
    origin = _origin(bot_service, relay)
    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(f'{origin}/product/v1/items', timeout=5)
    assert refused.value.code == 401
    assert relay.calls == []


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
def test_each_sessions_origin_carries_its_own_sessions_credential(bot_service: _Service, relay: FakeRelay) -> None:
    origins = set()
    for thread in ('thread-1', 'thread-2'):
        events = bot_service.turn(
            'run: printf "%s\\n" "$BOTCUBE_RELAY_URL"; curl -sS "$PRODUCT_URL/items"',
            thread=thread, **_bound(relay, f'invocation-{thread}'),
        )
        origin, body, *_ = _tool_output(events).split('\n')
        origins.add(origin)
        assert body == 'relayed'

    assert len(origins) == 2
    assert [(call['authorization'], call['session']) for call in relay.calls] == [
        ('Bearer invocation-thread-1', 'thread-1'), ('Bearer invocation-thread-2', 'thread-2'),
    ]


def test_an_empty_bot_environment_starts_no_shell_listener(
    bot_service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    listeners = []
    serve = shell_relay.socketserver.ThreadingTCPServer

    def record_listener(*args: Any, **kwargs: Any) -> shell_relay.socketserver.ThreadingTCPServer:
        server = serve(*args, **kwargs)
        listeners.append(server.server_address)
        return server

    monkeypatch.setattr(shell_relay.socketserver, 'ThreadingTCPServer', record_listener)
    events = bot_service.turn('run: printenv BOTCUBE_RELAY_URL || echo absent')
    assert listeners == []
    assert _tool_output(events).startswith('absent\n')


@pytest.mark.parametrize('bot_service', [{'environment': {'NOTE': 'cost $$5 at ${BOTCUBE_RELAY_URL}'}}], indirect=True)
def test_a_value_is_literal_but_for_the_relay_origin_as_in_compose(bot_service: _Service) -> None:
    events = bot_service.turn('run: printf "%s|%s" "$NOTE" "$BOTCUBE_RELAY_URL"')

    note, origin = _tool_output(events).split('\n')[0].split('|')
    loopback = urlsplit(origin)
    assert (loopback.scheme, loopback.hostname, loopback.path) == ('http', '127.0.0.1', '')
    assert loopback.port
    assert note == f'cost $5 at {origin}'


def _origin(service: _Service, relay: FakeRelay, thread: str = 'thread-1') -> str:
    return _tool_output(service.turn('run: printf %s "$BOTCUBE_RELAY_URL"', thread=thread, **_bound(relay, 'invocation-1'))).split('\n')[0]


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
def test_a_websocket_upgrade_reaches_the_relay_and_carries_its_frames_both_ways(bot_service: _Service, relay: FakeRelay) -> None:
    script = """
import os, socket
from urllib.parse import urlsplit

origin = urlsplit(os.environ['BOTCUBE_RELAY_URL'])
with socket.create_connection((origin.hostname, origin.port), timeout=5) as client:
    client.sendall(b'GET /product/v1/socket HTTP/1.1\\r\\nHost: product\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n')
    with client.makefile('rb') as stream:
        print(stream.readline().split()[1].decode())
        for line in stream:
            if line == b'\\r\\n':
                break
        client.sendall(b'hello')
        print(stream.read(5).decode())
"""
    events = bot_service.turn(f'run: python -c {shlex.quote(script)}', **_bound(relay, 'invocation-1'))

    assert _tool_output(events).startswith('101\nhello\n')
    assert relay.calls[-1]['authorization'] == 'Bearer invocation-1'


@pytest.fixture
def tls_relay(tmp_path: Path) -> Iterator[FakeRelay]:
    (tmp_path / 'certs').mkdir()
    certs = mtls_fake.certificates(tmp_path / 'certs')
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(str(certs.dir / 'localhost.pem'), str(certs.dir / 'localhost.key'))
    yield from _fake_relay('https', context)


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
def test_the_loopback_reaches_a_credential_service_the_ca_bundle_trusts(
    bot_service: _Service, tls_relay: FakeRelay, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    (tmp_path / 'trusting').mkdir()
    deploy(monkeypatch, tmp_path / 'trusting', caBundle=str(tmp_path / 'certs' / 'ca.pem'))

    config_reads = 0
    read_config = serving.deployed_config

    def count_config_reads():
        nonlocal config_reads
        config_reads += 1
        return read_config()

    context_calls = 0
    create_context = shell_relay.ssl.create_default_context

    def count_contexts(*args: Any, **kwargs: Any) -> ssl.SSLContext:
        nonlocal context_calls
        context_calls += 1
        return create_context(*args, **kwargs)

    monkeypatch.setattr(serving, 'deployed_config', count_config_reads)
    monkeypatch.setattr(shell_relay.ssl, 'create_default_context', count_contexts)
    events = bot_service.turn('run: curl -sS "$PRODUCT_URL/items" "$PRODUCT_URL/more"', **_bound(tls_relay, 'invocation-1'))

    assert _tool_output(events).startswith('relayed')
    assert [call['path'] for call in tls_relay.calls] == ['/product/v1/items', '/product/v1/more']
    assert config_reads == context_calls == 1


@pytest.mark.parametrize('bot_service', [PRODUCT], indirect=True)
def test_a_loopback_closes_with_its_backend(bot_service: _Service, relay: FakeRelay) -> None:
    origin = urlsplit(_origin(bot_service, relay))

    serving._AGENTS.clear()
    serving._BACKENDS.clear()
    serving._BACKEND_BY_AGENT.clear()
    gc.collect()

    deadline = time.monotonic() + 5
    with pytest.raises(ConnectionRefusedError):
        while time.monotonic() < deadline:
            with suppress(ConnectionResetError):
                socket.create_connection((origin.hostname or '', origin.port or 80), timeout=5).close()
            time.sleep(0.05)
