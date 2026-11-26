"""Client TLS for BotCube Endpoints (ADR 0091)."""
from __future__ import annotations

import contextlib
import logging
import os
import socket
import ssl
from collections.abc import Callable, Generator, Mapping
from threading import Lock
from time import time
from typing import Annotated, Any, Literal

import anyio
import httpcore
from botcube_credential_source import (
    ALLOW_COMMAND_CREDENTIALS_ENV,
    Credential,
    CredentialSource,
    CredentialSourceError,
    stdout_of,
)
from cryptography import x509
from pydantic import (
    AfterValidator,
    AnyUrl,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)

log = logging.getLogger(__name__)


def _uri(value: str) -> str:
    AnyUrl(value)
    return value


class _Block(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, populate_by_name=True)


class FileCertificate(_Block):
    certificate: str = Field(pattern='^/')
    key: str = Field(pattern='^/')


class CommandCertificate(_Block):
    command: list[str] = Field(min_length=1)
    timeout_seconds: int = Field(alias='timeoutSeconds', default=30, gt=0)


class TlsConfig(_Block):
    client_certificate: FileCertificate | CommandCertificate | None = Field(alias='clientCertificate', default=None)
    server_identity: Annotated[str, AfterValidator(_uri)] | None = Field(alias='serverIdentity', default=None)

    @model_validator(mode='after')
    def _certificate_or_identity(self) -> TlsConfig:
        if self.client_certificate is None and self.server_identity is None:
            raise ValueError('Expected a clientCertificate, a serverIdentity or both')
        return self


class EndpointTlsError(RuntimeError):
    pass


class EndpointTls:
    def __init__(self, seam: str, config: TlsConfig | None, env: Mapping[str, str]) -> None:
        self._seam = seam
        self._expected = config.server_identity if config else None
        self._load = _certificate_loader(seam, config.client_certificate, env) if config else None

    def validate_client_certificate(self) -> None:
        self._context()

    def _context(self, base: Callable[[], ssl.SSLContext] = ssl.create_default_context) -> ssl.SSLContext:
        """A context for one new connection: `base`'s trust roots, the client certificate as read now, and no hostname check under an identity."""
        context = base()
        if self._expected is not None:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_REQUIRED
        if self._load is not None:
            self._load(context)
        return context

    def _check(self, peer: ssl.SSLSocket | ssl.SSLObject) -> None:
        """Refuse a server whose certificate does not carry the expected identity; call after the handshake, before sending."""
        if self._expected is None:
            return
        certificate = peer.getpeercert() or {}
        received = [str(value) for kind, value in certificate.get('subjectAltName', ()) if kind == 'URI']
        if self._expected not in received:
            raise EndpointTlsError(
                f'{self._seam} TLS: expected server identity {self._expected}, but the server presented {", ".join(received) or "no URI identity"}',
            )


    def secure(self, stream: socket.socket | Callable[[], socket.socket], hostname: str | bytes | None) -> ssl.SSLSocket:
        """Upgrade a connected stream or open it lazily. Return it only after peer verification."""
        try:
            context = self._context()
        except BaseException:
            if isinstance(stream, socket.socket):
                stream.close()
            raise
        sock = stream if isinstance(stream, socket.socket) else stream()
        return self._wrap(sock, context.wrap_socket, server_hostname=hostname)

    def _wrap(
        self, sock: socket.socket, wrap: Callable[..., ssl.SSLSocket], *,
        server_hostname: str | bytes | None, suppress_ragged_eofs: bool = True, session: ssl.SSLSession | None = None,
    ) -> ssl.SSLSocket:
        try:
            secured = wrap(sock, server_hostname=server_hostname, suppress_ragged_eofs=suppress_ragged_eofs, session=session)
        except BaseException:
            sock.close()
            raise
        try:
            self._check(secured)
        except BaseException:
            secured.close()
            raise
        return secured

    async def secure_async(
        self, stream: httpcore.AsyncNetworkStream, hostname: str | None, timeout: float | None,
    ) -> httpcore.AsyncNetworkStream:
        """Upgrade httpcore's Endpoint connection, including one reached through a proxy tunnel."""
        try:
            context = await anyio.to_thread.run_sync(self._context)
            context.set_alpn_protocols(['http/1.1'])
            stream = await stream.start_tls(context, hostname, timeout)
            self._check(stream.get_extra_info('ssl_object'))
        except BaseException as error:
            with anyio.CancelScope(shield=True):
                await stream.aclose()
            if isinstance(error, EndpointTlsError):
                raise httpcore.ConnectError(str(error)) from error
            raise
        return stream

    def urllib3_context(self) -> ssl.SSLContext:
        """Supply urllib3's socket hook so each connection reloads the client certificate."""
        tls = self
        lock = Lock()

        class PerConnection(ssl.SSLContext):
            def wrap_socket(
                self, sock: socket.socket, server_side: bool = False, do_handshake_on_connect: bool = True,
                suppress_ragged_eofs: bool = True, server_hostname: str | bytes | None = None, session: ssl.SSLSession | None = None,
            ) -> ssl.SSLSocket:
                with lock:
                    # urllib3 disables hostname checks before invoking this hook.
                    self.verify_mode = ssl.CERT_REQUIRED
                    self.check_hostname = True
                    try:
                        tls._context(lambda: self)
                    except BaseException:
                        sock.close()
                        raise
                    return tls._wrap(
                        sock, super().wrap_socket, server_hostname=server_hostname,
                        suppress_ragged_eofs=suppress_ragged_eofs, session=session,
                    )

            def wrap_bio(
                self, incoming: ssl.MemoryBIO, outgoing: ssl.MemoryBIO, server_side: bool = False,
                server_hostname: str | bytes | None = None, session: ssl.SSLSession | None = None,
            ) -> ssl.SSLObject:
                raise EndpointTlsError('telemetry TLS: the Endpoint is reached through an https proxy, which the Harness tunnels only over http')

        context = PerConnection(ssl.PROTOCOL_TLS_CLIENT)
        context.load_default_certs()
        return context


def endpoint_tls(seam: str, config: object, *, env: Mapping[str, str] = os.environ) -> EndpointTls:
    """The TLS block of `seam`'s Endpoint; a malformed block, or a command the deploy did not opt in to, is refused here, at startup."""
    try:
        parsed = TlsConfig.model_validate(config)
    except ValidationError as error:
        raise EndpointTlsError('\n'.join(f'{seam} TLS: {".".join(str(part) for part in issue["loc"]) or "(root)"}: {issue["msg"]}' for issue in error.errors())) from None
    return EndpointTls(seam, parsed, env)


def _certificate_loader(seam: str, source: FileCertificate | CommandCertificate | None, env: Mapping[str, str]) -> Callable[[ssl.SSLContext], None] | None:
    match source:
        case None:
            return None
        case FileCertificate(certificate=certificate, key=key):

            def load_files(context: ssl.SSLContext) -> None:
                try:
                    context.load_cert_chain(certificate, key)
                except OSError as error:
                    raise EndpointTlsError(f'{seam} client certificate (file {certificate}, file {key}): {error.strerror or error}') from None

            return load_files
        case CommandCertificate(command=command, timeout_seconds=timeout):
            named = f'{seam} client certificate (command {command[0]})'
            if env.get(ALLOW_COMMAND_CREDENTIALS_ENV) != '1':
                raise EndpointTlsError(f'{named}: a command runs only when {ALLOW_COMMAND_CREDENTIALS_ENV}=1')

            credentials = CredentialSource(named, lambda: _exec_certificate(stdout_of(command, timeout)), time)

            def load_printed(context: ssl.SSLContext) -> None:
                try:
                    with _private_file(credentials.get().value) as path:
                        context.load_cert_chain(path)
                except CredentialSourceError as error:
                    raise EndpointTlsError(str(error)) from None
                except OSError as error:
                    raise EndpointTlsError(f'{named}: {_reason(error)}') from None

            return load_printed


_MALFORMED = 'the command did not print a Kubernetes ExecCredential with status.clientCertificateData and status.clientKeyData'


class _ExecStatus(BaseModel):
    client_certificate_data: str = Field(alias='clientCertificateData', min_length=1)
    client_key_data: str = Field(alias='clientKeyData', min_length=1)
    expiration_timestamp: AwareDatetime | None = Field(alias='expirationTimestamp', default=None)


class _ExecCredential(BaseModel):
    """A Kubernetes `ExecCredential` carrying a client certificate, as a credential plugin prints it."""

    kind: Literal['ExecCredential']
    status: _ExecStatus


def _exec_certificate(stdout: str) -> Credential:
    """The printed certificate and key as one PEM; a malformed print is refused without echoing it, as it may hold the key."""
    try:
        status = _ExecCredential.model_validate_json(stdout).status
    except ValidationError:
        raise ValueError(_MALFORMED) from None
    pem = f'{status.client_key_data.rstrip()}\n{status.client_certificate_data.rstrip()}\n'
    try:
        with _private_file(pem) as path:
            ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_cert_chain(path)
        expiry = status.expiration_timestamp or x509.load_pem_x509_certificate(status.client_certificate_data.encode()).not_valid_after_utc
    except (OSError, ValueError):
        raise ValueError('the command printed an invalid client certificate or key') from None
    return Credential(pem, expiry.timestamp())


def _reason(error: BaseException) -> str:
    # An ssl error reads `[SSL] PEM lib`, naming no key material.
    return str(error.strerror) if isinstance(error, OSError) and error.strerror else str(error)


@contextlib.contextmanager
def _private_file(text: str) -> Generator[str]:
    """A path holding `text` only while the context is open, in an anonymous memory file."""
    fd = os.memfd_create('client-certificate', os.MFD_CLOEXEC)
    try:
        with os.fdopen(fd, 'w', closefd=False) as file:
            file.write(text)
        yield f'/proc/self/fd/{fd}'
    finally:
        os.close(fd)


DEFAULT_TLS = EndpointTls('endpoint', None, {})


def refuse(client: socket.socket, doing: str, error: BaseException) -> None:
    """Answer a relay's client 502 with `error`, which names no credential or key."""
    log.error('Proxy relay %s: %s', doing, error)
    message = str(error).encode()
    with contextlib.suppress(OSError):
        client.sendall(
            b'HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n'
            + f'content-length: {len(message)}\r\n\r\n'.encode() + message,
        )


def tls_network_backend(tls: EndpointTls, endpoint_context: ssl.SSLContext) -> httpcore.AsyncNetworkBackend:
    backend = httpcore.AnyIOBackend()
    if not isinstance(backend, httpcore.AsyncNetworkBackend):
        raise RuntimeError('httpcore has no anyio backend')
    return _TlsBackend(backend, tls, endpoint_context)


class _TlsBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, inner: httpcore.AsyncNetworkBackend, tls: EndpointTls, endpoint_context: ssl.SSLContext) -> None:
        self._inner = inner
        self._tls = tls
        self._endpoint_context = endpoint_context

    async def connect_tcp(
        self, host: str, port: int, timeout: float | None = None, local_address: str | None = None, socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        stream = await self._inner.connect_tcp(host, port, timeout=timeout, local_address=local_address, socket_options=socket_options)
        return _TlsStream(stream, self._tls, self._endpoint_context)

    async def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: Any = None) -> httpcore.AsyncNetworkStream:
        return await self._inner.connect_unix_socket(path, timeout=timeout, socket_options=socket_options)

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class _TlsStream(httpcore.AsyncNetworkStream):
    """A connection whose handshake with the Endpoint presents the certificate as read now and checks the identity, before any request byte."""

    def __init__(self, inner: httpcore.AsyncNetworkStream, tls: EndpointTls, endpoint_context: ssl.SSLContext) -> None:
        self._inner = inner
        self._tls = tls
        self._endpoint_context = endpoint_context

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return await self._inner.read(max_bytes, timeout)

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        await self._inner.write(buffer, timeout)

    async def aclose(self) -> None:
        await self._inner.aclose()

    def get_extra_info(self, info: str) -> Any:
        return self._inner.get_extra_info(info)

    async def start_tls(self, ssl_context: ssl.SSLContext, server_hostname: str | None = None, timeout: float | None = None) -> httpcore.AsyncNetworkStream:
        if ssl_context is not self._endpoint_context:
            return _TlsStream(await self._inner.start_tls(ssl_context, server_hostname, timeout), self._tls, self._endpoint_context)
        return await self._tls.secure_async(self._inner, server_hostname, timeout)
