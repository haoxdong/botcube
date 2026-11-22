from __future__ import annotations

import json
import logging
from types import SimpleNamespace

import pytest

from botcube_harness_deepagents import turn_timing


@pytest.mark.parametrize('available', [True, False])
def test_graph_phase_reports_thread_cpu_fault_deltas_and_scoped_step_starts(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, available: bool,
) -> None:
    caplog.set_level(logging.INFO, logger=turn_timing.__name__)
    wall = iter([10.1, 10.2, 10.3, 10.6])
    cpu = iter([2.0, 2.125])
    faults = iter([SimpleNamespace(ru_minflt=100, ru_majflt=4), SimpleNamespace(ru_minflt=107, ru_majflt=6)])
    monkeypatch.setattr(turn_timing, 'perf_counter', lambda: next(wall))
    monkeypatch.setattr(turn_timing, 'thread_time', lambda: next(cpu))
    def usage(who: int) -> SimpleNamespace:
        assert who == turn_timing.resource.RUSAGE_THREAD
        return next(faults)
    monkeypatch.setattr(turn_timing.resource, 'RUSAGE_THREAD', 1, raising=False)
    monkeypatch.setattr(turn_timing.resource, 'getrusage', usage)
    if not available:
        monkeypatch.delattr(turn_timing.resource, 'RUSAGE_THREAD')
    timing = turn_timing.TurnTiming('run', 'session', 'model', warmup=False, receipt=10)
    turn_timing.graph_step('outside')
    with turn_timing.use(timing):
        turn_timing.graph_step('outside')
        with turn_timing.phase('graph_build'):
            turn_timing.graph_step('profile_checks')
            turn_timing.graph_step('create_agent')
        turn_timing.graph_step('outside')
    lines = [json.loads(record.message) for record in caplog.records]
    assert lines == [
        {'event': 'harness_graph_substep', 'runId': 'run', 'sessionId': 'session', 'phase': 'graph_build',
         'step': 'profile_checks', 'startMs': 200},
        {'event': 'harness_graph_substep', 'runId': 'run', 'sessionId': 'session', 'phase': 'graph_build',
         'step': 'create_agent', 'startMs': 300},
        {'event': 'harness_phase', 'runId': 'run', 'sessionId': 'session', 'phase': 'graph_build',
         'startMs': 100, 'durationMs': 500, 'threadCpuMs': 125,
         'minorFaultsDelta': 7 if available else None, 'majorFaultsDelta': 2 if available else None},
    ]
