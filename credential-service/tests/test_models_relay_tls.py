from __future__ import annotations

import contextlib
import socket
from collections.abc import Generator, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.endpoint_tls import EndpointTlsError
from botcube_credential_service.invocation import sign_credential_service_invocation
from botcube_credential_service.models import models_provider_from_config
from botcube_credential_service.server import CredentialServiceSettings, create_app
from mtls_fake import (
    IMPOSTOR_IDENTITY,
    SERVER_IDENTITY,
    Certificates,
    certificates,
    mtls_front,
    mtls_proxy,
)

pytestmark = pytest.mark.integration

SECRET = 'credential-service-secret'
BODY = b'{"model":"echo","messages":[{"role":"user","content":"Hello"}]}'
ANSWER = b'{"id":"c1","object":"chat.completion","choices":[]}'


class _Gateway(BaseHTTPRequestHandler):
    """A plain OpenAI-compatible stand-in behind the mTLS front: records each request's bearer and answers a completion."""

    protocol_version = 'HTTP/1.1'
    bearers: ClassVar[list[str]] = []

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get('content-length') or 0))
        type(self).bearers.append(self.headers.get('authorization') or '')
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(ANSWER)))
        self.end_headers()
        self.wfile.write(ANSWER)

    def log_message(self, format: str, *args: object) -> None:
        return


@pytest.fixture(scope='module')
def certs(tmp_path_factory: pytest.TempPathFactory) -> Certificates:
    return certificates(tmp_path_factory.mktemp('mtls'))


@pytest.fixture(autouse=True)
def trusted(certs: Certificates, monkeypatch: pytest.MonkeyPatch) -> None:
    # The stand-in CA as the trust roots, as SSL_CERT_FILE sets them in a deployment; no proxy unless a test sets one.
    monkeypatch.setenv('SSL_CERT_FILE', str(certs.authority))
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def gateway() -> Iterator[int]:
    server = ThreadingHTTPServer(('127.0.0.1', 0), _Gateway)
    server.daemon_threads = True
    Thread(target=server.serve_forever, daemon=True).start()
    _Gateway.bearers = []
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def key(tmp_path: Path) -> Path:
    path = tmp_path / 'models-api-key'
    path.write_text('sk-mounted\n')
    return path


@contextlib.contextmanager
def _credential_service(port: int, key: Path, tls: dict[str, Any], proxy: dict[str, Any] | None = None) -> Generator[TestClient]:
    endpoint = {'url': f'https://127.0.0.1:{port}/v1', 'credential': {'kind': 'file', 'path': str(key)}, 'tls': tls, **({'proxy': 'integrations.proxy'} if proxy else {})}
    integrations = {'modelGateway': {'kind': 'openai-compatible', **endpoint}, 'proxy': proxy or {'kind': 'none'}}
    provider = models_provider_from_config(CredentialAuditRecorder(), {'integrations': integrations}, {})
    assert provider is not None
    settings = CredentialServiceSettings(name='test-credential-service', invocation_secret=lambda: SECRET)
    with TestClient(create_app(settings, [provider])) as client:
        yield client


def _completion(client: TestClient) -> Any:
    token = sign_credential_service_invocation(SECRET, 'acct-1', 'thread-1', model_provider='example', model_id='echo')
    headers = {'Authorization': f'Bearer {token}', 'X-BotCube-Session-Id': 'thread-1', 'content-type': 'application/json'}
    return client.post('/models/openai/chat/completions', content=BODY, headers=headers)


def test_the_agents_model_calls_present_the_client_certificate_to_an_endpoint_carrying_the_expected_identity(
    certs: Certificates, gateway: int, key: Path,
) -> None:
    with mtls_front(certs, gateway) as front, _credential_service(front.port, key, {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY}) as client:
        response = _completion(client)

        assert (response.status_code, response.content) == (200, ANSWER)
        assert front.clients == ['client-a']
        assert _Gateway.bearers == ['Bearer sk-mounted']


def test_a_replaced_certificate_is_presented_on_the_next_connection_without_a_restart(
    certs: Certificates, gateway: int, key: Path, tmp_path: Path,
) -> None:
    pair = certs.rotate('client_a', tmp_path / 'svid')
    with mtls_front(certs, gateway) as front, _credential_service(front.port, key, {'clientCertificate': pair, 'serverIdentity': SERVER_IDENTITY}) as client:
        _completion(client)
        certs.rotate('client_b', tmp_path / 'svid')
        front.drop()
        _completion(client)

        assert front.clients == ['client-a', 'client-b']


def test_an_endpoint_carrying_another_identity_is_refused_before_the_bearer_is_sent_naming_both(
    certs: Certificates, gateway: int, key: Path,
) -> None:
    with mtls_front(certs, gateway, 'impostor') as front, _credential_service(front.port, key, {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY}) as client:
        response = _completion(client)

        assert response.status_code == 500
        assert response.json()['error']['type'] == 'models_endpoint'
        assert f'expected server identity {SERVER_IDENTITY}, but the server presented {IMPOSTOR_IDENTITY}' in response.json()['error']['message']
        assert 'PRIVATE KEY' not in response.text
        assert _Gateway.bearers == []


def test_the_agents_model_calls_go_through_the_proxys_relay_when_the_endpoint_names_it_presenting_both_certificates(
    certs: Certificates, gateway: int, key: Path,
) -> None:
    with mtls_front(certs, gateway) as front, mtls_proxy(certs, routes={f'127.0.0.1:{front.port}': front.port}) as proxy:
        through = {'kind': 'forward', 'url': proxy.url, 'tls': {'clientCertificate': certs.files('client_b'), 'serverIdentity': SERVER_IDENTITY}}
        with _credential_service(front.port, key, {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY}, through) as client:
            response = _completion(client)

        assert response.status_code == 200
        assert (proxy.hosts(), proxy.clients(), front.clients) == ([f'127.0.0.1:{front.port}'], ['client-b'], ['client-a'])


def test_the_agents_model_calls_go_direct_when_the_endpoint_names_no_proxy(certs: Certificates, gateway: int, key: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with mtls_front(certs, gateway) as front, mtls_proxy(certs, routes={f'127.0.0.1:{front.port}': front.port}) as proxy:
        monkeypatch.setenv('HTTPS_PROXY', proxy.url)
        with _credential_service(front.port, key, {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY}) as client:
            response = _completion(client)

        assert response.status_code == 200
        assert (proxy.hosts(), front.clients) == ([], ['client-a'])


def test_an_impostor_reached_through_an_https_proxy_is_refused_before_the_bearer_is_sent(
    certs: Certificates, gateway: int, key: Path,
) -> None:
    with mtls_front(certs, gateway, 'impostor') as front, mtls_proxy(certs, 'localhost', {f'127.0.0.1:{front.port}': front.port}, client_certificate=False) as proxy:
        through = {'kind': 'forward', 'url': proxy.url}
        with _credential_service(front.port, key, {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY}, through) as client:
            response = _completion(client)

        assert proxy.hosts() == [f'127.0.0.1:{front.port}']
        assert f'expected server identity {SERVER_IDENTITY}, but the server presented {IMPOSTOR_IDENTITY}' in response.json()['error']['message']
        assert front.clients == ['client-a']
        assert _Gateway.bearers == []


def test_startup_fails_naming_the_models_seam_and_the_file_when_the_certificate_cannot_be_read(key: Path, tmp_path: Path) -> None:
    endpoint = {
        'url': 'https://models.example.com/v1', 'credential': {'kind': 'file', 'path': str(key)},
        'tls': {'clientCertificate': {'certificate': str(tmp_path / 'svid.pem'), 'key': str(tmp_path / 'svid-key.pem')}},
    }

    with pytest.raises(EndpointTlsError, match=r'^models client certificate \(file .*svid\.pem, file .*svid-key\.pem\)'):
        models_provider_from_config(CredentialAuditRecorder(), {'integrations': {'modelGateway': {'kind': 'openai-compatible', **endpoint}}}, {})


def test_startup_fails_when_the_endpoint_url_cannot_carry_tls(key: Path) -> None:
    endpoint = {'url': 'http://models.example.com/v1', 'credential': {'kind': 'file', 'path': str(key)}, 'tls': {'serverIdentity': SERVER_IDENTITY}}

    with pytest.raises(EndpointTlsError, match=r'^models TLS: the Endpoint http://models\.example\.com/v1 is not https'):
        models_provider_from_config(CredentialAuditRecorder(), {'integrations': {'modelGateway': {'kind': 'openai-compatible', **endpoint}}}, {})


def test_an_impostor_is_refused_however_the_endpoint_host_is_spelt(certs: Certificates, gateway: int, key: Path) -> None:
    with mtls_front(certs, gateway, 'impostor') as front:
        endpoint = {'url': f'https://LocalHost:{front.port}/v1', 'credential': {'kind': 'file', 'path': str(key)}, 'tls': {'serverIdentity': SERVER_IDENTITY}}
        provider = models_provider_from_config(CredentialAuditRecorder(), {'integrations': {'modelGateway': {'kind': 'openai-compatible', **endpoint}}}, {})
        assert provider is not None
        settings = CredentialServiceSettings(name='test-credential-service', invocation_secret=lambda: SECRET)
        with TestClient(create_app(settings, [provider])) as client:
            response = _completion(client)

        assert f'but the server presented {IMPOSTOR_IDENTITY}' in response.json()['error']['message']
        assert _Gateway.bearers == []


def test_an_unreachable_endpoint_with_tls_still_reads_as_dropped_before_any_response(key: Path) -> None:
    with socket.socket() as closed:
        closed.bind(('127.0.0.1', 0))
        port = closed.getsockname()[1]
    with _credential_service(port, key, {'serverIdentity': SERVER_IDENTITY}) as client:
        response = _completion(client)

    assert response.status_code == 502


def test_an_empty_tls_block_is_refused_at_startup_not_read_as_no_tls(key: Path) -> None:
    endpoint = {'url': 'https://models.example.com/v1', 'credential': {'kind': 'file', 'path': str(key)}, 'tls': {}}

    with pytest.raises(EndpointTlsError, match=r'^models TLS: '):
        models_provider_from_config(CredentialAuditRecorder(), {'integrations': {'modelGateway': {'kind': 'openai-compatible', **endpoint}}}, {})
