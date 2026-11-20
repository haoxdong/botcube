"""The proxy Endpoint's credential and headers (ADR 0091) for the Credential Service, the twin of the Harness's `proxy_relay`.

The OpenAI relay and the sign-in socket read HTTP(S)_PROXY, so the deploy points them at this loopback relay
(`proxyEnvironment` in botcube/deployment-config), which opens each request to the proxy the Deployment Config names
with the credential file's current value: a rotated token reaches the next request.
"""
from __future__ import annotations

import contextlib
import logging
import os
import socket
import socketserver
import ssl
from collections.abc import Callable, Mapping
from pathlib import Path
from threading import Thread
from typing import Any
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

# The most a client's request head may take before the relay refuses it.
_MAX_HEAD_BYTES = 64 * 1024
# Request headers the relay sets itself, dropping a client's.
_REPLACED = {'proxy-authorization', 'proxy-connection', 'connection'}


def _file_credential(source: Mapping[str, str]) -> Callable[[], str]:
    """A proxy credential, always a file (`proxy.credential` in botcube/deployment-config)."""
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


def start_proxy_relay_from_config(config: Mapping[str, Any], env: Mapping[str, str] = os.environ) -> str | None:
    """The relay for the Deployment Config's proxy, listening where HTTPS_PROXY points; None unless it has a credential or headers."""
    proxy = config['proxy']
    if proxy['kind'] == 'none' or ('credential' not in proxy and 'headers' not in proxy):
        return None
    listen = urlsplit(env.get('HTTPS_PROXY') or '')
    if not listen.hostname or listen.port is None:
        raise RuntimeError("HTTPS_PROXY is unset beside the Deployment Config's proxy credential or headers; the deploy points it at the proxy relay")
    credential = _file_credential(proxy['credential']) if 'credential' in proxy else None
    return start_proxy_relay(upstream=proxy['url'], listen=(listen.hostname, listen.port), credential=credential, headers=proxy.get('headers', {}))


def start_proxy_relay(*, upstream: str, listen: tuple[str, int], credential: Callable[[], str] | None, headers: Mapping[str, str]) -> str:
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
            except Exception as error:
                log.error('Proxy relay could not open a request through %s: %s', upstream, error)
                message = str(error).encode()
                client.sendall(
                    b'HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n'
                    + f'content-length: {len(message)}\r\n\r\n'.encode() + message,
                )
                return
            try:
                proxy = socket.create_connection(address)
                if secure:
                    proxy = ssl.create_default_context().wrap_socket(proxy, server_hostname=address[0])
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
