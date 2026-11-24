"""The Harness's traces to an OTLP Endpoint with TLS (ADR 0091), at a stand-in mTLS collector."""
from __future__ import annotations

import logging
import threading
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

from botcube_harness_deepagents.trace_relay import start_trace_relay
from credential_service_fakes import mtls_fake
from deployment_fixture import deploy

pytestmark = pytest.mark.integration


@dataclass
class Collector:
    port: int
    exports: list[bytes] = field(default_factory=list)
    received: threading.Event = field(default_factory=threading.Event)


@pytest.fixture
def collector() -> Iterator[Collector]:
    server = ThreadingHTTPServer(('127.0.0.1', 0), BaseHTTPRequestHandler)
    collected = Collector(server.server_port)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            collected.exports.append(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
            collected.received.set()

        def log_message(self, format: str, *args: object) -> None:
            return

    server.RequestHandlerClass = Handler
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield collected
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def certs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    certificates = mtls_fake.certificates(tmp_path)
    monkeypatch.setenv('SSL_CERT_FILE', str(certificates.authority))
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'):
        monkeypatch.delenv(name, raising=False)
    return certificates


def deploy_collector(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, port: int, tls: dict[str, object], proxy: dict[str, object] | None = None) -> None:
    """A BotCube Config whose OTLP Endpoint has TLS, through `proxy` if given, and the variables the deploy sets beside it (config's `telemetry.ts`)."""
    url = f'https://127.0.0.1:{port}/v1/traces'
    telemetry = {'kind': 'otlp', 'url': url, 'tls': tls, **({'proxy': 'integrations.proxy'} if proxy else {})}
    deploy(monkeypatch, tmp_path, integrations={'telemetry': telemetry, **({'proxy': proxy} if proxy else {})})
    monkeypatch.setenv('OTEL_TRACES_EXPORTER', 'otlp')
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', url)
    monkeypatch.setenv('OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER', 'botcube')


def export(provider: TracerProvider, span: str) -> None:
    provider.get_tracer('test').start_span(span).end()


def test_traces_arrive_with_the_client_certificate_at_a_collector_carrying_the_expected_identity(
    certs, collector: Collector, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    with mtls_fake.mtls_front(certs, collector.port) as front:
        deploy_collector(monkeypatch, tmp_path, front.port, {'clientCertificate': certs.files('client_a'), 'serverIdentity': mtls_fake.SERVER_IDENTITY})
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))

        export(provider, 'mtls export probe')
        provider.shutdown()

        assert front.clients == ['client-a']
    assert [b'mtls export probe' in body for body in collector.exports] == [True]


def test_a_certificate_whose_files_were_replaced_is_presented_on_the_next_connection(
    certs, collector: Collector, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    files = certs.rotate('client_a', tmp_path / 'telemetry-client')
    with mtls_fake.mtls_front(certs, collector.port) as front:
        deploy_collector(monkeypatch, tmp_path, front.port, {'clientCertificate': files, 'serverIdentity': mtls_fake.SERVER_IDENTITY})
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))

        export(provider, 'before rotation')
        certs.rotate('client_b', tmp_path / 'telemetry-client')
        front.drop()
        export(provider, 'after rotation')
        provider.shutdown()

        assert front.clients == ['client-a', 'client-b']


def test_a_collector_carrying_another_identity_is_sent_nothing_and_the_refusal_logged_once(
    certs, collector: Collector, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    with mtls_fake.mtls_front(certs, collector.port, server='impostor') as front:
        deploy_collector(monkeypatch, tmp_path, front.port, {'clientCertificate': certs.files('client_a'), 'serverIdentity': mtls_fake.SERVER_IDENTITY})
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))

        with caplog.at_level(logging.ERROR):
            export(provider, 'refused export probe')
        provider.shutdown()

    expected = f'telemetry TLS: expected server identity {mtls_fake.SERVER_IDENTITY}, but the server presented {mtls_fake.IMPOSTOR_IDENTITY}'
    assert [expected in record.getMessage() for record in caplog.records] == [True]
    assert collector.exports == []


@pytest.mark.parametrize(('server', 'arrives'), [('localhost', True), ('server', False)])
def test_with_a_client_certificate_and_no_expected_identity_the_collector_hostname_is_checked(
    certs, collector: Collector, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, server: str, arrives: bool,
) -> None:
    """`localhost` names 127.0.0.1; `server` carries only a URI identity, so it is a certificate for another host."""
    with mtls_fake.mtls_front(certs, collector.port, server=server) as front:
        deploy_collector(monkeypatch, tmp_path, front.port, {'clientCertificate': certs.files('client_a')})
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))

        export(provider, 'hostname probe')
        provider.shutdown()

    assert [b'hostname probe' in body for body in collector.exports] == ([True] if arrives else [])


def test_shell_command_traces_reach_the_collector_through_the_trace_relay_with_the_client_certificate(
    certs, collector: Collector, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    with mtls_fake.mtls_front(certs, collector.port) as front:
        deploy_collector(monkeypatch, tmp_path, front.port, {'clientCertificate': certs.files('client_a'), 'serverIdentity': mtls_fake.SERVER_IDENTITY})
        request = urllib.request.Request(start_trace_relay(), data=b'command spans', method='POST', headers={'Content-Type': 'application/x-protobuf'})

        with urllib.request.urlopen(request, timeout=5) as response:
            assert response.status == 200
        assert collector.received.wait(5)

        assert front.clients == ['client-a']
    assert collector.exports == [b'command spans']


def test_traces_keep_the_certificate_and_identity_check_through_the_proxys_relay_when_the_endpoint_names_it(
    certs, collector: Collector, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    with mtls_fake.mtls_front(certs, collector.port) as front, mtls_fake.mtls_proxy(certs, routes={f'127.0.0.1:{front.port}': front.port}) as proxy:
        through = {'kind': 'forward', 'url': proxy.url, 'tls': {'clientCertificate': certs.files('client_b'), 'serverIdentity': mtls_fake.SERVER_IDENTITY}}
        deploy_collector(monkeypatch, tmp_path, front.port, {'clientCertificate': certs.files('client_a'), 'serverIdentity': mtls_fake.SERVER_IDENTITY}, through)
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))

        export(provider, 'proxied export probe')
        provider.shutdown()

        assert [proxy.hosts(), proxy.clients(), front.clients] == [[f'127.0.0.1:{front.port}'], ['client-b'], ['client-a']]
    assert len(collector.exports) == 1

