"""AgentCore Runtime V2 restores every microVM from one memory snapshot taken at the first healthy /ping.

A fork after that point copies the same frozen memory into each child, so it stands in for two restored instances.
"""
import importlib
import json
import logging
import os
from collections.abc import Iterator
from types import ModuleType
from typing import Any

import pytest

from botcube_harness_deepagents import process_observation, turn_timing


class _Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict[str, Any]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(json.loads(record.getMessage()))


Observation = tuple[ModuleType, list[dict[str, Any]]]


@pytest.fixture
def observation() -> Iterator[Observation]:
    module = importlib.reload(process_observation)
    handler = _Records()
    logger = logging.getLogger(module.__name__)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    yield module, handler.records
    logger.removeHandler(handler)


def _restored_process_ids(module: ModuleType) -> list[str]:
    ids: list[str] = []
    for _ in range(2):
        read, write = os.pipe()
        if (child := os.fork()) == 0:
            os.close(read)
            module.mark('first_invocation')
            os.write(write, module.process_id().encode())
            os._exit(0)
        os.close(write)
        ids.append(os.read(read, 64).decode())
        os.waitpid(child, 0)
    return ids


def test_each_restored_instance_gets_its_own_process_id(observation: Observation) -> None:
    module, records = observation
    module.mark('serve_handoff')
    module.mark('first_ping')

    first, second = _restored_process_ids(module)

    assert first and second and first != second
    assert [record['processId'] for record in records] == [None, None]


def test_durations_across_the_snapshot_use_the_wall_clock(observation: Observation, monkeypatch: pytest.MonkeyPatch) -> None:
    module, records = observation
    wall, monotonic = [1_000_000_000_000], [5.0]
    monkeypatch.setattr(module, 'time_ns', lambda: wall[0])
    monkeypatch.setattr(module, 'perf_counter', lambda: monotonic[0])
    module.mark('serve_handoff')
    wall[0] += 2_000_000_000
    module.mark('first_ping')
    # Frozen in the snapshot for ten minutes: the wall clock moves on, the monotonic clock does not.
    wall[0] += 600_000_000_000
    module.mark('first_asgi_invocation')
    wall[0] += 50_000_000
    monotonic[0] += 0.05
    module.mark('first_invocation')

    final = records[-1]
    assert final['sinceHandoffMs'] == 602_050.0
    assert final['sinceFirstPingMs'] == 600_050.0
    assert final['sinceIngressMs'] == 50.0


def test_process_age_counts_from_the_instance_first_request(observation: Observation, monkeypatch: pytest.MonkeyPatch) -> None:
    module, _ = observation
    monotonic = [5.0]
    monkeypatch.setattr(module, 'perf_counter', lambda: monotonic[0])
    monkeypatch.setattr(turn_timing, 'process_observation', module)
    assert module.serving_since() is None
    module.mark('serve_handoff')
    monotonic[0] = 30.0
    module.mark('first_asgi_invocation')

    assert module.serving_since() == 30.0
    timing = turn_timing.TurnTiming('run', 'session', 'model', warmup=False, receipt=30.25)
    assert timing.record(30.5, 'finished')['processAgeMs'] == 250.0


def test_spans_name_the_restored_process_not_the_snapshot_host(observation: Observation) -> None:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    module, _ = observation
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    module.name_spans(provider)
    tracer = provider.get_tracer('fixture')
    with tracer.start_as_current_span('ping'):
        pass
    module.mark('first_invocation')
    with tracer.start_as_current_span('invocation'):
        pass

    ping, invocation = exporter.get_finished_spans()
    assert 'botcube.process.id' not in (ping.attributes or {})
    assert module.process_id() is not None
    assert (invocation.attributes or {}).get('botcube.process.id') == module.process_id()
