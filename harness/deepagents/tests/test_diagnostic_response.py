from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest
from ag_ui.core import RunAgentInput
from starlette.types import Message

from botcube_harness_deepagents import diagnostic_response, serving
from botcube_harness_deepagents.invocation import Invocation

FRAMES = ': keepalive\n\ndata: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n'
WALL = datetime(2026, 11, 23, tzinfo=UTC).timestamp()
_yield = asyncio.sleep


@dataclass
class Clock:
    mono: float = 100
    wall: float = WALL
    waits: list[float] = field(default_factory=list)
    release: asyncio.Event = field(default_factory=asyncio.Event)
    block: bool = False

    async def sleep(self, seconds: float) -> None:
        self.waits.append(seconds)
        if self.block:
            await self.release.wait()
        self.mono += seconds
        self.wall += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[Clock]:
    result = Clock()
    monkeypatch.setattr(diagnostic_response, 'perf_counter', lambda: result.mono)
    monkeypatch.setattr(diagnostic_response, 'time', lambda: result.wall)
    monkeypatch.setattr(asyncio, 'sleep', result.sleep)
    diagnostic_response._configured_gate.cache_clear()
    monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE', '1')
    scope(monkeypatch)
    yield result
    diagnostic_response._configured_gate.cache_clear()


def scope(monkeypatch: pytest.MonkeyPatch, *, seconds: float = 120) -> None:
    monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE_SCOPE', json.dumps({
        'runId': 'diagnostic-run', 'verificationIdentity': 'owned-test-user',
        'expiresAt': datetime.fromtimestamp(WALL + seconds, UTC).isoformat(),
    }))


def run(run_id: str = 'diagnostic-run', forwarded: dict[str, object] | None = None) -> Invocation:
    return Invocation.parse(RunAgentInput(thread_id='owned-session', run_id=run_id, messages=[], tools=[],
                         context=[], state={}, forwarded_props=forwarded or {}))


async def respond(request: Invocation, sent: list[Message], produced: list[bool], *,
                  identity: str = 'owned-test-user', receipt: float = 100) -> None:
    async def body() -> AsyncIterator[str]:
        produced.append(True)
        yield FRAMES

    async def send(message: Message) -> None:
        sent.append(message)

    async def receive() -> Message:
        return {'type': 'http.request', 'body': b''}

    response = serving._InvocationResponse(
        body(), run_id=request.run_id, runtime_session_id='runtime-session', media_type='text/event-stream',
        diagnostic_hold=diagnostic_response.response_hold(request, receipt, lambda: identity),
    )
    await response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send)


def test_holds_headers_comments_and_body_until_31_seconds_from_receipt(clock: Clock) -> None:
    async def scenario() -> None:
        sent: list[Message] = []
        produced: list[bool] = []
        clock.block = True
        clock.mono = 104
        clock.wall += 4
        task = asyncio.create_task(respond(run(), sent, produced))
        await _yield(0)
        assert clock.waits == [27]
        assert sent == []
        assert produced == []
        clock.release.set()
        await task
        assert clock.mono == 131
        assert sent[0]['type'] == 'http.response.start'
        assert b''.join(message.get('body', b'') for message in sent) == FRAMES.encode()
        assert sent[-1]['more_body'] is False

    asyncio.run(scenario())


@pytest.mark.parametrize('case', ['default-off', 'off', 'wrong-run', 'wrong-identity', 'expired', 'too-late',
                                 'warmup', 'stop', 'steering', 'withdrawSteering'])
def test_other_requests_pass_without_a_delay(
    case: str, clock: Clock, monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = run()
    identity = 'owned-test-user'
    if case == 'default-off':
        monkeypatch.delenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE')
        monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE_SCOPE', 'ignored while off')
    elif case == 'off':
        monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE', '0')
    elif case == 'wrong-run':
        request = run('ordinary-run')
    elif case == 'wrong-identity':
        identity = 'real-person-account'
    elif case == 'expired':
        scope(monkeypatch, seconds=0)
    elif case == 'too-late':
        scope(monkeypatch, seconds=30)
    else:
        request = run(forwarded={case: 'message-id' if case == 'withdrawSteering' else True})
    sent: list[Message] = []
    asyncio.run(respond(request, sent, [], identity=identity))
    assert clock.waits == []
    assert sent[0]['type'] == 'http.response.start'
    assert b''.join(message.get('body', b'') for message in sent) == FRAMES.encode()


def test_nonmatching_identity_does_not_consume_the_verification_attempt(clock: Clock) -> None:
    async def scenario() -> None:
        await respond(run(), [], [], identity='real-person-account')
        await respond(run(), [], [])
        assert clock.waits == [31]
    asyncio.run(scenario())


def test_concurrent_duplicates_cannot_both_claim_the_hold(clock: Clock) -> None:
    async def scenario() -> None:
        first: list[Message] = []
        second: list[Message] = []
        clock.block = True
        task = asyncio.create_task(respond(run(), first, []))
        await _yield(0)
        await respond(run(), second, [])
        assert clock.waits == [31]
        assert first == []
        assert second[-1]['more_body'] is False
        clock.release.set()
        await task
    asyncio.run(scenario())


def test_cancellation_sends_nothing_and_consumes_the_attempt(clock: Clock) -> None:
    async def scenario() -> None:
        sent: list[Message] = []
        produced: list[bool] = []
        clock.block = True
        task = asyncio.create_task(respond(run(), sent, produced))
        await _yield(0)
        assert clock.waits == [31]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert sent == []
        assert produced == []
        await respond(run(), sent, produced)
        assert clock.waits == [31]
        assert sent[-1]['more_body'] is False
    asyncio.run(scenario())


def test_expired_unused_configuration_is_inert(clock: Clock) -> None:
    clock.wall += 121
    sent: list[Message] = []
    asyncio.run(respond(run(), sent, []))
    assert clock.waits == []
    assert sent[-1]['more_body'] is False


@pytest.mark.parametrize('raw', ['', '{}', '{"runId":"x"}',
                                 '{"runId":"x","verificationIdentity":"y","expiresAt":"2026-11-23"}',
                                 '{"runId":"","verificationIdentity":"y","expiresAt":"2026-11-23T00:00:00Z"}'])
def test_enabled_configuration_requires_the_whole_scope(raw: str, clock: Clock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE_SCOPE', raw)
    with pytest.raises(ValueError, match='requires runId, verificationIdentity and timezone-aware expiresAt'):
        diagnostic_response.configured_gate()


def test_flag_must_be_explicit(clock: Clock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_DIAGNOSTIC_FIRST_RESPONSE', 'true')
    with pytest.raises(ValueError, match='must be 0 or 1'):
        diagnostic_response.configured_gate()
