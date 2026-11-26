"""A stand-in mTLS forward proxy and its certificates, the Python twin of botcube/chat's `test/fakes/mtls.ts`."""
from __future__ import annotations

import contextlib
import json
import shutil
import socket
import socketserver
import ssl
import subprocess
from collections.abc import Generator
from dataclasses import dataclass, field
from pathlib import Path
from threading import Thread

# The SPIFFE ID the stand-in's server certificate carries, as its only identity: no DNS or IP SAN, as a SPIFFE SVID.
SERVER_IDENTITY = 'spiffe://example.org/ns/egress/sa/proxy'
IMPOSTOR_IDENTITY = 'spiffe://example.org/ns/other/sa/impostor'
_EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']


@dataclass(frozen=True)
class Certificates:
    dir: Path

    @property
    def authority(self) -> Path:
        return self.dir / 'ca.pem'

    def files(self, name: str) -> dict[str, str]:
        """A certificate's PEM chain and key, as a BotCube Config's file pair names them."""
        return {'certificate': str(self.dir / f'{name}.pem'), 'key': str(self.dir / f'{name}.key')}

    def exec_credential(self, name: str) -> str:
        """The Kubernetes ExecCredential a certificate command prints for `name`."""
        status = {'clientCertificateData': (self.dir / f'{name}.pem').read_text(), 'clientKeyData': (self.dir / f'{name}.key').read_text()}
        return json.dumps({'kind': 'ExecCredential', 'status': status})

    def rotate(self, name: str, to: Path) -> dict[str, str]:
        """Copy `name`'s certificate and key over the pair at `to`, as a SPIFFE helper replaces them."""
        shutil.copyfile(self.dir / f'{name}.pem', to.with_suffix('.pem'))
        shutil.copyfile(self.dir / f'{name}.key', to.with_suffix('.key'))
        return {'certificate': str(to.with_suffix('.pem')), 'key': str(to.with_suffix('.key'))}


def certificates(directory: Path) -> Certificates:
    """A CA, server certificates carrying a URI SAN, one from outside the CA, and two client certificates to rotate between."""

    def openssl(*args: str) -> None:
        subprocess.run(['openssl', *args], cwd=directory, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def leaf(name: str, common_name: str, san: str, usage: str) -> None:
        openssl('req', '-new', *_EC, '-subj', f'/CN={common_name}', '-addext', f'subjectAltName={san}', '-addext', f'extendedKeyUsage={usage}',
                '-keyout', f'{name}.key', '-out', f'{name}.csr')
        openssl('x509', '-req', '-in', f'{name}.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-copy_extensions', 'copy', '-out', f'{name}.pem')

    openssl('req', '-x509', *_EC, '-days', '1', '-subj', '/CN=Stand-in CA', '-addext', 'basicConstraints=critical,CA:TRUE',
            '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'ca.key', '-out', 'ca.pem')
    leaf('server', 'egress proxy', f'URI:{SERVER_IDENTITY}', 'serverAuth')
    leaf('impostor', 'impostor', f'URI:{IMPOSTOR_IDENTITY}', 'serverAuth')
    (directory / 'spoof.ext').write_text(f'extendedKeyUsage=serverAuth\nsubjectAltName=@alt\n[alt]\nURI.1 = spiffe://example.org/x, URI:{SERVER_IDENTITY}\n')
    openssl('req', '-new', *_EC, '-subj', '/CN=spoof', '-keyout', 'spoof.key', '-out', 'spoof.csr')
    openssl('x509', '-req', '-in', 'spoof.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1',
            '-extfile', 'spoof.ext', '-out', 'spoof.pem')
    leaf('localhost', 'localhost', 'IP:127.0.0.1', 'serverAuth')
    leaf('client_a', 'client-a', 'URI:spiffe://example.org/ns/botcube/sa/credential-service', 'clientAuth')
    leaf('client_b', 'client-b', 'URI:spiffe://example.org/ns/botcube/sa/credential-service', 'clientAuth')
    openssl('req', '-x509', *_EC, '-days', '1', '-subj', '/CN=untrusted', '-addext', f'subjectAltName=URI:{SERVER_IDENTITY}',
            '-keyout', 'untrusted.key', '-out', 'untrusted.pem')
    return Certificates(directory)


@dataclass
class MtlsProxy:
    """An mTLS forward proxy: records each connection's client common name and request head, and tunnels a CONNECT to its route or echoes it."""

    url: str
    connections: list[tuple[str | None, str]] = field(default_factory=list)

    def clients(self) -> list[str | None]:
        return [client for client, _ in self.connections]

    def hosts(self) -> list[str]:
        return [head.split(' ')[1] for _, head in self.connections if head.startswith('CONNECT ')]


@contextlib.contextmanager
def mtls_proxy(
    certs: Certificates, server: str = 'server', routes: dict[str, int] | None = None, client_certificate: bool = True,
) -> Generator[MtlsProxy]:
    context = _server_context(certs, server, client_certificate)
    proxy = MtlsProxy('')

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            try:
                tls = context.wrap_socket(self.request, server_side=True)
            except (ssl.SSLError, OSError):
                return
            with tls:
                subject = {key: value for rdn in (tls.getpeercert() or {}).get('subject', ()) for key, value in rdn}
                buffered = b''
                while b'\r\n\r\n' not in buffered:
                    chunk = tls.recv(4096)
                    if not chunk:
                        return
                    buffered += chunk
                head, rest = buffered.split(b'\r\n\r\n', 1)
                proxy.connections.append((subject.get('commonName'), head.decode('latin-1')))
                route = (routes or {}).get(head.decode('latin-1').split(' ')[1])
                if route is None:
                    tls.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n' + rest)
                    with contextlib.suppress(OSError):
                        while chunk := tls.recv(4096):
                            tls.sendall(chunk)
                    return
                with socket.create_connection(('127.0.0.1', route)) as target:
                    tls.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                    target.sendall(rest)
                    _carry(tls, target)

    server_ = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
    server_.daemon_threads = True
    Thread(target=server_.serve_forever, daemon=True).start()
    proxy.url = f'https://127.0.0.1:{server_.server_address[1]}'
    try:
        yield proxy
    finally:
        server_.shutdown()
        server_.server_close()


def _server_context(certs: Certificates, server: str, client_certificate: bool = True) -> ssl.SSLContext:
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH, cafile=str(certs.authority))
    context.verify_mode = ssl.CERT_REQUIRED if client_certificate else ssl.CERT_NONE
    context.load_cert_chain(str(certs.dir / f'{server}.pem'), str(certs.dir / f'{server}.key'))
    return context


def _carry(one: socket.socket, other: socket.socket) -> None:
    def pump(source: socket.socket, sink: socket.socket) -> None:
        with contextlib.suppress(OSError):
            while chunk := source.recv(65536):
                sink.sendall(chunk)
        for side in (sink, source):
            with contextlib.suppress(OSError):
                side.shutdown(socket.SHUT_RDWR)

    back = Thread(target=pump, args=(other, one), daemon=True)
    back.start()
    pump(one, other)
    back.join()


@dataclass
class MtlsFront:
    """An mTLS front for a plain HTTP stand-in, as a gateway terminates TLS in front of the models."""

    port: int = 0
    clients: list[str | None] = field(default_factory=list)
    open: set[socket.socket] = field(default_factory=set)

    def drop(self) -> None:
        """Close every open connection, so the next request opens a new one."""
        for each in list(self.open):
            with contextlib.suppress(OSError):
                each.shutdown(socket.SHUT_RDWR)


@contextlib.contextmanager
def mtls_front(certs: Certificates, target: int, server: str = 'server') -> Generator[MtlsFront]:
    context = _server_context(certs, server)
    front = MtlsFront()

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            try:
                tls = context.wrap_socket(self.request, server_side=True)
            except (ssl.SSLError, OSError):
                return
            subject = {key: value for rdn in (tls.getpeercert() or {}).get('subject', ()) for key, value in rdn}
            front.clients.append(subject.get('commonName'))
            front.open.add(tls)
            try:
                with tls, socket.create_connection(('127.0.0.1', target)) as upstream:
                    _carry(tls, upstream)
            finally:
                front.open.discard(tls)

    server_ = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
    server_.daemon_threads = True
    Thread(target=server_.serve_forever, daemon=True).start()
    front.port = server_.server_address[1]
    try:
        yield front
    finally:
        front.drop()
        server_.shutdown()
        server_.server_close()


def tunnel(relay: str, tunnelled: bytes = b'hello') -> bytes:
    """Opens a CONNECT through the relay and sends `tunnelled` once answered; everything the relay sent back."""
    host, port = relay.removeprefix('http://').split(':')
    with socket.create_connection((host, int(port)), timeout=5) as client:
        client.sendall(b'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\n\r\n')
        received = b''
        while b'\r\n\r\n' not in received:
            chunk = client.recv(4096)
            if not chunk:
                return received
            received += chunk
        if not received.startswith(b'HTTP/1.1 200'):
            while chunk := client.recv(4096):
                received += chunk
            return received
        client.sendall(tunnelled)
        while not received.endswith(tunnelled):
            chunk = client.recv(4096)
            if not chunk:
                break
            received += chunk
        return received
