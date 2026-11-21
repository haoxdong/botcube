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
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from botcube_harness_deepagents import llm, turn_timing
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.botcube_config import BotCubeConfigError
from botcube_harness_deepagents.definition import ModelRelay, openai_model_relay
from botcube_harness_deepagents.turn_memory import collecting_turn_feeds
from deployment_fixture import ENDPOINT_MODELS, deploy

pytestmark = pytest.mark.integration


def _responses_stream(body: dict[str, Any], tool_call: str | None) -> bytes:
    """The Responses API's event stream for one output item: a call to `tool_call` until its result is back, else `Echo: <text>`."""
    items = [{'role': 'user', 'content': body['input']}] if isinstance(body['input'], str) else body['input']
    asked = max(index for index, item in enumerate(items) if item.get('role') == 'user')
    content = items[asked]['content']
    text = 'Echo: ' + (content if isinstance(content, str) else ''.join(part['text'] for part in content))
    answered = any(item.get('type') == 'function_call_output' for item in items[asked + 1:])
    if tool_call is not None and not answered:
        item: dict[str, Any] = {'id': 'fc_1', 'type': 'function_call', 'status': 'completed', 'call_id': 'call-1', 'name': tool_call, 'arguments': '{}'}
        streamed = [
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'status': 'in_progress', 'arguments': ''}},
            {'type': 'response.function_call_arguments.delta', 'item_id': 'fc_1', 'output_index': 0, 'delta': '{}'},
            {'type': 'response.function_call_arguments.done', 'item_id': 'fc_1', 'output_index': 0, 'arguments': '{}'},
        ]
    else:
        part = {'type': 'output_text', 'annotations': [], 'logprobs': [], 'text': text}
        item = {'id': 'msg_1', 'type': 'message', 'status': 'completed', 'role': 'assistant', 'content': [part]}
        at = {'item_id': 'msg_1', 'output_index': 0, 'content_index': 0}
        streamed = [
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'status': 'in_progress', 'content': []}},
            {'type': 'response.content_part.added', **at, 'part': {**part, 'text': ''}},
            {'type': 'response.output_text.delta', **at, 'delta': text, 'logprobs': []},
            {'type': 'response.output_text.done', **at, 'text': text, 'logprobs': []},
            {'type': 'response.content_part.done', **at, 'part': part},
        ]
    usage = {'input_tokens': 26, 'input_tokens_details': {'cached_tokens': 20}, 'output_tokens': 4, 'output_tokens_details': {'reasoning_tokens': 0}, 'total_tokens': 30}
    response = {'id': 'resp_1', 'object': 'response', 'created_at': 1790965829, 'model': body['model'], 'status': 'in_progress', 'output': [], 'usage': None}
    events = [
        {'type': 'response.created', 'response': response},
        *streamed,
        {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
        {'type': 'response.completed', 'response': {**response, 'status': 'completed', 'output': [item], 'usage': usage}},
    ]
    return ''.join(
        f'event: {event["type"]}\ndata: {json.dumps({**event, "sequence_number": index})}\n\n' for index, event in enumerate(events)
    ).encode()


class StandIn:
    """The Credential Service's models relay, answering each chat completion or response with `Echo: <text>`, after any gateway failures and dropped connections.

    With `tool_call` set, a response first calls that tool, and echoes once its result is back.
    """

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.gateway_failures: list[int] = []
        self.errors: list[tuple[int, dict[str, Any]]] = []
        self.tool_call: str | None = None
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
                if stand_in.errors:
                    status, error = stand_in.errors.pop(0)
                    self._send(status, 'application/json', json.dumps({'error': error}).encode())
                    return
                drop = stand_in.drops.pop(0) if stand_in.drops else None
                if drop == 'before-response':
                    self._reset()
                    return
                if drop == 'closed-before-response':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                if self.path.endswith('/responses'):
                    self._send(200, 'text/event-stream', _responses_stream(body, stand_in.tool_call))
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
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': ENDPOINT_MODELS})


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
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': {**ENDPOINT_MODELS, 'cacheMarkers': 'claude'}})


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


def test_a_turn_fails_on_cache_markers_the_botcube_config_wrote_wrong(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn) -> None:
    path = deploy(monkeypatch, tmp_path, integrations={'modelGateway': {**ENDPOINT_MODELS, 'cacheMarkers': 'openai'}})
    with pytest.raises(BotCubeConfigError, match=f"^BotCube Config {path}: integrations.modelGateway.cacheMarkers: 'claude' was expected$"):
        llm.build_model(model='echo', relay=lambda: _turn(stand_in))


@pytest.fixture
def responses(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': {**ENDPOINT_MODELS, 'wire': 'responses'}})


@pytest.fixture
def responses_cache_markers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': {**ENDPOINT_MODELS, 'wire': 'responses', 'cacheMarkers': 'claude'}})


@pytest.mark.usefixtures('responses')
def test_a_turn_on_the_responses_wire_streams_from_the_responses_api_through_the_credential_service(stand_in: StandIn) -> None:
    streamed = io.StringIO()

    async def stream() -> None:
        async for chunk in llm.build_model(model='echo', relay=lambda: _turn(stand_in)).astream('Hello, who are you?'):
            streamed.write(chunk.text)

    asyncio.run(stream())

    assert streamed.getvalue() == 'Echo: Hello, who are you?'
    [request] = stand_in.requests
    assert request['path'] == '/models/responses'
    assert (request['body']['model'], request['body']['stream']) == ('echo', True)
    assert request['body']['input'] == [{'type': 'message', 'role': 'user', 'content': 'Hello, who are you?'}]
    assert request['headers']['authorization'] == 'Bearer invocation-1'


@pytest.mark.usefixtures('responses')
def test_a_tool_call_and_its_result_go_over_the_responses_wire(stand_in: StandIn) -> None:
    stand_in.tool_call = 'ls'
    model = llm.build_model(model='echo', relay=lambda: _turn(stand_in))

    def ls() -> str:
        """List the files."""
        return 'notes.md'

    called = asyncio.run(model.bind_tools([ls]).ainvoke(CONVERSATION[:2]))
    answered = asyncio.run(model.bind_tools([ls]).ainvoke([*CONVERSATION[:2], called, ToolMessage('notes.md', tool_call_id=called.tool_calls[0]['id'])]))

    assert [(call['name'], call['args']) for call in called.tool_calls] == [('ls', {})]
    assert answered.text == 'Echo: List the files.'
    assert [request['body']['tools'] for request in stand_in.requests] == [[{
        'type': 'function', 'name': 'ls', 'description': 'List the files.', 'parameters': {'properties': {}, 'type': 'object'},
    }]] * 2
    assert stand_in.requests[1]['body']['input'][-2:] == [
        {'type': 'function_call', 'name': 'ls', 'arguments': '{}', 'call_id': 'call-1', 'id': 'fc_1'},
        {'type': 'function_call_output', 'output': 'notes.md', 'call_id': 'call-1'},
    ]


@pytest.mark.usefixtures('responses_cache_markers')
def test_cache_markers_land_on_the_system_prompt_and_the_latest_items_over_the_responses_wire(stand_in: StandIn) -> None:
    assert _converse_text(stand_in, CONVERSATION) == 'Echo: Read it.'

    [request] = stand_in.requests
    assert request['body']['input'] == [
        {'type': 'message', 'role': 'system', 'content': [{'type': 'input_text', 'text': 'You are BotCube.', 'cache_control': MARKER}]},
        {'type': 'message', 'role': 'user', 'content': 'List the files.'},
        {'type': 'function_call', 'name': 'ls', 'arguments': '{}', 'call_id': 'call-1'},
        {'type': 'function_call_output', 'output': 'notes.md', 'call_id': 'call-1'},
        {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'There is one file, notes.md.', 'annotations': [], 'cache_control': MARKER}]},
        {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Read it.', 'cache_control': MARKER}]},
    ]


@pytest.mark.usefixtures('responses_cache_markers')
def test_cache_markers_mark_a_tool_result_but_not_a_call_over_the_responses_wire(stand_in: StandIn) -> None:
    _converse_text(stand_in, CONVERSATION[:4])

    [request] = stand_in.requests
    assert request['body']['input'][-2:] == [
        {'type': 'function_call', 'name': 'ls', 'arguments': '{}', 'call_id': 'call-1'},
        {'type': 'function_call_output', 'output': [{'type': 'input_text', 'text': 'notes.md', 'cache_control': MARKER}], 'call_id': 'call-1'},
    ]


@pytest.mark.usefixtures('responses')
def test_no_responses_request_carries_a_cache_marker_unless_the_operator_turns_them_on(stand_in: StandIn) -> None:
    _converse_text(stand_in, CONVERSATION)

    [request] = stand_in.requests
    assert 'cache_control' not in json.dumps(request['body'])


@pytest.mark.usefixtures('responses')
def test_the_turn_reports_the_cached_input_tokens_the_gateway_reports_over_the_responses_wire(stand_in: StandIn) -> None:
    async def turn() -> dict[str, Any]:
        timing = turn_timing.TurnTiming('run', 'session', 'echo', warmup=False, receipt=turn_timing.perf_counter())
        with turn_timing.use(timing):
            await llm.build_model(model='echo', relay=lambda: _turn(stand_in)).ainvoke(CONVERSATION)
        return timing.record(turn_timing.perf_counter(), 'finished')

    record = asyncio.run(turn())
    assert (record['inputTokens'], record['cachedInputTokens']) == (26, 20)


@pytest.mark.parametrize(('wire', 'path'), [('chat-completions', '/models/chat/completions'), ('responses', '/models/responses')])
def test_a_turn_that_overflows_the_context_on_either_wire_compacts_and_answers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn, wire: str, path: str,
) -> None:
    deploy(monkeypatch, tmp_path, integrations={'modelGateway': {**ENDPOINT_MODELS, 'wire': wire}})
    stand_in.errors.append((400, {
        'message': 'Your input exceeds the context window of this model.', 'type': 'invalid_request_error', 'code': 'context_length_exceeded',
    }))
    graph = build_agent(
        model=llm.build_model(model='echo', relay=lambda: _turn(stand_in)),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False), skills=[], checkpointer=InMemorySaver(),
    )
    config = {'configurable': {'thread_id': 'overflow'}}
    history = [message for index in range(6) for message in (
        HumanMessage('Earlier copper question. ' * 600, id=f'q-{index}'), AIMessage('Earlier copper answer. ' * 600, id=f'a-{index}'),
    )]

    async def turn() -> Any:
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        with collecting_turn_feeds():
            return await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)

    result = asyncio.run(turn())

    assert result['messages'][-1].text == 'Echo: Reply OK.'
    # The overflowing call, the emergency summary, then the call on the compacted history.
    assert [request['path'] for request in stand_in.requests] == [path] * 3
    event = asyncio.run(graph.aget_state(config)).values['_summarization_event']
    assert (tmp_path / event['file_path'].lstrip('/')).is_file()


def _converse_text(stand_in: StandIn, messages: list[Any]) -> str:
    return asyncio.run(llm.build_model(model='echo', relay=lambda: _turn(stand_in)).ainvoke(messages)).text


def test_a_turn_fails_on_a_models_kind_the_botcube_config_wrote_wrong(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stand_in: StandIn) -> None:
    path = deploy(monkeypatch, tmp_path, integrations={'modelGateway': {'kind': 'anthropic'}})
    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: integrations.modelGateway: '):
        llm.build_model(model='echo', relay=lambda: _turn(stand_in))
