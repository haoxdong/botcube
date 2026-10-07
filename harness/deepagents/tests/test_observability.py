from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture(scope='module')
def exported_spans_by_session() -> dict[str, list[dict[str, Any]]]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(('OTEL_', 'AWS_', 'AGENT_'))}
    env.update({
        'AGENT_OBSERVABILITY_ENABLED': 'true',
        'OTEL_PYTHON_DISTRO': 'aws_distro',
        'OTEL_PYTHON_CONFIGURATOR': 'aws_configurator',
        'OTEL_AWS_APPLICATION_SIGNALS_ENABLED': 'false',
        'OTEL_TRACES_EXPORTER': 'console',
        'OTEL_TRACES_SAMPLER': 'always_on',
        'OTEL_METRICS_EXPORTER': 'none',
        'OTEL_LOGS_EXPORTER': 'none',
        'TRACELOOP_TRACE_CONTENT': 'false',
        'LANGSMITH_TRACING': 'true',
        'LANGCHAIN_TRACING_V2': 'true',
    })
    result = subprocess.run(
        [str(Path(sys.executable).with_name('opentelemetry-instrument')), sys.executable,
         str(Path(__file__).with_name('trace_workload.py'))],
        env=env, capture_output=True, text=True, timeout=45, check=True,
    )
    decoder = json.JSONDecoder()
    remaining = result.stdout.strip()
    spans: list[dict[str, Any]] = []
    while remaining:
        span, end = decoder.raw_decode(remaining)
        spans.append(span)
        remaining = remaining[end:].lstrip()
    assert spans, result.stderr
    assert any('session.id' in span['attributes'] for span in spans), result.stderr
    return {
        session: [span for span in spans if span['attributes'].get('session.id') == session]
        for session in ('agentcore-success', 'agentcore-tool-error', 'agentcore-model-error', 'agentcore-disconnect')
    }


@pytest.mark.parametrize('session', [
    'agentcore-success', 'agentcore-tool-error', 'agentcore-model-error', 'agentcore-disconnect',
])
def test_automatic_adot_exports_detached_turn_span_tree(
    exported_spans_by_session: dict[str, list[dict[str, Any]]], session: str,
) -> None:
    session_spans = exported_spans_by_session[session]
    assert any(span['attributes'].get('gen_ai.operation.name') == 'invoke_agent' for span in session_spans)
    assert len({span['context']['trace_id'] for span in session_spans}) == 1
    span_ids = {span['context']['span_id'] for span in session_spans}
    for span in session_spans:
        assert span['end_time'] > span['start_time']
        assert span['resource']['attributes']['telemetry.auto.version'].endswith('-aws')
        if span['parent_id'] is not None:
            assert span['parent_id'] in span_ids


@pytest.mark.parametrize('name', ['FakeListChatModel.chat', 'execute_tool lookup'])
def test_automatic_adot_exports_one_success_span(
    exported_spans_by_session: dict[str, list[dict[str, Any]]], name: str,
) -> None:
    success = exported_spans_by_session['agentcore-success']
    assert len([span for span in success if span['name'] == name]) == 1


@pytest.mark.parametrize(('session', 'name'), [
    ('agentcore-tool-error', 'execute_tool lookup'),
    ('agentcore-model-error', 'FakeListChatModel.chat'),
])
def test_automatic_adot_exports_error_status(
    exported_spans_by_session: dict[str, list[dict[str, Any]]], session: str, name: str,
) -> None:
    errors = [span for span in exported_spans_by_session[session] if span['name'] == name]
    assert len(errors) == 1
    assert errors[0]['status']['status_code'] == 'ERROR'


def test_automatic_adot_omits_conversation_content(
    exported_spans_by_session: dict[str, list[dict[str, Any]]],
) -> None:
    for spans in exported_spans_by_session.values():
        for span in spans:
            assert not any(key.startswith((
                'gen_ai.prompt', 'gen_ai.completion', 'gen_ai.input.messages', 'gen_ai.output.messages',
                'gen_ai.task.input', 'gen_ai.task.output', 'traceloop.entity.input', 'traceloop.entity.output',
            )) for key in span['attributes'])
            assert not any(event['name'] in ('gen_ai.content.prompt', 'gen_ai.content.completion')
                           for event in span['events'])
