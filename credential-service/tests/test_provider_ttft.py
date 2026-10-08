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
    [phases] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    assert phases['result'] == ('answer' if answer else 'no_answer')
    assert phases['phases'][0]['phase'] == 'headers_returned'
    assert phases['phases'][-1]['phase'] == 'terminal'
    assert '_aws' not in phases
    assert phases['upstreamContentEncoding'] == 'absent'


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
    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    names = [phase['phase'] for phase in summary['phases']]
    assert 'decoded_stream_eof' in names
    assert 'first_completed_event' not in names


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

    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    assert summary['result'] == outcome['result']
    assert [phase['phase'] for phase in summary['phases']] == ['terminal']
    assert summary['upstreamContentEncoding'] == 'unavailable'


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


@pytest.mark.parametrize('audit_event', ['provider_response_outcome', 'provider_upstream_phases'])
def test_audit_failure_propagates_after_both_stream_resources_close(audit_event: str) -> None:
    closed: list[str] = []

    class FailingSink(Sink):
        def record(self, event: Mapping[str, Any]) -> None:
            if event['event'] == audit_event:
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


@pytest.mark.parametrize('trace_flood', [False, True])
def test_upstream_phases_separate_monotonic_boundaries_and_never_log_trace_info(
    monkeypatch: pytest.MonkeyPatch, trace_flood: bool,
) -> None:
    sink = Sink()
    clock = [100.0]
    wall = [2000.0]
    monkeypatch.setattr('botcube_credential_service.openai.time.monotonic', lambda: clock[0])
    monkeypatch.setattr('botcube_credential_service.openai.time.time', lambda: wall[0])
    reasoning = frame('response.reasoning_summary_text.delta', delta='private reasoning')
    blank_reasoning = frame('response.reasoning_summary_text.delta', delta='  \n')
    answer = frame('response.output_text.delta', delta='private answer')
    completed = frame('response.completed')
    chunks = [b'', blank_reasoning[:5], blank_reasoning[5:], reasoning, frame('response.output_text.delta', delta='  '), answer, completed]
    times = [100.6, 100.7, 100.8, 100.9, 101.1, 101.2, 101.9]

    class TimedStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            for instant, chunk in zip(times, chunks, strict=True):
                clock[0] = instant
                wall[0] -= 1000
                yield chunk
            clock[0] = 102.0

    async def handle(request: httpx.Request) -> httpx.Response:
        await _emit_transport_phases(request, clock, trace_flood)
        clock[0] = 100.5
        assert request.content == b'private prompt'
        assert request.headers['authorization'] == 'Bearer secret-access'
        return httpx.Response(200, stream=TimedStream())

    async def run() -> bytes:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink, clock=lambda: wall[0]),
                                  transport=httpx.MockTransport(handle))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'private prompt'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'secret-access', account_id='account',
                                        request_context={'runId': 'run', 'modelStepId': 'step', 'traceId': 'trace'})
        assert isinstance(response, StreamingResponse)
        return b''.join([cast('bytes', chunk) async for chunk in response.body_iterator])

    assert asyncio.run(run()) == b''.join(chunks)
    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    app_phases = [phase for phase in summary['phases'] if '.' not in phase['phase']]
    assert [phase['phase'] for phase in app_phases] == [
        'headers_returned', 'first_decoded_chunk', 'first_parsed_event', 'first_reasoning_delta', 'first_answer_delta',
        'first_completed_event', 'decoded_stream_eof', 'terminal',
    ]
    assert [phase['offsetMs'] for phase in app_phases] == pytest.approx([500, 700, 800, 900, 1200, 1900, 2000, 2000])
    assert len(summary['phases']) == (72 if trace_flood else 15)
    assert summary.get('phasesTruncated', False) == trace_flood
    assert [phase['phase'] for phase in summary['phases']].count('connection.connect_tcp.complete') == 2
    assert summary['runId'] == 'run' and summary['modelStepId'] == 'step' and summary['traceId'] == 'trace'
    assert '_aws' not in summary
    assert 'private' not in json.dumps(sink.events) and 'secret' not in json.dumps(sink.events)


async def _emit_transport_phases(request: httpx.Request, clock: list[float], trace_flood: bool) -> None:
    from collections.abc import Awaitable, Callable

    trace = cast('Callable[[str, Mapping[str, Any]], Awaitable[None]]', request.extensions['trace'])
    info = {'request': request, 'authorization': 'secret trace credential', 'return_value': 'private completion'}
    names = ['connection.connect_tcp.started', 'connection.connect_tcp.complete',
             'proxy.start_tls.started', 'proxy.start_tls.complete', 'http2.send_request_headers.complete',
             'http2.receive_response_headers.complete', 'connection.connect_tcp.complete']
    for index, name in enumerate(names):
        clock[0] = 100.05 + index * 0.05
        await trace(name, info)
    await trace('http2.receive_response_body.started', info)
    await trace('secret-unknown-phase', info)
    if trace_flood:
        for _ in range(100):
            await trace('http2.send_request_headers.complete', info)


@pytest.mark.parametrize('compressed', [False, True])
def test_real_http_transport_reports_only_allowlisted_connection_and_header_milestones(
    monkeypatch: pytest.MonkeyPatch, compressed: bool,
) -> None:
    import gzip
    from dataclasses import replace

    sink = Sink()
    content = frame('response.output_text.delta', delta='private answer') + frame('response.completed')
    wire_content = gzip.compress(content) if compressed else content
    requests: list[bytes] = []

    async def run() -> bytes:
        served = asyncio.Event()

        async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                headers = await reader.readuntil(b'\r\n\r\n')
                requests.append(headers)
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n'
                             + f'Content-Length: {len(wire_content)}\r\n'.encode()
                             + (b'Content-Encoding: gzip\r\n' if compressed else b'')
                             + b'X-Private-Upstream: secret header\r\nConnection: close\r\n\r\n' + wire_content)
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                served.set()

        server = await asyncio.start_server(serve, '127.0.0.1', 0)
        async with server:
            port = server.sockets[0].getsockname()[1]
            provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                      audit=CredentialAuditRecorder(sink=sink),
                                      transport=httpx.AsyncHTTPTransport(trust_env=False))
            monkeypatch.setattr(provider, '_settings', replace(provider._settings, api_origin=f'http://127.0.0.1:{port}'))

            async def receive() -> dict[str, Any]:
                return {'type': 'http.request', 'body': b'private prompt'}

            request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                               'headers': [], 'query_string': b''}, receive=receive)
            response = await provider.relay(request, 'v1/responses', 'secret-access', account_id='account',
                                            request_context={'runId': 'run', 'modelStepId': 'step'})
            assert isinstance(response, StreamingResponse)
            forwarded = b''.join([cast('bytes', chunk) async for chunk in response.body_iterator])
            await asyncio.wait_for(served.wait(), 5)
            return forwarded

    assert asyncio.run(run()) == content
    assert len(requests) == 1 and b'Bearer secret-access' in requests[0]
    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    phases = [entry['phase'] for entry in summary['phases']]
    assert phases[:2] == ['connection.connect_tcp.started', 'connection.connect_tcp.complete']
    assert 'http11.send_request_headers.complete' in phases
    assert 'http11.send_request_body.complete' in phases
    assert 'http11.receive_response_headers.complete' in phases
    assert phases.index('http11.receive_response_headers.complete') < phases.index('headers_returned')
    assert phases.index('headers_returned') < phases.index('first_decoded_chunk')
    assert not any('start_tls' in name or 'receive_response_body' in name for name in phases)
    assert summary['runId'] == 'run' and summary['modelStepId'] == 'step'
    assert summary['upstreamContentEncoding'] == ('gzip' if compressed else 'absent')
    assert 'private' not in json.dumps(sink.events) and 'secret' not in json.dumps(sink.events)


@pytest.mark.parametrize('failure', [None, httpx.ReadError('secret read error'), asyncio.CancelledError()])
def test_closing_or_failing_the_body_preserves_absent_eof_and_closes_resources(failure: BaseException | None) -> None:
    from collections.abc import AsyncGenerator

    sink = Sink()
    closed: list[str] = []

    class ClosingStream(Stream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield frame('response.in_progress')
            if failure is not None:
                raise failure

        async def aclose(self) -> None:
            closed.append('upstream')

    class ClosingTransport(httpx.MockTransport):
        async def aclose(self) -> None:
            closed.append('client')

    async def run() -> None:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink),
                                  transport=ClosingTransport(lambda request: httpx.Response(
                                      200, stream=ClosingStream(frame('response.in_progress')))))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
        assert isinstance(response, StreamingResponse)
        body = cast('AsyncGenerator[bytes, None]', response.body_iterator)
        assert await anext(body) == frame('response.in_progress')
        if failure is None:
            await body.aclose()
        else:
            with pytest.raises(type(failure)) as caught:
                await anext(body)
            assert caught.value is failure

    asyncio.run(run())
    assert closed == ['upstream', 'client']
    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    assert summary['result'] == ('failure' if isinstance(failure, httpx.ReadError) else 'cancelled')
    assert [phase['phase'] for phase in summary['phases']] == [
        'headers_returned', 'first_decoded_chunk', 'first_parsed_event', 'terminal',
    ]
    assert all('_aws' not in event for event in sink.events)


def test_interleaved_requests_keep_phases_and_joins_request_local() -> None:
    from collections.abc import Awaitable, Callable

    sink = Sink()

    async def handle(request: httpx.Request) -> httpx.Response:
        if request.content == b'one':
            trace = cast('Callable[[str, Mapping[str, Any]], Awaitable[None]]', request.extensions['trace'])
            await trace('connection.connect_tcp.failed', {'exception': RuntimeError('secret exception detail')})
        await asyncio.sleep(0)
        return httpx.Response(200, stream=Stream(frame('response.output_text.delta', delta='private answer')))

    async def run() -> None:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink), transport=httpx.MockTransport(handle))

        async def call(name: str) -> None:
            async def receive() -> dict[str, Any]:
                return {'type': 'http.request', 'body': name.encode()}

            request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                               'headers': [], 'query_string': b''}, receive=receive)
            response = await provider.relay(request, 'v1/responses', f'secret-{name}', account_id=f'account-{name}',
                                            request_context={'runId': name, 'modelStepId': f'step-{name}', 'traceId': f'trace-{name}'})
            assert isinstance(response, StreamingResponse)
            assert b''.join([cast('bytes', chunk) async for chunk in response.body_iterator]) == frame('response.output_text.delta', delta='private answer')

        await asyncio.gather(call('one'), call('two'))

    asyncio.run(run())
    summaries = {event['runId']: event for event in sink.events if event['event'] == 'provider_upstream_phases'}
    assert set(summaries) == {'one', 'two'}
    for name, summary in summaries.items():
        assert summary['accountId'] == f'account-{name}'
        assert summary['modelStepId'] == f'step-{name}' and summary['traceId'] == f'trace-{name}'
        names = [phase['phase'] for phase in summary['phases']]
        assert names.count('connection.connect_tcp.failed') == (1 if name == 'one' else 0)
        assert names[-1] == 'terminal'
    assert 'private' not in json.dumps(sink.events) and 'secret' not in json.dumps(sink.events)


@pytest.mark.parametrize(('encoding', 'classified'), [
    (None, 'absent'), ('', 'other'), ('identity', 'identity'), ('GZIP', 'gzip'),
    ('deflate', 'deflate'), ('br', 'br'), ('zstd', 'zstd'), ('secret-unknown', 'other'), ('gzip, br', 'other'),
])
def test_upstream_content_encoding_is_a_safe_enum_on_failed_responses(
    encoding: str | None, classified: str,
) -> None:
    sink = Sink()

    async def run() -> None:
        headers = {} if encoding is None else {'content-encoding': encoding}
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink),
                                  transport=httpx.MockTransport(lambda request: httpx.Response(503, stream=Stream(b''), headers=headers)))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'secret-access', account_id='account', request_context={})
        assert response.status_code == 503

    asyncio.run(run())
    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    assert summary['upstreamContentEncoding'] == classified
    assert [phase['phase'] for phase in summary['phases']] == ['headers_returned', 'terminal']
    assert 'secret' not in json.dumps(sink.events)
    assert all('_aws' not in event for event in sink.events)


def test_answer_and_completed_frames_forward_before_the_decoded_stream_eof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from collections.abc import AsyncGenerator

    sink = Sink()
    clock = [100.0]
    monkeypatch.setattr('botcube_credential_service.openai.time.monotonic', lambda: clock[0])
    answer = frame('response.output_text.delta', delta='private answer')
    completed = frame('response.completed')

    async def run() -> None:
        allow_completion = asyncio.Event()
        allow_eof = asyncio.Event()

        class GatedStream(httpx.AsyncByteStream):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                clock[0] = 101.2
                yield answer
                await allow_completion.wait()
                clock[0] = 101.9
                yield completed
                await allow_eof.wait()
                clock[0] = 102.0

        async def handle(request: httpx.Request) -> httpx.Response:
            clock[0] = 100.5
            return httpx.Response(200, stream=GatedStream())

        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink), transport=httpx.MockTransport(handle))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
        assert isinstance(response, StreamingResponse)
        body = cast('AsyncGenerator[bytes, None]', response.body_iterator)
        assert await anext(body) == answer
        assert not allow_completion.is_set() and not allow_eof.is_set()
        allow_completion.set()
        assert await anext(body) == completed
        assert not allow_eof.is_set()
        assert not any(event['event'] == 'provider_upstream_phases' for event in sink.events)
        allow_eof.set()
        with pytest.raises(StopAsyncIteration):
            await anext(body)

    asyncio.run(run())
    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    offsets = {phase['phase']: phase['offsetMs'] for phase in summary['phases']}
    assert offsets['first_answer_delta'] == pytest.approx(1200)
    assert offsets['first_completed_event'] == pytest.approx(1900)
    assert offsets['decoded_stream_eof'] == pytest.approx(2000)
    assert offsets['terminal'] == pytest.approx(2000)


def test_grouped_answer_and_completed_keep_the_same_decoded_chunk_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    sink = Sink()
    content = frame('response.output_text.delta', delta='answer') + frame('response.completed')
    monkeypatch.setattr('botcube_credential_service.openai.time.monotonic', lambda: 100.0)

    async def run() -> bytes:
        class GroupedStream(httpx.AsyncByteStream):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                yield content

        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink), transport=httpx.MockTransport(
                                      lambda request: httpx.Response(200, stream=GroupedStream())))

        async def receive() -> dict[str, Any]:
            return {'type': 'http.request', 'body': b'{}'}

        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses',
                           'headers': [], 'query_string': b''}, receive=receive)
        response = await provider.relay(request, 'v1/responses', 'access', account_id='account', request_context={})
        assert isinstance(response, StreamingResponse)
        return b''.join([cast('bytes', chunk) async for chunk in response.body_iterator])

    assert asyncio.run(run()) == content
    [summary] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    assert [phase['phase'] for phase in summary['phases']] == [
        'headers_returned', 'first_decoded_chunk', 'first_parsed_event', 'first_answer_delta',
        'first_completed_event', 'decoded_stream_eof', 'terminal',
    ]
    assert all(phase['offsetMs'] == 0 for phase in summary['phases'])
