"""An Endpoint's TLS (ADR 0091), the Python twin of botcube/chat's `endpoint-tls.ts`.

botcube/harness/deepagents holds a byte-identical copy of botcube/credential-service's, where its behaviour is tested.

The client certificate an Endpoint presents is read again for each new connection, so a rotated one is used without a
restart, and the server identity it expects, a URI or SPIFFE ID, is matched against the server certificate's URI SAN
in place of its hostname; the chain is still verified against the trust roots. The environment carries only the
certificate's paths or command: a key printed by a command lives in an anonymous file only while it is loaded.
"""
from __future__ import annotations

import contextlib
import logging
import os
import socket
import ssl
from collections.abc import Callable, Generator, Mapping
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)

from .credential_source import ALLOW_COMMAND_CREDENTIALS_ENV, stdout_of

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
    def __init__(self, seam: str, config: TlsConfig, env: Mapping[str, str]) -> None:
        self._seam = seam
        self._expected = config.server_identity
        self._load = _certificate_loader(seam, config.client_certificate, env)

    def context(self, base: Callable[[], ssl.SSLContext] = ssl.create_default_context) -> ssl.SSLContext:
        """A context for one new connection: `base`'s trust roots, the client certificate as read now, and no hostname check under an identity."""
        context = base()
        if self._expected is not None:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_REQUIRED
        if self._load is not None:
            self._load(context)
        return context

    def check(self, peer: ssl.SSLSocket | ssl.SSLObject) -> None:
        """Refuse a server whose certificate does not carry the expected identity; call after the handshake, before sending."""
        if self._expected is None:
            return
        certificate = peer.getpeercert() or {}
        received = [str(value) for kind, value in certificate.get('subjectAltName', ()) if kind == 'URI']
        if self._expected not in received:
            raise EndpointTlsError(
                f'{self._seam} TLS: expected server identity {self._expected}, but the server presented {", ".join(received) or "no URI identity"}',
            )


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

            def load_printed(context: ssl.SSLContext) -> None:
                try:
                    pem = _exec_certificate(stdout_of(command, timeout))
                    with _private_file(pem) as path:
                        context.load_cert_chain(path)
                except (OSError, ValueError, RuntimeError) as error:
                    raise EndpointTlsError(f'{named}: {_reason(error)}') from None

            return load_printed


_MALFORMED = 'the command did not print a Kubernetes ExecCredential with status.clientCertificateData and status.clientKeyData'


class _ExecStatus(BaseModel):
    client_certificate_data: str = Field(alias='clientCertificateData', min_length=1)
    client_key_data: str = Field(alias='clientKeyData', min_length=1)


class _ExecCredential(BaseModel):
    """A Kubernetes `ExecCredential` carrying a client certificate, as a credential plugin prints it."""

    kind: Literal['ExecCredential']
    status: _ExecStatus


def _exec_certificate(stdout: str) -> str:
    """The printed certificate and key as one PEM; a malformed print is refused without echoing it, as it may hold the key."""
    try:
        status = _ExecCredential.model_validate_json(stdout).status
    except ValidationError:
        raise ValueError(_MALFORMED) from None
    return f'{status.client_key_data.rstrip()}\n{status.client_certificate_data.rstrip()}\n'


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


def connect_proxy(address: tuple[str, int], context: ssl.SSLContext | None, tls: EndpointTls | None) -> socket.socket:
    """
    A connection to the proxy at `address`, over TLS when `context` is given, its chain verified and identity checked
    before any byte is sent. Raises `EndpointTlsError` for a refused identity, `OSError` for anything else.
    """
    proxy = socket.create_connection(address)
    if context is None:
        return proxy
    try:
        secured = context.wrap_socket(proxy, server_hostname=address[0])
    except OSError:
        proxy.close()
        raise
    if tls is not None:
        try:
            tls.check(secured)
        except EndpointTlsError:
            secured.close()
            raise
    return secured


def refuse(client: socket.socket, doing: str, error: BaseException) -> None:
    """Answer a relay's client 502 with `error`, which names no credential or key."""
    log.error('Proxy relay %s: %s', doing, error)
    message = str(error).encode()
    with contextlib.suppress(OSError):
        client.sendall(
            b'HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n'
            + f'content-length: {len(message)}\r\n\r\n'.encode() + message,
        )
