from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


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
        env=env, capture_output=True, text=True, timeout=45, check=False,
    )
    assert result.returncode == 0, result.stderr
    decoder = json.JSONDecoder()
    remaining = result.stdout.strip()
    spans: list[dict[str, Any]] = []
    while remaining:
        span, end = decoder.raw_decode(remaining)
        spans.append(span)
        remaining = remaining[end:].lstrip()
    assert spans, result.stderr
    assert any('session.id' in span['attributes'] for span in spans), result.stderr
    return {'all': spans, **{
        session: [span for span in spans if span['attributes'].get('session.id') == session]
        for session in ('agentcore-success', 'agentcore-tool-error', 'agentcore-model-error', 'agentcore-disconnect', 'cli-success', 'cli-failure',
                        'cli-failed-turn')
    }}


@pytest.mark.parametrize('session', [
    'agentcore-success', 'agentcore-tool-error', 'agentcore-model-error', 'agentcore-disconnect',
])
def test_automatic_adot_exports_detached_turn_span_tree(
    exported_spans_by_session: dict[str, list[dict[str, Any]]], session: str,
) -> None:
    session_spans = exported_spans_by_session[session]
    assert any(span['attributes'].get('gen_ai.operation.name') == 'invoke_agent' for span in session_spans)
    assert len({span['context']['trace_id'] for span in session_spans}) == 1
    span_ids = {span['context']['span_id'] for span in exported_spans_by_session['all']}
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


@pytest.mark.parametrize(('session', 'trace_id'), [
    ('agentcore-success', '0x' + '1' * 32),
    ('agentcore-tool-error', '0x' + '2' * 32),
    ('agentcore-model-error', '0x' + '3' * 32),
])
def test_invocations_extracts_traceparent_for_detached_descendants(
    exported_spans_by_session: dict[str, list[dict[str, Any]]], session: str, trace_id: str,
) -> None:
    spans = [span for span in exported_spans_by_session['all'] if span['context']['trace_id'] == trace_id]
    servers = [span for span in spans if span['kind'] == 'SpanKind.SERVER']
    assert len(servers) == 1
    assert servers[0]['name'] == 'POST /invocations'
    assert servers[0]['parent_id'] == '0x1234567890abcdef'
    assert {span['context']['trace_id'] for span in exported_spans_by_session[session]} == {trace_id}
    assert any(span['name'] == 'FakeListChatModel.chat' for span in spans)
    if session != 'agentcore-model-error':
        assert any(span['name'] == 'execute_tool lookup' for span in spans)


@pytest.mark.parametrize('session', ['agentcore-success', 'agentcore-tool-error', 'agentcore-model-error'])
def test_invocations_exports_timing_phases_without_content(
    exported_spans_by_session: dict[str, list[dict[str, Any]]], session: str,
) -> None:
    trace_id = exported_spans_by_session[session][0]['context']['trace_id']
    spans = [span for span in exported_spans_by_session['all'] if span['context']['trace_id'] == trace_id]
    phases = [span for span in spans if span['name'].startswith('harness.phase.')]
    assert {span['name'] for span in phases} >= {
        'harness.phase.invocation_auth', 'harness.phase.checkpoint_read', 'harness.phase.state_preparation',
        'harness.phase.workspace',
    }
    span_ids = {span['context']['span_id'] for span in spans}
    for phase in phases:
        assert phase['parent_id'] in span_ids
        assert phase['end_time'] > phase['start_time']
        assert set(phase['attributes']) <= {'session.id'}
        assert phase['events'] == []


def test_shell_span_exports_only_the_registered_command_words(
    exported_spans_by_session: dict[str, list[dict[str, Any]]],
) -> None:
    spans = [span for span in exported_spans_by_session['all'] if span['name'] == 'execute_tool execute']
    assert spans
    assert spans[0]['attributes']['botcube.command.name'] == 'samplecli reports search'
    assert 'private search' not in json.dumps(spans)


def test_shell_spans_classify_single_commands_without_labeling_unknown_or_compound_calls(
    exported_spans_by_session: dict[str, list[dict[str, Any]]],
) -> None:
    spans = [span for span in exported_spans_by_session['all'] if span['name'] == 'execute_tool execute']
    assert [span['attributes'].get('botcube.command.name') for span in spans] == [
        'samplecli reports search',
        'samplecli reports search',
        'samplecli reports dashboard view',
        'samplecli reports search',
        None, None, None, None, None, None, None, None, None, None,
        'samplecli reports search',
        'appcli data eval', None, 'appcli data eval',
    ]
    assert all(span['end_time'] > span['start_time'] for span in spans)
    assert 'private-' not in json.dumps(spans)


@pytest.mark.parametrize(('session', 'recorded'), [
    ('cli-failure', {'botcube.turn.failed_cli_calls': 2, 'botcube.turn.response_after_failed_call': True}),
    ('cli-success', {}),
    ('cli-failed-turn', {'botcube.turn.failed_cli_calls': 1}),
])
def test_a_turn_span_records_its_failed_cli_calls_and_a_response_that_followed_one(
    exported_spans_by_session: dict[str, list[dict[str, Any]]], session: str, recorded: dict[str, Any],
) -> None:
    [tool] = [span for span in exported_spans_by_session[session] if span['name'] == 'execute_tool execute']
    [turn] = [span for span in exported_spans_by_session['all']
              if span['name'] == 'POST /invocations' and span['context']['trace_id'] == tool['context']['trace_id']]
    assert {key: value for key, value in turn['attributes'].items() if key.startswith('botcube.turn.')} == recorded
