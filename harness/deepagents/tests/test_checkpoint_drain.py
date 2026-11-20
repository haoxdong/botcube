from __future__ import annotations

import json
import socket
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import httpx2
import pytest
import uvicorn
from langchain_core.messages import AIMessage

from agentcore_fake import FakeAgentCoreMemory, turn_identity
from botcube_harness_deepagents import serving
from botcube_harness_deepagents.memory.agentcore import warm_session
from test_serving import _replay, _Service

pytest_plugins = ('test_serving', 'test_finished_session_reuse')
pytestmark = pytest.mark.integration


@dataclass
class FinalWrite:
    entered: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)
    stored: int = 0
    fail: bool = False
    answer: str = 'Echo: first'
    checkpoint_id: str | None = None


@pytest.fixture
def final_write(monkeypatch: pytest.MonkeyPatch) -> Iterator[FinalWrite]:
    gate = FinalWrite()
    original = warm_session.WarmSessionSaver.put_with_writes

    def gated(self: warm_session.WarmSessionSaver, config: Any, checkpoint: Any, *args: Any, **kwargs: Any) -> Any:
        messages = checkpoint['channel_values'].get('messages', [])
        if messages and isinstance(messages[-1], AIMessage) and messages[-1].text == gate.answer:
            if gate.checkpoint_id is None:
                gate.checkpoint_id = checkpoint['id']
            if checkpoint['id'] != gate.checkpoint_id:
                return original(self, config, checkpoint, *args, **kwargs)
            gate.entered.set()
            assert gate.release.wait(15), 'Final checkpoint was never released'
            if gate.fail:
                raise ConnectionError('Final checkpoint refused after answer')
            result = original(self, config, checkpoint, *args, **kwargs)
            gate.stored += 1
            return result
        return original(self, config, checkpoint, *args, **kwargs)

    monkeypatch.setattr(warm_session.WarmSessionSaver, 'put_with_writes', gated)
    yield gate
    gate.release.set()


@pytest.fixture
def streaming_url(service: _Service) -> Iterator[str]:
    """Match the per-test bot and Memory fixture lifecycle."""
    ready = threading.Event()

    class Server(uvicorn.Server):
        async def startup(self, sockets: list[socket.socket] | None = None) -> None:
            await super().startup(sockets)
            ready.set()

    with socket.socket() as sock, ThreadPoolExecutor(max_workers=1) as pool:
        sock.bind(('127.0.0.1', 0))
        server = Server(uvicorn.Config(serving.app, log_level='error', lifespan='off'))
        running = pool.submit(server.run, sockets=[sock])
        try:
            assert ready.wait(5), 'The local streaming server did not start'
            yield f'http://127.0.0.1:{sock.getsockname()[1]}/invocations'
        finally:
            server.should_exit = True
            running.result(timeout=5)


def payload(text: str = 'first', run: str = 'draining-run', canonical: bool = False) -> dict[str, Any]:
    return {
        'threadId': 'thread-1', 'runId': run,
        'messages': [{'id': run, 'role': 'user', 'content': text}],
        'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1',
                           'turnIdentity': turn_identity('actor-1', 'user-1', 'thread-1'),
                           'worklog_clock': int(canonical)},
    }


def read_stream(url: str, body: dict[str, Any], finished: threading.Event, eof: threading.Event, disconnect_on_finish: bool = False) -> list[dict[str, Any]]:
    events = []
    with httpx2.Client(timeout=10) as client, client.stream('POST', url, json=body) as response:
        assert response.status_code == 200
        for line in response.iter_lines():
            if line.startswith('data: '):
                value = json.loads(line[6:])
                events.append(value)
                if value.get('type') == 'RUN_FINISHED':
                    finished.set()
                    if disconnect_on_finish:
                        return events
    eof.set()
    return events


@pytest.mark.parametrize('canonical', [False, True])
def test_client_receives_finished_before_eof_and_the_checkpoint_is_stored_once(
    service: _Service, memory: FakeAgentCoreMemory, streaming_url: str, final_write: FinalWrite, canonical: bool,
) -> None:
    finished, eof = threading.Event(), threading.Event()
    with ThreadPoolExecutor() as pool:
        response = pool.submit(read_stream, streaming_url, payload(canonical=canonical), finished, eof)
        try:
            assert final_write.entered.wait(5)
            assert finished.wait(2), 'Client did not receive RUN_FINISHED while the final write was held'
            assert not eof.is_set()
            assert final_write.stored == 0
        finally:
            final_write.release.set()
        events = response.result(timeout=5)
    assert eof.is_set()
    assert final_write.stored == 1
    assert sum(event.get('type') == 'RUN_FINISHED' for event in events) == 1
    assert _replay('user-1', 'thread-1') == [('user', 'first'), ('assistant', 'Echo: first')]


@pytest.mark.parametrize('canonical', [False, True])
def test_a_failed_final_write_has_a_non_agui_frame_and_fails_the_next_turn(
    service: _Service, memory: FakeAgentCoreMemory, streaming_url: str, final_write: FinalWrite, caplog: pytest.LogCaptureFixture, canonical: bool,
) -> None:
    final_write.fail = True
    finished, eof = threading.Event(), threading.Event()
    with ThreadPoolExecutor() as pool:
        response = pool.submit(read_stream, streaming_url, payload(canonical=canonical), finished, eof)
        try:
            assert final_write.entered.wait(5)
            assert finished.wait(2)
            assert not eof.is_set()
        finally:
            final_write.release.set()
        events = response.result(timeout=5)
    assert [event.get('type') for event in events].count('RUN_FINISHED') == 1
    assert not any(event.get('type') == 'RUN_ERROR' for event in events)
    assert events[-1]['error'] == {'code': 'CHECKPOINT_WRITE_FAILED', 'message': 'Final checkpoint refused after answer'}
    assert 'checkpoint_write_failed_after_finish' in caplog.text
    with httpx2.Client(timeout=10) as client:
        following = client.post(streaming_url, json=payload('second', 'next-run'))
    assert 'CHECKPOINT_WRITE_FAILED' in following.text
    assert 'RUN_FINISHED' not in following.text
    assert service.recorder.heard == [['first']]


def test_a_tool_turn_keeps_its_terminal_behind_the_final_checkpoint(
    service: _Service, memory: FakeAgentCoreMemory, streaming_url: str, final_write: FinalWrite,
) -> None:
    final_write.answer = 'Tool said: child answer'
    finished, eof = threading.Event(), threading.Event()
    with ThreadPoolExecutor() as pool:
        response = pool.submit(read_stream, streaming_url, payload('delegate: say: child answer'), finished, eof)
        try:
            assert final_write.entered.wait(5)
            assert not finished.wait(0.2)
            assert not eof.is_set()
        finally:
            final_write.release.set()
        events = response.result(timeout=5)
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert final_write.stored == 1
    assert _replay('user-1', 'thread-1')[-1] == ('assistant', 'Tool said: child answer')


@pytest.mark.parametrize('canonical', [False, True])
def test_closing_the_client_after_finished_does_not_cancel_the_checkpoint(
    service: _Service, memory: FakeAgentCoreMemory, streaming_url: str, final_write: FinalWrite, canonical: bool,
) -> None:
    finished, eof = threading.Event(), threading.Event()
    with ThreadPoolExecutor() as pool:
        response = pool.submit(read_stream, streaming_url, payload(canonical=canonical), finished, eof, True)
        try:
            assert final_write.entered.wait(5)
            assert finished.wait(2)
            response.result(timeout=2)
            assert not eof.is_set()
            assert final_write.stored == 0
        finally:
            final_write.release.set()
    with httpx2.Client(timeout=10) as client:
        following = client.post(streaming_url, json=payload('second', 'next-run'))
    assert 'RUN_FINISHED' in following.text
    assert final_write.stored == 1
    assert service.recorder.heard[-1] == ['first', 'second']
    assert _replay('user-1', 'thread-1')[-2:] == [('user', 'second'), ('assistant', 'Echo: second')]
