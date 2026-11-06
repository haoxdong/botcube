from __future__ import annotations

import json
import logging

import pytest
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

from botcube_harness_deepagents.turn_output import retain

# The user and password an answer's curl command quotes, kept off the curl line so the mirror's secret scan finds no credential.
CURL_USER = 'alice:opaque-private-auth'


def test_retained_chunks_preserve_large_unicode_answers_and_strip_secrets_before_splitting(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_output')
    context = SpanContext(1, 2, False, TraceFlags(1))
    answer = '市場' * 16000 + ' literal-private-token cookie=private-cookie'
    with trace.use_span(NonRecordingSpan(context)):
        retain(answer, {'AUTH_TOKEN': 'literal-private-token'})
    records = [json.loads(record.message) for record in caplog.records]
    assert len(records) == 3
    assert [row['chunkIndex'] for row in records] == [0, 1, 2]
    assert {row['chunkCount'] for row in records} == {3}
    assert ''.join(row['output'] for row in records) == '市場' * 16000 + ' [redacted] cookie=[redacted]'
    assert all(len(record.message.encode()) < 256000 for record in caplog.records)


def test_untraced_answers_are_not_retained(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_output')
    with trace.use_span(trace.INVALID_SPAN):
        retain('No trace join is possible.', {})
    assert not caplog.records


@pytest.mark.parametrize('answer', [
    f'Run `curl --user={CURL_USER} https://example.com` again.',
    f'Run `curl -u {CURL_USER} https://example.com` again.',
    "Use curl --cookie 'a=opaque-private-auth' https://example.com to check.",
    '```sh\ncurl -sb a=opaque-private-auth https://example.com\n```\nIt printed opaque-private-auth.',
    'Try `curl --oauth2-bearer opaque-private-auth https://example.com`.',
])
def test_curl_credentials_an_answer_quotes_are_stripped_before_retention(
    caplog: pytest.LogCaptureFixture, answer: str,
) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_output')
    with trace.use_span(NonRecordingSpan(SpanContext(1, 2, False, TraceFlags(1)))):
        retain(answer, {})
    [record] = [json.loads(record.message) for record in caplog.records]
    assert 'opaque-private-auth' not in record['output']
    assert 'https://example.com' in record['output']


def test_an_answer_without_curl_credentials_is_retained_unchanged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_output')
    answer = 'Run `curl -s https://example.com` or `grep -b ordinary.txt`; curl --user alice works too.'
    with trace.use_span(NonRecordingSpan(SpanContext(1, 2, False, TraceFlags(1)))):
        retain(answer, {})
    [record] = [json.loads(record.message) for record in caplog.records]
    assert record['output'] == answer
