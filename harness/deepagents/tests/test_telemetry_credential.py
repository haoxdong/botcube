from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor


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
    # The variables the deploy sets from the Deployment Config's telemetry section (deployment-config/telemetry.ts).
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', url)
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'x-tenant=botcube-example')
    monkeypatch.setenv('BOTCUBE_TELEMETRY_CREDENTIAL', json.dumps({'kind': 'file', 'path': str(token)}))
    monkeypatch.setenv('OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER', 'botcube')

    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))
    provider.get_tracer('test').start_span('authenticated export probe').end()
    provider.shutdown()

    assert len(received) == 1
    assert received[0]['authorization'] == 'Bearer collector-token'
    assert received[0]['x-tenant'] == 'botcube-example'


@pytest.mark.parametrize(('value', 'error'), [
    ('{not json', 'BOTCUBE_TELEMETRY_CREDENTIAL: not JSON'),
    (json.dumps({'kind': 'file'}), 'telemetry.credential credential: file.path: '),
])
def test_the_harness_refuses_a_malformed_telemetry_credential_naming_it(value: str, error: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents.credential_source import CredentialSourceError
    from botcube_harness_deepagents.telemetry_credential import telemetry_session

    monkeypatch.setenv('BOTCUBE_TELEMETRY_CREDENTIAL', value)
    with pytest.raises(CredentialSourceError, match=f'^{error}'):
        telemetry_session()
