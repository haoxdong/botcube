from __future__ import annotations

import math
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .audit import CredentialAuditRecorder


def _identifier(value: Any) -> str | None:
    if isinstance(value, str) and 0 < len(value) <= 128 and value.isascii() and all(c.isalnum() or c in '-_' for c in value):
        return value
    return None


@dataclass
class CredentialAnswerBoundary:
    audit: CredentialAuditRecorder
    context: Mapping[str, str]
    receipt: float | None
    dispatch: float
    response_id: str | None = None
    item_id: str | None = None
    received: float | None = None
    emission: float | None = None
    pending: bool = False
    invalid: bool = False
    recorded: bool = False

    def __post_init__(self) -> None:
        safe = {key: identity for key in ('runId', 'sessionId', 'modelStepId', 'modelId')
                if (identity := _identifier(self.context.get(key))) is not None}
        trace = self.context.get('traceId')
        if isinstance(trace, str) and len(trace) == 32 and all(c in '0123456789abcdef' for c in trace):
            safe['traceId'] = trace
        self.context = safe

    def observe(self, event: Any) -> None:
        if not isinstance(event, Mapping) or self.recorded:
            return
        if event.get('type') == 'response.created':
            response = event.get('response')
            identity = _identifier(response.get('id')) if isinstance(response, Mapping) else None
            if self.response_id is not None or identity is None:
                self.invalid = True
            self.response_id = identity
        delta = event.get('delta')
        if self.received is None and event.get('type') == 'response.output_text.delta' and isinstance(delta, str) and delta.strip():
            self.received = time.monotonic()
            self.item_id = _identifier(event.get('item_id'))
            response_id = event.get('response_id')
            self.invalid |= self.response_id is None or self.item_id is None
            self.invalid |= response_id is not None and response_id != self.response_id
            self.pending = True

    def emitted(self) -> None:
        if self.pending:
            self.emission = time.monotonic()
            self.pending = False

    def record(self) -> None:
        if self.recorded:
            return
        self.recorded = True
        times = (self.receipt, self.dispatch, self.received, self.emission)
        available = all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in times)
        values = [float(value) for value in times if isinstance(value, (int, float)) and not isinstance(value, bool)]
        reason = self._invalid_reason(available, values)
        offsets: dict[str, float] = dict(zip(('receipt', 'upstreamDispatch', 'answerReceived', 'answerEmitted'),
                           [(value - values[0]) * 1000 for value in values], strict=True)) if available else {}
        self.audit.record_first_answer_boundary(self.context, response_id=self.response_id, item_id=self.item_id,
                                               offsets=offsets, invalid_reason=reason)

    def _invalid_reason(self, available: bool, values: list[float]) -> str | None:
        if not available:
            return 'missing_boundary'
        if self.invalid:
            return 'invalid_identity'
        if not all(self.context.get(key) for key in ('runId', 'sessionId', 'modelStepId', 'traceId', 'modelId')):
            return 'missing_correlation'
        if values != sorted(values):
            return 'out_of_order'
        return None
