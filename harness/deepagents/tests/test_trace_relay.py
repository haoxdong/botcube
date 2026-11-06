from __future__ import annotations

import time
import urllib.request
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import ClassVar

import pytest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from botcube_harness_deepagents.trace_relay import start_trace_relay

pytestmark = pytest.mark.integration


class _Upstream(BaseHTTPRequestHandler):
    received: ClassVar[list[dict[str, str | bytes]]] = []

    def do_PUT(self) -> None:
        type(self).received.append({
            'method': self.command,
            'path': self.path,
            'custom': self.headers.get('X-Custom', ''),
            'content_type': self.headers['Content-Type'],
            'content_encoding': self.headers.get('Content-Encoding', ''),
            'authorization': self.headers.get('Authorization', ''),
            'body': self.rfile.read(int(self.headers['Content-Length'])),
        })
        body = b'{"message":"throttled"}'
        self.send_response(429)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, str | bytes]]]:
    server = ThreadingHTTPServer(('127.0.0.1', 0), _Upstream)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', f'http://127.0.0.1:{server.server_port}/v1/traces')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'fake-key')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'fake-secret')
    monkeypatch.setenv('AWS_SESSION_TOKEN', 'fake-token')
    _Upstream.received = []
    try:
        yield _Upstream.received
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_relay_forwards_any_request_signed_and_logs_an_upstream_refusal(
    upstream: list[dict[str, str | bytes]], caplog: pytest.LogCaptureFixture,
) -> None:
    body = bytes(range(256)) * 4
    relay = start_trace_relay().removesuffix('/v1/traces')
    # The CLI's Node exporter streams its export chunked, with no Content-Length.
    request = urllib.request.Request(
        f'{relay}/any/path?x=1', data=iter([body[:300], body[300:]]), method='PUT',
        headers={'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip', 'X-Custom': 'kept'},
    )

    with urllib.request.urlopen(request, timeout=5) as response:
        assert (response.status, response.read()) == (200, b'')
    for _ in range(50):
        if 'Trace relay export' in caplog.text:
            break
        time.sleep(0.05)

    [forwarded] = upstream
    assert {key: forwarded[key] for key in ('method', 'path', 'content_type', 'content_encoding', 'custom', 'body')} == {
        'method': 'PUT', 'path': '/any/path?x=1', 'content_type': 'application/x-protobuf',
        'content_encoding': 'gzip', 'custom': 'kept', 'body': body,
    }
    assert str(forwarded['authorization']).startswith('AWS4-HMAC-SHA256 Credential=fake-key/')
    assert '/us-east-1/xray/aws4_request' in str(forwarded['authorization'])
    assert [record.levelname for record in caplog.records] == ['ERROR']
    assert '429' in caplog.text
    assert 'throttled' in caplog.text


def test_relay_logs_an_unreachable_upstream_after_accepting_the_export(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    closed = ThreadingHTTPServer(('127.0.0.1', 0), _Upstream)
    port = closed.server_port
    closed.server_close()
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', f'http://127.0.0.1:{port}/v1/traces')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'fake-key')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'fake-secret')
    request = urllib.request.Request(start_trace_relay(), data=ExportTraceServiceRequest().SerializeToString(), method='POST')

    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.status == 200
    for _ in range(50):
        if 'could not forward' in caplog.text:
            break
        time.sleep(0.05)

    assert [record.levelname for record in caplog.records] == ['ERROR']
    assert caplog.records[0].exc_info is not None


def test_relay_forwards_a_traces_export_it_cannot_count_and_logs_why(
    upstream: list[dict[str, str | bytes]], caplog: pytest.LogCaptureFixture,
) -> None:
    body = b'not gzip, not protobuf'
    request = urllib.request.Request(
        start_trace_relay(), data=body, method='PUT',
        headers={'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip'},
    )

    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.status == 200
    for _ in range(50):
        if 'could not count' in caplog.text:
            break
        time.sleep(0.05)

    assert [forwarded['body'] for forwarded in upstream] == [body]
    [counting] = [record for record in caplog.records if 'could not count' in record.getMessage()]
    assert counting.exc_info is not None
