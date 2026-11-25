"""The telemetry Endpoint's credential, TLS and proxy on the Harness's OTLP exporter.

OpenTelemetry Python loads this as the `botcube` `opentelemetry_otlp_credential_provider` entry point when
OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER names it, as botcube/config's `telemetry.ts` sets it
beside the BotCube Config's `otlp` Endpoint; the Credential Source and the TLS are read from the file.
"""
from __future__ import annotations

import socket
import ssl
import threading
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from requests.auth import AuthBase

from .credential_source import CredentialSource, credential_source
from .deployment import deployed_config
from .endpoint_tls import EndpointTls, EndpointTlsError, endpoint_tls
from .proxy_relay import proxy_url_from_config


class _Bearer(AuthBase):
    """Sends the source's current value as the bearer, read again before it expires."""

    def __init__(self, source: CredentialSource) -> None:
        self._source = source

    def __call__(self, r: requests.PreparedRequest) -> requests.PreparedRequest:
        r.headers['Authorization'] = f'Bearer {self._source.get().value}'
        return r


class _TlsAdapter(HTTPAdapter):
    """Opens each https connection, direct or through a proxy's tunnel, with the Endpoint's TLS in place of requests' own."""

    def __init__(self, tls: EndpointTls) -> None:
        self._context = _per_connection_context(tls)
        super().__init__()

    def build_connection_pool_key_attributes(
        self, request: requests.PreparedRequest, verify: bool | str, cert: str | tuple[str, str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        host, pool = super().build_connection_pool_key_attributes(request, verify, cert)
        return host, {**pool, 'ssl_context': self._context, 'assert_hostname': False}


def _per_connection_context(tls: EndpointTls) -> ssl.SSLContext:
    """A context that presents the client certificate as read for each new connection, and refuses a server without the
    expected identity before anything is sent; with no identity expected, it checks the hostname itself."""
    lock = threading.Lock()

    class PerConnection(ssl.SSLContext):
        def wrap_socket(
            self, sock: socket.socket, server_side: bool = False, do_handshake_on_connect: bool = True,
            suppress_ragged_eofs: bool = True, server_hostname: str | bytes | None = None, session: ssl.SSLSession | None = None,
        ) -> ssl.SSLSocket:
            with lock:
                # urllib3 turns the hostname check off on this shared context (assert_hostname=False); put it back, and
                # `tls.context` takes it off again only when an identity is expected, which `tls.check` then verifies.
                self.verify_mode = ssl.CERT_REQUIRED
                self.check_hostname = True
                tls.context(lambda: self)
                secured = super().wrap_socket(sock, server_side, do_handshake_on_connect, suppress_ragged_eofs, server_hostname, session)
            tls.check(secured)
            return secured

        def wrap_bio(
            self, incoming: ssl.MemoryBIO, outgoing: ssl.MemoryBIO, server_side: bool = False,
            server_hostname: str | bytes | None = None, session: ssl.SSLSession | None = None,
        ) -> ssl.SSLObject:
            raise EndpointTlsError('telemetry TLS: the Endpoint is reached through an https proxy, which the Harness tunnels only over http')

    context = PerConnection(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs()
    return context


def telemetry_session() -> requests.Session:
    """A session that authenticates each export with the telemetry credential and connects with the TLS the deploy set,
    through the BotCube Config's proxy when the telemetry Endpoint names it."""
    source = telemetry_credential()
    tls = telemetry_tls()
    proxy = telemetry_proxy()
    if source is None and tls is None and proxy is None:
        raise RuntimeError(
            'The BotCube Config names no telemetry.credential, telemetry.tls or telemetry.proxy; the deploy sets the botcube OTLP credential provider only beside one',
        )
    session = requests.Session()
    if proxy is not None:
        session.proxies = {'http': proxy, 'https': proxy}
    if source is not None:
        session.auth = _Bearer(source)
    if tls is not None:
        session.mount('https://', _TlsAdapter(tls))
    return session


def telemetry_credential() -> CredentialSource | None:
    """The BotCube Config's `otlp` Endpoint credential, or None."""
    telemetry = deployed_config()['config']['integrations']['telemetry']
    return credential_source('telemetry.credential', telemetry['credential']) if 'credential' in telemetry else None


def telemetry_proxy() -> str | None:
    """Where the BotCube Config's `otlp` Endpoint is reached through, when it names the proxy, or None."""
    config = deployed_config()['config']
    url = proxy_url_from_config(config) if 'proxy' in config['integrations']['telemetry'] else None
    return url() if url else None


def telemetry_tls() -> EndpointTls | None:
    """The BotCube Config's `otlp` Endpoint TLS, or None."""
    telemetry = deployed_config()['config']['integrations']['telemetry']
    return endpoint_tls('telemetry', telemetry['tls']) if 'tls' in telemetry else None
