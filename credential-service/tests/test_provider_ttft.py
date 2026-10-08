from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from typing import Any, cast

import httpx
import pytest
from starlette.requests import Request
from starlette.responses import StreamingResponse

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.vault import RotatingCredentialVault


class Sink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, event: Mapping[str, Any]) -> None:
        self.events.append(dict(event))


class Stream(httpx.AsyncByteStream):
    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for offset in range(0, len(self.content), 7):
            yield self.content[offset:offset + 7]


def frame(kind: str, **data: Any) -> bytes:
    return f'data: {json.dumps({"type": kind, **data})}\n\n'.encode()


@pytest.mark.parametrize('answer', [True, False])
def test_real_responses_relay_records_answer_boundary_without_logging_content(answer: bool) -> None:
    sink = Sink()
    content = frame('response.reasoning_summary_text.delta', delta='private reasoning')
    content += frame('response.function_call_arguments.delta', delta='private tool')
    content += frame('response.in_progress')
    content += frame('response.output_text.delta', delta='')
    content += frame('response.output_text.delta', delta='  \n')
    if answer:
        content += frame('response.output_text.delta', delta='private answer')
    content += frame('response.completed')

    async def run() -> bytes:
        provider = OpenAIProvider(lambda: cast("RotatingCredentialVault", None), audit=CredentialAuditRecorder(sink=sink),
                                  transport=httpx.MockTransport(lambda request: httpx.Response(
                                      200, stream=Stream(content), headers={'content-type': 'text/event-stream'},
                                  )))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{"model":"gpt-6-astra","input":"private prompt"}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'secret-access', account_id='account',
                                        request_context={'sessionId': 'session', 'runId': 'run',
                                                         'modelStepId': 'step', 'traceId': 'trace',
                                                         'modelId': 'gpt-6-astra'})
        assert isinstance(response, StreamingResponse)
        return b''.join([cast("bytes", chunk) async for chunk in response.body_iterator])

    assert asyncio.run(run()) == content
    measured = [event for event in sink.events if event['event'] == 'provider_first_answer']
    assert len(measured) == 1
    assert measured[0]['result'] == ('answer' if answer else 'no_answer')
    assert measured[0]['runId'] == 'run'
    assert measured[0]['modelStepId'] == 'step'
    assert measured[0]['traceId'] == 'trace'
    if answer:
        assert measured[0]['durationMs'] >= 0
    else:
        assert 'durationMs' not in measured[0]
    assert 'private' not in json.dumps(sink.events)
    assert 'secret-access' not in json.dumps(sink.events)


@pytest.mark.parametrize('prefix', [b'', frame('response.output_text.delta', delta='answer')])
def test_relay_reports_failed_stream_even_after_answer(prefix: bytes) -> None:
    sink = Sink()
    failed = frame('response.failed', response={'error': {'code': 'subscription_sharing_usage_unavailable'}})

    async def run() -> bytes:
        provider = OpenAIProvider(lambda: cast("RotatingCredentialVault", None), audit=CredentialAuditRecorder(sink=sink),
                                  transport=httpx.MockTransport(lambda request: httpx.Response(
                                      200, stream=Stream(prefix + failed),
                                  )))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
        assert isinstance(response, StreamingResponse)
        return b''.join([cast("bytes", chunk) async for chunk in response.body_iterator])

    forwarded = asyncio.run(run())
    assert b'PLAN_USAGE_UNAVAILABLE' in forwarded
    outcomes = [event for event in sink.events if event['event'] == 'provider_response_outcome']
    assert len(outcomes) == 1
    assert outcomes[0]['result'] == 'failure'
    assert outcomes[0]['answerObserved'] == bool(prefix)


def test_dispatch_clock_starts_after_body_preparation(monkeypatch: pytest.MonkeyPatch) -> None:
    sink = Sink()
    clock = [10.0]
    monkeypatch.setattr('botcube_credential_service.openai.time.monotonic', lambda: clock[0])

    class PreparedRequest(Request):
        async def body(self) -> bytes:
            clock[0] = 100.0
            return b'{}'

    class TimedStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            clock[0] = 100.1
            yield frame('response.output_text.delta', delta='  \n')
            clock[0] = 100.25
            yield frame('response.output_text.delta', delta='answer')

    async def run() -> None:
        provider = OpenAIProvider(lambda: cast("RotatingCredentialVault", None), audit=CredentialAuditRecorder(sink=sink),
                                  transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=TimedStream())))
        request = PreparedRequest({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                                   'headers': [], 'query_string': b''})
        response = await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
        assert isinstance(response, StreamingResponse)
        async for _ in response.body_iterator:
            pass

    asyncio.run(run())
    [measured] = [event for event in sink.events if event['event'] == 'provider_first_answer']
    assert measured['durationMs'] == 250.0
    assert measured['Moment'] == 'provider-first-token'
    assert measured['Latency'] == 250.0
    assert measured['_aws']['CloudWatchMetrics'] == [{
        'Namespace': 'RUM/CustomMetrics/WebLatency', 'Dimensions': [['Moment']],
        'Metrics': [{'Name': 'Latency', 'Unit': 'Milliseconds'}],
    }]


@pytest.mark.parametrize('failure', [httpx.ReadTimeout('timeout'), asyncio.CancelledError()])
def test_dispatch_failures_have_no_success_metric(failure: BaseException) -> None:
    sink = Sink()

    async def handle(request: httpx.Request) -> httpx.Response:
        raise failure

    async def run() -> None:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink), transport=httpx.MockTransport(handle))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        if isinstance(failure, asyncio.CancelledError):
            with pytest.raises(asyncio.CancelledError):
                await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
        else:
            response = await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
            assert response.status_code == 504

    asyncio.run(run())
    [outcome] = [event for event in sink.events if event['event'] == 'provider_response_outcome']
    assert outcome['result'] == ('cancelled' if isinstance(failure, asyncio.CancelledError) else 'failure')
    assert all('_aws' not in event for event in sink.events)


@pytest.mark.parametrize('content', [b'not json', b'[]'])
def test_relay_does_not_parse_or_change_the_forwarded_request(content: bytes) -> None:
    sink = Sink()
    calls: list[bytes] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request.content)
        assert 'x-botcube-run-id' not in request.headers
        assert 'x-botcube-model-step-id' not in request.headers
        assert 'traceparent' not in request.headers
        return httpx.Response(400, content=b'upstream rejection')

    async def run() -> None:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink), transport=httpx.MockTransport(handle))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': content}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses', 'query_string': b'',
                           'headers': [(b'x-botcube-run-id', b'run'), (b'x-botcube-model-step-id', b'step'),
                                       (b'traceparent', b'00-1234567890abcdef1234567890abcdef-1234567890abcdef-01')]},
                          receive=receive)
        response = await provider.relay(request, 'v1/responses', 'access', account_id='account',
                                        request_context={'modelId': 'gpt-6-astra'})
        assert response.status_code == 400
        assert response.body == b'upstream rejection'

    asyncio.run(run())
    assert calls == [content]
    [outcome] = [event for event in sink.events if event['event'] == 'provider_response_outcome']
    assert outcome['runId'] == 'run'
    assert outcome['modelStepId'] == 'step'
    assert outcome['traceId'] == '1234567890abcdef1234567890abcdef'
    assert outcome['modelId'] == 'gpt-6-astra'
    assert outcome['result'] == 'failure'
    assert all('_aws' not in event for event in sink.events)


def test_audit_failure_propagates_after_both_stream_resources_close() -> None:
    closed: list[str] = []

    class FailingSink(Sink):
        def record(self, event: Mapping[str, Any]) -> None:
            if event['event'] == 'provider_response_outcome':
                raise RuntimeError('audit failed')
            super().record(event)

    class ClosingStream(Stream):
        async def aclose(self) -> None:
            closed.append('upstream')

    class ClosingTransport(httpx.MockTransport):
        async def aclose(self) -> None:
            closed.append('client')

    async def run() -> None:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=FailingSink()),
                                  transport=ClosingTransport(lambda request: httpx.Response(
                                      200, stream=ClosingStream(frame('response.completed')))))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
        assert isinstance(response, StreamingResponse)
        with pytest.raises(RuntimeError, match='audit failed'):
            async for _ in response.body_iterator:
                pass
        assert closed == ['upstream', 'client']

    asyncio.run(run())
