from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Iterator, Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from types import SimpleNamespace
from typing import Any, cast

import httpx
import langsmith.utils
from ag_ui.core import RunAgentInput, UserMessage
from botcube_cartridge import HarnessDefinition
from langchain.agents import AgentState
from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import (
    FakeListChatModel,
)
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage
from langchain_core.messages.tool import tool_call_chunk
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from opentelemetry import baggage, trace
from opentelemetry.sdk.trace import TracerProvider

from botcube_harness_deepagents import serving, trace_relay, turn_timing
from botcube_harness_deepagents.agent import build_agent
from conftest import ToolBindableFakeMessagesModel, prepared


@tool
async def lookup(value: str) -> str:
    """Look up a value."""
    await asyncio.sleep(0.01)
    if value == 'tool-error':
        raise ValueError('lookup failed')
    return 'found ' + value


async def exercise(session_id: str, mode: str) -> None:
    entered = asyncio.Event()
    turns = serving._SessionTurns()

    async def reply(state: Any) -> dict[str, Any]:
        entered.set()
        model = FakeListChatModel(responses=['answer'], error_on_chunk_number=0 if mode == 'model-error' else None)
        async for _chunk in model.astream('question'):
            await asyncio.sleep(0.001)
        result = await lookup.ainvoke({'value': mode})
        return {'messages': [AIMessage(result)]}

    serving._require_cartridge = lambda: SimpleNamespace(
        skills=(), prepare_invocation=lambda _: serving.InvocationAuth('owner', False, None),
        apply_session_id=lambda *_: None,
    )
    graph = StateGraph(AgentState)
    graph.add_node('model', reply)
    graph.add_edge(START, 'model')
    graph.add_edge('model', END)
    agent = serving._SessionAgent(name='test', graph=graph.compile(checkpointer=MemorySaver()))
    inputs = RunAgentInput(thread_id=session_id, run_id=mode, messages=[UserMessage(id='question', role='user', content='question')], tools=[], context=[], state={}, forwarded_props={})
    if mode == 'disconnect':
        stream = turns.stream(('owner', session_id), prepared(agent, Path('.')), inputs, None, serving._RequestContext(session_id))
        async for _event in stream:
            if entered.is_set():
                await stream.aclose()
                break
    else:
        def backend() -> SimpleNamespace:
            with turn_timing.phase('workspace'):
                return SimpleNamespace(cwd='.')

        async def turn_agent(*_args: Any) -> tuple[Any, Any]:
            return agent, await asyncio.to_thread(backend)

        serving._SESSION_TURNS = turns
        serving._turn_agent = turn_agent
        inputs.forwarded_props = {'sessionUserId': 'owner'}
        trace_id = {'success': '1', 'tool-error': '2', 'model-error': '3'}[mode] * 32
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=serving.app), base_url='http://harness') as client:
            response = await client.post('/invocations', json=inputs.model_dump(by_alias=True), headers={
                serving.SESSION_ID_HEADER: session_id,
                'traceparent': f'00-{trace_id}-1234567890abcdef-01',
            })
        assert response.status_code == 200
        assert ('RUN_ERROR' if mode.endswith('error') else 'RUN_FINISHED') in response.text
    while turns._turns:
        await asyncio.sleep(0)
    assert baggage.get_baggage('session.id') is None


async def exercise_command(command: str, *, sync: bool = False) -> None:
    with TemporaryDirectory() as root:
        executable = Path(root) / 'samplecli'
        executable.write_text('#!/bin/sh\ncase "$*" in *--fail*) echo "command failed" >&2; exit 7;; esac\nprintf "command completed\\n%s\\n" "$*"\n')
        executable.chmod(0o755)
        os.environ['BOTCUBE_WORKSPACE'] = root
        serving._cartridge = None
        serving.configure_harness_definition(HarnessDefinition(
            skills=(), agent_name='test', prepare_invocation=lambda _: serving.InvocationAuth('owner', False, None),
            prepare_root=lambda _: None, session_id_env_var='TEST_SESSION', environment_cache_key=lambda _: (),
            shell_command_prefixes=('samplecli reports search', 'samplecli reports dashboard view'),
        ))
        backend = serving._require_cartridge().build_backend({'PATH': root + ':/usr/bin:/bin'})
        model = ToolBindableFakeMessagesModel(responses=[
            AIMessage(content='', tool_calls=[{
                'name': 'execute', 'args': {'command': command},
                'id': 'command-test', 'type': 'tool_call',
            }]),
            AIMessage(content='done'),
        ])
        agent = build_agent(backend=backend, skills=[], model=model)
        inputs = {'messages': [('user', 'run command')]}
        result = agent.invoke(inputs) if sync else await agent.ainvoke(inputs)
        assert result['messages'][-1].content == 'done'
        if any(value in command for value in ('private search', 'private-dashboard', 'private-sync')):
            assert 'command completed' in result['messages'][-2].content
        if 'private-nested' in command:
            assert 'reports search private-nested' in result['messages'][-2].content
        if '--fail' in command:
            assert 'Exit code: 7' in result['messages'][-2].content


_EXPORTING_CLI = """#!{python} -I
import os, sys, urllib.request
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.trace.v1.trace_pb2 import Span, Status
_, trace_id, parent_id, _ = os.environ['TRACEPARENT'].split('-')
failed = '--fail' in sys.argv
outcome = Status(code=Status.STATUS_CODE_ERROR if failed else Status.STATUS_CODE_OK)
request = ExportTraceServiceRequest()
spans = request.resource_spans.add().scope_spans.add().spans
command = os.urandom(8)
spans.add(trace_id=bytes.fromhex(trace_id), span_id=command, parent_span_id=bytes.fromhex(parent_id), name='appcli data eval', status=outcome)
spans.add(trace_id=bytes.fromhex(trace_id), span_id=os.urandom(8), parent_span_id=command, name='POST', kind=Span.SPAN_KIND_CLIENT, status=outcome)
urllib.request.urlopen(urllib.request.Request(
    os.environ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'], data=request.SerializeToString(), headers={{'Content-Type': 'application/x-protobuf'}},
), timeout=5).read()
sys.exit(3 if failed else 0)
"""


class _AcceptingCollector(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


class _CommandModel(BaseChatModel):
    """Streams one `execute` call of `command`, then an answer once the tool replies, or fails there if `answer_fails`."""

    command: str
    answer_fails: bool = False

    @property
    def _llm_type(self) -> str:
        return 'fake-command'

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        raise AssertionError('The Harness streams model output')

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        if isinstance(messages[-1], HumanMessage):
            call = tool_call_chunk(name='execute', args=json.dumps({'command': self.command}), id='cli', index=0)
            yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))
            return
        if self.answer_fails:
            raise RuntimeError('The model failed after the tool replied')
        yield ChatGenerationChunk(message=AIMessageChunk(content='answer'))

    def bind_tools(self, tools: Sequence[Any], *, tool_choice: str | None = None, **kwargs: Any) -> _CommandModel:
        return self


async def exercise_cli_turn(session_id: str, command: str, *, answer_fails: bool = False) -> None:
    """A Turn through /invocations whose one tool call runs `command`, its `appcli` calls exporting through the relay."""
    collector = ThreadingHTTPServer(('127.0.0.1', 0), _AcceptingCollector)
    Thread(target=collector.serve_forever, daemon=True).start()
    os.environ.update({
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': f'http://127.0.0.1:{collector.server_port}/v1/traces',
        'AWS_REGION': 'us-east-1', 'AWS_ACCESS_KEY_ID': 'fake-key', 'AWS_SECRET_ACCESS_KEY': 'fake-secret',
    })
    serving.harness_trace_relay = trace_relay.start_trace_relay
    with TemporaryDirectory() as root:
        executable = Path(root) / 'appcli'
        executable.write_text(_EXPORTING_CLI.format(python=sys.executable))
        executable.chmod(0o755)
        os.environ['BOTCUBE_WORKSPACE'] = root
        serving._cartridge = None
        serving.configure_harness_definition(HarnessDefinition(
            skills=(), agent_name='test', prepare_invocation=lambda _: serving.InvocationAuth('owner', False, None),
            prepare_root=lambda _: None, session_id_env_var='TEST_SESSION', environment_cache_key=lambda _: (),
            shell_command_prefixes=('appcli data eval',),
        ))
        backend = serving._require_cartridge().build_backend({'PATH': root + ':/usr/bin:/bin'})
        model = _CommandModel(command=command, answer_fails=answer_fails)
        agent = serving._SessionAgent(name='test', graph=build_agent(backend=backend, skills=[], model=model, checkpointer=MemorySaver()))

        async def turn_agent(*_args: Any) -> tuple[Any, Any]:
            return agent, backend

        serving._SESSION_TURNS = serving._SessionTurns()
        serving._turn_agent = turn_agent
        inputs = RunAgentInput(
            thread_id=session_id, run_id=session_id, messages=[UserMessage(id='question', role='user', content='question')],
            tools=[], context=[], state={}, forwarded_props={'sessionUserId': 'owner'},
        )
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=serving.app), base_url='http://harness') as client:
            response = await client.post('/invocations', json=inputs.model_dump(by_alias=True), headers={serving.SESSION_ID_HEADER: session_id})
        assert ('RUN_ERROR' if answer_fails else 'RUN_FINISHED') in response.text, response.text
    collector.shutdown()
    collector.server_close()


async def main() -> None:
    assert not langsmith.utils.tracing_is_enabled()
    for command in (
        'samplecli reports search "private search" --limit 1',
        '  samplecli\treports   search "private search"',
        'samplecli reports dashboard view private-dashboard',
        'samplecli reports search --fail',
        'samplecli reports private-secret',
        'printf "samplecli reports search"',
        'samplecli reports search x; true',
        'samplecli reports search a & samplecli reports search b & wait',
        'samplecli reports search x\ntrue',
        'samplecli reports search "unterminated',
        'samplecli reports search `printf private-nested`',
        'samplecli reports search "`printf private-nested`"',
        'samplecli reports search $(printf private-nested)',
        'samplecli reports search "$(printf private-nested)"',
    ):
        await exercise_command(command)
    await exercise_command('samplecli reports search private-sync', sync=True)
    await exercise_cli_turn('cli-success', 'appcli data eval')
    await exercise_cli_turn('cli-failure', 'appcli data eval --fail | cat; appcli data eval; appcli data eval --fail')
    await exercise_cli_turn('cli-failed-turn', 'appcli data eval --fail', answer_fails=True)
    for mode in ('success', 'tool-error', 'model-error', 'disconnect'):
        await exercise('agentcore-' + mode, mode)


if __name__ == '__main__':
    asyncio.run(main())
    cast(TracerProvider, trace.get_tracer_provider()).force_flush()
