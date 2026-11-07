from __future__ import annotations

import gzip
import logging
import os
from collections.abc import Callable, Generator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Thread
from urllib.parse import urlsplit
from weakref import WeakValueDictionary

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.httpsession import URLLib3Session
from botocore.session import Session
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.trace.v1.trace_pb2 import Status

log = logging.getLogger(__name__)

_TRACES_PATH = '/v1/traces'
# Headers that belong to the loopback hop; the signed upstream request sets its own.
_HOP_BY_HOP = frozenset({'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'expect'})


class FailedCalls:
    """How many CLI commands under one Turn's tool calls ended their span in error (ADR 0085 decision 3)."""

    def __init__(self) -> None:
        self._count = 0
        self._lock = Lock()

    def add(self) -> None:
        with self._lock:
            self._count += 1

    @property
    def count(self) -> int:
        return self._count


_turn_calls: ContextVar[FailedCalls | None] = ContextVar('turn_failed_calls', default=None)
_calls_by_tool_span: WeakValueDictionary[bytes, FailedCalls] = WeakValueDictionary()


@contextmanager
def counting_failed_calls(calls: FailedCalls) -> Generator[None, None, None]:
    token = _turn_calls.set(calls)
    try:
        yield
    finally:
        _turn_calls.reset(token)


def count_failures_under(tool_span_id: int) -> None:
    """Counts each command span the relay receives under `tool_span_id` that ended in error against the current Turn."""
    if (calls := _turn_calls.get()) is not None:
        _calls_by_tool_span[tool_span_id.to_bytes(8, 'big')] = calls


def _count_failed_commands(body: bytes) -> None:
    for resource in ExportTraceServiceRequest.FromString(body).resource_spans:
        for scope in resource.scope_spans:
            for span in scope.spans:
                calls = _calls_by_tool_span.get(span.parent_span_id)
                if calls is not None and span.status.code == Status.STATUS_CODE_ERROR:
                    calls.add()


class _RelayServer(ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: tuple[str, int]) -> None:
        log.exception('Trace relay could not count failed CLI calls in, or forward, an export from %s', client_address)


@cache
def harness_trace_relay() -> str | None:
    """The relay's traces endpoint, started once and only when this process exports its own traces over OTLP."""
    if 'otlp' not in os.environ.get('OTEL_TRACES_EXPORTER', '').split(','):
        return None
    return start_trace_relay()


def start_trace_relay() -> str:
    """Serve an OTLP/HTTP endpoint on loopback that forwards each export, SigV4-signed, to the runtime's trace endpoint.

    The runtime's X-Ray endpoint rejects unsigned exports, and a shell command's Node exporter cannot sign.
    """
    session = Session()
    # botocore alone reads only AWS_DEFAULT_REGION; ADOT resolves AWS_REGION first.
    region = os.environ.get('AWS_REGION') or session.get_config_variable('region')
    credentials = session.get_credentials()
    if not region or credentials is None:
        raise RuntimeError('The trace relay needs an AWS region and AWS credentials to sign trace exports')
    # ADOT sets this to the region's X-Ray endpoint when agent observability is on.
    endpoint = os.environ.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') or f'https://xray.{region}.amazonaws.com/v1/traces'
    signer = SigV4Auth(credentials, 'xray', region)
    upstream = URLLib3Session()

    origin = endpoint.removesuffix(urlsplit(endpoint).path)

    class Relay(BaseHTTPRequestHandler):
        def __getattr__(self, name: str) -> Callable[[], None]:
            if name.startswith('do_'):
                return self._forward
            raise AttributeError(name)

        def _forward(self) -> None:
            body = self._body()
            headers = {name: value for name, value in self.headers.items() if name.lower() not in _HOP_BY_HOP}
            try:
                if urlsplit(self.path).path == _TRACES_PATH:
                    self._count_before_answering(body)
            finally:
                self._answer_and_send(AWSRequest(method=self.command, url=origin + self.path, data=body, headers=headers))

        def _count_before_answering(self, body: bytes) -> None:
            _count_failed_commands(gzip.decompress(body) if self.headers.get('Content-Encoding') == 'gzip' else body)

        def _answer_and_send(self, request: AWSRequest) -> None:
            # A trace export failure is the Harness's error, not the command's: answering first keeps it out of the
            # command's exit status and off the agent's tool result.
            self._respond_accepted()
            signer.add_auth(request)
            response = upstream.send(request.prepare())
            if response.status_code >= 300:
                log.error('Trace relay export to %s failed: %s %s', endpoint, response.status_code, response.content[:500])

        def _body(self) -> bytes:
            # http.server leaves chunked bodies undecoded, and the Node exporter sends chunked.
            if self.headers.get('Transfer-Encoding', '').lower() != 'chunked':
                return self.rfile.read(int(self.headers.get('Content-Length', 0)))
            chunks: list[bytes] = []
            while size := int(self.rfile.readline().split(b';')[0], 16):
                chunks.append(self.rfile.read(size))
                self.rfile.readline()
            while self.rfile.readline() not in (b'\r\n', b'\n', b''):
                pass
            return b''.join(chunks)

        def _respond_accepted(self) -> None:
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
            self.wfile.flush()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = _RelayServer(('127.0.0.1', 0), Relay)
    Thread(target=server.serve_forever, name='trace-relay', daemon=True).start()
    return f'http://127.0.0.1:{server.server_port}{_TRACES_PATH}'
