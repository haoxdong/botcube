from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator, Sequence
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

import pytest
from ag_ui.core import RunAgentInput
from deepagents.backends import LocalShellBackend
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from opentelemetry.instrumentation.langchain import LangchainInstrumentor

from agentcore_fake import memory_capability_props
from botcube_harness_deepagents import serving
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.llm import ModelRelay, build_model
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.turn_saver import TurnCheckpointSaver
from relay_fake import RECORDED_STREAM, serving_relay
from test_session_resume import (
    MEMORY_ID,
    _await_fixture_admission_or_public_completion,
    _cancel_unfinished_readers,
    _FakeAgentCoreMemory,
    _serve_session,
)

FOLLOWUP = Path(__file__).parent / 'fixtures' / 'issue-3458-subagent-followup.json'
READ_ID = 'call_iHzme567E1QpdUpW3bK29ZeJ'
TODO_ID = 'call_VP4nTvgPEfnxe4f0ZZQ4s0fu'
TASK_IDS = [
    'call_pnilxIEkBg6phI17hokGCREL',
    'call_pWBZA0nNMS30rtRKd0IKdprY',
    'call_uNoUxGldELmisgRKfuwO8otS',
]
ASSISTANT_IDS = [
    'resp_080c0c1c030c5c9d016ac4a0a67a3c87d19161d24e06974f37',
    'resp_080c0c1c030c5c9d016ac4a0abf3dc87d1ba240485a586c794',
    'resp_080c0c1c030c5c9d016ac4a0b0fec487d199818918595a4286',
]


@pytest.fixture(params=[False, True], ids=['plain', 'deployed-tracing'])
def langchain_tracing(request: pytest.FixtureRequest) -> Iterator[None]:
    instrumentor = LangchainInstrumentor()
    enabled = request.param and not instrumentor.is_instrumented_by_opentelemetry
    hooks = {name: method for name, method in vars(AgentMiddleware).items()
             if name in {'before_agent', 'abefore_agent', 'after_agent', 'aafter_agent',
                         'before_model', 'abefore_model', 'after_model', 'aafter_model'}}
    if enabled:
        instrumentor.instrument()
    try:
        yield
    finally:
        if enabled:
            instrumentor.uninstrument()
            for name, method in hooks.items():
                setattr(AgentMiddleware, name, method)


def _task_stream(response_id: str, calls: list[tuple[str, dict[str, Any], str]]) -> bytes:
    response = json.loads(RECORDED_STREAM.split(b'data: ')[1].split(b'\n')[0])['response']
    response.update(id=response_id, output=[])
    events: list[dict[str, Any]] = [{'type': 'response.created', 'response': dict(response)}]
    items: list[dict[str, Any]] = []
    for index, (name, args, call_id) in enumerate(calls):
        item = {'type': 'function_call', 'id': f'fc_{call_id}', 'call_id': call_id,
                'name': name, 'arguments': '', 'status': 'in_progress'}
        events.append({'type': 'response.output_item.added', 'output_index': index, 'item': dict(item)})
        encoded = json.dumps(args)
        events.append({'type': 'response.function_call_arguments.delta', 'output_index': index,
                       'item_id': item['id'], 'delta': encoded})
        item.update(arguments=encoded, status='completed')
        events.append({'type': 'response.function_call_arguments.done', 'output_index': index,
                       'item_id': item['id'], 'arguments': encoded})
        events.append({'type': 'response.output_item.done', 'output_index': index, 'item': dict(item)})
        items.append(item)
    events.append({'type': 'response.completed', 'response': {**response, 'output': items, 'status': 'completed'}})
    return b''.join(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n'.encode() for event in events)


def _missing_response_outputs(items: list[dict[str, Any]]) -> list[str]:
    pending: list[str] = []
    errors: list[str] = []
    for item in items:
        if item.get('type') == 'function_call':
            pending.append(item['call_id'])
        elif item.get('type') == 'function_call_output':
            if item['call_id'] in pending:
                pending.remove(item['call_id'])
            else:
                errors.append(f'unmatched output {item["call_id"]}')
        elif item.get('role') == 'user':
            errors.extend(pending)
    return [*errors, *pending]


def _tool_call_ids(messages: Sequence[BaseMessage]) -> list[str | None]:
    return [call['id'] for message in messages if isinstance(message, AIMessage) for call in message.tool_calls]


class _ResponsesFixture:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.missing: list[str] = []
        self.root_phase = 0

    def respond(self, body: dict[str, Any]) -> tuple[int, bytes]:
        self.requests.append(body)
        dangling = _missing_response_outputs(body['input'])
        if dangling:
            self.missing.extend(dangling)
            payload = json.dumps({'error': {'message': f'No tool output found for function call {dangling[0]}.',
                                           'type': 'invalid_request_error', 'code': None}}).encode()
            return 400, payload
        return 200, self.stream(_last_user_text(body['input']))

    def stream(self, text: str | None) -> bytes:
        if text == 'Start parallel tasks':
            steps = [
                [('read_file', {'file_path': '/probe.txt'}, READ_ID)],
                [('write_todos', {'todos': [{'content': 'Research', 'status': 'in_progress'}]}, TODO_ID)],
                [('task', {'description': f'child-{index}', 'subagent_type': 'worker'}, call_id)
                 for index, call_id in enumerate(TASK_IDS)],
            ]
            payload = _task_stream(ASSISTANT_IDS[self.root_phase], steps[self.root_phase])
            self.root_phase += 1
            return payload
        if text in {'child-0', 'child-1', 'child-2'}:
            return _task_stream(f'resp_{text}', [('execute', {'command': text}, f'execute-{text}')])
        return RECORDED_STREAM


def _last_user_text(items: list[dict[str, Any]]) -> str | None:
    text = next((item.get('content') for item in reversed(items) if item.get('role') == 'user'), '')
    if isinstance(text, list):
        return ''.join(item.get('text', '') for item in text)
    return text


def _responses_handler(fixture: _ResponsesFixture) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            status, payload = fixture.respond(body)
            self.send_response(status)
            self.send_header('content-type', 'application/json' if status == 400 else 'text/event-stream')
            self.send_header('content-length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:
            return None

    return Handler


def test_cancel_during_parallel_tools_rebuilds_sendable_persisted_history_issue_3458(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, langchain_tracing: None,
) -> None:
    followup = RunAgentInput.model_validate_json(FOLLOWUP.read_text())
    assert isinstance(followup.forwarded_props, dict)
    followup.forwarded_props['sessionUserId'] = 'user-1'
    followup.forwarded_props['turnMemory'] = memory_capability_props()
    memory = _FakeAgentCoreMemory()
    session = _serve_session(tmp_path, monkeypatch, memory, session_id=followup.thread_id)
    (tmp_path / 'probe.txt').write_text('persisted content')
    responses = _ResponsesFixture()
    with serving_relay() as relay:
        relay.server.RequestHandlerClass = _responses_handler(responses)
        model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: ModelRelay(
            base_url=relay.url, token='test', headers={}, session_id=followup.thread_id,
        ))
        monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
        original_build = build_agent

        def with_worker(**kwargs: Any) -> Any:
            return original_build(**kwargs, subagents=[{
                'name': 'worker', 'description': 'Research', 'system_prompt': '', 'model': model,
            }])

        monkeypatch.setattr(serving, 'build_agent', with_worker)

        async def scenario() -> None:
            entered: set[str] = set()
            admitted = asyncio.Event()

            async def held_execute(self: LocalShellBackend, command: str, **_kwargs: Any) -> Any:
                entered.add(command)
                if entered == {'child-0', 'child-1', 'child-2'}:
                    admitted.set()
                await asyncio.Event().wait()

            monkeypatch.setattr(LocalShellBackend, 'aexecute', held_execute)
            running = asyncio.create_task(session.events([{
                'id': '91cdc820-5380-41d5-a456-dd5324ba01e0', 'role': 'user', 'content': 'Start parallel tasks',
            }]))
            try:
                await _await_fixture_admission_or_public_completion(running, admitted)
                assert isinstance(serving._DEFERRED_SAVER, TurnCheckpointSaver)
                config: RunnableConfig = {'configurable': {'actor_id': 'user-1', 'thread_id': followup.thread_id}}
                current = await next(iter(serving._AGENTS.values())).graph.aget_state(config)
                assert _tool_call_ids(current.values['messages']) == [READ_ID, TODO_ID, *TASK_IDS]
                stop = RunAgentInput.model_validate({
                    'threadId': followup.thread_id, 'runId': 'run-1', 'messages': [],
                    'tools': [], 'context': [], 'state': {},
                    'forwardedProps': {'stop': True, 'sessionUserId': 'user-1', 'turnMemory': memory_capability_props()},
                })
                assert [event async for event in serving.invoke(stop, serving._RequestContext('agentcore-session-1'))] == []
                stopped = await running
                assert (stopped[-1].type, stopped[-1].code) == ('RUN_ERROR', 'TURN_STOPPED')
                reader = original_build(model=model, backend=LocalShellBackend(
                    root_dir=tmp_path, virtual_mode=True, inherit_env=False,
                ), skills=[], tools=[], memory=[], checkpointer=agentcore.build_checkpointer(
                    MEMORY_ID, region_name='us-east-1', wrapper=TurnCheckpointSaver,
                ))
                persisted = (await reader.aget_state(config)).values['messages']
                assert _tool_call_ids(persisted) == [READ_ID, TODO_ID, *TASK_IDS]
                assert [message.tool_call_id for message in persisted if isinstance(message, ToolMessage)] == [READ_ID, TODO_ID]
                for name, value in {'_AGENTS': {}, '_DEFERRED_SAVER': None, '_CHECKPOINTER': None, '_STORE': None}.items():
                    monkeypatch.setattr(serving, name, value)
                events = [event async for event in serving.invoke(followup, serving._RequestContext('agentcore-session-1'))]
                assert [(event.type, getattr(event, 'message', None)) for event in events
                        if event.type in {'RUN_ERROR', 'RUN_FINISHED'}] == [('RUN_FINISHED', None)]
                assert not responses.missing
                outputs = [item['call_id'] for item in responses.requests[-1]['input'] if item.get('type') == 'function_call_output']
                assert outputs == [READ_ID, TODO_ID, *TASK_IDS]
            finally:
                await _cancel_unfinished_readers(running)

        asyncio.run(asyncio.wait_for(scenario(), timeout=20))
