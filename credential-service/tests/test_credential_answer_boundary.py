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
from test_provider_ttft import Sink, frame


@pytest.mark.parametrize('response_id', ['resp-safe', None, 'resp-wrong'])
def test_actual_relay_boundary_excludes_headers_and_completion_and_keeps_bytes(
    monkeypatch: pytest.MonkeyPatch, response_id: str | None,
) -> None:
    clock = [10.0]
    monkeypatch.setattr('botcube_credential_service.openai.time.monotonic', lambda: clock[0])

    class DelayedSink(Sink):
        def record(self, event: Mapping[str, Any]) -> None:
            super().record(event)
            if event['event'] == 'provider_first_answer':
                clock[0] += .05
            if event['event'] == 'credential_first_answer_boundary':
                clock[0] += 5.0

    sink = DelayedSink()
    created = b'' if response_id is None else frame('response.created', response={'id': response_id})
    answer = frame('response.output_text.delta', response_id='resp-safe', item_id='msg-safe', delta='private answer')
    content = created + frame('response.output_text.delta', delta='  ') + answer + frame('response.completed')

    class TimedStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            clock[0] = 10.5
            yield created + frame('response.output_text.delta', delta='  ') + answer[:15]
            clock[0] = 10.7
            yield answer[15:]
            clock[0] = 20.0
            yield frame('response.completed')

    async def handle(_: httpx.Request) -> httpx.Response:
        clock[0] = 10.4
        return httpx.Response(200, stream=TimedStream())

    async def run() -> bytes:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None),
                                  audit=CredentialAuditRecorder(sink=sink), transport=httpx.MockTransport(handle))
        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses', 'headers': [], 'query_string': b''})
        request._body = b'{}'
        request.state.credential_received_at = 10.0
        clock[0] = 10.2
        response = await provider.relay(request, 'v1/responses', 'secret-token', account_id='private-account',
                                        request_context={'runId': 'run', 'sessionId': 'session', 'modelStepId': 'step',
                                                         'modelId': 'model', 'traceId': 'a' * 32})
        assert isinstance(response, StreamingResponse)
        forwarded: list[bytes] = []
        async for chunk in response.body_iterator:
            forwarded.append(cast('bytes', chunk))
            if chunk == answer:
                assert clock[0] == pytest.approx(10.75)
                assert not any(event['event'] == 'credential_first_answer_boundary' for event in sink.events)
        assert clock[0] == pytest.approx(25.0)
        return b''.join(forwarded)

    assert asyncio.run(run()) == content
    [boundary] = [event for event in sink.events if event['event'] == 'credential_first_answer_boundary']
    assert boundary['status'] == ('complete' if response_id == 'resp-safe' else 'invalid')
    assert boundary['offsetsMs'] == pytest.approx({'receipt': 0, 'upstreamDispatch': 200,
                                                  'answerReceived': 700, 'answerEmitted': 750})
    [phases] = [event for event in sink.events if event['event'] == 'provider_upstream_phases']
    assert phases['phases'][-1]['offsetMs'] == pytest.approx(9800)
    assert boundary['providerResponseId'] == response_id
    assert boundary['providerItemId'] == 'msg-safe'
    assert 'accountId' not in boundary
    assert 'private' not in json.dumps(boundary) and 'secret' not in json.dumps(boundary)


@pytest.mark.parametrize('receipt,created,item,answer', [
    (None, 'resp-safe', 'msg-safe', True),
    (11.0, 'resp-safe', 'msg-safe', True),
    (10.0, None, 'msg-safe', True),
    (10.0, 'resp-safe', None, True),
    (10.0, 'resp-safe', 'msg-safe', False),
])
def test_missing_reversed_and_wrong_message_boundaries_never_break_forwarding(
    receipt: float | None, created: str | None, item: str | None, answer: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sink = Sink()
    clock = [10.0]
    monkeypatch.setattr('botcube_credential_service.openai.time.monotonic', lambda: clock[0])
    content = frame('response.created', response={'id': created})
    content += frame('response.output_text.delta', item_id=item, delta='private answer' if answer else ' ')
    content += frame('response.completed')

    async def run() -> bytes:
        provider = OpenAIProvider(lambda: cast('RotatingCredentialVault', None), audit=CredentialAuditRecorder(sink=sink),
                                  transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=httpx.ByteStream(content))))
        request = Request({'type': 'http', 'method': 'POST', 'path': '/v1/responses', 'headers': [], 'query_string': b''})
        request._body = b'{}'
        request.state.credential_received_at = receipt
        response = await provider.relay(request, 'v1/responses', 'secret', account_id='private',
                                        request_context={'runId': 'run', 'sessionId': 'session', 'modelId': 'model',
                                                         'modelStepId': 'step', 'traceId': 'a' * 32})
        assert isinstance(response, StreamingResponse)
        return b''.join([cast('bytes', chunk) async for chunk in response.body_iterator])

    assert asyncio.run(run()) == content
    [event] = [entry for entry in sink.events if entry['event'] == 'credential_first_answer_boundary']
    assert event['status'] == 'invalid'
    assert 'private' not in json.dumps(event)


@pytest.mark.parametrize('receipt', [True, float('inf'), float('nan'), None])
def test_private_boundary_omits_invalid_raw_identifiers_and_rejects_nonfinite_clocks(receipt: Any) -> None:
    from botcube_credential_service.answer_boundary import CredentialAnswerBoundary

    sink = Sink()
    boundary = CredentialAnswerBoundary(CredentialAuditRecorder(sink=sink),
                                         {'sessionId': 'session', 'runId': 'private text', 'traceId': 'raw-secret',
                                          'modelStepId': 's' * 129, 'modelId': 'private/model'}, receipt, 10.0)
    boundary.record()
    [event] = sink.events
    assert event['status'] == 'invalid' and event['invalidReason'] == 'missing_boundary'
    assert event['offsetsMs'] == {}
    assert 'runId' not in event and 'traceId' not in event and 'modelStepId' not in event and 'modelId' not in event
    assert 'private' not in json.dumps(event) and 'secret' not in json.dumps(event)
