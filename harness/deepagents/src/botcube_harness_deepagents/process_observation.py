from __future__ import annotations

import json
import logging
from threading import Lock
from time import perf_counter, time_ns
from typing import Any, Literal, NamedTuple
from uuid import uuid4

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.sdk.trace import Span, SpanProcessor, TracerProvider

_Stage = Literal['serve_handoff', 'first_ping', 'first_asgi_invocation', 'first_invocation']


class _Moment(NamedTuple):
    wall_ns: int
    monotonic: float


log = logging.getLogger(__name__)
# Runtime V2 restores each microVM from a snapshot taken at the first healthy /ping, so anything made before then
# is shared by every instance: the id is made at the instance's first invocation, and spans across the snapshot
# use the wall clock, since the monotonic clock stands still while the snapshot waits.
_process_id: str | None = None
_observed: dict[_Stage, _Moment] = {}
_lock = Lock()
_INVOCATION_STAGES = frozenset({'first_asgi_invocation', 'first_invocation'})
# The AgentCore runtime session the instance serves, from its first invocation: one session is one microVM, so a
# warmup and the Turn after it share a VM only when they share this id.
_SESSION_HEADER = b'x-amzn-bedrock-agentcore-runtime-session-id'
_runtime_session: str | None = None


def process_id() -> str | None:
    return _process_id


class _ProcessSpans(SpanProcessor):
    """Stamps the process id on each span: every restored instance reports the snapshot's host name and pid."""

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        if _process_id is not None:
            span.set_attribute('botcube.process.id', _process_id)


def name_spans(provider: object) -> None:
    """Add the stamp to an SDK tracer provider; a no-op provider records no spans to name."""
    if isinstance(provider, TracerProvider):
        provider.add_span_processor(_ProcessSpans())


def serving_since() -> float | None:
    """The monotonic time of this instance's first request, None before it."""
    ingress = _observed.get('first_asgi_invocation') or _observed.get('first_invocation')
    return None if ingress is None else ingress.monotonic


def mark_ingress(scope: Any) -> None:
    """The instance's first /invocations request, with its runtime session id, before FastAPI sees it."""
    global _runtime_session
    with _lock:
        if _runtime_session is None:
            _runtime_session = next((value.decode('latin-1') for name, value in scope['headers'] if name == _SESSION_HEADER), None)
    mark('first_asgi_invocation')


def mark(stage: _Stage) -> None:
    global _process_id
    now = _Moment(time_ns(), perf_counter())
    with _lock:
        if stage in _observed:
            return
        _observed[stage] = now
        if _process_id is None and stage in _INVOCATION_STAGES:
            _process_id = str(uuid4())
        process = _process_id
        handoff = _observed.get('serve_handoff')
        ping = _observed.get('first_ping')
        ingress = _observed.get('first_asgi_invocation')
    context = trace.get_current_span().get_span_context()
    # Early logs may be absent from the invocation stream, so its record repeats the observed boundaries.
    record: dict[str, str | int | float | None] = {
        'event': 'harness_process_observation',
        'stage': stage,
        'processId': process,
        'atUnixNs': now.wall_ns,
        'handoffAtUnixNs': None if handoff is None else handoff.wall_ns,
        'firstPingAtUnixNs': None if ping is None else ping.wall_ns,
        'ingressAtUnixNs': None if ingress is None else ingress.wall_ns,
        'sinceIngressMs': None if ingress is None else round((now.monotonic - ingress.monotonic) * 1000, 3),
        'sinceHandoffMs': None if handoff is None else round((now.wall_ns - handoff.wall_ns) / 1e6, 3),
        'sinceFirstPingMs': None if ping is None else round((now.wall_ns - ping.wall_ns) / 1e6, 3),
        'traceId': format(context.trace_id, '032x') if context.is_valid else None,
        'spanId': format(context.span_id, '016x') if context.is_valid else None,
    }
    if stage in _INVOCATION_STAGES:
        record['runtimeSessionId'] = _runtime_session
    log.info(json.dumps(record, separators=(',', ':')))
