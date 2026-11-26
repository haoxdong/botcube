from __future__ import annotations

import asyncio
import base64
import json
import socket
import struct
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from ag_ui.core import EventType, RunAgentInput, RunErrorEvent, UserMessage
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from botcube_harness_deepagents import llm, turn_timing
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.definition import ModelRelay, openai_model_relay
from botcube_harness_deepagents.session_agent import SessionAgent
from botcube_harness_deepagents.turn_memory import collecting_turn_feeds
from deployment_fixture import ENDPOINT_MODELS, deploy

pytestmark = pytest.mark.integration

PROVIDERS = ('anthropic', 'openai')
# Each provider's own API, as the Credential Service relays it under the provider's name.
PATHS = {'anthropic': '/models/anthropic/v1/messages', 'openai': '/models/openai/responses'}
CHAT_COMPLETIONS = '/models/openai/chat/completions'
MODELS = {'anthropic': 'claude-sonnet-5-5', 'openai': 'gpt-5'}
THOUGHT = 'The user asks who I am.'
# An image's bytes, base64 as a screenshot tool returns them.
PIXEL = base64.b64encode(b'one pixel').decode()


def _sse(events: list[dict[str, Any]], numbered: bool = False) -> bytes:
    return ''.join(
        f'event: {event["type"]}\ndata: {json.dumps({**event, "sequence_number": index} if numbered else event)}\n\n'
        for index, event in enumerate(events)
    ).encode()


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return ''.join(part.get('text', '') for part in content if part.get('type') in ('text', 'input_text'))


def _model_text(text: str) -> str:
    """The model's answer to `text`: a summary of a history it is asked to compact, else an echo."""
    return 'Earlier requests concerned copper.' if '\n<messages>\n' in text else 'Echo: ' + text


def _responses_stream(body: dict[str, Any], tool_call: str | None, thinking: bool) -> bytes:
    """The Responses API's event stream: a reasoning summary if `thinking`, then a call to `tool_call` until its result is back, else `Echo: <text>`."""
    items = [{'role': 'user', 'content': body['input']}] if isinstance(body['input'], str) else body['input']
    asked = max(index for index, item in enumerate(items) if item.get('role') == 'user')
    text = _model_text(_text(items[asked]['content']))
    answered = any(item.get('type') == 'function_call_output' for item in items[asked + 1:])
    streamed: list[dict[str, Any]] = []
    output: list[dict[str, Any]] = []
    if thinking:
        summary = {'type': 'summary_text', 'text': THOUGHT}
        reasoning = {'id': 'rs_1', 'type': 'reasoning', 'summary': [summary]}
        at = {'item_id': 'rs_1', 'output_index': 0, 'summary_index': 0}
        streamed += [
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**reasoning, 'summary': []}},
            {'type': 'response.reasoning_summary_part.added', **at, 'part': {**summary, 'text': ''}},
            {'type': 'response.reasoning_summary_text.delta', **at, 'delta': THOUGHT},
            {'type': 'response.reasoning_summary_text.done', **at, 'text': THOUGHT},
            {'type': 'response.reasoning_summary_part.done', **at, 'part': summary},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': reasoning},
        ]
        output.append(reasoning)
    index = len(output)
    if tool_call is not None and not answered:
        item: dict[str, Any] = {'id': 'fc_1', 'type': 'function_call', 'status': 'completed', 'call_id': 'call-1', 'name': tool_call, 'arguments': '{}'}
        streamed += [
            {'type': 'response.output_item.added', 'output_index': index, 'item': {**item, 'status': 'in_progress', 'arguments': ''}},
            {'type': 'response.function_call_arguments.delta', 'item_id': 'fc_1', 'output_index': index, 'delta': '{}'},
            {'type': 'response.function_call_arguments.done', 'item_id': 'fc_1', 'output_index': index, 'arguments': '{}'},
        ]
    else:
        part = {'type': 'output_text', 'annotations': [], 'logprobs': [], 'text': text}
        item = {'id': 'msg_1', 'type': 'message', 'status': 'completed', 'role': 'assistant', 'content': [part]}
        at = {'item_id': 'msg_1', 'output_index': index, 'content_index': 0}
        streamed += [
            {'type': 'response.output_item.added', 'output_index': index, 'item': {**item, 'status': 'in_progress', 'content': []}},
            {'type': 'response.content_part.added', **at, 'part': {**part, 'text': ''}},
            {'type': 'response.output_text.delta', **at, 'delta': text, 'logprobs': []},
            {'type': 'response.output_text.done', **at, 'text': text, 'logprobs': []},
            {'type': 'response.content_part.done', **at, 'part': part},
        ]
    streamed.append({'type': 'response.output_item.done', 'output_index': index, 'item': item})
    output.append(item)
    usage = {'input_tokens': 26, 'input_tokens_details': {'cached_tokens': 20}, 'output_tokens': 4, 'output_tokens_details': {'reasoning_tokens': 0}, 'total_tokens': 30}
    response = {'id': 'resp_1', 'object': 'response', 'created_at': 1790965829, 'model': body['model'], 'status': 'in_progress', 'output': [], 'usage': None}
    return _sse([
        {'type': 'response.created', 'response': response},
        *streamed,
        {'type': 'response.completed', 'response': {**response, 'status': 'completed', 'output': output, 'usage': usage}},
    ], numbered=True)


def _chat_completions_stream(body: dict[str, Any], tool_call: str | None, thinking: bool) -> bytes:
    """OpenAI's Chat Completions stream, answering `Echo: <text>` to the last user message."""
    asked = [message for message in body['messages'] if message['role'] == 'user'][-1]
    chunks = [{'role': 'assistant', 'content': _model_text(_text(asked['content']))}, {}]
    return b''.join(
        f'data: {json.dumps({"id": "chatcmpl-1", "object": "chat.completion.chunk", "model": body["model"], "choices": [{"index": 0, "delta": delta, "finish_reason": None if delta else "stop"}]})}\n\n'.encode()
        for delta in chunks
    ) + b'data: [DONE]\n\n'


def _messages_stream(body: dict[str, Any], tool_call: str | None, thinking: bool) -> bytes:
    """Anthropic's Messages event stream: a thinking block if `thinking`, then a call to `tool_call` until its result is back, else `Echo: <text>`."""
    messages = body['messages']

    def asks(message: dict[str, Any]) -> bool:
        return message['role'] == 'user' and (isinstance(message['content'], str) or any(part['type'] == 'text' for part in message['content']))

    asked = max(index for index, message in enumerate(messages) if asks(message))
    text = _model_text(_text(messages[asked]['content']))
    answered = any(
        isinstance(message['content'], list) and any(part['type'] == 'tool_result' for part in message['content'])
        for message in messages[asked + 1:]
    )
    blocks: list[list[dict[str, Any]]] = []
    if thinking:
        blocks.append([
            {'type': 'content_block_start', 'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}},
            {'type': 'content_block_delta', 'delta': {'type': 'thinking_delta', 'thinking': THOUGHT}},
            {'type': 'content_block_delta', 'delta': {'type': 'signature_delta', 'signature': 'signed'}},
        ])
    if tool_call is not None and not answered:
        blocks.append([
            {'type': 'content_block_start', 'content_block': {'type': 'tool_use', 'id': 'call-1', 'name': tool_call, 'input': {}}},
            {'type': 'content_block_delta', 'delta': {'type': 'input_json_delta', 'partial_json': '{}'}},
        ])
        stop = 'tool_use'
    else:
        blocks.append([
            {'type': 'content_block_start', 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': text}},
        ])
        stop = 'end_turn'
    usage = {'input_tokens': 6, 'cache_read_input_tokens': 20, 'cache_creation_input_tokens': 0, 'output_tokens': 1}
    message = {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}
    return _sse([
        {'type': 'message_start', 'message': message},
        *[{**event, 'index': index} for index, block in enumerate(blocks) for event in [*block, {'type': 'content_block_stop'}]],
        # As Anthropic's API does, the closing delta carries the call's whole usage.
        {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {**usage, 'output_tokens': 4}},
        {'type': 'message_stop'},
    ])


def _cut_after_output(stream: bytes, path: str) -> bytes:
    if path == CHAT_COMPLETIONS:
        end = stream.index(b'"finish_reason": "stop"')
        return stream[:stream.rindex(b'data: ', 0, end)]
    end_event = b'content_block_stop' if path == PATHS['anthropic'] else b'response.output_text.done'
    return stream[:stream.index(b'event: ' + end_event)]


class StandIn:
    """The Credential Service's models relay, answering each provider's own API with `Echo: <text>`, after any gateway failures and dropped connections.

    With `tool_call` set, a reply first calls that tool, and echoes once its result is back; with `thinking`, it thinks first.
    """

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.gateway_failures: list[int] = []
        self.errors: list[tuple[int, dict[str, Any]]] = []
        self.tool_call: str | None = None
        self.thinking = False
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
                if stand_in.errors:
                    status, error = stand_in.errors.pop(0)
                    self._send(status, 'application/json', json.dumps(error).encode())
                    return
                drop = stand_in.drops.pop(0) if stand_in.drops else None
                if drop == 'before-response':
                    self._reset()
                    return
                if drop == 'closed-before-response':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                answer = {PATHS['anthropic']: _messages_stream, CHAT_COMPLETIONS: _chat_completions_stream}.get(self.path, _responses_stream)
                stream = answer(body, stand_in.tool_call, stand_in.thinking)
                self._stream_reply(stream, drop)

            def _stream_reply(self, stream: bytes, drop: str | None) -> None:
                if drop == 'clean-eof-after-output':
                    self._send(200, 'text/event-stream', _cut_after_output(stream, self.path))
                    return
                if drop in ('before-output', 'after-output', 'stalled'):
                    self.send_response(200)
                    self.send_header('content-type', 'text/event-stream')
                    self.end_headers()
                    # The stream opens with an event that carries no output; its first output is a delta event.
                    cut = stream.index(b'delta\ndata: ') if drop == 'after-output' else 0
                    self.wfile.write(stream[:stream.index(b'\n\n', cut) + 2])
                    self.wfile.flush()
                    if drop == 'stalled':
                        self._keep_alive()
                    self._reset()
                    return
                self._send(200, 'text/event-stream', stream)

            def _keep_alive(self) -> None:
                """A gateway's keepalive comments, and Anthropic's own pings, with no model output, until the client hangs up."""
                ping = b': keepalive\n\n' + (b'event: ping\ndata: {"type": "ping"}\n\n' if self.path == PATHS['anthropic'] else b'')
                for _ in range(200):
                    try:
                        self.wfile.write(ping)
                        self.wfile.flush()
                    except OSError:
                        return
                    time.sleep(0.05)

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


GATEWAY = {**ENDPOINT_MODELS, 'providers': {'anthropic': {'url': 'https://models.example.com'}, 'openai': {'useResponsesApi': True}}}


@pytest.fixture
def deployed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': GATEWAY})


def _turn(stand_in: StandIn, token: str = 'invocation-1') -> ModelRelay:
    return openai_model_relay(f'{stand_in.url}/template', token, 'thread-1')


def _model(stand_in: StandIn, provider: str, **kwargs: Any) -> Any:
    return llm.build_model(model=MODELS[provider], provider=provider, max_tokens=64000, relay=lambda: _turn(stand_in), **kwargs)


def _reply(stand_in: StandIn, provider: str = 'openai') -> str:
    return asyncio.run(_model(stand_in, provider).ainvoke('Hello, who are you?')).text


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_turn_reaches_its_providers_own_api_through_the_credential_service_under_its_invocation_and_ceiling(stand_in: StandIn, provider: str) -> None:
    assert _reply(stand_in, provider) == 'Echo: Hello, who are you?'

    [request] = stand_in.requests
    assert request['path'] == PATHS[provider]
    assert (request['body']['model'], request['body']['stream']) == (MODELS[provider], True)
    assert request['body']['max_tokens' if provider == 'anthropic' else 'max_output_tokens'] == 64000
    assert request['headers']['authorization'] == 'Bearer invocation-1'
    assert 'x-api-key' not in request['headers']
    assert request['headers']['x-botcube-session-id'] == 'thread-1'


@pytest.mark.usefixtures('deployed')
def test_a_model_without_its_own_ceiling_runs_under_its_providers_default(stand_in: StandIn) -> None:
    from langchain_anthropic import ChatAnthropic

    for provider in PROVIDERS:
        asyncio.run(llm.build_model(model=MODELS[provider], provider=provider, relay=lambda: _turn(stand_in)).ainvoke('Hello'))

    anthropic, openai = (request['body'] for request in stand_in.requests)
    assert anthropic['max_tokens'] == ChatAnthropic(model=MODELS['anthropic']).max_tokens
    assert 'max_output_tokens' not in openai


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_thinking_streams_as_it_arrives_before_the_answer(stand_in: StandIn, provider: str) -> None:
    stand_in.thinking = True
    streamed: list[tuple[str, str]] = []

    async def stream() -> None:
        async for chunk in _model(stand_in, provider).astream('Hello, who are you?'):
            streamed.extend((block['type'], block.get('reasoning') or block.get('text') or '') for block in chunk.content_blocks)

    asyncio.run(stream())

    said = [(kind, text) for kind, text in streamed if text]
    assert said[0] == ('reasoning', THOUGHT)
    assert ''.join(text for kind, text in said if kind == 'text') == 'Echo: Hello, who are you?'


@pytest.mark.usefixtures('deployed')
def test_a_claude_model_thinks_adaptively_at_the_turns_effort(stand_in: StandIn) -> None:
    asyncio.run(_model(stand_in, 'anthropic', effort='high').ainvoke('Hello'))

    [request] = stand_in.requests
    assert request['body']['thinking'] == {'type': 'adaptive', 'display': 'summarized'}
    assert request['body']['output_config'] == {'effort': 'high'}


@pytest.mark.usefixtures('deployed')
def test_an_openai_model_reasons_at_the_turns_effort_and_summarizes_its_reasoning(stand_in: StandIn) -> None:
    asyncio.run(_model(stand_in, 'openai', effort='high').ainvoke('Hello'))

    [request] = stand_in.requests
    assert request['body']['reasoning'] == {'effort': 'high', 'summary': 'auto'}


def test_an_openai_model_runs_on_chat_completions_unless_its_provider_uses_responses(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn) -> None:
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': ENDPOINT_MODELS})

    assert asyncio.run(_model(stand_in, 'openai', effort='high').ainvoke('Hello')).text == 'Echo: Hello'

    [request] = stand_in.requests
    assert request['path'] == CHAT_COMPLETIONS
    assert request['body']['reasoning_effort'] == 'high'


WIRES = {'responses': (GATEWAY, 'reasoning'), 'chat-completions': (ENDPOINT_MODELS, 'reasoning_effort')}


@pytest.mark.parametrize('wire', WIRES)
def test_an_openai_model_gets_no_effort_when_the_turn_chose_none(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn, wire: str) -> None:
    gateway, field = WIRES[wire]
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': gateway})

    asyncio.run(_model(stand_in, 'openai').ainvoke('Hello'))

    [request] = stand_in.requests
    assert field not in request['body']


@pytest.mark.parametrize('wire', WIRES)
def test_an_openai_model_reasons_at_high_when_the_turn_chose_max(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn, wire: str) -> None:
    gateway, field = WIRES[wire]
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': gateway})

    asyncio.run(_model(stand_in, 'openai', effort='max').ainvoke('Hello'))

    [request] = stand_in.requests
    assert request['body'][field] == ({'effort': 'high', 'summary': 'auto'} if wire == 'responses' else 'high')


SCREENSHOT = [
    HumanMessage('Take a screenshot.'),
    AIMessage('', tool_calls=[{'id': 'call-1', 'name': 'screenshot', 'args': {}}]),
    ToolMessage([{'type': 'image', 'base64': PIXEL, 'mime_type': 'image/png'}], tool_call_id='call-1'),
]


@pytest.mark.usefixtures('deployed')
def test_an_image_in_a_tool_result_reaches_a_claude_model(stand_in: StandIn) -> None:
    asyncio.run(_model(stand_in, 'anthropic').ainvoke(SCREENSHOT))

    [request] = stand_in.requests
    [result] = request['body']['messages'][-1]['content']
    assert (result['type'], result['tool_use_id']) == ('tool_result', 'call-1')
    assert result['content'] == [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': PIXEL}}]


@pytest.mark.usefixtures('deployed')
def test_an_image_in_a_tool_result_reaches_an_openai_model(stand_in: StandIn) -> None:
    asyncio.run(_model(stand_in, 'openai').ainvoke(SCREENSHOT))

    [request] = stand_in.requests
    result = request['body']['input'][-1]
    assert (result['type'], result['call_id']) == ('function_call_output', 'call-1')
    assert result['output'] == [{'type': 'input_image', 'image_url': f'data:image/png;base64,{PIXEL}'}]


def _agent_turn(stand_in: StandIn, provider: str, tmp_path: Path) -> Any:
    graph = build_agent(
        model=_model(stand_in, provider),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False), skills=[], checkpointer=InMemorySaver(),
    )

    async def turn() -> Any:
        with collecting_turn_feeds():
            return await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, {'configurable': {'thread_id': 'thread-1'}})

    return asyncio.run(turn())


@pytest.mark.usefixtures('deployed')
def test_an_agent_turn_on_a_claude_model_marks_its_cache_breakpoints(stand_in: StandIn, tmp_path: Path) -> None:
    assert _agent_turn(stand_in, 'anthropic', tmp_path)['messages'][-1].text == 'Echo: Reply OK.'

    [request] = stand_in.requests
    # Anthropic's own API takes one marker for the whole request, at its latest cacheable block.
    assert request['body']['cache_control']['type'] == 'ephemeral'


@pytest.mark.usefixtures('deployed')
def test_an_agent_turn_on_an_openai_model_keys_its_prompt_cache_by_session(stand_in: StandIn, tmp_path: Path) -> None:
    assert _agent_turn(stand_in, 'openai', tmp_path)['messages'][-1].text == 'Echo: Reply OK.'

    [request] = stand_in.requests
    assert request['body']['prompt_cache_key'] == 'thread-1'


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_cached_model_takes_each_turns_invocation(stand_in: StandIn, provider: str) -> None:
    current = {'token': 'invocation-1'}
    model = llm.build_model(model=MODELS[provider], provider=provider, relay=lambda: _turn(stand_in, current['token']))

    asyncio.run(model.ainvoke('Hello'))
    current['token'] = 'invocation-2'
    asyncio.run(model.ainvoke('Hello'))

    assert [request['headers']['authorization'] for request in stand_in.requests] == ['Bearer invocation-1', 'Bearer invocation-2']


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
@pytest.mark.parametrize('status', [502, 503, 504])
def test_a_turn_retries_a_gateway_failure_before_the_first_byte(stand_in: StandIn, provider: str, status: int) -> None:
    stand_in.gateway_failures.extend([status, status])

    assert _reply(stand_in, provider) == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_turn_retries_a_connection_dropped_before_the_response(stand_in: StandIn, provider: str) -> None:
    stand_in.drops.extend(['before-response', 'before-response'])

    assert _reply(stand_in, provider) == 'Echo: Hello, who are you?'
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
    return f'http://127.0.0.1:{port}'


def _attempts(monkeypatch: pytest.MonkeyPatch, url: str) -> tuple[int, type[BaseException] | None]:
    """The requests an OpenAI model sends to `url` for one reply, and the transport error it fails with."""
    import httpx
    import openai

    attempts: list[object] = []

    async def attempted(request: object) -> None:
        attempts.append(request)

    monkeypatch.setattr(turn_timing, 'dispatched', attempted)
    model = llm.build_model(model=MODELS['openai'], provider='openai', relay=lambda: openai_model_relay(f'{url}/template', 'invocation-1', 'thread-1'))
    with pytest.raises(openai.APIConnectionError) as failure:
        asyncio.run(model.ainvoke('Hello'))
    cause: BaseException | None = failure.value
    while cause is not None and not isinstance(cause, httpx.TransportError):
        cause = cause.__cause__ or cause.__context__
    return len(attempts), None if cause is None else type(cause)


@pytest.mark.usefixtures('deployed')
def test_a_turn_retries_a_refused_connection(monkeypatch: pytest.MonkeyPatch, refusing_url: str) -> None:
    import httpx

    assert _attempts(monkeypatch, refusing_url) == (3, httpx.ConnectError)


@pytest.mark.usefixtures('deployed')
def test_a_turn_retries_a_connect_timeout(monkeypatch: pytest.MonkeyPatch, refusing_url: str) -> None:
    import httpx

    async def unanswered(transport: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout('The connection was not accepted in time', request=request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, 'handle_async_request', unanswered)
    assert _attempts(monkeypatch, refusing_url) == (3, httpx.ConnectTimeout)


async def _streamed(model: Any) -> str:
    return ''.join([chunk.text async for chunk in model.astream('Hello, who are you?')])


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_turn_retries_a_reply_that_fails_after_its_200_and_before_its_first_output(stand_in: StandIn, provider: str) -> None:
    stand_in.drops.extend(['before-output', 'before-output'])

    assert asyncio.run(_streamed(_model(stand_in, provider))) == 'Echo: Hello, who are you?'
    assert len(stand_in.requests) == 3


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_turn_fails_once_on_a_reply_that_fails_after_its_first_output(stand_in: StandIn, provider: str) -> None:
    import httpx
    import httpx2

    stand_in.drops.append('after-output')

    # Each provider's SDK raises its own httpx package's error.
    with pytest.raises((httpx.TransportError, httpx2.TransportError)):
        asyncio.run(_streamed(_model(stand_in, provider)))
    assert len(stand_in.requests) == 1


@pytest.mark.parametrize('wire', ['anthropic', 'responses', 'chat-completions', 'plan'])
def test_a_turn_with_clean_eof_before_model_completion_fails_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn, wire: str,
) -> None:
    gateway = ENDPOINT_MODELS if wire == 'chat-completions' else GATEWAY
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': gateway})
    stand_in.drops.append('clean-eof-after-output')

    model = (
        llm.build_model(model='openai-plan:gpt-5', relay=lambda: _turn(stand_in))
        if wire == 'plan'
        else _model(stand_in, 'anthropic' if wire == 'anthropic' else 'openai')
    )
    graph = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], checkpointer=InMemorySaver(),
    )
    agent = SessionAgent(name='test', graph=graph)
    request = RunAgentInput(
        thread_id='session', run_id='turn', state={},
        messages=[UserMessage(id='question', content='Reply OK.')], tools=[], context=[], forwarded_props={},
    )

    async def run() -> list[Any]:
        with collecting_turn_feeds():
            return [event async for event in agent.run(request)]

    events = asyncio.run(run())
    assert ''.join(event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT) == 'Echo: Reply OK.'
    [terminal] = [event for event in events if event.type in {EventType.RUN_ERROR, EventType.RUN_FINISHED}]
    assert isinstance(terminal, RunErrorEvent)
    assert terminal.message == 'Model stream ended before the provider completed the reply'
    assert len(stand_in.requests) == 1


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_turn_ends_a_stream_that_sends_only_keepalives_for_the_idle_time(monkeypatch: pytest.MonkeyPatch, stand_in: StandIn, provider: str) -> None:
    monkeypatch.setattr(llm, 'MODEL_IDLE_SECONDS', 0.5)
    stand_in.drops.append('stalled')

    started = time.monotonic()
    with pytest.raises(llm.ModelIdleError, match='^The model sent no output for 0.5 seconds$'):
        asyncio.run(_streamed(_model(stand_in, provider)))
    assert time.monotonic() - started < 5
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
    with pytest.raises(RuntimeError, match='^Model "gpt-5" runs on the model gateway, which needs the Credential Service relay; this Turn has none$'):
        llm.build_model(model='gpt-5', provider='openai')


@pytest.mark.usefixtures('deployed')
def test_a_model_the_bot_settings_do_not_list_has_no_provider_on_the_gateway(stand_in: StandIn) -> None:
    with pytest.raises(RuntimeError, match="^Model \"gpt-5\" is not one of the bot settings' models, so the model gateway has no provider for it$"):
        llm.build_model(model='gpt-5', relay=lambda: _turn(stand_in))


@pytest.mark.usefixtures('deployed')
def test_botcubes_own_echo_model_answers_on_the_gateway_without_calling_it(stand_in: StandIn) -> None:
    model = llm.build_model(model='echo', provider='echo', relay=lambda: _turn(stand_in))

    assert asyncio.run(model.ainvoke('Hello')).text == 'Echo: Hello'
    assert stand_in.requests == []


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_the_turn_reports_the_cached_input_tokens_the_gateway_reports(stand_in: StandIn, provider: str) -> None:
    async def turn() -> dict[str, Any]:
        timing = turn_timing.TurnTiming('run', 'session', MODELS[provider], warmup=False, receipt=turn_timing.perf_counter())
        with turn_timing.use(timing):
            await _model(stand_in, provider).ainvoke([SystemMessage('You are BotCube.'), HumanMessage('Hello')])
        return timing.record(turn_timing.perf_counter(), 'finished')

    record = asyncio.run(turn())
    assert (record['inputTokens'], record['cachedInputTokens']) == (26, 20)


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_tool_call_and_its_result_go_over_the_providers_own_api(stand_in: StandIn, provider: str) -> None:
    stand_in.tool_call = 'ls'
    model = _model(stand_in, provider)

    def ls() -> str:
        """List the files."""
        return 'notes.md'

    asked = [HumanMessage('List the files.')]
    called = asyncio.run(model.bind_tools([ls]).ainvoke(asked))
    answered = asyncio.run(model.bind_tools([ls]).ainvoke([*asked, called, ToolMessage('notes.md', tool_call_id=called.tool_calls[0]['id'])]))

    assert [(call['name'], call['args']) for call in called.tool_calls] == [('ls', {})]
    assert answered.text == 'Echo: List the files.'


OVERFLOWS = {
    'anthropic': {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'prompt is too long: 250000 tokens > 200000 maximum'}},
    'openai': {'error': {'message': 'Your input exceeds the context window of this model.', 'type': 'invalid_request_error', 'code': 'context_length_exceeded'}},
}


@pytest.mark.usefixtures('deployed')
@pytest.mark.parametrize('provider', PROVIDERS)
def test_a_turn_that_overflows_the_context_compacts_and_answers(tmp_path: Path, stand_in: StandIn, provider: str) -> None:
    stand_in.errors.append((400, OVERFLOWS[provider]))
    model = _model(stand_in, provider)
    graph = build_agent(
        model=model,
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False), skills=[], checkpointer=InMemorySaver(),
    )
    config = {'configurable': {'thread_id': 'overflow'}}
    repeats = model.profile['max_input_tokens'] // 450
    history = [message for index in range(6) for message in (
        HumanMessage('Earlier copper question. ' * repeats, id=f'q-{index}'), AIMessage('Earlier copper answer. ' * repeats, id=f'a-{index}'),
    )]

    async def turn() -> Any:
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        with collecting_turn_feeds():
            return await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)

    result = asyncio.run(turn())

    assert result['messages'][-1].text == 'Echo: Reply OK.'
    # The overflowing call, the emergency summary, then the call on the compacted history.
    assert [request['path'] for request in stand_in.requests] == [PATHS[provider]] * 3
    event = asyncio.run(graph.aget_state(config)).values['_summarization_event']
    assert 'Earlier requests concerned copper.' in event['summary_message'].text
    assert (tmp_path / event['file_path'].lstrip('/')).is_file()
