from __future__ import annotations

import json
import time
from collections import defaultdict, deque
from collections.abc import Callable, Mapping
from typing import Any, Protocol


class CredentialAuditSink(Protocol):
    def record(self, event: Mapping[str, Any]) -> None:
        ...


class NoopCredentialAuditSink:
    def record(self, event: Mapping[str, Any]) -> None:
        return None


class StdoutCredentialAuditSink:
    """Structured container output, routed to CloudWatch by the awslogs driver."""

    def record(self, event: Mapping[str, Any]) -> None:
        print(json.dumps(dict(event), sort_keys=True), flush=True)


class CredentialAuditRecorder:
    def __init__(
        self,
        *,
        sink: CredentialAuditSink | None = None,
        clock: Callable[[], float] = time.time,
        decrypt_rate_limit: int = 30,
        decrypt_window_seconds: int = 60,
    ) -> None:
        self.sink = sink or NoopCredentialAuditSink()
        self.clock = clock
        self.decrypt_rate_limit = decrypt_rate_limit
        self.decrypt_window_seconds = decrypt_window_seconds
        self._decrypt_timestamps: dict[str, deque[float]] = defaultdict(deque)

    def record_kms_decrypt(self, account_id: str, request_context: Mapping[str, Any] | None = None) -> None:
        timestamp = self.clock()
        self._record('kms_decrypt', account_id, request_context=request_context, timestamp=timestamp)
        self._record_decrypt_anomaly(account_id, timestamp, request_context)

    def record_session_remint(self, account_id: str, request_context: Mapping[str, Any] | None = None) -> None:
        self._record('session_remint', account_id, request_context=request_context)

    def record_upstream_relay(self, account_id: str, provider: str, request_context: Mapping[str, Any]) -> None:
        self._record('upstream_relay', account_id, request_context=request_context, extra={'provider': provider})

    def _record(
        self,
        event_name: str,
        account_id: str,
        *,
        request_context: Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
        timestamp: float | None = None,
    ) -> None:
        event = {
            'event': event_name,
            'accountId': account_id,
            **_request_context_fields(request_context),
            **(dict(extra) if extra is not None else {}),
            'timestamp': self.clock() if timestamp is None else timestamp,
        }
        self.sink.record(event)

    def _record_decrypt_anomaly(
        self,
        account_id: str,
        timestamp: float,
        request_context: Mapping[str, Any] | None,
    ) -> None:
        if self.decrypt_rate_limit <= 0:
            return
        cutoff = timestamp - self.decrypt_window_seconds
        timestamps = self._decrypt_timestamps[account_id]
        timestamps.append(timestamp)
        while timestamps and timestamps[0] < cutoff:
            timestamps.popleft()
        if len(timestamps) <= self.decrypt_rate_limit:
            return
        self.sink.record({
            'event': 'credential_anomaly',
            'accountId': account_id,
            **_request_context_fields(request_context),
            'kind': 'kms_decrypt_rate',
            'count': len(timestamps),
            'windowSeconds': self.decrypt_window_seconds,
            'timestamp': timestamp,
        })


def _request_context_fields(request_context: Mapping[str, Any] | None) -> dict[str, str]:
    if request_context is None:
        return {}
    result: dict[str, str] = {}
    for source, target in (
        ('sessionId', 'sessionId'),
        ('method', 'method'),
        ('path', 'path'),
        ('scope', 'scope'),
    ):
        value = request_context.get(source)
        if isinstance(value, str) and value:
            result[target] = value
    return result
