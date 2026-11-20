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
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from botcube_harness_deepagents import llm, turn_timing
from botcube_harness_deepagents.definition import ModelRelay, openai_model_relay
from botcube_harness_deepagents.deployment_config import DeploymentConfigError
from deployment_fixture import ENDPOINT_MODELS, deploy

pytestmark = pytest.mark.integration


class StandIn:
    """The Credential Service's models relay, answering each chat completion with `Echo: <text>`, after any gateway failures and dropped connections."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.gateway_failures: list[int] = []
        self.usage: dict[str, Any] = {'prompt_tokens': 26, 'completion_tokens': 4, 'total_tokens': 30}
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
                content = body['messages'][-1]['content']
                text = 'Echo: ' + (content if isinstance(content, str) else ''.join(part['text'] for part in content))
                if drop == 'mid-response':
                    started = {'id': 'c1', 'object': 'chat.completion.chunk', 'model': body['model'], 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': None}]}
                    self.send_response(200)
                    self.send_header('content-type', 'text/event-stream')
                    self.end_headers()
                    self.wfile.write(f'data: {json.dumps(started)}\n\n'.encode())
                    self.wfile.flush()
                    self._reset()
                    return
                chunks = [{'id': 'c1', 'object': 'chat.completion.chunk', 'model': body['model'], 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}]}]
                if body.get('stream_options', {}).get('include_usage'):
                    chunks.append({'id': 'c1', 'object': 'chat.completion.chunk', 'model': body['model'], 'choices': [], 'usage': stand_in.usage})
                self._send(200, 'text/event-stream', ''.join(f'data: {json.dumps(chunk)}\n\n' for chunk in chunks).encode() + b'data: [DONE]\n\n')

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
        self.url = f'http://127.0.0.1:{self.server.server_port}'


@pytest.fixture
def stand_in() -> Iterator[StandIn]:
    server = StandIn()
    thread = threading.Thread(target=server.server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.server.shutdown()


@pytest.fixture
def deployed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    deploy(monkeypatch, tmp_path, models=ENDPOINT_MODELS)


def _turn(stand_in: StandIn, token: str = 'invocation-1') -> ModelRelay:
    return openai_model_relay(f'{stand_in.url}/template', token, 'thread-1')


def _reply(stand_in: StandIn, model_key: str = 'echo') -> str:
    return str(asyncio.run(llm.build_model(model=model_key, relay=lambda: _turn(stand_in)).ainvoke('Hello, who are you?')).content)


@pytest.mark.usefixtures('deployed')
def test_a_turn_reaches_the_endpoint_through_the_credential_service_under_its_invocation_and_no_bearer(stand_in: StandIn) -> None:
    assert _reply(stand_in) == 'Echo: Hello, who are you?'

    [request] = stand_in.requests
    assert request['path'] == '/models/chat/completions'
    assert request['body']['model'] == 'echo'
    assert request['headers']['authorization'] == 'Bearer invocation-1'
    assert request['headers']['x-botcube-session-id'] == 'thread-1'


@pytest.mark.usefixtures('deployed')
def test_a_cached_endpoint_model_takes_each_turns_invocation(stand_in: StandIn) -> None:
    current = {'token': 'invocation-1'}
    model = llm.build_model(model='echo', relay=lambda: _turn(stand_in, current['token']))

    asyncio.run(model.ainvoke('Hello'))
    current['token'] = 'invocation-2'
    asyncio.run(model.ainvoke('Hello'))

    assert [request['headers']['authorization'] for request in stand_in.requests] == ['Bearer invocation-1', 'Bearer invocation-2']


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('status', [502, 503, 504])
def test_a_turn_retries_a_gateway_failure_before_the_first_byte(stand_in: StandIn, status: int) -> None:
    stand_in.gateway_failures.extend([status, status])

    assert _reply(stand_in) == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
def test_a_turn_retries_a_connection_dropped_before_the_response(stand_in: StandIn) -> None:
    stand_in.drops.extend(['before-response', 'before-response'])

    assert _reply(stand_in) == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_after_three_dropped_connections(stand_in: StandIn) -> None:
    import openai

    stand_in.drops.extend(['before-response', 'before-response', 'before-response'])
    with pytest.raises(openai.APIConnectionError):
        _reply(stand_in)
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_without_retrying_a_connection_closed_before_the_response(stand_in: StandIn) -> None:
    import openai

    stand_in.drops.append('closed-before-response')
    with pytest.raises(openai.APIConnectionError):
        _reply(stand_in)
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
        async for chunk in llm.build_model(model='echo', relay=lambda: _turn(stand_in)).astream('Hello, who are you?'):
            streamed.write(str(chunk.content))

    with pytest.raises(httpx.TransportError):
        asyncio.run(stream())
    assert streamed.getvalue() == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 1


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_once_on_a_body_dropped_mid_response_without_streaming(stand_in: StandIn) -> None:
    import openai

    stand_in.drops.append('mid-response')
    model = llm.build_model(model='echo', relay=lambda: _turn(stand_in)).model_copy(update={'streaming': False})
    with pytest.raises(openai.APIConnectionError):
        asyncio.run(model.ainvoke('Hello, who are you?'))
    assert len(stand_in.requests) == 1


@pytest.mark.usefixtures('deployed')
def test_a_turn_fails_after_three_gateway_failures(stand_in: StandIn) -> None:
    import openai

    stand_in.gateway_failures.extend([503, 503, 503])
    with pytest.raises(openai.InternalServerError):
        _reply(stand_in)
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('status', [500, 429])
def test_a_turn_fails_on_other_errors_without_retrying(stand_in: StandIn, status: int) -> None:
    import openai

    stand_in.gateway_failures.append(status)
    with pytest.raises(openai.APIStatusError):
        _reply(stand_in)
    assert len(stand_in.requests) == 1


@pytest.mark.usefixtures('deployed')
def test_a_turn_without_the_credential_service_fails_naming_it() -> None:
    with pytest.raises(RuntimeError, match='^Model "echo" runs on the models Endpoint, which needs the Credential Service relay; this Turn has none$'):
        llm.build_model(model='echo')


CONVERSATION = [
    SystemMessage('You are BotCube.'),
    HumanMessage('List the files.'),
    AIMessage('', tool_calls=[{'id': 'call-1', 'name': 'ls', 'args': {}}]),
    ToolMessage('notes.md', tool_call_id='call-1'),
    AIMessage('There is one file, notes.md.'),
    HumanMessage('Read it.'),
]
MARKER = {'type': 'ephemeral'}


@pytest.fixture
def cache_markers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    deploy(monkeypatch, tmp_path, models={**ENDPOINT_MODELS, 'cacheMarkers': 'claude'})


def _converse(stand_in: StandIn, messages: list[Any]) -> str:
    return str(asyncio.run(llm.build_model(model='echo', relay=lambda: _turn(stand_in)).ainvoke(messages)).content)


@pytest.mark.usefixtures('deployed', 'cache_markers')
def test_cache_markers_land_on_the_system_prompt_and_the_latest_messages(stand_in: StandIn) -> None:
    assert _converse(stand_in, CONVERSATION) == 'Echo: Read it.'

    [request] = stand_in.requests
    assert request['body']['messages'] == [
        {'role': 'system', 'content': [{'type': 'text', 'text': 'You are BotCube.', 'cache_control': MARKER}]},
        {'role': 'user', 'content': 'List the files.'},
        {'role': 'assistant', 'content': None, 'tool_calls': [{'type': 'function', 'id': 'call-1', 'function': {'name': 'ls', 'arguments': '{}'}}]},
        {'role': 'tool', 'content': 'notes.md', 'tool_call_id': 'call-1'},
        {'role': 'assistant', 'content': [{'type': 'text', 'text': 'There is one file, notes.md.', 'cache_control': MARKER}]},
        {'role': 'user', 'content': [{'type': 'text', 'text': 'Read it.', 'cache_control': MARKER}]},
    ]


@pytest.mark.usefixtures('deployed', 'cache_markers')
def test_cache_markers_mark_a_tool_result_but_not_a_call_with_no_text(stand_in: StandIn) -> None:
    _converse(stand_in, CONVERSATION[:4])

    [request] = stand_in.requests
    assert [message.get('content') for message in request['body']['messages']] == [
        [{'type': 'text', 'text': 'You are BotCube.', 'cache_control': MARKER}],
        'List the files.',
        None,
        [{'type': 'text', 'text': 'notes.md', 'cache_control': MARKER}],
    ]


@pytest.mark.usefixtures('deployed')
def test_no_request_carries_a_cache_marker_unless_the_operator_turns_them_on(stand_in: StandIn) -> None:
    _converse(stand_in, CONVERSATION)

    [request] = stand_in.requests
    assert 'cache_control' not in json.dumps(request['body'])
    assert request['body']['messages'][0] == {'role': 'system', 'content': 'You are BotCube.'}


@pytest.mark.usefixtures('deployed')
def test_the_turn_reports_the_cached_input_tokens_the_gateway_reports(stand_in: StandIn) -> None:
    stand_in.usage = {'prompt_tokens': 26, 'completion_tokens': 4, 'total_tokens': 30, 'prompt_tokens_details': {'cached_tokens': 20}}

    async def turn() -> dict[str, Any]:
        timing = turn_timing.TurnTiming('run', 'session', 'echo', warmup=False, receipt=turn_timing.perf_counter())
        with turn_timing.use(timing):
            await llm.build_model(model='echo', relay=lambda: _turn(stand_in)).ainvoke(CONVERSATION)
        return timing.record(turn_timing.perf_counter(), 'finished')

    record = asyncio.run(turn())
    assert (record['inputTokens'], record['cachedInputTokens']) == (26, 20)


def test_a_turn_fails_on_cache_markers_the_deployment_config_wrote_wrong(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn) -> None:
    path = deploy(monkeypatch, tmp_path, models={**ENDPOINT_MODELS, 'cacheMarkers': 'openai'})
    with pytest.raises(DeploymentConfigError, match=f"^Deployment Config {path}: models.cacheMarkers: 'claude' was expected$"):
        llm.build_model(model='echo', relay=lambda: _turn(stand_in))


def test_a_turn_fails_on_a_models_kind_the_deployment_config_wrote_wrong(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn) -> None:
    path = deploy(monkeypatch, tmp_path, models={'kind': 'anthropic'})
    with pytest.raises(DeploymentConfigError, match=f'^Deployment Config {path}: models: '):
        llm.build_model(model='echo', relay=lambda: _turn(stand_in))
