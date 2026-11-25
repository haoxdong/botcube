from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import lru_cache, partial
from time import perf_counter, time, time_ns

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from .invocation import Invocation

log = logging.getLogger(__name__)


class _Scope(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    run_id: str = Field(alias='runId', min_length=1)
    verification_identity: str = Field(alias='verificationIdentity', min_length=1)
    expires_at: AwareDatetime = Field(alias='expiresAt')


@dataclass
class DiagnosticResponseGate:
    scope: _Scope
    consumed: bool = False

    async def hold(self, *, run_id: str, receipt: float, identify: Callable[[], str | None]) -> None:
        if self.consumed or run_id != self.scope.run_id:
            return
        remaining = self.scope.expires_at.timestamp() - time()
        delay = max(0.0, receipt + 31.0 - perf_counter())
        if remaining <= delay or identify() != self.scope.verification_identity:
            return
        self.consumed = True
        log.info(json.dumps({'event': 'diagnostic_response_hold', 'phase': 'held', 'runId': run_id,
                             'atUnixNs': time_ns(), 'requestedDelayMs': delay * 1000,
                             'expiresAt': self.scope.expires_at.isoformat()}, separators=(',', ':')))
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            log.info(json.dumps({'event': 'diagnostic_response_hold', 'phase': 'cancelled', 'runId': run_id,
                                 'atUnixNs': time_ns()}, separators=(',', ':')))
            raise
        log.info(json.dumps({'event': 'diagnostic_response_hold', 'phase': 'released', 'runId': run_id,
                             'atUnixNs': time_ns(), 'elapsedMs': (perf_counter() - receipt) * 1000},
                            separators=(',', ':')))


@lru_cache(maxsize=1)
def _configured_gate(raw: str) -> DiagnosticResponseGate:
    try:
        scope = _Scope.model_validate_json(raw)
    except ValidationError:
        raise ValueError('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE_SCOPE requires runId, verificationIdentity and timezone-aware expiresAt') from None
    return DiagnosticResponseGate(scope)


def configured_gate() -> DiagnosticResponseGate | None:
    flag = os.environ.get('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE', '0')
    if flag == '0':
        return None
    if flag != '1':
        raise ValueError('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE must be 0 or 1')
    return _configured_gate(os.environ.get('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE_SCOPE', ''))


def response_hold(run: Invocation, receipt: float, identify: Callable[[], str | None]) -> Callable[[], Awaitable[None]] | None:
    gate = configured_gate()
    if gate is None or run.run_id != gate.scope.run_id:
        return None
    options = run.options
    if options.warmup or options.stop or options.steering or options.withdraw_steering is not None:
        return None
    return partial(gate.hold, run_id=run.run_id, receipt=receipt, identify=identify)
