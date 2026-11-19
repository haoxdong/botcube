from __future__ import annotations

import asyncio
import io
import json
import socket
import struct
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from botcube_harness_deepagents import llm
from botcube_harness_deepagents.credential_source import CredentialSourceError

pytestmark = pytest.mark.integration


class StandIn:
    """An OpenAI-compatible endpoint answering each chat completion with `Echo: <text>`, after any gateway failures and dropped connections."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.gateway_failures: list[int] = []
        self.drops: list[str] = []
        stand_in = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                stand_in.requests.append({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body})
                if stand_in.gateway_failures:
                    self._send(stand_in.gateway_failures.pop(0), 'application/json', b'{"error":{"message":"gateway"}}')
                    return
                drop = stand_in.drops.pop(0) if stand_in.drops else None
                if drop == 'before-response':
                    self._reset()
                    return
                if drop == 'closed-before-response':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                text = f"Echo: {body['messages'][-1]['content']}"
                if drop == 'mid-response':
                    started = {'id': 'c1', 'object': 'chat.completion.chunk', 'model': body['model'], 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': None}]}
                    self.send_response(200)
                    self.send_header('content-type', 'text/event-stream')
                    self.end_headers()
                    self.wfile.write(f'data: {json.dumps(started)}\n\n'.encode())
                    self.wfile.flush()
                    self._reset()
                    return
                chunk = {'id': 'c1', 'object': 'chat.completion.chunk', 'model': body['model'], 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}]}
                self._send(200, 'text/event-stream', f'data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n'.encode())

            def _reset(self) -> None:
                self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                self.connection.close()
                self.close_connection = True

            def _send(self, status: int, content_type: str, payload: bytes) -> None:
                self.send_response(status)
                self.send_header('content-type', content_type)
                self.send_header('content-length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1'


@pytest.fixture
def stand_in() -> Iterator[StandIn]:
    server = StandIn()
    thread = threading.Thread(target=server.server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.server.shutdown()


@pytest.fixture
def deployed(stand_in: StandIn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """The environment the deploy gives the Harness for the enterprise example's models Endpoint, at the stand-in."""
    key = tmp_path / 'models-api-key'
    key.write_text('sk-mounted\n')
    endpoint = {'url': stand_in.url, 'credential': {'kind': 'file', 'path': str(key)}, 'headers': {'x-tenant': 'botcube-example'}}
    monkeypatch.setenv('BOTCUBE_MODELS_ENDPOINT', json.dumps(endpoint))
    monkeypatch.setenv('BOTCUBE_TURN_SUMMARY_MODEL', 'example-summary')
    llm.models_endpoint.cache_clear()
    yield key
    llm.models_endpoint.cache_clear()


def _reply(model_key: str = 'echo') -> str:
    return str(asyncio.run(llm.build_model(model=model_key).ainvoke('Hello, who are you?')).content)


@pytest.mark.usefixtures('deployed')
def test_a_turn_reaches_the_endpoint_with_its_credential_and_headers(stand_in: StandIn) -> None:
    assert _reply() == 'Echo: Hello, who are you?'

    [request] = stand_in.requests
    assert request['path'] == '/v1/chat/completions'
    assert request['body']['model'] == 'echo'
    assert request['headers']['authorization'] == 'Bearer sk-mounted'
    assert request['headers']['x-tenant'] == 'botcube-example'


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('status', [502, 503, 504])
def test_a_turn_retries_a_gateway_failure_before_the_first_byte(stand_in: StandIn, status: int) -> None:
    stand_in.gateway_failures.extend([status, status])

    assert _reply() == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
def test_a_turn_retries_a_connection_dropped_before_the_response(stand_in: StandIn) -> None:
    stand_in.drops.extend(['before-response', 'before-response'])

    assert _reply() == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_after_three_dropped_connections(stand_in: StandIn) -> None:
    import openai

    stand_in.drops.extend(['before-response', 'before-response', 'before-response'])
    with pytest.raises(openai.APIConnectionError):
        _reply()
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_without_retrying_a_connection_closed_before_the_response(stand_in: StandIn) -> None:
    import openai

    stand_in.drops.append('closed-before-response')
    with pytest.raises(openai.APIConnectionError):
        _reply()
    assert len(stand_in.requests) == 1


@pytest.fixture
def refusing_url() -> str:
    with socket.socket() as closed:
        closed.bind(('127.0.0.1', 0))
        port = closed.getsockname()[1]
    return f'http://127.0.0.1:{port}/v1/chat/completions'


@pytest.fixture
def unaccepting_url() -> Iterator[str]:
    """A listener whose accept queue is full, so a new connection never completes."""
    with socket.socket() as listener, socket.socket() as queued:
        listener.bind(('127.0.0.1', 0))
        listener.listen(0)
        queued.connect(listener.getsockname())
        yield f'http://127.0.0.1:{listener.getsockname()[1]}/v1/chat/completions'


def _attempts(url: str) -> tuple[int, type[BaseException]]:
    import httpx

    client = llm._endpoint_client()
    attempts: list[httpx.Request] = []

    async def attempted(request: httpx.Request) -> None:
        attempts.append(request)

    client.event_hooks['request'].append(attempted)

    async def send() -> None:
        async with client:
            await client.post(url, json={}, timeout=httpx.Timeout(5, connect=0.05))

    with pytest.raises(httpx.TransportError) as failure:
        asyncio.run(send())
    return len(attempts), failure.type


def test_the_endpoint_retries_a_refused_connection(refusing_url: str) -> None:
    import httpx

    assert _attempts(refusing_url) == (3, httpx.ConnectError)


def test_the_endpoint_retries_a_connect_timeout(unaccepting_url: str) -> None:
    import httpx

    assert _attempts(unaccepting_url) == (3, httpx.ConnectTimeout)


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_once_on_a_stream_dropped_mid_response(stand_in: StandIn) -> None:
    import httpx

    stand_in.drops.append('mid-response')
    streamed = io.StringIO()

    async def stream() -> None:
        async for chunk in llm.build_model(model='echo').astream('Hello, who are you?'):
            streamed.write(str(chunk.content))

    with pytest.raises(httpx.TransportError):
        asyncio.run(stream())
    assert streamed.getvalue() == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 1


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_once_on_a_body_dropped_mid_response_without_streaming(stand_in: StandIn) -> None:
    import openai

    stand_in.drops.append('mid-response')
    model = llm.build_model(model='echo').model_copy(update={'streaming': False})
    with pytest.raises(openai.APIConnectionError):
        asyncio.run(model.ainvoke('Hello, who are you?'))
    assert len(stand_in.requests) == 1


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_after_three_gateway_failures(stand_in: StandIn) -> None:
    import openai

    stand_in.gateway_failures.extend([503, 503, 503])
    with pytest.raises(openai.InternalServerError):
        _reply()
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('status', [500, 429])
def test_a_turn_fails_on_other_errors_without_retrying(stand_in: StandIn, status: int) -> None:
    import openai

    stand_in.gateway_failures.append(status)
    with pytest.raises(openai.APIStatusError):
        _reply()
    assert len(stand_in.requests) == 1


def test_startup_fails_naming_the_seam_and_source_when_the_credential_cannot_be_read(deployed: Path) -> None:
    deployed.unlink()
    with pytest.raises(CredentialSourceError, match=f'^models credential \\(file {deployed}\\): '):
        llm.models_endpoint()


def test_startup_fails_on_an_endpoint_the_deploy_wrote_wrong(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_MODELS_ENDPOINT', json.dumps({'url': 'https://models.example.com/v1', 'apiKey': 'sk-live'}))
    llm.models_endpoint.cache_clear()
    with pytest.raises(RuntimeError, match="^BOTCUBE_MODELS_ENDPOINT: unknown field apiKey$"):
        llm.models_endpoint()
    llm.models_endpoint.cache_clear()
