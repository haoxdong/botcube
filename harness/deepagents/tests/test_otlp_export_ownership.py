from __future__ import annotations

import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


def test_runtime_exports_request_spans_only_through_signed_adot() -> None:
    received: list[tuple[bool, bytes]] = []

    class Collector(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            signed = self.headers.get('Authorization', '').startswith('AWS4-HMAC-SHA256 ')
            received.append((signed, self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(200 if signed else 403)
            self.send_header('x-amzn-errortype', 'MissingAuthenticationTokenException' if not signed else '')
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(('127.0.0.1', 0), Collector)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = subprocess.run(
            [sys.executable, '-c', '''
import os
from botocore.session import Session
from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import OTLPAwsSpanExporter
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from fastapi.testclient import TestClient
session = Session()
session.set_credentials('fake-key', 'fake-secret', 'fake-token')
provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(OTLPAwsSpanExporter(
    aws_region='us-east-1', session=session, endpoint=os.environ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
)))
trace.set_tracer_provider(provider)
from botcube_harness_deepagents.serving import app
with TestClient(app) as client:
    assert client.get('/ping').json() == {'status': 'Healthy'}
    assert client.get('/missing').status_code == 404
provider.force_flush()
provider.shutdown()
'''],
            env={**{key: value for key, value in os.environ.items() if not key.startswith(('OTEL_', 'AWS_', 'AGENT_'))},
                 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': f'http://127.0.0.1:{server.server_port}/v1/traces',
                 'OTEL_METRICS_EXPORTER': 'none', 'OTEL_LOGS_EXPORTER': 'none',
                 'OTEL_TRACES_SAMPLER': 'always_on'},
            capture_output=True, text=True, check=False,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert result.returncode == 0, result.stderr
    assert received, result.stderr
    unsigned = sum(not signed for signed, _ in received)
    assert unsigned == 0, f'{unsigned} unsigned OTLP exports received; {result.stderr}'
    spans = [span for _, body in received
             for resource in ExportTraceServiceRequest.FromString(body).resource_spans
             for scope in resource.scope_spans for span in scope.spans]
    assert {span.name for span in spans} >= {'GET /ping', 'GET'}
    assert 'Failed to export' not in result.stderr
