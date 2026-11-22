import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from starlette.requests import ClientDisconnect
from starlette.types import Message

from botcube_harness_deepagents import serving
from test_serving import _Service
from test_serving import service as service
from test_serving import start as start


def _stamps(caplog: pytest.LogCaptureFixture) -> list[dict[str, object]]:
    return [json.loads(record.message) for record in caplog.records
            if record.message.startswith('{"event":"harness_response_first_body"')]


@pytest.mark.parametrize('chunks,fail_send', [
    (['', ': keepalive\n\n', 'data: private-answer\n\n'], False),
    (['', ''], False),
    (['', 'data: private-answer\n\n'], True),
])
def test_first_nonempty_body_is_stamped_at_the_asgi_send_boundary(
    chunks: list[str], fail_send: bool, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, 'time_ns', lambda: 123456789)
    caplog.set_level(logging.INFO, logger=serving.__name__)
    output: list[Message] = []

    async def body() -> AsyncGenerator[str, None]:
        for chunk in chunks:
            yield chunk

    async def send(message: Message) -> None:
        stamps = _stamps(caplog)
        if message['type'] == 'http.response.start' or not any(chunks):
            assert stamps == []
        elif message['type'] == 'http.response.body' and message.get('body'):
            assert stamps == [{'event': 'harness_response_first_body', 'runId': 'run-1',
                               'runtimeSessionId': 'runtime-session-1', 'atUnixNs': 123456789}]
            if fail_send:
                raise OSError('Disconnected')
        output.append(message)

    async def receive() -> Message:
        return {'type': 'http.request', 'body': b''}

    async def request() -> None:
        response = serving._InvocationResponse(body(), run_id='run-1', runtime_session_id='runtime-session-1',
                                                media_type='text/event-stream')
        await response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send)

    if fail_send:
        with pytest.raises(ClientDisconnect):
            asyncio.run(request())
    else:
        asyncio.run(request())
        assert b''.join(message.get('body', b'') for message in output) == ''.join(chunks).encode()
    assert 'private-answer' not in caplog.text


def test_diagnostic_invocation_holds_the_selected_verification_run(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE', '1')
    monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE_SCOPE', json.dumps({
        'runId': 'run-0', 'verificationIdentity': 'diagnostic-test-user',
        'expiresAt': (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
    }))
    waits: list[float] = []
    sleep = asyncio.sleep

    async def fast_sleep(seconds: float) -> None:
        if seconds >= 1:
            waits.append(seconds)
        else:
            await sleep(seconds)

    monkeypatch.setattr(asyncio, 'sleep', fast_sleep)
    events = service.turn('hello', actor='diagnostic-test-user', user='diagnostic-test-user')

    assert len(waits) == 1
    assert 30 < waits[0] <= 31
    assert events[-1]['type'] == 'RUN_FINISHED'
