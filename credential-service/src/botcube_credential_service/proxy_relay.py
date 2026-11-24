"""The proxy Endpoint's credential, headers and TLS (ADR 0091) for the Credential Service, the twin of the Harness's `proxy_relay`.

An HTTP client takes its proxy once, so the models relay, when its Endpoint names the proxy, is pointed at this
loopback relay, which opens each request to the proxy the BotCube Config names with the credential file's current
value and the client certificate as read now: a rotated token or certificate reaches the next request. Neither is
read before the first request.
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import socket
import socketserver
import ssl
from collections.abc import Callable, Mapping
from pathlib import Path
from threading import Lock, Thread
from typing import Any
from urllib.parse import urlsplit

from .endpoint_tls import (
    EndpointTls,
    EndpointTlsError,
    connect_proxy,
    endpoint_tls,
    refuse,
)

log = logging.getLogger(__name__)

# The most a client's request head may take before the relay refuses it.
_MAX_HEAD_BYTES = 64 * 1024
# Request headers the relay sets itself, dropping a client's.
_REPLACED = {'proxy-authorization', 'proxy-connection', 'connection'}


def _file_credential(source: Mapping[str, str]) -> Callable[[], str]:
    """A proxy credential, always a file (`proxy.credential` in botcube/config)."""
    if source['kind'] != 'file':
        raise RuntimeError(f"proxy.credential: the proxy credential is a file, not {source['kind']}")
    path = Path(source['path'])

    def read() -> str:
        # Read on each request, so a rotated file reaches the next one.
        try:
            return path.read_text().strip()
        except OSError as error:
            raise RuntimeError(f'proxy credential (file {path}): {error.strerror}') from None

    return read


_relays: dict[str, str] = {}
_relays_lock = Lock()


def proxy_url_from_config(config: Mapping[str, Any], env: Mapping[str, str] = os.environ) -> Callable[[], str] | None:
    """
    Where this process's clients reach the BotCube Config's proxy, or None without one: the proxy's own URL, or, for a
    proxy taking a credential, headers or TLS, one loopback relay per process, started when first asked for.
    """
    proxy = config['integrations']['proxy']
    if proxy['kind'] == 'none':
        return None
    if not {'credential', 'headers', 'tls'} & proxy.keys():
        return lambda: proxy['url']
    key = json.dumps(proxy, sort_keys=True)
    credential = _file_credential(proxy['credential']) if 'credential' in proxy else None
    tls = endpoint_tls('proxy', proxy['tls'], env=env) if 'tls' in proxy else None

    def relay() -> str:
        with _relays_lock:
            if key not in _relays:
                _relays[key] = start_proxy_relay(upstream=proxy['url'], listen=('127.0.0.1', 0), credential=credential, headers=proxy.get('headers', {}), tls=tls)
            return _relays[key]

    return relay


def relay_provider_proxy(config: Mapping[str, Any], provider: str, env: Mapping[str, str] = os.environ) -> Callable[[], str] | None:
    """Where the Relay provider `provider` reaches its upstream through the proxy, as `proxy_url_from_config`, or None for direct."""
    named = (config['integrations'].get('relayProviders') or {}).get(provider, {})
    return proxy_url_from_config(config, env) if named.get('proxy') else None


def start_proxy_relay(
    *, upstream: str, listen: tuple[str, int], credential: Callable[[], str] | None, headers: Mapping[str, str], tls: EndpointTls | None = None,
) -> str:
    """Serve `listen` as a forward proxy that sends each request on to `upstream`, authenticated; its proxy URL."""
    target = urlsplit(upstream)
    secure = target.scheme == 'https'
    address = (target.hostname or '', target.port or (443 if secure else 80))

    class Relay(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            client: socket.socket = self.request
            try:
                head, rest = _read_head(client)
                authorization = f'Bearer {credential()}' if credential else None
                context = (tls.context() if tls else ssl.create_default_context()) if secure else None
            except Exception as error:
                refuse(client, f'could not open a request through {upstream}', error)
                return
            try:
                proxy = connect_proxy(address, context, tls)
            except EndpointTlsError as error:
                refuse(client, f'refused {upstream}', error)
                return
            except OSError as error:
                log.error('Proxy relay could not reach %s: %s', upstream, error)
                return
            with proxy:
                proxy.sendall(_rewrite(head, authorization, headers) + rest)
                _carry(client, proxy)

    server = socketserver.ThreadingTCPServer(listen, Relay)
    server.daemon_threads = True
    Thread(target=server.serve_forever, name='proxy-relay', daemon=True).start()
    return f'http://{listen[0]}:{server.server_address[1]}'


def _read_head(client: socket.socket) -> tuple[str, bytes]:
    buffered = b''
    while b'\r\n\r\n' not in buffered:
        if len(buffered) > _MAX_HEAD_BYTES:
            raise ValueError(f'the request head is over {_MAX_HEAD_BYTES} bytes')
        chunk = client.recv(65536)
        if not chunk:
            raise ConnectionError('the client closed before its request head ended')
        buffered += chunk
    head, rest = buffered.split(b'\r\n\r\n', 1)
    return head.decode('latin-1'), rest


def _rewrite(head: str, authorization: str | None, headers: Mapping[str, str]) -> bytes:
    """The head with the client's own proxy credential dropped and the relay's set; a plain HTTP request closes after."""
    request_line, *lines = head.split('\r\n')
    kept = [line for line in lines if line.split(':', 1)[0].strip().lower() not in _REPLACED]
    added = [
        *([f'Proxy-Authorization: {authorization}'] if authorization else []),
        *(f'{name}: {value}' for name, value in headers.items()),
        *([] if request_line.startswith('CONNECT ') else ['Connection: close']),
    ]
    return '\r\n'.join([request_line, *kept, *added, '', '']).encode('latin-1')


def _carry(client: socket.socket, proxy: socket.socket) -> None:
    """Carry bytes both ways until either side closes."""

    def pump(source: socket.socket, sink: socket.socket) -> None:
        try:
            while chunk := source.recv(65536):
                sink.sendall(chunk)
        except OSError:
            pass
        finally:
            for side in (sink, source):
                with contextlib.suppress(OSError):
                    side.shutdown(socket.SHUT_RDWR)

    back = Thread(target=pump, args=(proxy, client), daemon=True)
    back.start()
    pump(client, proxy)
    back.join()
