"""The agent's loopback origin to the Credential Service Relay, which signs each request with the current Turn's invocation.

The bot settings' `environment` names it as `${BOTCUBE_RELAY_URL}`, so a stock CLI pointed at `${BOTCUBE_RELAY_URL}/<provider>`
reaches that Relay provider. The shell never holds the credential, and a long-lived process reaches the Relay under the
Turn that is current when it sends, not the one that started it. Each agent's shell has its own origin, bound to it.
"""
from __future__ import annotations

import contextlib
import logging
import re
import socket
import socketserver
import ssl
from collections.abc import Mapping
from threading import Thread
from typing import TypeVar
from urllib.parse import unquote, urlsplit
from weakref import WeakKeyDictionary, finalize

from .botcube_config import botcube_config_from_env
from .definition import ModelRelay
from .proxy_relay import _carry, _read_head

log = logging.getLogger(__name__)

RELAY_URL_ENV = 'BOTCUBE_RELAY_URL'
_REFERENCE = re.compile(r'\$\$|\$\{' + RELAY_URL_ENV + r'\}(/([^/?#\s$]+))?')
_REPLACED = {'host', 'authorization', 'connection', 'proxy-authorization', 'proxy-connection'}

Backend = TypeVar('Backend')
_BOUND: WeakKeyDictionary[object, ShellRelay] = WeakKeyDictionary()


class ShellRelay:
    """One loopback listener forwarding `/{provider}/…` to the Relay, for only the providers the bot's environment names."""

    def __init__(self, bot_environment: Mapping[str, str]) -> None:
        self.providers = frozenset(match[2] for value in bot_environment.values() for match in _REFERENCE.finditer(value) if match[2])
        self.current: ModelRelay | None = None
        relay = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                relay._forward(self.request)

        self._server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
        self._server.daemon_threads = True
        Thread(target=self._server.serve_forever, name='shell-relay', daemon=True).start()
        self.origin = f'http://127.0.0.1:{self._server.server_address[1]}'
        self.environment = {
            RELAY_URL_ENV: self.origin,
            **{name: _REFERENCE.sub(lambda match: '$' if match[0] == '$$' else self.origin + (match[1] or ''), value)
               for name, value in bot_environment.items()},
        }

    def bound(self, backend: Backend) -> Backend:
        _BOUND[backend] = self
        finalize(backend, _close, self._server)
        return backend

    def _forward(self, client: socket.socket) -> None:
        try:
            head, rest = _read_head(client)
        except (OSError, ValueError):
            return
        request_line, *lines = head.split('\r\n')
        target = request_line.split(' ')[1] if request_line.count(' ') == 2 else ''
        path = urlsplit(target).path if target.startswith('/') else ''
        if _resolvable(path):
            _answer(client, 400, 'A Relay path may hold no "." or ".." segment and no encoded "/"')
            return
        provider = path.split('/')[1] if path else ''
        if provider not in self.providers:
            _answer(client, 403, f'The bot settings name no Relay provider "{provider}"')
            return
        if (current := self.current) is None:
            _answer(client, 401, 'No Turn has bound the Credential Service')
            return
        upstream = urlsplit(current.base_url)
        secure = upstream.scheme == 'https'
        upgrade = any(line.split(':', 1)[0].strip().lower() == 'upgrade' for line in lines)
        headers = {'Host': upstream.netloc, 'Authorization': f'Bearer {current.token}', **current.headers, 'Connection': 'Upgrade' if upgrade else 'close'}
        replaced = _REPLACED | {name.lower() for name in headers}
        kept = [line for line in lines if line.split(':', 1)[0].strip().lower() not in replaced]
        signed = '\r\n'.join([request_line, *kept, *(f'{name}: {value}' for name, value in headers.items()), '', '']).encode('latin-1')
        try:
            connection = socket.create_connection((upstream.hostname or '', upstream.port or (443 if secure else 80)))
            if secure:
                trust = ssl.create_default_context(cafile=botcube_config_from_env().get('caBundle'))
                connection = trust.wrap_socket(connection, server_hostname=upstream.hostname)
        except OSError as error:
            log.error('Shell relay could not reach the Credential Service: %s', error)
            _answer(client, 502, 'The Credential Service could not be reached')
            return
        with connection:
            connection.sendall(signed + rest)
            _carry(client, connection)


def renew(backend: object, relay: ModelRelay | None) -> None:
    """Sign the requests of `backend`'s shell with this Turn's relay; none, the shell's requests are refused."""
    if (shell_relay := _BOUND.get(backend)) is not None:
        shell_relay.current = relay


def _resolvable(path: str) -> bool:
    """Whether a hop that normalizes paths could take `path` to another provider than its first segment names."""
    return '%2f' in path.lower() or any(unquote(segment) in {'.', '..'} for segment in path.split('/'))


def _close(server: socketserver.ThreadingTCPServer) -> None:
    def close() -> None:
        server.shutdown()
        server.server_close()

    Thread(target=close, name='shell-relay-close', daemon=True).start()


def _answer(client: socket.socket, status: int, message: str) -> None:
    body = message.encode()
    with contextlib.suppress(OSError):
        client.sendall(f'HTTP/1.1 {status} {_REASONS[status]}\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: {len(body)}\r\n\r\n'.encode() + body)


_REASONS = {400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 502: 'Bad Gateway'}
