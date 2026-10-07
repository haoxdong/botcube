"""A missing fake transport must fail before any external network effects."""

from __future__ import annotations

import asyncio
import socket
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import httpx
import pytest
from starlette.requests import Request

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.vault import DynamoDbCredentialVault
from test_openai import vault as vault


@contextmanager
def fail_before_network_effects() -> Iterator[None]:
    # Audit events execute before their native socket operation. This sentinel keeps
    # even the regression's RED run offline if the real test guard is missing.
    active = True

    def sentinel(event: str, args: tuple[Any, ...]) -> None:
        if active and event in {'socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr',
                                'socket.getnameinfo', 'socket.connect', 'socket.sendto'}:
            raise AssertionError('Missing offline guard: intercepted before network effects')

    sys.addaudithook(sentinel)
    try:
        yield
    finally:
        active = False


@pytest.mark.parametrize('operation', [
    lambda: socket.getaddrinfo('api.openai.com', 443),
    lambda: socket.gethostbyname('api.openai.com'),
    lambda: socket.gethostbyname_ex('api.openai.com'),
    lambda: socket.gethostbyaddr('192.0.2.1'),
    lambda: socket.getnameinfo(('192.0.2.1', 443), 0),
])
def test_external_resolution_is_denied_before_the_resolver_runs(operation: Callable[[], Any]) -> None:
    with fail_before_network_effects(), pytest.raises(pytest.fail.Exception, match='Offline test blocked'):
        operation()


@pytest.mark.parametrize('family,address', [
    (socket.AF_INET, ('192.0.2.1', 443)),
    (socket.AF_INET6, ('2001:db8::1', 443)),
])
@pytest.mark.parametrize('method', ['connect', 'connect_ex', 'sendto'])
def test_external_connections_are_denied_before_the_socket_runs(
    family: socket.AddressFamily, address: tuple[str, int], method: str,
) -> None:
    with (
        socket.socket(family, socket.SOCK_DGRAM if method == 'sendto' else socket.SOCK_STREAM) as connection,
        fail_before_network_effects(),
        pytest.raises(pytest.fail.Exception, match='Offline test blocked'),
    ):
        if method == 'sendto':
            connection.sendto(b'offline-regression', address)
        else:
            getattr(connection, method)(address)


def test_a_relay_losing_its_mock_transport_fails_before_resolution(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Match the generated __init__ transport-dropping mutant without touching product code.
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
        monkeypatch.delenv(name, raising=False)
    provider = OpenAIProvider(lambda: vault, audit=CredentialAuditRecorder(),
                              transport=httpx.MockTransport(lambda request: httpx.Response(200)))
    provider._transport = None

    async def receive() -> dict[str, Any]:
        return {'type': 'http.request', 'body': b'', 'more_body': False}

    request = Request({'type': 'http', 'method': 'GET', 'path': '/openai/v1/models',
                       'query_string': b'', 'headers': []}, receive)
    with fail_before_network_effects(), pytest.raises(pytest.fail.Exception, match='Offline test blocked'):
        asyncio.run(provider.relay(request, 'v1/models', 'synthetic-access', account_id='acct-1', request_context={}))


def test_loopback_resolution_and_connections_remain_available() -> None:
    assert socket.getaddrinfo('localhost', 0)
    assert socket.gethostbyname('127.0.0.1') == '127.0.0.1'
    with socket.socket() as listener, socket.socket() as client:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        client.connect(listener.getsockname())
        with listener.accept()[0] as accepted:
            client.sendall(b'local')
            assert accepted.recv(5) == b'local'
