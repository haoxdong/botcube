from __future__ import annotations

import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

from deployment_fixture import deploy


@pytest.fixture
def collector() -> Iterator[tuple[str, list[dict[str, str]]]]:
    received: list[dict[str, str]] = []

    class Collector(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            received.append({name.lower(): value for name, value in self.headers.items()})
            self.send_response(200)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(('127.0.0.1', 0), Collector)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/v1/traces', received
    finally:
        server.shutdown()


def test_the_harness_exports_to_the_otlp_endpoint_with_its_credential_as_the_bearer_and_its_headers(
    collector: tuple[str, list[dict[str, str]]], tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    url, received = collector
    token = tmp_path / 'telemetry-token'
    token.write_text('collector-token\n')
    # The standard variables the deploy sets from the BotCube Config's telemetry section (config/telemetry.ts),
    # and the file itself, which holds the credential.
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', url)
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'x-tenant=botcube-example')
    deploy(monkeypatch, tmp_path, integrations={'telemetry': {'kind': 'otlp', 'url': url, 'credential': {'kind': 'file', 'path': str(token)}}})
    monkeypatch.setenv('OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER', 'botcube')

    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))
    provider.get_tracer('test').start_span('authenticated export probe').end()
    provider.shutdown()

    assert len(received) == 1
    assert received[0]['authorization'] == 'Bearer collector-token'
    assert received[0]['x-tenant'] == 'botcube-example'
