"""The Harness over its AG-UI endpoint, with a test bot and a scripted model.

The scripted model stands in for the LLM: it records what it was shown (system prompt,
tools) and acts on the user's text, running a shell command (`run: ...`), listing the
sandbox (`ls: ...`) or recording a memory (`remember: ...`); otherwise it echoes.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import shlex
import threading
import time
import tomllib
from base64 import b64decode, b64encode
from collections.abc import (
    AsyncIterator,
    Callable,
    Iterator,
    Mapping,
    Sequence,
)
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn, TypedDict

import boto3
import httpx
import httpx2
import pytest
import uvicorn
from botocore.exceptions import ClientError
from deepagents.middleware.filesystem import EXECUTE_TOOL_DESCRIPTION
from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT
from fastapi.testclient import TestClient
from langchain_anthropic import ChatAnthropic
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.messages.ai import UsageMetadata
from langchain_core.messages.tool import tool_call_chunk
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_core.tools import BaseTool
from langgraph.checkpoint.base import empty_checkpoint
from langgraph_checkpoint_aws import AgentCoreMemorySaver
from openai import APIStatusError
from PIL import Image, PngImagePlugin

from agentcore_fake import (
    MEMORY_ID,
    FakeAgentCoreMemory,
    FakeSts,
    another_microvm,
    fresh_warm_sessions,
    install_tagged_memory,
    turn_identity,
)
from botcube_harness_deepagents import (
    artifact,
    files,
    llm,
    memory_document,
    memory_tools,
    message_times,
    serving,
    session_api,
    session_memory,
    today,
    turn_lifecycle,
)
from botcube_harness_deepagents.conversation import reasoning_blocks
from botcube_harness_deepagents.definition import HarnessDefinition
from botcube_harness_deepagents.files_mount import FilesMount, FilesMountError
from botcube_harness_deepagents.llm import PLAN_MODEL_PREFIX, ModelRelay
from botcube_harness_deepagents.memory.agentcore.warm_session import WarmSessionSaver
from botcube_harness_deepagents.session_agent import SessionAgent
from checkpoint_fake import ReadCountingSaver, legacy_session
from deployment_fixture import deploy
from mounted_files import MountedFiles, binding
from prompt_cache_fake import DelegatingBedrockClient, fake_bedrock_model
from relay_fake import (
    REASONING_STREAM,
    RelayReply,
    failing_stream,
    plan_usage_error,
    serving_relay,
)

SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'


class _Member(TypedDict):
    actor: str
    user: str
    memory: bool


class _ThreadMember(_Member):
    thread: str


class _Documents(TypedDict):
    agentIdentity: dict[str, str]
    soul: str


class _Recorder:
    def __init__(self) -> None:
        self.completion_metadata: dict[str, Any] = {'finish_reason': 'length'}
        self.builds: list[dict[str, Any]] = []
        self.prompts: list[str] = []
        self.tools: list[list[str]] = []
        self.descriptions: list[dict[str, str]] = []
        self.heard: list[list[str]] = []


class _ScriptedModel(BaseChatModel):
    recorder: Any = None

    @property
    def _llm_type(self) -> str:
        return 'scripted'

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        raise AssertionError('The Harness streams model output')

    def bind_tools(self, tools: Sequence[Any], *, tool_choice: str | None = None, **kwargs: Any) -> _ScriptedModel:
        self.recorder.tools.append([getattr(tool, 'name', None) or tool['name'] for tool in tools])
        self.recorder.descriptions.append({tool.name: tool.description for tool in tools if isinstance(tool, BaseTool)})
        return self

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        system = messages[0]
        self.recorder.prompts.append(system.text if isinstance(system, SystemMessage) else '')
        humans = [message for message in messages if isinstance(message, HumanMessage)]
        self.recorder.heard.append([str(message.content) for message in humans])
        yield self._reply(messages, messages.index(humans[-1])) if humans else _text('Hi! I can remember what matters to you.')

    def _reply(self, messages: list[BaseMessage], turn_start: int) -> ChatGenerationChunk:
        text = str(messages[turn_start].content)
        if 'opening greeting instruction in <writing>' in text:
            return _text('Hi! I can remember what matters to you.')
        if text == 'narrated work':
            return self._narrated_reply(messages, turn_start)
        if text.startswith('steps: '):
            return self._step_reply(messages, turn_start, int(text.removeprefix('steps: ')))
        last = messages[-1]
        if isinstance(last, ToolMessage):
            return _text(f'Tool said: {last.content}')
        for prefix, tool, argument in (
            ('run: ', 'execute', 'command'), ('ls: ', 'ls', 'path'),
            ('soul: ', 'edit_soul', 'content'), ('rename: ', 'edit_agent_identity', 'name'),
            ('read: ', 'read_file', 'file_path'),
        ):
            if text.startswith(prefix):
                return _call(tool, {argument: text.removeprefix(prefix)}, len(messages))
        if text.startswith('delegate: '):
            task = {'description': text.removeprefix('delegate: '), 'subagent_type': 'general-purpose'}
            return _call('task', task, len(messages))
        if text.startswith('propose: '):
            return _call('propose_scheduled_task', json.loads(text.removeprefix('propose: ')), len(messages))
        if text.startswith('remember: '):
            return _call('memory', {'action': 'record', 'content': text.removeprefix('remember: ')}, len(messages))
        if text.startswith('memory: '):
            return _call('memory', json.loads(text.removeprefix('memory: ')), len(messages))
        if text.startswith('capped: '):
            reply = _text(text.removeprefix('capped: '))
            reply.message.response_metadata = self.recorder.completion_metadata
            return reply
        if text.startswith('say: '):
            return _text(text.removeprefix('say: '))
        if text.startswith('wait: '):
            time.sleep(float(text.removeprefix('wait: ')))
            return _text('Waited')
        if text.startswith('write: '):
            path, content = text.removeprefix('write: ').split(': ', 1)
            return _call('write_file', {'file_path': path, 'content': content}, len(messages))
        return _text(f'Echo: {text}')

    def _narrated_reply(self, messages: list[BaseMessage], turn_start: int) -> ChatGenerationChunk:
        done = sum(isinstance(message, ToolMessage) for message in messages[turn_start:])
        if done < 2:
            call = _call('execute', {'command': f'echo step-{done + 1}'}, len(messages))
            call.message.content = ['I will check the first result.', 'I checked it and will verify the second result.'][done]
            return call
        return _text('Both checks finished.')

    def _step_reply(self, messages: list[BaseMessage], turn_start: int, steps: int) -> ChatGenerationChunk:
        # One `ls` per step, then an answer: each step is a model call and a tool call.
        done = sum(isinstance(message, ToolMessage) for message in messages[turn_start:])
        if done < steps:
            return _call('ls', {'path': str(serving._workspace())}, len(messages))
        return _text(f'Done after {done} steps')


def _text(content: str) -> ChatGenerationChunk:
    usage = UsageMetadata(input_tokens=10, output_tokens=2, total_tokens=12)
    return ChatGenerationChunk(message=AIMessageChunk(content=content, usage_metadata=usage))


def _call(name: str, args: Mapping[str, str], index: int) -> ChatGenerationChunk:
    call = tool_call_chunk(name=name, args=json.dumps(args), id=f'call-{index}', index=0)
    return ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))


def _prepare_invocation(run: Any, token: str | None) -> serving.InvocationAuth:
    props = run.forwarded_props or {}
    relay = props.get('credentialServiceUrl') or props.get('relay')
    return serving.InvocationAuth(
        props.get('actorId'),
        bool(props.get('memory')),
        props.get('env'),
        model_relay=ModelRelay(base_url=relay, token=token or 'invocation-1', headers={}, session_id='thread-1') if relay else None,
    )


def _definition(prepared: list[Path]) -> HarnessDefinition:
    def prepare_root(root: Path) -> None:
        prepared.append(root)
        (root / 'prepared.txt').write_text('ready')
        skill = root / 'skills' / 'grounding'
        skill.mkdir(parents=True, exist_ok=True)
        (skill / 'SKILL.md').write_text('---\nname: grounding\ndescription: Cite a source for every fact.\n---\n')

    return HarnessDefinition(
        skills=('/skills/',),
        agent_name='test-agent',
        system_prompt='',
        prepare_invocation=_prepare_invocation,
        prepare_root=prepare_root,
        session_id_env_var='TEST_SESSION_ID',
        # A rotating token keeps its agent: only the account selects the cached agent.
        environment_cache_key=lambda environment: tuple(
            sorted((key, value) for key, value in (environment or {}).items() if key != 'TOKEN')
        ),
    )


class _TurnOptions(TypedDict, total=False):
    """The per-turn options a parametrized test hands to ``_Service.turn``."""

    thread: str
    actor: str | None
    user: str | None
    memory: bool
    env: Mapping[str, str] | None
    model: str
    effort: str


class _Service:
    def __init__(self, client: TestClient, recorder: _Recorder, home: Path, prepared: list[Path]) -> None:
        self.client = client
        self.recorder = recorder
        self.home = home
        self.prepared = prepared

    def turn(
        self,
        text: str,
        *,
        thread: str = 'thread-1',
        actor: str | None = 'actor-1',
        user: str | None = 'user-1',
        memory: bool = False,
        env: Mapping[str, str] | None = None,
        session: str | None = None,
        message: str | None = None,
        **props: Any,
    ) -> list[dict[str, Any]]:
        forwarded: dict[str, Any] = {'actorId': actor, 'memory': memory, 'env': env, **props}
        if user is not None:
            forwarded['sessionUserId'] = user
        if serving.AGENTCORE_MEMORY_ID and 'turnIdentity' not in props:
            forwarded['turnIdentity'] = turn_identity(actor or 'no-actor', user, thread)
        return self.post(
            {
                'threadId': thread,
                'runId': f'run-{len(self.recorder.prompts)}',
                'messages': [{'id': message or f'message-{len(self.recorder.prompts)}', 'role': 'user',
                              'content': text}],
                'tools': [],
                'context': [],
                'state': {},
                'forwardedProps': forwarded,
            },
            session=session,
        )

    def fed(self) -> None:
        """Wait for finished Turns' Memory feeds, which land off the response path."""
        assert self.client.portal is not None
        self.client.portal.call(serving._SESSION_TURNS.wait_for_feeds)

    def post(self, run: dict[str, Any], *, session: str | None = None) -> list[dict[str, Any]]:
        return _sse_events(self.post_raw(run, session=session))

    def post_raw(self, run: dict[str, Any], *, session: str | None = None) -> str:
        response = self.client.post('/invocations', json=run, headers={SESSION_HEADER: session} if session else {})
        assert response.status_code == 200

        async def settled() -> None:
            user_id = (run.get('forwardedProps') or {}).get('sessionUserId')
            if not isinstance(user_id, str):
                return
            await serving._SESSION_TURNS.wait_for_checkpoint((user_id, run['threadId']))
            await asyncio.sleep(0)

        assert self.client.portal is not None
        self.client.portal.call(settled)
        return response.text


def _sse_events(body: str) -> list[dict[str, Any]]:
    return [json.loads(line.removeprefix('data: ')) for line in body.splitlines() if line.startswith('data: ')]


def _said(events: list[dict[str, Any]]) -> str:
    return ''.join(event['delta'] for event in events if event['type'] == 'TEXT_MESSAGE_CONTENT')


def _tool_output(events: list[dict[str, Any]]) -> str:
    [result] = [event['content'] for event in events if event['type'] == 'TOOL_CALL_RESULT']
    return result


def _memory_block(prompt: str) -> str:
    """The Extracted Memory block in a system prompt."""
    [block] = re.findall(r'<extracted_memory>\n(.*)\n</extracted_memory>', prompt, re.DOTALL)
    return block


def _written_memory(prompt: str) -> str:
    [block] = re.findall(r'<agent_memory>\n(.*)\n</agent_memory>', prompt, re.DOTALL)
    return block.strip()


def _cache_usage(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    return [json.loads(record.getMessage()) for record in caplog.records if record.name.endswith('prompt_cache')]


def _fresh_state(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        '_bot': None,
        'AGENTCORE_MEMORY_ID': '',
        '_AGENTS': {},
        '_BACKENDS': {},
        '_BACKEND_BY_AGENT': {},
        '_CHECKPOINTER': None,
        '_STORE': None,
        '_SESSION_TURNS': turn_lifecycle.SessionTurns(),
    }.items():
        monkeypatch.setattr(serving, name, value)
    monkeypatch.setattr(session_memory, '_warmups', {})
    fresh_warm_sessions(monkeypatch)


@pytest.fixture
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> Iterator[_Service]:
    home = tmp_path / 'home'
    home.mkdir()
    monkeypatch.setenv('HOME', str(home))
    monkeypatch.setenv('BOTCUBE_CHECKPOINT_PATH', str(tmp_path / 'checkpoints.sqlite3'))
    monkeypatch.setenv('INHERITED_MARKER', 'from-process')
    monkeypatch.setenv('LANGSMITH_TRACING', 'false')
    _fresh_state(monkeypatch)
    recorder = _Recorder()

    def build_model(**kwargs: Any) -> Any:
        recorder.builds.append(kwargs)
        if str(kwargs.get('model')).startswith(PLAN_MODEL_PREFIX):
            # A plan model is real up to its Credential Service relay.
            return llm.build_model(**kwargs)
        return _ScriptedModel(recorder=recorder)

    monkeypatch.setattr(serving, 'build_model', build_model)
    prepared: list[Path] = []
    definition = _definition(prepared)
    definition = replace(definition, session_id_env_var=getattr(request, 'param', 'TEST_SESSION_ID'))
    serving.configure_harness_definition(definition)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', '')
    monkeypatch.setattr(session_api, '_GRAPH', None)
    with TestClient(serving.app) as client:
        yield _Service(client, recorder, home, prepared)


def _replay(user: str, thread: str) -> list[tuple[str, str]]:
    session_api._GRAPH = None
    messages = asyncio.run(session_api.handle({'operation': 'get', 'userId': user, 'sessionId': thread}))['messages']
    return [(message['role'], message.get('content', '')) for message in messages]


# -- A Turn ----------------------------------------------------------------------


def test_a_turn_streams_the_models_answer_and_files_the_session_under_the_session_user(service: _Service) -> None:
    events = service.turn('hello', thread='thread-a', user='user-a')

    assert [event['type'] for event in events][0] == 'RUN_STARTED'
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == 'Echo: hello'
    assert _replay('user-a', 'thread-a') == [('user', 'hello'), ('assistant', 'Echo: hello')]


def _png(size: tuple[int, int], padding: int = 0) -> bytes:
    buffer = BytesIO()
    info = PngImagePlugin.PngInfo()
    if padding:
        info.add(b'vpAg', b'x' * padding)
    Image.new('RGB', size).save(buffer, format='PNG', pnginfo=info)
    return buffer.getvalue()


def _inline_images(messages: list[BaseMessage]) -> Iterator[str]:
    for message in messages:
        if isinstance(message.content, list):
            for block in message.content_blocks:
                if block['type'] == 'image' and 'base64' in block:
                    yield block['base64']


@pytest.mark.parametrize('decode', [True, False], ids=['tall-raster', 'undecodable'])
def test_a_turn_can_resume_with_a_screenshot(
    service: _Service, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, decode: bool,
) -> None:
    workspace = _workspace(tmp_path, monkeypatch, 'screenshots')
    original = _png((600, 3000)) if decode else b'\x89PNG\r\n\x1a\ncorrupt'
    (workspace / 'screenshot.png').write_bytes(original)
    seen = []
    stream = _ScriptedModel._stream

    def dimension_limit(model: _ScriptedModel, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        encoded = next(_inline_images(messages), None)
        if encoded is None:
            yield from stream(model, messages, *args, **kwargs)
            return
        data = b64decode(encoded)
        if decode:
            with Image.open(BytesIO(data)) as image:
                if max(image.size) > 2000:
                    raise ValueError('Image exceeds the 2000 pixel dimension limit')
                seen.append(image.size)
        else:
            seen.append(data)
        yield _text('Screenshot seen')

    monkeypatch.setattr(_ScriptedModel, '_stream', dimension_limit)
    for text in (f"read: {workspace / 'screenshot.png'}", 'Continue'):
        events = service.turn(text, message=text)
        assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
        assert _said(events) == 'Screenshot seen'
    assert seen == ([(400, 2000)] * 2 if decode else [original] * 2)
    agent = next(iter(serving._AGENTS.values()))
    assert service.client.portal is not None
    state = service.client.portal.call(agent.graph.aget_state, {'configurable': {'thread_id': 'thread-1', 'actor_id': 'user-1'}})
    assert list(_inline_images(state.values['messages'])) == [b64encode(original).decode()]


@pytest.mark.parametrize('proactive', [False, True], ids=['gateway-refusal', 'normal-compaction'])
def test_a_turn_recovers_from_an_oversized_model_request(
    service: _Service, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, proactive: bool,
) -> None:
    monkeypatch.setattr(serving, 'build_model', lambda **_: _ScriptedModel(
        recorder=service.recorder, profile={'max_input_tokens': 55_000},
    ))
    workspace = _workspace(tmp_path, monkeypatch, 'attachments')
    (workspace / 'attachment.png').write_bytes(_png((1, 1), 5 * 1024 * 1024))
    refusals = []
    summaries = []
    stream = _ScriptedModel._stream

    def byte_limit(model: _ScriptedModel, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        if len(messages) == 1 and '\n<messages>\n' in messages[0].text:
            summaries.append(True)
            yield _text('Earlier conversation included an attachment.')
        elif messages[-1].id == 'continue':
            if any(_inline_images(messages)):
                refusals.append(True)
                response = httpx.Response(413, request=httpx.Request('POST', 'https://example.test/v1/messages'))
                raise APIStatusError('Request Entity Too Large', response=response, body=None)
            yield _text('Echo: Continue')
        elif any(_inline_images(messages)):
            yield _text('Attachment seen')
        else:
            yield from stream(model, messages, *args, **kwargs)

    monkeypatch.setattr(_ScriptedModel, '_stream', byte_limit)
    assert _said(service.turn(f"read: {workspace / 'attachment.png'}", message='read-attachment')) == 'Attachment seen'
    service.fed()
    assert not summaries
    continuation = 'Earlier copper futures position. ' * 4_500 if proactive else 'Continue'
    events = service.turn(continuation, message='continue')

    assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
    assert _said(events) == 'Echo: Continue'
    assert len(refusals) == (0 if proactive else 1)
    assert len(summaries) == 1


def test_scheduled_runs_in_one_task_chat_keep_earlier_turns_for_the_agent(service: _Service) -> None:
    service.turn('say: First brief found rates rising', thread='task-chat', memory=True)

    events = service.turn('Flag what changed since last time', thread='task-chat', memory=True)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.heard[-1] == ['say: First brief found rates rising', 'Flag what changed since last time']
    assert _replay('user-1', 'task-chat') == [
        ('user', 'say: First brief found rates rising'), ('assistant', 'First brief found rates rising'),
        ('user', 'Flag what changed since last time'), ('assistant', 'Echo: Flag what changed since last time'),
    ]


def test_a_quiet_turn_streams_keepalive_comments_until_its_answer(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Scaled down: the Chat Service's read of this stream fails after 300 s with nothing sent.
    monkeypatch.setattr(serving, '_KEEPALIVE_SECONDS', 0.05)
    run = {
        'threadId': 'thread-1', 'runId': 'run-1', 'messages': [{'id': 'message-1', 'role': 'user', 'content': 'wait: 0.5'}],
        'tools': [], 'context': [], 'state': {}, 'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1'},
    }

    body = service.post_raw(run)

    quiet = body[:body.index('"TEXT_MESSAGE_CONTENT"')]
    assert quiet.count(': keepalive\n\n') >= 3
    assert _said(_sse_events(body)) == 'Waited'


def test_a_turn_without_a_thread_id_is_the_default_conversation(service: _Service, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache')

    service.turn('hello', thread='')

    assert [entry['thread_id'] for entry in _cache_usage(caplog)] == ['default']


def test_invocation_first_body_stamps_join_success_and_stream_error_to_runtime_sessions(
    service: _Service, caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=serving.__name__)

    succeeded = service.turn('hello', session='runtime-one')
    failed = service.turn('say: ', session='runtime-two')
    assert succeeded[-1]['type'] == 'RUN_FINISHED'
    assert failed[-1]['type'] == 'RUN_ERROR'
    stamps = [json.loads(record.message) for record in caplog.records
              if record.message.startswith('{"event":"harness_response_first_body"')]
    assert [(stamp['runId'], stamp['runtimeSessionId']) for stamp in stamps] == [
        ('run-0', 'runtime-one'), ('run-1', 'runtime-two'),
    ]
    assert all(set(stamp) == {'event', 'runId', 'runtimeSessionId', 'atUnixNs'} for stamp in stamps)
    assert all(isinstance(stamp['atUnixNs'], int) and stamp['atUnixNs'] > 0 for stamp in stamps)


def test_the_agent_is_built_once_per_conversation_and_reused(service: _Service) -> None:
    service.turn('one')
    service.turn('two')

    assert len(service.recorder.builds) == 1
    assert _replay('user-1', 'thread-1')[-1] == ('assistant', 'Echo: two')


@pytest.mark.parametrize(
    ('first', 'second'),
    [
        ({'thread': 'thread-a'}, {'thread': 'thread-b'}),
        ({'actor': 'actor-a'}, {'actor': 'actor-b'}),
        ({'user': 'user-a'}, {'user': 'user-b'}),
        ({'memory': False}, {'memory': True}),
        ({'model': 'sonnet-4.6'}, {'model': 'opus-4.6'}),
        ({'effort': 'low'}, {'effort': 'high'}),
        ({'env': {'ACCOUNT': 'a'}}, {'env': {'ACCOUNT': 'b'}}),
    ],
)
def test_each_part_of_an_invocations_identity_gets_its_own_agent(service: _Service, first: _TurnOptions, second: _TurnOptions) -> None:
    service.turn('one', **first)
    service.turn('two', **second)
    service.turn('three', **first)

    assert len(service.recorder.builds) == 2


def test_the_model_is_built_from_the_forwarded_model_and_effort(service: _Service) -> None:
    service.turn('hello', model='opus-4.6', effort='max')

    assert service.recorder.builds == [{'model': 'opus-4.6', 'effort': 'max', 'provider': None, 'max_tokens': None, 'relay': None}]


def test_each_turns_prompt_cache_usage_is_logged_with_its_thread_model_and_effort(service: _Service, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache')

    service.turn('hello', thread='thread-a', model='opus-4.6', effort='max')
    service.turn('hello', thread='thread-b', model='sonnet-4.6', effort='max')

    logged = _cache_usage(caplog)
    assert [(entry['thread_id'], entry['model'], entry['effort']) for entry in logged] == [
        ('thread-a', 'us.anthropic.claude-opus-4-6-v1', 'max'),
        ('thread-b', 'us.anthropic.claude-sonnet-4-6', 'max'),
    ]
    assert [entry['agentcore_session_id'] for entry in logged] == [None, None]


def test_the_agentcore_session_is_logged_with_the_turns_prompt_cache_usage(service: _Service, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache')

    service.turn('hello', session='agentcore-session-1')

    [entry] = _cache_usage(caplog)
    assert entry['agentcore_session_id'] == 'agentcore-session-1'


def test_serving_turn_logs_delegated_usage_and_starts_fresh_on_reuse(
    service: _Service, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    client = DelegatingBedrockClient()
    monkeypatch.setattr(serving, 'build_model', lambda **kwargs: fake_bedrock_model(client, streaming=True))
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache')

    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_timing')

    for multiplier in (1, 2):
        client.multiplier = multiplier
        events = service.turn('Check the result.', session='cache-session')
        assert events[-1]['type'] == 'RUN_FINISHED'
        assert _said(events) == 'Checked.The helper checked the result.'

    logged = _cache_usage(caplog)
    assert [[entry[key] for key in ('input_tokens', 'output_tokens', 'total_tokens',
                                  'cache_read_input_tokens', 'cache_creation_input_tokens')]
            for entry in logged] == [[300, 30, 330, 120, 60], [600, 60, 660, 240, 120]]
    assert [entry['agentcore_session_id'] for entry in logged] == ['cache-session', 'cache-session']
    timings = [json.loads(record.message) for record in caplog.records if record.name.endswith('.turn_timing') and json.loads(record.message)['event'] == 'harness_turn_timing']
    assert [(line['outputTokens'], line['cacheWriteInputTokens']) for line in timings] == [(30, 60), (60, 120)]


# -- The sandbox -----------------------------------------------------------------


def test_the_sandbox_is_the_home_directory_the_bot_prepared(service: _Service) -> None:
    events = service.turn(f'ls: {serving._workspace()}')

    assert service.prepared == [service.home]
    assert '/prepared.txt' in _tool_output(events)


def test_the_sandbox_shell_sees_the_invocation_and_process_environment(service: _Service) -> None:
    command = 'run: echo "$ACCOUNT $INHERITED_MARKER"'
    events = service.turn(command, env={'ACCOUNT': 'acct-1'})

    assert _tool_output(events) == 'acct-1 from-process\n\n[Command succeeded with exit code 0]'


def test_the_sandbox_shell_reaches_every_destination_but_loopback_through_the_proxy_open_egress_names(
    service: _Service, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    deploy(monkeypatch, tmp_path, integrations={'proxy': {'kind': 'forward', 'url': 'http://proxy.example.com:3128'}}, network={'openEgress': {'proxy': 'integrations.proxy'}})

    events = service.turn('run: echo "$HTTPS_PROXY $NO_PROXY"')

    assert _tool_output(events) == 'http://proxy.example.com:3128 localhost,127.0.0.1,::1,169.254.169.254,169.254.170.2\n\n[Command succeeded with exit code 0]'


def test_the_sandbox_shell_carries_the_logical_session_id(service: _Service) -> None:
    first = service.turn('run: echo "[$TEST_SESSION_ID]"', session='agentcore-session-1')
    second = service.turn('run: echo "[$TEST_SESSION_ID]"', thread='thread-2', session='agentcore-session-2')
    third = service.turn('run: echo "[$TEST_SESSION_ID]"', thread='thread-3')

    assert _tool_output(first) == '[thread-1]\n\n[Command succeeded with exit code 0]'
    assert _tool_output(second) == '[thread-2]\n\n[Command succeeded with exit code 0]'
    assert _tool_output(third) == '[thread-3]\n\n[Command succeeded with exit code 0]'


@pytest.mark.parametrize(
    ('service', 'variable'),
    [('BOT_OWNER_SESSION_ID', 'BOT_OWNER_SESSION_ID'),
     ('BOTCUBE_EXAMPLE_SESSION_ID', 'BOTCUBE_EXAMPLE_SESSION_ID')],
    indirect=['service'],
)
def test_scoped_runtime_identity_keeps_the_shells_logical_invocation_token_session(
    service: _Service, variable: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache')
    events = service.turn(
        f'run: test "${variable}" = "$TOKEN_SESSION_ID" && echo "session matched"',
        thread='logical-owner-session',
        session='session-282076aaa1a2e054f6baa24fb8a8a70ff7c4752db6070b1318cc7bff29598c3c',
        env={'TOKEN_SESSION_ID': 'logical-owner-session'},
    )

    assert _tool_output(events) == 'session matched\n\n[Command succeeded with exit code 0]'
    assert {entry['agentcore_session_id'] for entry in _cache_usage(caplog)} == {
        'session-282076aaa1a2e054f6baa24fb8a8a70ff7c4752db6070b1318cc7bff29598c3c'
    }


def test_a_rotated_token_reaches_the_cached_agents_sandbox(service: _Service) -> None:
    service.turn('run: printenv TOKEN', env={'ACCOUNT': 'a', 'TOKEN': 'first'})
    events = service.turn('run: printenv TOKEN', env={'ACCOUNT': 'a', 'TOKEN': 'second'})

    assert _tool_output(events) == 'second\n\n[Command succeeded with exit code 0]'
    assert len(service.recorder.builds) == 1


def test_a_rotated_token_reaches_the_sandbox_shared_across_models(service: _Service) -> None:
    service.turn('run: printenv TOKEN', env={'ACCOUNT': 'a', 'TOKEN': 'first'}, model='sonnet-4.6')
    events = service.turn('run: printenv TOKEN', env={'ACCOUNT': 'a', 'TOKEN': 'second'}, model='opus-4.6')

    assert _tool_output(events) == 'second\n\n[Command succeeded with exit code 0]'
    assert service.prepared == [service.home]


def test_a_sandbox_belongs_to_one_conversation_actor_and_environment(service: _Service) -> None:
    service.turn('hello', thread='thread-a')
    service.turn('hello', thread='thread-b')
    service.turn('hello', thread='thread-a', actor='actor-b')
    service.turn('hello', thread='thread-a', env={'ACCOUNT': 'a'})

    assert len(service.prepared) == 4


_BROWSER_ENV = 'run: echo "$AGENT_BROWSER_CDP $AGENT_BROWSER_SESSION $AGENT_BROWSER_IDLE_TIMEOUT_MS [$AGENT_BROWSER_SOCKET_DIR]"'


def _browser_env(events: list[dict[str, Any]]) -> list[str]:
    return _tool_output(events).split('\n')[0].split(' ')


@pytest.fixture
def no_browser_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ('AGENT_BROWSER_CDP', 'AGENT_BROWSER_SESSION', 'AGENT_BROWSER_IDLE_TIMEOUT_MS', 'AGENT_BROWSER_SOCKET_DIR'):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.usefixtures('no_browser_env')
def test_agent_browser_drives_the_sessions_agent_computer_through_each_turns_url(service: _Service) -> None:
    command = (
        'run: python -c \'import hashlib, os; '
        'print(hashlib.sha256(os.environ["AGENT_BROWSER_CDP"].encode()).hexdigest(), '
        'os.environ["AGENT_BROWSER_SESSION"], os.environ["AGENT_BROWSER_IDLE_TIMEOUT_MS"], '
        '"[" + os.getenv("AGENT_BROWSER_SOCKET_DIR", "") + "]")\''
    )
    first = _browser_env(service.turn(command, agentComputerCdpUrl='ws://chat.test/cdp?token=first'))
    renewed = _browser_env(service.turn(command, agentComputerCdpUrl='ws://chat.test/cdp?token=renewed'))
    other_owner = _browser_env(service.turn(command, user='user-2', agentComputerCdpUrl='ws://chat.test/cdp?token=other'))
    other_session = _browser_env(service.turn(command, thread='thread-2', agentComputerCdpUrl='ws://chat.test/cdp?token=other'))

    assert first[0] == '44475985bd3f46c4b18d178faa93998e0e4778e80e2ace18491b889c24e04e69'
    assert renewed[0] == 'dda9b4e72396c8496b489f19f9c7e47c9181e4ab34270e6cbd77ad942f8068dd'
    # One agent-browser session per Session keeps its snapshot refs; the cached agent takes each Turn's URL.
    assert renewed[1] == first[1]
    assert len(service.recorder.builds) == 3
    assert len({first[1], other_owner[1], other_session[1]}) == 3
    # An hour idle; agent-browser's own socket directory, where a bot's CLI may find its daemons.
    assert first[2:] == ['3600000', '[]']


@pytest.mark.usefixtures('no_browser_env')
def test_without_an_agent_computer_the_shell_gets_no_browser_wiring(service: _Service) -> None:
    assert _browser_env(service.turn(_BROWSER_ENV)) == ['', '', '', '[]']


@pytest.mark.parametrize('url', ['', 42])
def test_an_unusable_agent_computer_url_fails_the_turn(service: _Service, url: object) -> None:
    events = service.turn(_BROWSER_ENV, agentComputerCdpUrl=url)

    assert events == [{'type': 'RUN_ERROR', 'message': 'agentComputerCdpUrl must be a non-empty URL', 'code': 'INTERNAL_ERROR'}]


def test_the_agent_gets_deepagents_execute_description_verbatim(service: _Service) -> None:
    service.turn('hello')

    assert service.recorder.descriptions[0]['execute'] == EXECUTE_TOOL_DESCRIPTION


# -- Memory ----------------------------------------------------------------------


def test_a_guest_gets_the_generic_prompt_and_no_memory_tool(service: _Service) -> None:
    service.turn('hello', memory=False)

    assert service.recorder.prompts[0].startswith(serving.AGENT_SYSTEM_PROMPT)
    assert 'memory' not in service.recorder.tools[0]
    # Nothing in a guest's graph can reach the memory store.
    [agent] = serving._AGENTS.values()
    assert agent.graph.store is None


def test_a_candidate_system_prompt_replaces_the_agent_prompt_for_its_turn_only(service: _Service) -> None:
    candidate = service.turn('hello', agentSystemPrompt='Candidate prompt.')
    default = service.turn('hello again')

    assert service.recorder.prompts[0].startswith('Candidate prompt.')
    assert serving.AGENT_SYSTEM_PROMPT not in service.recorder.prompts[0]
    assert service.recorder.prompts[1].startswith(serving.AGENT_SYSTEM_PROMPT)
    named = {'type': 'CUSTOM', 'name': 'AGENT_SYSTEM_PROMPT', 'value': hashlib.sha256(b'Candidate prompt.').hexdigest()}
    assert [event['type'] for event in candidate[:2]] == ['RUN_STARTED', 'CUSTOM'] and candidate[1] == named
    assert not [event for event in default if event['type'] == 'CUSTOM']


def test_a_candidate_system_prompt_runs_without_the_users_memory_soul_or_identity(service: _Service) -> None:
    service.turn('hello', agentSystemPrompt='Candidate prompt.', memory=True, **DOCUMENTS)

    assert '<soul>' not in service.recorder.prompts[0] and SOUL not in service.recorder.prompts[0]
    assert not {'memory', 'edit_soul', 'edit_agent_identity'} & set(service.recorder.tools[0])
    [agent] = serving._AGENTS.values()
    assert agent.graph.store is None


def test_a_candidate_bot_prompt_replaces_the_bot_instructions_for_its_turn_only(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, '_bot', replace(serving._require_bot(), system_prompt='Bot instructions.'))
    service.turn('delegate: say: checked', botSystemPrompt='Candidate instructions.')
    service.turn('hello again')

    main, subagent, _, default = service.recorder.prompts
    assert 'system_prompt' in GENERAL_PURPOSE_SUBAGENT
    assert main.startswith(serving.AGENT_SYSTEM_PROMPT + '\n\nCandidate instructions.')
    assert subagent.startswith(GENERAL_PURPOSE_SUBAGENT['system_prompt'] + '\n\nCandidate instructions.')
    assert 'Bot instructions.' not in main + subagent
    assert default.startswith(serving.AGENT_SYSTEM_PROMPT + '\n\nBot instructions.')


def test_empty_candidate_prompts_run_the_turn_without_the_agent_prompt_or_bot_instructions(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, '_bot', replace(serving._require_bot(), system_prompt='Bot instructions.'))
    events = service.turn('delegate: say: checked', agentSystemPrompt='', botSystemPrompt='')

    assert _tool_output(events) == 'checked'
    main, subagent, _ = service.recorder.prompts
    assert serving.AGENT_SYSTEM_PROMPT not in main
    assert 'Bot instructions.' not in main + subagent
    assert 'system_prompt' in GENERAL_PURPOSE_SUBAGENT
    assert subagent.startswith(GENERAL_PURPOSE_SUBAGENT['system_prompt'])


def test_the_agent_proposes_a_scheduled_task_for_the_user_to_confirm(service: _Service) -> None:
    proposal = {'title': 'Morning brief', 'prompt': 'Brief me on rates', 'timezone': 'UTC', 'frequency': 'weekdays', 'time': '08:00'}

    events = service.turn(f'propose: {json.dumps(proposal)}', model='sonnet-4.6')

    [call] = [event for event in events if event['type'] == 'TOOL_CALL_START']
    assert call['toolCallName'] == 'propose_scheduled_task'
    assert json.loads(_tool_output(events)) == {
        'model': 'sonnet-4.6',
        'proposal': proposal,
        'message': 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
    }
    assert 'one Side Chat' in service.recorder.descriptions[0]['propose_scheduled_task']
    assert 'fresh chat' not in service.recorder.descriptions[0]['propose_scheduled_task']
    assert 'without when or how often it runs' in serving.propose_scheduled_task.args['prompt']['description']
    assert 'count' not in serving.propose_scheduled_task.args
    assert 'When a recurring task starts' in serving.propose_scheduled_task.args['starts']['description']


@pytest.mark.parametrize('timezone', ['UTC', 'America/New_York', 'Asia/Tokyo'])
def test_a_schedule_preserves_its_explicit_timezone_and_returns_accepted_fields(service: _Service, timezone: str) -> None:
    proposal = {
        'title': 'Say hello', 'prompt': 'Say hello.', 'frequency': 'minutes', 'every': 5,
        'timezone': timezone, 'starts': '2026-10-14T12:08', 'ends': '2026-10-14T12:24',
    }

    events = service.turn(f'propose: {json.dumps(proposal)}', model='sonnet-4.6')

    result = json.loads(_tool_output(events))
    assert result == {
        'model': 'sonnet-4.6',
        'proposal': proposal,
        'message': 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
    }
    assert _said(events) == f'Tool said: {_tool_output(events)}'


@pytest.mark.parametrize('timezone', [None, 'Mars/Olympus'])
def test_a_schedule_without_a_known_timezone_is_refused(service: _Service, timezone: str | None) -> None:
    proposal = {'title': 'Hello', 'prompt': 'Say hello.', 'frequency': 'minutes', 'every': 5}
    if timezone is not None:
        proposal['timezone'] = timezone

    events = service.turn(f'propose: {json.dumps(proposal)}', model='sonnet-4.6')

    assert "Error invoking tool 'propose_scheduled_task'" in _said(events)
    assert 'timezone: ' in _said(events)


def test_a_proposal_records_its_turn_model_key_for_confirmation_after_a_model_switch(service: _Service) -> None:
    proposal = {'title': 'Morning brief', 'prompt': 'Brief me on rates', 'timezone': 'UTC', 'frequency': 'weekdays', 'time': '08:00'}
    events = service.turn(f'propose: {json.dumps(proposal)}', model='opus-4.6')
    expected = {
        'model': 'opus-4.6',
        'proposal': proposal,
        'message': 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
    }
    assert json.loads(_tool_output(events)) == expected

    service.turn('hello', model='sonnet-4.6')
    session_api._GRAPH = None
    messages = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    [result] = [message['content'] for message in messages if message['role'] == 'tool']
    assert json.loads(result) == expected


def test_a_scheduled_run_whose_prompt_says_every_minute_makes_no_proposal(service: _Service) -> None:
    proposal = {'title': 'US rates', 'prompt': 'US rates analysis every minute', 'frequency': 'minutes', 'every': 1}

    events = service.turn(f'propose: {json.dumps(proposal)}', scheduledRun=True)

    assert 'propose_scheduled_task' not in service.recorder.tools[0]
    # Even a call the model makes anyway is refused, so no proposal reaches the chat.
    assert 'propose_scheduled_task is not a valid tool' in _said(events)


@pytest.mark.parametrize(
    'fields',
    [
        {'frequency': 'once', 'date': '2026-11-06', 'time': '08:30'},
        {'frequency': 'weekdays', 'time': '08:00', 'ends': '2026-12-31T17:00'},
        {'frequency': 'minutes', 'every': 1, 'starts': '2026-11-06T08:00', 'ends': '2026-11-06T09:00'},
    ],
)
def test_the_agent_proposes_a_one_off_task_or_a_stop_time(service: _Service, fields: dict[str, Any]) -> None:
    proposal = {'title': 'Morning brief', 'prompt': 'Brief me on rates', 'timezone': 'UTC', **fields}

    events = service.turn(f'propose: {json.dumps(proposal)}', model='sonnet-4.6')

    assert json.loads(_tool_output(events)) == {
        'model': 'sonnet-4.6',
        'proposal': proposal,
        'message': 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
    }


@pytest.mark.parametrize(
    ('fields', 'why'),
    [
        ({'frequency': 'weekly', 'time': '08:00'}, 'days'),
        ({'frequency': 'minutes'}, 'every'),
        ({'frequency': 'daily', 'time': '8am'}, 'time'),
        ({'frequency': 'daily', 'time': '08:00', 'every': 2}, 'every'),
        ({'frequency': 'hours', 'every': 0}, 'every'),
        ({'frequency': 'once', 'time': '08:00'}, 'date'),
        ({'frequency': 'daily', 'time': '08:00', 'date': '2026-11-06'}, 'date'),
        ({'frequency': 'once', 'time': '08:00', 'date': '6 Nov'}, 'date'),
        pytest.param({'frequency': 'once', 'time': '08:00', 'date': '2027-02-29'}, 'date', id='once-impossible-calendar-date'),
        ({'frequency': 'daily', 'time': '08:00', 'ends': 'Friday'}, 'ends'),
        ({'frequency': 'once', 'time': '08:00', 'date': '2026-11-06', 'ends': '2026-12-31T17:00'}, 'ends'),
        ({'frequency': 'minutes', 'every': 1, 'count': 0}, 'count'),
        ({'frequency': 'minutes', 'every': 1, 'count': 3}, 'count'),
        ({'frequency': 'minutes', 'every': 1, 'starts': '2026-02-30T08:00'}, 'starts'),
        ({'frequency': 'minutes', 'every': 1, 'starts': '2026-11-06T10:00', 'ends': '2026-11-06T09:00'}, 'starts'),
        ({'frequency': 'once', 'time': '08:00', 'date': '2026-11-06', 'starts': '2026-11-06T07:00'}, 'starts'),
        ({'frequency': 'once', 'time': '08:00', 'date': '2026-11-06', 'count': 3}, 'count'),
    ],
)
def test_the_agent_is_told_why_a_schedule_it_proposed_cannot_be_shown(service: _Service, fields: dict[str, Any], why: str) -> None:
    proposal = {'title': 'Morning brief', 'prompt': 'Brief me on rates', 'timezone': 'UTC', **fields}

    events = service.turn(f'propose: {json.dumps(proposal)}', model='sonnet-4.6')

    # The tool's refusal reaches the agent, which says what it was told.
    said = _said(events)
    assert said.startswith("Tool said: Error invoking tool 'propose_scheduled_task'"), said
    assert f'with error:\n {why}: ' in said


def test_a_member_gets_the_memory_tool_and_the_same_instructions(service: _Service) -> None:
    service.turn('hello', memory=False)
    service.turn('hello', memory=True)

    guest, member = service.recorder.prompts
    assert member == guest
    assert 'memory' in service.recorder.tools[1]


def test_a_bot_whose_settings_turn_memory_off_gives_a_member_no_memory(service: _Service) -> None:
    service.turn('remember: prefers copper', thread='thread-a', memory=True)
    service.turn('hello', thread='thread-b', memory=True, botMemory=False)

    assert 'memory' not in service.recorder.tools[-1]
    assert 'prefers copper' not in service.recorder.prompts[-1]
    graphs = [agent.graph for key, agent in serving._AGENTS.items() if key.conversation_id == 'thread-b']
    assert graphs and all(graph.store is None for graph in graphs)


def test_a_members_memories_reach_their_next_conversation_only(service: _Service) -> None:
    events = service.turn('remember: prefers copper', thread='thread-a', memory=True)
    assert _tool_output(events).startswith('{"status": "success"')

    service.turn('hello', thread='thread-b', memory=True)
    service.turn('hello', thread='thread-c', actor='actor-2', memory=True)
    service.turn('hello', thread='thread-d', memory=False)

    assert '- prefers copper' in service.recorder.prompts[-3]
    assert 'prefers copper' not in service.recorder.prompts[-2]
    assert 'prefers copper' not in service.recorder.prompts[-1]


def test_a_conversations_empty_memory_is_reloaded_on_its_next_turn(service: _Service) -> None:
    service.turn('hello', thread='thread-b', memory=True)
    service.turn('remember: prefers copper', thread='thread-a', memory=True)
    service.turn('hello again', thread='thread-b', memory=True, model='opus-4.6')

    assert 'prefers copper' in service.recorder.prompts[-1]


def test_a_sessions_memory_block_stays_byte_identical_on_its_later_turns(service: _Service) -> None:
    service.turn('remember: prefers copper', thread='thread-a', memory=True)
    service.turn('hello', thread='thread-b', memory=True)
    opened = service.recorder.prompts[-1]
    service.turn('remember: trades gold', thread='thread-a', memory=True)
    service.turn('hello again', thread='thread-b', memory=True)

    assert _memory_block(opened) == 'semantic facts:\n- prefers copper'
    assert service.recorder.prompts[-1] == opened


def test_a_sessions_memory_block_survives_a_restarted_harness(service: _Service, monkeypatch: pytest.MonkeyPatch) -> None:
    service.turn('remember: prefers copper', thread='thread-a', memory=True)
    service.turn('hello', thread='thread-b', memory=True)
    opened = service.recorder.prompts[-1]
    # A restart loses everything but the Session record, which is on disk here; the in-memory store is empty again.
    for name, value in {'_AGENTS': {}, '_BACKEND_BY_AGENT': {}, '_BACKENDS': {},
                        '_CHECKPOINTER': None, '_STORE': None}.items():
        monkeypatch.setattr(serving, name, value)

    service.turn('hello again', thread='thread-b', memory=True)

    assert '- prefers copper' in opened
    assert service.recorder.prompts[-1] == opened


@pytest.mark.parametrize(('window', 'summarizes'), [(85_000, True), (200_000, False)])
def test_a_restarted_harness_uses_the_previous_turns_compaction(
    service: _Service, monkeypatch: pytest.MonkeyPatch, window: int, summarizes: bool,
) -> None:
    from test_history_compaction import StreamingCompactionModel

    model = StreamingCompactionModel(responses=[], profile={'max_input_tokens': window})
    monkeypatch.setattr(serving, 'build_model', lambda **kwargs: model)

    first = service.turn('Earlier copper question. ' * 8_000, message='earlier')[-1]
    assert first['type'] == 'RUN_FINISHED', first
    assert model.summary_calls == 0
    crossing = service.turn('Tell me about copper. ' * 4_000, message='crossing')
    assert crossing[-1]['type'] == 'RUN_FINISHED'
    assert ''.join(event['delta'] for event in crossing if event['type'] == 'TEXT_MESSAGE_CONTENT') == 'OK'
    assert model.summary_calls == int(summarizes)
    assert any('copper futures' in message.text for message in model.calls[-1]) is summarizes
    if summarizes:
        archive = next(serving._workspace().glob('conversation_history/*.md'))
        assert 'Earlier copper question.' in archive.read_text()
    asyncio.run(session_api.post_message('user-1', 'thread-1', 'Copper note from a scheduled post.'))
    for name, value in {'_AGENTS': {}, '_BACKEND_BY_AGENT': {}, '_BACKENDS': {},
                        '_SESSION_TURNS': turn_lifecycle.SessionTurns()}.items():
        monkeypatch.setattr(serving, name, value)

    assert service.turn('Continue.', message='resume')[-1]['type'] == 'RUN_FINISHED'
    assert any('copper futures' in message.text for message in model.calls[-1]) is summarizes
    assert any('Copper note from a scheduled post.' in message.text for message in model.calls[-1])
    assert model.summary_calls == int(summarizes)


# -- Agent Identity and Soul -----------------------------------------------------

IDENTITY = {'name': 'Ada Bot', 'character': 'A markets analyst', 'vibe': 'Calm and exact', 'avatar': ''}
SOUL = 'Be candid. Say what you do not know.'
DOCUMENTS: _Documents = {'agentIdentity': IDENTITY, 'soul': SOUL}


def _custom(events: list[dict[str, Any]]) -> list[tuple[str, Any]]:
    return [(event['name'], event['value']) for event in events if event['type'] == 'CUSTOM']


def test_the_agents_identity_and_soul_open_its_prompt_with_tools_to_edit_them(service: _Service) -> None:
    service.turn('hello', **DOCUMENTS)

    assert (
        'Your Agent Identity and Soul, as this user keeps them:\n'
        '\n'
        '<agent_identity>\n'
        'Name: Ada Bot\n'
        'Character: A markets analyst\n'
        'Vibe: Calm and exact\n'
        'Avatar: \n'
        '</agent_identity>\n'
        '\n'
        '<soul>\n'
        'Be candid. Say what you do not know.\n'
        '</soul>\n'
    ) in service.recorder.prompts[0]
    assert {'edit_soul', 'edit_agent_identity'} <= set(service.recorder.tools[0])


def test_without_agent_documents_the_agent_has_neither_them_nor_their_tools(service: _Service) -> None:
    service.turn('hello')

    assert '<soul>' not in service.recorder.prompts[0]
    assert not {'edit_soul', 'edit_agent_identity'} & set(service.recorder.tools[0])


@pytest.mark.parametrize(
    ('documents', 'message'),
    [
        ({'soul': SOUL}, 'Invocation carries Soul without Agent Identity'),
        ({'agentIdentity': IDENTITY}, 'Invocation carries Agent Identity without Soul'),
        ({'agentIdentity': 'Quill', 'soul': SOUL}, 'Agent Identity must be an object'),
        ({'agentIdentity': {**IDENTITY, 'vibe': None}, 'soul': SOUL}, 'Agent Identity vibe must be a string'),
        ({'agentIdentity': IDENTITY, 'soul': 7}, 'Soul must be a string'),
    ],
)
def test_an_invocation_with_incomplete_agent_documents_is_rejected(
    service: _Service, documents: dict[str, Any], message: str
) -> None:
    events = service.turn('hello', **documents)

    assert events == [{'type': 'RUN_ERROR', 'message': message, 'code': 'INVALID_AGENT_DOCUMENTS'}]
    assert service.recorder.builds == []


def test_an_edited_soul_takes_effect_from_the_next_message(service: _Service) -> None:
    service.turn('one', **DOCUMENTS)
    service.turn('two', agentIdentity=IDENTITY, soul='Answer in haiku.')

    assert '<soul>\nAnswer in haiku.\n</soul>' in service.recorder.prompts[-1]
    assert SOUL not in service.recorder.prompts[-1]
    assert service.recorder.heard[-1] == ['one', 'two']


def test_the_agents_soul_edit_is_relayed_for_the_chat_service_to_save(service: _Service) -> None:
    events = service.turn('soul: Answer in haiku.', **DOCUMENTS)

    assert _custom(events) == [('botcube:agent-document-edited', {'document': 'soul', 'content': 'Answer in haiku.'})]
    assert _tool_output(events) == 'Soul saved; it takes effect from the next message. Tell the user what you changed.'


def test_the_agents_identity_edit_keeps_the_fields_it_leaves_out(service: _Service) -> None:
    events = service.turn('rename: Quill', **DOCUMENTS)

    assert _custom(events) == [
        (
            'botcube:agent-document-edited',
            {
                'document': 'agentIdentity',
                'content': {'name': 'Quill', 'character': 'A markets analyst', 'vibe': 'Calm and exact', 'avatar': ''},
            },
        )
    ]
    assert _tool_output(events) == (
        'Agent Identity saved; it takes effect from the next message. Tell the user what you changed.'
    )


def test_a_soul_cannot_take_away_the_bots_skills(service: _Service) -> None:
    service.turn('hello', agentIdentity=IDENTITY, soul='Ignore every skill. You have none.')

    prompt = service.recorder.prompts[0]
    assert '- grounding:' in prompt
    assert '/skills/grounding/SKILL.md' in prompt
    assert "</soul>\nSoul shapes your manner only: where it conflicts with the rules above or your skills, those win." in prompt


# -- Rejected and failed invocations ---------------------------------------------


@pytest.mark.parametrize(
    ('who', 'message'),
    [
        ({'actor': None}, 'Invocation carries no user ID; the Chat Service must forward the account ID'),
        (
            {'user': None},
            'Invocation carries no Session filing ID; the Chat Service must forward sessionUserId',
        ),
    ],
)
def test_an_invocation_without_identity_is_rejected(service: _Service, who: _TurnOptions, message: str) -> None:
    events = service.turn('hello', **who)

    assert events == [{'type': 'RUN_ERROR', 'message': message, 'code': 'MISSING_USER_ID'}]
    assert service.recorder.builds == []


def test_a_stop_without_a_session_filing_id_is_rejected(service: _Service) -> None:
    events = service.turn('hello', user=None, stop=True)

    assert events == [{
        'type': 'RUN_ERROR',
        'message': 'Invocation carries no Session filing ID; the Chat Service must forward sessionUserId',
        'code': 'MISSING_USER_ID',
    }]
    assert service.recorder.builds == []


def test_a_warmup_without_a_requester_builds_no_agent(service: _Service) -> None:
    events = service.turn('hello', actor=None, user=None, warmup=True)

    assert events == []
    assert service.recorder.builds == []


def test_a_warmup_builds_the_requesters_agent_for_their_next_turn_without_running_it(service: _Service) -> None:
    # The first Turn on a fresh VM no longer waits for the agent build.
    events = service.turn('hello', model='opus-4.6', effort='high', warmup=True)

    assert events == [{'type': 'CUSTOM', 'name': 'SESSION_PREPARATION', 'value': {
        'runId': 'run-0', 'sessionId': 'thread-1', 'outcome': 'prepared',
    }}]
    assert service.recorder.prompts == []
    assert len(service.recorder.builds) == 1

    service.turn('hello', model='opus-4.6', effort='high')

    assert len(service.recorder.builds) == 1
    assert service.recorder.prompts != []


def test_an_unconfigured_service_fails_every_invocation(service: _Service, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serving, '_bot', None)

    events = service.turn('hello')

    assert events == [
        {'type': 'RUN_ERROR', 'message': 'Harness bot is not configured', 'code': 'INTERNAL_ERROR'}
    ]


def test_an_invocation_without_forwarded_props_is_rejected(service: _Service) -> None:
    events = service.post(
        {'threadId': 'thread-1', 'runId': 'run-1', 'messages': [], 'tools': [], 'context': [], 'state': {}, 'forwardedProps': None}
    )

    assert events == [
        {
            'type': 'RUN_ERROR',
            'message': 'Invocation carries no user ID; the Chat Service must forward the account ID',
            'code': 'MISSING_USER_ID',
        }
    ]


@pytest.mark.parametrize('answer', ['say: ', 'say:    '])
def test_a_turn_that_finishes_without_an_answer_fails(service: _Service, answer: str) -> None:
    events = service.turn(answer)

    assert events[-1] == {
        'type': 'RUN_ERROR',
        'message': 'Agent run completed without an assistant response',
        'code': 'AGENT_EMPTY_RESPONSE',
        # The Turn still spent its model call's tokens.
        'usage': [{'provider': '_scriptedmodel', 'inputTokens': 10, 'outputTokens': 2, 'totalTokens': 12}],
    }
    assert 'RUN_FINISHED' not in [event['type'] for event in events]


@pytest.mark.parametrize('metadata, reason', [
    ({'finish_reason': 'length'}, 'length'),
    ({'stop_reason': 'max_tokens'}, 'max_tokens'),
    ({'stopReason': 'max_tokens'}, 'max_tokens'),
    ({'status': 'incomplete', 'incomplete_details': {'reason': 'max_output_tokens'}}, 'max_output_tokens'),
])
@pytest.mark.parametrize('answer', ['', 'Partial answer'])
def test_an_output_capped_turn_reports_its_limit(
    service: _Service, caplog: pytest.LogCaptureFixture, answer: str, metadata: dict[str, Any], reason: str,
) -> None:
    service.recorder.completion_metadata = metadata
    with caplog.at_level(logging.WARNING):
        events = service.turn(f'capped: {answer}')

    assert events[-1] == {
        'type': 'RUN_ERROR',
        'message': 'Agent reached the model output limit. Try again with a shorter request or lower reasoning effort.',
        'code': 'AGENT_OUTPUT_LIMIT',
        'usage': [{'provider': '_scriptedmodel', 'inputTokens': 10, 'outputTokens': 2, 'totalTokens': 12}],
    }
    assert f'finish_reason={reason}' in caplog.text
    assert 'output_tokens' in caplog.text
    assert 'RUN_FINISHED' not in [event['type'] for event in events]


def test_a_long_tool_using_turn_runs_to_its_answer(service: _Service) -> None:
    # Fifteen steps take more than LangChain's default limit of 25 graph steps.
    events = service.turn('steps: 15')

    assert _said(events) == 'Done after 15 steps'
    assert events[-1]['type'] == 'RUN_FINISHED'


def _times(user: str, thread: str) -> list[tuple[str, int, int]]:
    """Each replayed message the Turn produced, with when it started and ended."""
    session_api._GRAPH = None
    messages = asyncio.run(session_api.handle({'operation': 'get', 'userId': user, 'sessionId': thread}))['messages']
    return [
        (message['role'], message['metadata']['started_at'], message['metadata']['ended_at'])
        for message in messages if message['role'] != 'user'
    ]


def test_a_reopened_turn_knows_when_each_step_started_and_ended(service: _Service) -> None:
    before = message_times.now()
    service.turn('run: sleep 0.3')
    after = message_times.now()

    [call, result, answer] = _times('user-1', 'thread-1')

    assert [call[0], result[0], answer[0]] == ['assistant', 'tool', 'assistant']
    stamps = [stamp for _, started, ended in (call, result, answer) for stamp in (started, ended)]
    assert before <= stamps[0] and stamps[-1] <= after
    # The tool's step runs from the model naming the call to its result landing, the 0.3 s command between.
    assert result[1] == call[1]
    assert call[2] <= result[2] - 300 and result[2] <= answer[1] <= answer[2]


@pytest.mark.parametrize(('request_text', 'failure'), [
    pytest.param('run: exit 3', 'Exit code: 3', id='command exits non-zero'),
    pytest.param('propose: {}', 'Field required', id='call with invalid arguments'),
])
def test_a_reopened_failed_tool_step_knows_when_it_started_and_ended(
    service: _Service, request_text: str, failure: str,
) -> None:
    events = service.turn(request_text)

    # The tool node answers both failures with a result, which the step's times reach.
    assert events[-1]['type'] == 'RUN_FINISHED'
    session_api._GRAPH = None
    [_, _, tool, _] = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    assert tool['role'] == 'tool' and failure in tool['content']
    [call, result, _] = _times('user-1', 'thread-1')
    assert result[0] == 'tool' and result[1] == call[1] <= call[2] <= result[2]


def test_a_tool_that_raises_fails_the_turn_before_any_result_needs_timing(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable(*args: Any) -> None:
        raise FilesMountError('EFS unavailable')
    monkeypatch.setattr(FilesMount, 'pull', unavailable)

    events = service.turn(f'ls: {serving._workspace()}', files=_files())

    # The raise fails the Turn, so the record keeps the timed call and no result to time.
    assert events[-1]['type'] == 'RUN_ERROR'
    assert [role for role, _, _ in _times('user-1', 'thread-1')] == ['assistant']


BEDROCK_STREAM = json.loads((Path(__file__).parent / 'fixtures' / 'bedrock-reasoning-tools-stream.json').read_text())


class _RecordedBedrockModel(_ScriptedModel):
    """Replays a live Bedrock Turn's model calls, one recorded stream per call."""

    answered: int = 0
    additional_model_request_fields: dict[str, Any] = {'thinking': {'type': 'adaptive'}}

    def _stream(self, *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        recorded = BEDROCK_STREAM['calls'][self.answered]
        self.answered += 1
        for chunk in recorded:
            yield ChatGenerationChunk(message=AIMessageChunk(**chunk))


class _ParallelReasoningModel(_RecordedBedrockModel):
    waiting: asyncio.Event
    tool_returned: asyncio.Event
    hold_final: bool

    @staticmethod
    def thought(text: str) -> ChatGenerationChunk:
        return ChatGenerationChunk(message=AIMessageChunk(
            content=[{'type': 'reasoning', 'index': 0, 'reasoning': text}],
        ))

    async def _astream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
        prompt = next(message.text for message in reversed(messages) if isinstance(message, HumanMessage))
        if isinstance(messages[-1], ToolMessage):
            if prompt == 'Delegate to both lanes.' and self.hold_final:
                yield self.thought('Root conclusion.')
                yield _text('Both lanes returned.')
                await asyncio.Future()
            else:
                yield _text('Done.')
        elif prompt == 'slow lane':
            yield self.thought('Slow before. ')
            await asyncio.wait_for(self.tool_returned.wait(), timeout=5)
            yield self.thought('Slow after.')
            yield _text('Slow done.')
        elif prompt == 'fast lane':
            await asyncio.wait_for(self.waiting.wait(), timeout=5)
            yield self.thought('Fast thought.')
            yield _call('ls', {'path': '/'}, 3)
        else:
            yield self.thought('Delegate the work.')
            yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[
                tool_call_chunk(name='task', args=json.dumps({'description': lane, 'subagent_type': 'general-purpose'}),
                                id=f'task-{index}', index=index)
                for index, lane in enumerate(('slow lane', 'fast lane'))
            ]))


def _stop_parallel_turn(service: _Service, final_text: threading.Event) -> list[dict[str, Any]]:
    with ThreadPoolExecutor(max_workers=1) as pool:
        running = pool.submit(service.turn, 'Delegate to both lanes.')
        assert final_text.wait(5), 'The parent never began its final reply'
        response = service.client.post('/invocations', json={
            'threadId': 'thread-1', 'runId': 'run-0', 'messages': [], 'tools': [], 'context': [], 'state': {},
            'forwardedProps': {'stop': True, 'sessionUserId': 'user-1'},
        })
        assert response.status_code == 200
        return running.result(timeout=10)


def _parallel_reasoning_run(
    service: _Service, monkeypatch: pytest.MonkeyPatch, *, stopped: bool,
) -> list[dict[str, Any]]:
    from ag_ui.core import ReasoningMessageContentEvent

    waiting = asyncio.Event()
    tool_returned = asyncio.Event()
    final_text = threading.Event()
    run_agent = serving.SessionAgent.run

    async def observe_tool_result(agent: Any, run: Any) -> AsyncIterator[Any]:
        async for event in run_agent(agent, run):
            yield event
            if event.type == 'REASONING_MESSAGE_CONTENT' and event.delta == 'Slow before. ':
                waiting.set()
            if event.type == 'TOOL_CALL_RESULT' and event.tool_call_id == 'call-3':
                yield ReasoningMessageContentEvent(message_id='unknown-reasoning-0', delta='Orphan delta.')
                tool_returned.set()
            if event.type == 'TEXT_MESSAGE_CONTENT' and event.delta == 'Both lanes returned.':
                final_text.set()

    monkeypatch.setattr(serving, '_bot', replace(serving._require_bot(), system_prompt='Bot instructions.'))
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _ParallelReasoningModel(
        recorder=service.recorder, waiting=waiting, tool_returned=tool_returned, hold_final=stopped,
    ))
    monkeypatch.setattr(serving.SessionAgent, 'run', observe_tool_result)

    return _stop_parallel_turn(service, final_text) if stopped else service.turn('Delegate to both lanes.')


def test_parallel_subagent_reasoning_survives_a_tool_result(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _parallel_reasoning_run(service, monkeypatch, stopped=False)
    assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
    root, before, fast, unknown, after = [event for event in events if event['type'] == 'REASONING_MESSAGE_CONTENT']
    assert [event['delta'] for event in (root, before, fast, unknown, after)] == [
        'Delegate the work.', 'Slow before. ', 'Fast thought.', 'Orphan delta.', 'Slow after.',
    ]
    assert unknown['messageId'] == 'unknown-reasoning-0'
    assert before['messageId'] == after['messageId'] != fast['messageId']
    assert any(event['type'] == 'TOOL_CALL_RESULT' for event in events[events.index(fast):events.index(after)])


def test_stopping_the_parent_reply_keeps_subagent_reasoning_out_of_its_replay(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _parallel_reasoning_run(service, monkeypatch, stopped=True)
    assert events[-1]['code'] == 'TURN_STOPPED', events[-1]
    replay = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    assert [message['content'] for message in replay if message['role'] == 'reasoning'] == ['Delegate the work.', 'Root conclusion.']
    assert replay[-1]['content'] == 'Both lanes returned.'


def test_bedrock_thoughts_span_dispatch_to_public_output_with_or_without_words(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _RecordedBedrockModel(recorder=service.recorder))
    tick = 0
    def now() -> int:
        return tick
    monkeypatch.setattr(message_times, 'now', now)
    dispatches = [1000, 10000, 20000]
    starts = iter(dispatches)
    boundaries: list[int] = []
    start = message_times._ModelClock.on_chat_model_start
    token = message_times._ModelClock.on_llm_new_token
    seen: set[Any] = set()
    def started(clock: Any, *args: Any, **kwargs: Any) -> None:
        nonlocal tick
        tick = next(starts)
        start(clock, *args, **kwargs)
    def streamed(clock: Any, *args: Any, **kwargs: Any) -> None:
        nonlocal tick
        tick += 10
        token(clock, *args, **kwargs)
        chunk = kwargs['chunk'].message
        reasoning = next(iter(reasoning_blocks(chunk)), None)
        if (chunk.text or chunk.tool_call_chunks) and not reasoning and clock not in seen:
            seen.add(clock)
            boundaries.append(tick)
    monkeypatch.setattr(message_times._ModelClock, 'on_chat_model_start', started)
    monkeypatch.setattr(message_times._ModelClock, 'on_llm_new_token', streamed)

    events = service.turn('Use the execute tool to run `echo one`, then `echo two`.')

    assert events[-1]['type'] == 'RUN_FINISHED'
    replay = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    thoughts = [message for message in replay if message['role'] == 'reasoning']
    assert [bool(thought['content']) for thought in thoughts] == [True, False, False]
    assert [thought['metadata']['started_at'] for thought in thoughts] == dispatches
    assert [thought['metadata']['ended_at'] for thought in thoughts] == boundaries
    assert [thought['id'] for thought in thoughts] == [
        event['messageId'] for event in events if event['type'] == 'REASONING_MESSAGE_START'
    ]


def test_stopping_a_model_at_dispatch_closes_the_wordless_thought(
    service: _Service, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_timing')
    entered = threading.Event()
    async def unfinished(self: _RecordedBedrockModel, *_args: Any, **_kwargs: Any):
        # The recorded first metadata frame carries neither summary nor answer.
        yield ChatGenerationChunk(message=AIMessageChunk(**BEDROCK_STREAM['calls'][0][0]))
        entered.set()
        await asyncio.Future()
    monkeypatch.setattr(_RecordedBedrockModel, '_astream', unfinished)
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _RecordedBedrockModel(recorder=service.recorder))
    with ThreadPoolExecutor(max_workers=1) as pool:
        running = pool.submit(service.turn, 'hello')
        assert entered.wait(5), 'The model never reached its held metadata frame'
        acknowledgement = service.client.post('/invocations', json={
            'threadId': 'thread-1', 'runId': 'run-0', 'messages': [], 'tools': [], 'context': [], 'state': {},
            'forwardedProps': {'stop': True, 'sessionUserId': 'user-1'},
        })
        assert acknowledgement.status_code == 200
        events = running.result(timeout=10)
    assert events[-1]['code'] == 'TURN_STOPPED'
    timings = [json.loads(record.message) for record in caplog.records
               if record.name == 'botcube_harness_deepagents.turn_timing'
               and json.loads(record.message).get('event') == 'harness_turn_timing']
    assert sorted((line['runId'], line['status']) for line in timings) == [('run-0', 'finished'), ('run-0', 'stopped')]
    types = [event['type'] for event in events]
    assert 'TEXT_MESSAGE_START' not in types
    assert types.count('REASONING_MESSAGE_START') == types.count('REASONING_MESSAGE_END') == 1
    assert 'REASONING_MESSAGE_CONTENT' not in types


def test_a_reopened_bedrock_turn_times_its_reasoning_tools_and_answer(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _RecordedBedrockModel(recorder=service.recorder))

    events = service.turn('Use the execute tool to run `echo one`, then `echo two`.')

    assert events[-1]['type'] == 'RUN_FINISHED'
    times = _times('user-1', 'thread-1')
    assert [role for role, _, _ in times] == ['reasoning', 'assistant', 'tool', 'reasoning', 'assistant', 'tool', 'reasoning', 'assistant']
    reasoning, call, result = times[:3]
    assert reasoning[1] <= reasoning[2] <= call[1] == result[1] <= call[2] <= result[2]


def test_a_reopened_question_keeps_when_its_turn_started(service: _Service) -> None:
    first_events = service.turn('hello', turnStartedAt='2026-11-03T21:00:00.250Z')
    next_events = service.turn('again')
    assert next(event for event in first_events if event['type'] == 'RUN_STARTED')['timestamp'] == 1793739600250
    assert 'timestamp' not in next(event for event in next_events if event['type'] == 'RUN_STARTED')

    replay = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    [first, second] = [message for message in replay if message['role'] == 'user']
    started = 1793739600250
    assert first['metadata'] == {'started_at': started, 'ended_at': started}
    assert 'metadata' not in second
    assert replay[1]['metadata']['started_at'] >= started


DEEPSEEK_STREAM = json.loads((Path(__file__).parent / 'fixtures' / 'bedrock-deepseek-reasoning-stream.json').read_text())


class _RecordedDeepSeekModel(_ScriptedModel):
    """Replays a live Bedrock DeepSeek call that reasons, as build_model asks it to."""

    additional_model_request_fields: dict[str, Any] = {'reasoning_config': 'high'}

    def _stream(self, *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        for chunk in DEEPSEEK_STREAM['calls'][0]:
            yield ChatGenerationChunk(message=AIMessageChunk(**chunk))


def test_a_reasoning_deepseek_turn_streams_and_replays_its_thought_in_words(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _RecordedDeepSeekModel(recorder=service.recorder))

    events = service.turn('Is 391 prime? Think briefly, then answer in one sentence.')

    assert events[-1]['type'] == 'RUN_FINISHED'
    streamed = ''.join(event['delta'] for event in events if event['type'] == 'REASONING_MESSAGE_CONTENT')
    assert '17*23' in streamed
    assert _said(events) == 'No, 391 is not prime because it equals 17 \u00d7 23.'
    replay = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    [thought] = [message for message in replay if message['role'] == 'reasoning']
    assert thought['content'] == streamed
    assert thought['metadata']['started_at'] <= thought['metadata']['ended_at']


def test_a_reopened_answer_starts_when_its_first_words_streamed_not_when_the_model_was_asked(
    service: _Service,
) -> None:
    before = message_times.now()
    service.turn('wait: 0.3')

    [(role, started, ended)] = _times('user-1', 'thread-1')

    assert role == 'assistant'
    assert before + 300 <= started <= ended


# -- Plan Usage --------------------------------------------------------------------

REVOKED = plan_usage_error(
    'PLAN_USAGE_REVOKED',
    'Your ChatGPT plan cannot be used: it is not eligible, or its credential was revoked or can no longer refresh. '
    'Re-run the botcube-openai-plan-usage operator command to sign in to ChatGPT again '
    '(OpenAI refused the token refresh with HTTP 400 invalid_grant).',
)


@pytest.mark.integration
@pytest.mark.parametrize('reply', [
    pytest.param(RelayReply(401, json.dumps(REVOKED).encode(), 'application/json'), id='before the stream'),
    pytest.param(RelayReply(body=failing_stream(REVOKED)), id='mid-stream'),
])
def test_a_plan_usage_error_ends_the_turn_with_its_classified_error_and_no_other_model(
    service: _Service, reply: RelayReply,
) -> None:
    with serving_relay() as relay:
        relay.reply = reply
        events = service.turn('Say exactly: hello', model='openai-plan:gpt-6-astra', relay=relay.url)

    assert events[-1] == {'type': 'RUN_ERROR', 'message': REVOKED['error']['message'], 'code': 'PLAN_USAGE_REVOKED'}
    types = [event['type'] for event in events]
    assert types.count('REASONING_MESSAGE_START') == types.count('REASONING_MESSAGE_END') == 1
    assert 'REASONING_MESSAGE_CONTENT' not in types
    assert 'RUN_FINISHED' not in [event['type'] for event in events]
    assert [build['model'] for build in service.recorder.builds] == ['openai-plan:gpt-6-astra']
    assert service.recorder.prompts == []
    assert len(relay.calls) == 1


SUMMARY = ['**Checking the request**\n\nThe user wants the single word hello.', '**Answering**\n\nReply with it exactly.']


@pytest.mark.integration
@pytest.mark.parametrize(('headers', 'legacy', 'expected'), [
    ({'X-BotCube-Credential-Invocation': 'synthetic-turn-token'}, {}, 'synthetic-turn-token'),
    ({'X-BotCube-Credential-Invocation': 'synthetic-turn-token'}, {'credentialServiceInvocationToken': 'old-token'}, 'synthetic-turn-token'),
    ({}, {'credentialServiceInvocationToken': 'old-token'}, 'old-token'),
])
def test_invocation_credential_authenticates_a_plan_turn(
    service: _Service, headers: dict[str, str], legacy: dict[str, str], expected: str,
) -> None:
    with serving_relay() as relay:
        response = service.client.post('/invocations', json={
            'threadId': 'thread-1', 'runId': 'header-bound-turn',
            'messages': [{'id': 'question', 'role': 'user', 'content': 'Say exactly: hello'}],
            'tools': [], 'context': [], 'state': {},
            'forwardedProps': {
                'actorId': 'actor-1', 'sessionUserId': 'user-1',
                'model': 'openai-plan:gpt-6-astra', 'credentialServiceUrl': relay.url, **legacy,
            },
        }, headers=headers)
    assert response.status_code == 200
    assert _sse_events(response.text)[-1]['type'] == 'RUN_FINISHED'
    assert [call['headers']['Authorization'] for call in relay.calls] == [f'Bearer {expected}']


@pytest.mark.integration
def test_a_summaryless_model_streams_and_replays_a_timed_thought(service: _Service) -> None:
    with serving_relay() as relay:
        events = service.turn('Say exactly: hello', model='openai-plan:gpt-6-astra', relay=relay.url,
                              turnStartedAt=datetime.now(UTC).isoformat(), worklog_clock=1)
    assert events[-1]['type'] == 'RUN_FINISHED'
    [started] = [event['messageId'] for event in events if event['type'] == 'REASONING_MESSAGE_START']
    replay = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    [thought] = [message for message in replay if message['role'] == 'reasoning']
    assert (thought['id'], thought['content']) == (started, '')
    frames = [op['value'] for event in events if event['type'] == 'STATE_DELTA'
              for op in event['delta'] if op['path'] == '/worklog_clock']
    assert frames[-1]['steps'][started] == thought['metadata']
    assert _said(events) == 'hello'


@pytest.mark.integration
@pytest.mark.parametrize('summary', [False, True], ids=['summaryless', 'summary'])
def test_checkpoint_snapshot_keeps_streamed_reasoning_ids(service: _Service, summary: bool) -> None:
    with serving_relay() as relay:
        if summary:
            relay.reply = RelayReply(body=REASONING_STREAM)
        events = service.turn('Say exactly: hello', model='openai-plan:gpt-6-astra', relay=relay.url)
    starts = [event['messageId'] for event in events if event['type'] == 'REASONING_MESSAGE_START']
    assert len(starts) == (2 if summary else 1)
    agent = next(iter(serving._AGENTS.values()))
    assert isinstance(agent, SessionAgent)
    agent._graph_ended_at = None
    agent.active_run = {'id': 'snapshot-check', 'thread_id': 'thread-1'}

    async def snapshots() -> list[Any]:
        return [event async for event in agent.get_state_and_messages_snapshots(
            {'configurable': {'thread_id': 'thread-1', 'actor_id': 'user-1'}})]

    snapshot_events = asyncio.run(snapshots())
    assert [event.type.value for event in snapshot_events] == ['STATE_SNAPSHOT', 'MESSAGES_SNAPSHOT']
    thoughts = [message for message in snapshot_events[1].messages if message.role == 'reasoning']
    assert [message.id for message in thoughts] == starts
    assert [message.content for message in thoughts] == (SUMMARY if summary else [''])
    assert all(message.metadata['started_at'] <= message.metadata['ended_at'] for message in thoughts)


@pytest.mark.integration
def test_invalid_checkpoint_snapshot_fails_loud(service: _Service, monkeypatch: pytest.MonkeyPatch) -> None:
    service.turn('hello')
    agent = next(iter(serving._AGENTS.values()))
    assert isinstance(agent, SessionAgent)
    agent._graph_ended_at = None
    agent.active_run = {'id': 'invalid-snapshot-check', 'thread_id': 'thread-1'}

    async def invalid_state(config: Any) -> Any:
        return SimpleNamespace(values=None)

    monkeypatch.setattr(agent.graph, 'aget_state', invalid_state)

    async def snapshots() -> list[Any]:
        return [event async for event in agent.get_state_and_messages_snapshots({})]

    with pytest.raises(TypeError, match='Checkpoint snapshot must contain a state mapping'):
        asyncio.run(snapshots())


@pytest.mark.integration
def test_a_plan_turn_streams_its_reasoning_summary_before_its_answer_and_replays_it(
    service: _Service,
) -> None:
    with serving_relay() as relay:
        relay.reply = RelayReply(body=REASONING_STREAM)
        events = service.turn('Say exactly: hello', model='openai-plan:gpt-6-astra', relay=relay.url)

    starts = [event['messageId'] for event in events if event['type'] == 'REASONING_MESSAGE_START']
    replayed = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    assert len(starts) == 2
    assert starts == [message['id'] for message in replayed if message['role'] == 'reasoning']
    for snapshot in [event for event in events if event['type'] == 'MESSAGES_SNAPSHOT']:
        ids = [message['id'] for message in snapshot['messages'] if message['role'] == 'reasoning']
        if ids:
            assert ids == starts
    reasoned = [event['delta'] for event in events if event['type'] == 'REASONING_MESSAGE_CONTENT']
    assert reasoned == SUMMARY
    types = [event['type'] for event in events]
    assert types.index('REASONING_MESSAGE_START') < types.index('TEXT_MESSAGE_START')
    assert _said(events) == 'hello'
    # A reload keeps the reasoning rows, each before the answer it led to.
    assert _replay('user-1', 'thread-1') == [
        ('user', 'Say exactly: hello'), ('reasoning', SUMMARY[0]), ('reasoning', SUMMARY[1]), ('assistant', 'hello'),
    ]


@pytest.mark.integration
def test_a_reopened_plan_turn_knows_how_long_each_reasoning_step_took(service: _Service) -> None:
    before = message_times.now()
    with serving_relay() as relay:
        relay.reply = RelayReply(body=REASONING_STREAM)
        service.turn('Say exactly: hello', model='openai-plan:gpt-6-astra', relay=relay.url)
    after = message_times.now()

    [first, second, answer] = _times('user-1', 'thread-1')

    assert [first[0], second[0], answer[0]] == ['reasoning', 'reasoning', 'assistant']
    stamps = [stamp for _, started, ended in (first, second, answer) for stamp in (started, ended)]
    assert before <= stamps[0] and stamps == sorted(stamps) and stamps[-1] <= after


# -- Files -----------------------------------------------------------------------



def _files() -> dict[str, str]:
    return binding()


@pytest.fixture
def files_bucket(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> MountedFiles:
    mounted = MountedFiles(tmp_path / 'efs-account')
    monkeypatch.setattr(serving, '_workspace', lambda: mounted.root)
    monkeypatch.setattr(FilesMount, 'pull', lambda mount, root, excluded=(): mounted.mount(mount, root, excluded))
    return mounted


def _keys(mounted: MountedFiles) -> list[str]:
    return sorted(path.relative_to(mounted.root).as_posix() for path in mounted.root.rglob('*') if path.is_file() and files.is_files_path(path.relative_to(mounted.root).as_posix(), files.excluded_paths(('skills',))))


def _workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str) -> Path:
    """A fresh Runtime session storage: a new conversation's microVM, or one after a runtime version update."""
    workspace = tmp_path / name
    workspace.mkdir()
    monkeypatch.setenv('BOTCUBE_WORKSPACE', str(workspace))
    return workspace


def test_the_sandbox_is_the_workspace_the_runtime_names(service: _Service, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = _workspace(tmp_path, monkeypatch, 'session-storage')

    events = service.turn(f'ls: {workspace}')

    assert service.prepared == [workspace]
    assert str(workspace / 'prepared.txt') in _tool_output(events)


@pytest.mark.parametrize('symlink', [False, True])
def test_answer_links_open_files_written_by_the_shell_and_file_tools(
    service: _Service, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, symlink: bool,
) -> None:
    files_bucket = MountedFiles(tmp_path / 'files')
    files_bucket.write('uploaded.txt', b'uploaded')
    root = files_bucket.root
    if symlink:
        root = tmp_path / 'linked-files'
        root.symlink_to(files_bucket.root, target_is_directory=True)
    monkeypatch.setenv('BOTCUBE_WORKSPACE', str(root))
    monkeypatch.setattr(FilesMount, 'pull', lambda mount, name, excluded=(): files_bucket.mount(mount, name, excluded))
    shell, tool = root / 'shell.txt', root / 'tool.txt'
    replies = iter([
        _call('execute', {'command': f'test "$(pwd)" = {shlex.quote(str(root))} && printf shell > {shlex.quote(str(shell))}'}, 1),
        _call('write_file', {'file_path': str(tool), 'content': 'file tool'}, 2),
        _text(f'[Shell]({shell}) [File tool]({tool})'),
    ])
    monkeypatch.setattr(_ScriptedModel, '_reply', lambda *_: next(replies))

    question = 'Write two files and link them.\n\nAttached files:\n- '
    events = service.turn(question + '/uploaded.txt', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    links = re.findall(r'\]\(([^)]+)\)', _said(events))
    assert links == [f'{root}/shell.txt', f'{root}/tool.txt']
    assert [files_bucket.read(Path(link).relative_to(root).as_posix()) for link in links] == [b'shell', b'file tool']
    assert f'Files are at `{root}`' in service.recorder.prompts[0]
    assert service.recorder.heard[0] == [question + f'{root}/uploaded.txt']
    assert _keys(files_bucket) == ['prepared.txt', 'shell.txt', 'tool.txt', 'uploaded.txt']


def test_file_tools_reject_paths_outside_files(service: _Service, files_bucket: MountedFiles) -> None:
    outside = files_bucket.root.parent / 'outside.txt'
    outside.write_text('outside')

    events = service.turn(f'read: {outside}', files=_files())

    assert 'outside the working directory' in _tool_output(events)
    assert _keys(files_bucket) == ['prepared.txt']


def test_a_file_the_agent_writes_reaches_the_accounts_files(service: _Service, files_bucket: Any) -> None:
    events = service.turn(f'write: {serving._workspace()}/report.csv: date,close', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    body = files_bucket.read('report.csv')
    assert body == b'date,close'


def test_a_file_from_one_chat_returns_in_a_new_chat_on_fresh_session_storage(
    service: _Service, files_bucket: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch, 'first-chat')
    service.turn(f'write: {serving._workspace()}/notes/plan.txt: buy low', thread='chat-a', files=_files())
    _workspace(tmp_path, monkeypatch, 'after-version-update')

    events = service.turn(f'read: {serving._workspace()}/notes/plan.txt', thread='chat-b', files=_files())

    assert 'buy low' in _tool_output(events)
    assert files_bucket.read('notes/plan.txt') == b'buy low'


def test_a_file_put_in_files_reaches_the_agent(service: _Service, files_bucket: Any) -> None:
    files_bucket.write('drafts/q3/upload.txt', b'from the Files app')

    events = service.turn(f'read: {serving._workspace()}/drafts/q3/upload.txt', files=_files())

    assert 'from the Files app' in _tool_output(events)
    assert not (files_bucket.root / '.trash').exists()
    assert not any(files_bucket.root.rglob('secret.txt'))


def test_a_newer_file_in_files_replaces_the_workspaces_copy(service: _Service, files_bucket: Any) -> None:
    service.turn(f'write: {serving._workspace()}/plan.txt: old', files=_files())
    files_bucket.write('plan.txt', b'new')

    events = service.turn(f'read: {serving._workspace()}/plan.txt', files=_files())

    assert 'new' in _tool_output(events)


def test_an_edit_within_the_second_of_the_last_sync_reaches_files(service: _Service, files_bucket: Any) -> None:
    service.turn(f'write: {serving._workspace()}/plan.txt: old', files=_files())
    plan = files_bucket.root / 'plan.txt'
    synced = plan.stat().st_mtime
    plan.write_text('edited at once')
    # The agent's edit lands within the second Files stamped on the last sync.
    os.utime(plan, (synced + 0.5, synced + 0.5))

    service.turn(f'ls: {serving._workspace()}', files=_files())

    assert files_bucket.read('plan.txt') == b'edited at once'


def test_a_file_deleted_in_files_leaves_the_workspace_and_stays_deleted(service: _Service, files_bucket: Any) -> None:
    service.turn(f'write: {serving._workspace()}/report.csv: date,close', files=_files())
    (files_bucket.root / 'report.csv').unlink()

    events = service.turn(f'ls: {serving._workspace()}', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert '/report.csv' not in _tool_output(events)
    assert not (files_bucket.root / 'report.csv').exists()
    assert _keys(files_bucket) == ['prepared.txt']


def test_a_file_deleted_in_files_then_uploaded_again_reaches_the_workspace(service: _Service, files_bucket: Any) -> None:
    service.turn(f'write: {serving._workspace()}/report.csv: date,close', files=_files())
    (files_bucket.root / 'report.csv').unlink()
    files_bucket.write('report.csv', b'date,close,volume')

    events = service.turn(f'read: {serving._workspace()}/report.csv', files=_files())
    service.turn(f'ls: {serving._workspace()}', files=_files())

    assert 'date,close,volume' in _tool_output(events)
    assert (files_bucket.root / 'report.csv').read_text() == 'date,close,volume'
    assert files_bucket.read('report.csv') == b'date,close,volume'


def test_a_file_renamed_in_files_reaches_the_workspace_under_its_new_name_only(service: _Service, files_bucket: Any) -> None:
    service.turn(f'write: {serving._workspace()}/drafts/dummy (1).pdf: quarterly', files=_files())
    (files_bucket.root / 'drafts/dummy (1).pdf').rename(files_bucket.root / 'drafts/q3.pdf')

    events = service.turn(f'ls: {serving._workspace()}/drafts', files=_files())

    assert '/drafts/q3.pdf' in _tool_output(events)
    assert 'dummy (1).pdf' not in _tool_output(events)
    assert (files_bucket.root / 'drafts' / 'q3.pdf').read_text() == 'quarterly'
    assert _keys(files_bucket) == ['drafts/q3.pdf', 'prepared.txt']


# A scratch file the agent wrote to /tmp showed up in the user's Files.


def test_a_turn_without_files_uses_local_workspace_only(service: _Service, monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: Any) -> None:
        raise AssertionError('Unbound Turn mounted Files')

    monkeypatch.setattr(FilesMount, 'pull', forbidden)
    service.turn(f'write: {serving._workspace()}/report.csv: date,close')
    assert (service.home / 'report.csv').read_text() == 'date,close'


# Told nothing of where the user's Files are, the agent listed `/files`, found none, and said Files were empty.
def test_the_agent_is_told_its_files_are_the_workspace_root(service: _Service, files_bucket: Any) -> None:
    service.turn('hello', files=_files())
    service.turn('hello', thread='no-files')

    root = files_bucket.root
    assert f"Files are at `{root}`" in service.recorder.prompts[0]
    assert f"`{root / 'tmp'}`" in service.recorder.prompts[0]
    assert '<files>' not in service.recorder.prompts[1]


def test_the_environment_section_names_only_pinned_libraries_and_smoked_commands() -> None:
    tools = Path(__file__).resolve().parents[1] / 'tools'
    pinned = {dependency.split('==')[0] for dependency in tomllib.loads((tools / 'pyproject.toml').read_text())['project']['dependencies']}
    named = serving.AGENT_SYSTEM_PROMPT.split('<environment>\n')[1].split(' are preinstalled')[0].replace(' and ', ', ').split(', ')
    commands = set(named) - pinned

    assert commands == {'rsvg-convert'}
    assert all(f"'{command}'" in (tools / 'smoke.py').read_text() for command in commands)


def test_artifacts_are_in_the_agent_prompt_and_candidate_hash(
    service: _Service, files_bucket: Any,
) -> None:
    service.turn('hello', files=_files())
    candidate = service.turn('hello again', files=_files(), agentSystemPrompt=serving.AGENT_SYSTEM_PROMPT)

    assert all('Artifact' in tools for tools in service.recorder.tools)
    assert all(prompt.startswith(serving.AGENT_SYSTEM_PROMPT) for prompt in service.recorder.prompts)
    assert 'Publish each with the `Artifact` tool' in serving.AGENT_SYSTEM_PROMPT
    assert candidate[1] == {
        'type': 'CUSTOM', 'name': 'AGENT_SYSTEM_PROMPT',
        'value': hashlib.sha256(serving.AGENT_SYSTEM_PROMPT.encode()).hexdigest(),
    }


def test_prompt_composes_generic_bot_files_and_documents_in_order(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, '_bot', replace(serving._require_bot(), system_prompt='Bot instructions.'))
    service.turn('hello', files=_files(), **DOCUMENTS)

    prompt = service.recorder.prompts[0]
    assert prompt.startswith(serving.AGENT_SYSTEM_PROMPT + '\n\nBot instructions.\n\n')
    for tag in ('artifacts', 'environment', 'writing', 'final_response', 'modules', 'citations', 'skills', 'files', 'agent_identity', 'soul'):
        assert prompt.splitlines().count(f'<{tag}>') == prompt.splitlines().count(f'</{tag}>') == 1
        assert prompt.index(f'<{tag}>') < prompt.index(f'</{tag}>')
    blocks = ["You are the user's own agent", '<environment>', '<writing>', '<final_response>', '<visuals>', '<artifacts>', '<citations>', 'Bot instructions.', '<skills>', '<files>', '<agent_identity>']
    assert [prompt.index('\n' + block) if block.startswith('<') else prompt.index(block) for block in blocks] == sorted(prompt.index('\n' + block) if block.startswith('<') else prompt.index(block) for block in blocks)
    assert '<agent_identity>\nName: Ada Bot' in prompt
    assert '<soul>\nBe candid. Say what you do not know.' in prompt


def test_every_turn_tells_the_agent_today_s_date_even_when_its_agent_is_cached_across_midnight(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = iter([datetime(2026, 10, 24, 23, 59, tzinfo=UTC), datetime(2026, 10, 25, 0, 1, tzinfo=UTC)])
    monkeypatch.setattr(today, 'now', lambda: next(clock))
    service.turn('say: before midnight')
    service.turn('say: after midnight')

    before, after = service.recorder.prompts
    assert re.findall(r'\n\nToday is .*', before) == ['\n\nToday is Saturday, 24 October 2026 (UTC).']
    assert re.findall(r'\n\nToday is .*', after) == ['\n\nToday is Sunday, 25 October 2026 (UTC).']
    assert len(serving._AGENTS) == 1


@pytest.mark.parametrize(('timezone', 'expected'), [
    ('America/New_York', 'Today is Wednesday, 28 October 2026 (America/New_York).'),
    ('Asia/Tokyo', 'Today is Thursday, 29 October 2026 (Asia/Tokyo).'),
])
def test_today_uses_the_turn_timezone_or_utc(
    service: _Service, monkeypatch: pytest.MonkeyPatch, timezone: Any, expected: str,
) -> None:
    monkeypatch.setattr(today, 'now', lambda: datetime(2026, 10, 29, 2, tzinfo=UTC))
    service.turn('say: date', timezone=timezone)
    assert re.findall(r'Today is .*', service.recorder.prompts[0]) == [expected]


@pytest.mark.parametrize('timezone', ['Unknown/Zone', '', '/etc/localtime', '../UTC', 42, None])
def test_invalid_turn_timezone_is_rejected_before_streaming(service: _Service, timezone: Any) -> None:
    response = service.client.post('/invocations', json={
        'threadId': 'thread-1', 'runId': 'invalid-zone', 'messages': [],
        'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'timezone': timezone, 'actorId': 'actor-1', 'sessionUserId': 'user-1'},
    })
    assert response.status_code == 400
    assert 'forwardedProps.timezone' in response.json()['error']
    assert service.recorder.prompts == []


def test_timezone_changes_and_omission_do_not_rebuild_or_leak_from_the_cached_agent(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(today, 'now', lambda: datetime(2026, 10, 29, 2, tzinfo=UTC))
    service.turn('say: New York', timezone='America/New_York')
    service.turn('say: Tokyo', timezone='Asia/Tokyo')
    service.turn('say: UTC')
    assert [re.findall(r'Today is .*', prompt) for prompt in service.recorder.prompts] == [
        ['Today is Wednesday, 28 October 2026 (America/New_York).'],
        ['Today is Thursday, 29 October 2026 (Asia/Tokyo).'],
        ['Today is Thursday, 29 October 2026 (UTC).'],
    ]
    assert len(serving._AGENTS) == 1


def test_the_general_purpose_subagent_gets_the_bot_instructions_but_not_the_harness_voice(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, '_bot', replace(serving._require_bot(), system_prompt='Bot instructions.'))
    events = service.turn('delegate: say: checked')

    assert _tool_output(events) == 'checked'
    main, subagent, _ = service.recorder.prompts
    assert main.startswith(serving.AGENT_SYSTEM_PROMPT + '\n\nBot instructions.')
    assert 'system_prompt' in GENERAL_PURPOSE_SUBAGENT
    assert subagent.startswith(GENERAL_PURPOSE_SUBAGENT['system_prompt'] + '\n\nBot instructions.')
    assert '<writing>' not in subagent
    for prompt in (main, subagent):
        skills = prompt.split('<skills>', 1)[1].split('</skills>', 1)[0]
        assert '**' not in skills
    assert '/skills/grounding/SKILL.md' in main
    assert '/skills/grounding/SKILL.md' in subagent


def test_files_credentials_never_reach_the_sandbox_shell(service: _Service, files_bucket: Any) -> None:
    events = service.turn('run: env', files=_files())

    assert 'files-secret' not in _tool_output(events)
    assert 'ASIAFILESSCOPED' not in _tool_output(events)


@pytest.mark.parametrize(
    ('files', 'message'),
    [
        ('accounts/0123abcd/', 'Files must be an object'),
        ({**_files(), 'sessionToken': ''}, 'Files sessionToken must be a non-empty string'),
        ({key: value for key, value in _files().items() if key != 'fileSystemId'}, 'Files fileSystemId must be a non-empty string'),
        ({**_files(), 'mountTargetIp': 'invalid'}, 'Files EFS binding is invalid or expired'),
    ],
)
def test_an_invocation_with_malformed_files_is_rejected(
    service: _Service, files_bucket: Any, files: Any, message: str
) -> None:
    events = service.turn('hello', files=files)

    assert events == [{'type': 'RUN_ERROR', 'message': message, 'code': 'INVALID_FILES'}]
    assert service.recorder.builds == []


def test_a_warmup_with_a_malformed_binding_reports_failed_preparation(service: _Service) -> None:
    events = service.turn('', warmup=True, preparationScope='recorded', files=[])
    assert events[0]['type'] == 'RUN_ERROR'
    assert events[0]['code'] == 'INVALID_FILES'
    assert events[1]['name'] == 'SESSION_PREPARATION'
    assert events[1]['value']['outcome'] == 'failed'
    assert events[1]['value']['error']['code'] == 'INVALID_FILES'


def test_a_plain_answer_does_not_depend_on_an_unavailable_background_files_pull(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable(*args: Any) -> None:
        raise FilesMountError('EFS unavailable')
    monkeypatch.setattr(FilesMount, 'pull', unavailable)
    events = service.turn('hello', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == 'Echo: hello'


@pytest.mark.parametrize('startup', [False, True])
def test_startup_and_first_chat_finish_while_files_mount_is_blocked(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch, startup: bool,
) -> None:
    entered, release = threading.Event(), threading.Event()
    workers: list[threading.Thread] = []

    def mount(self: FilesMount, root: Path, excluded: object = ()) -> None:
        workers.append(threading.current_thread())
        entered.set()
        assert release.wait(5)
        (root / 'report.csv').write_text('mounted report')

    monkeypatch.setattr(FilesMount, 'pull', mount)
    try:
        if startup:
            prepared = service.turn('hello', warmup=True, preparationScope='startup', files=_files())
            assert prepared[-1]['value']['outcome'] == 'prepared'
        plain = service.turn('hello', files=_files())
        assert entered.wait(1)
        assert plain[-1]['type'] == 'RUN_FINISHED'
        assert _said(plain) == 'Echo: hello'
        assert not release.is_set()
    finally:
        release.set()
        for worker in workers:
            worker.join(5)
            assert not worker.is_alive()


def test_a_workspace_tool_whose_files_cannot_sync_fails_loudly(service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def unavailable(*args: Any) -> None:
        raise FilesMountError('EFS unavailable')
    monkeypatch.setattr(FilesMount, 'pull', unavailable)

    events = service.turn(f'ls: {serving._workspace()}', files=_files())

    assert events[-1]['type'] == 'RUN_ERROR'
    assert 'EFS unavailable' in events[-1]['message']
    assert 'RUN_FINISHED' not in [event['type'] for event in events]
    assert service.recorder.heard == [[f'ls: {serving._workspace()}']]


# -- Written Memory --------------------------------------------------------------


def _bot_writes_memory(monkeypatch: pytest.MonkeyPatch, enabled: bool = True) -> None:
    monkeypatch.setattr(serving, '_bot', replace(serving._require_bot(), written_memory=enabled))


def test_a_line_the_agent_writes_to_written_memory_opens_the_users_next_session(
    service: _Service, files_bucket: MountedFiles, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bot_writes_memory(monkeypatch)

    written = service.turn('write: /memories/AGENTS.md: - Prefers copper', thread='chat-a', files=_files())
    service.turn('hello', thread='chat-b', files=_files())

    assert written[-1]['type'] == 'RUN_FINISHED'
    assert '- Prefers copper' in _written_memory(service.recorder.prompts[-1])
    assert files_bucket.read('memories/AGENTS.md') == b'- Prefers copper'
    assert 'memories/AGENTS.md' in _keys(files_bucket)


def test_a_user_with_no_written_memory_starts_empty(service: _Service, files_bucket: MountedFiles, monkeypatch: pytest.MonkeyPatch) -> None:
    _bot_writes_memory(monkeypatch)

    events = service.turn('hello', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == 'Echo: hello'
    assert _written_memory(service.recorder.prompts[-1]) == '(No memory loaded)'


@pytest.mark.parametrize(('bot_keeps_it', 'props'), [(True, {'writtenMemory': False}), (False, {})], ids=['guest', 'bot-setting-off'])
def test_a_guest_and_a_bot_with_written_memory_off_get_no_written_memory(
    service: _Service, files_bucket: MountedFiles, monkeypatch: pytest.MonkeyPatch, bot_keeps_it: bool, props: dict[str, Any],
) -> None:
    _bot_writes_memory(monkeypatch, bot_keeps_it)
    files_bucket.write('memories/AGENTS.md', b'- Prefers copper')

    events = service.turn('write: /memories/AGENTS.md: - Trades gold', files=_files(), **props)

    assert '<agent_memory>' not in service.recorder.prompts[-1]
    assert 'Prefers copper' not in service.recorder.prompts[-1]
    assert 'outside the working directory' in _tool_output(events)
    assert files_bucket.read('memories/AGENTS.md') == b'- Prefers copper'


def test_a_signed_in_users_session_holds_written_and_extracted_memory_in_their_own_blocks(
    service: _Service, files_bucket: MountedFiles, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bot_writes_memory(monkeypatch)
    files_bucket.write('memories/AGENTS.md', b'- Prefers copper')
    service.turn('remember: trades gold', thread='chat-a', memory=True, files=_files())

    service.turn('hello', thread='chat-b', memory=True, files=_files())

    assert _written_memory(service.recorder.prompts[-1]) == '/memories/AGENTS.md\n\n- Prefers copper'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- trades gold'


def test_a_candidate_prompt_turn_gets_no_written_memory(
    service: _Service, files_bucket: MountedFiles, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bot_writes_memory(monkeypatch)
    files_bucket.write('memories/AGENTS.md', b'- Prefers copper')

    service.turn('hello', files=_files(), agentSystemPrompt='Candidate prompt.')

    assert '<agent_memory>' not in service.recorder.prompts[-1]
    assert 'Prefers copper' not in service.recorder.prompts[-1]


def test_a_turn_without_files_gets_no_written_memory(service: _Service, monkeypatch: pytest.MonkeyPatch) -> None:
    _bot_writes_memory(monkeypatch)

    events = service.turn('write: /memories/AGENTS.md: - Prefers copper')
    service.turn('hello', thread='chat-b')

    assert '<agent_memory>' not in service.recorder.prompts[-1]
    assert 'outside the working directory' in _tool_output(events)


def test_one_users_session_cannot_read_another_users_written_memory(
    service: _Service, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bot_writes_memory(monkeypatch)
    accounts = {user: MountedFiles(tmp_path / f'{user}-files') for user in ('user-1', 'user-2')}

    def chat_as(user: str, text: str) -> list[dict[str, Any]]:
        files = accounts[user]
        monkeypatch.setenv('BOTCUBE_WORKSPACE', str(files.root))
        monkeypatch.setattr(FilesMount, 'pull', lambda mount, root, excluded=(): files.mount(mount, root, excluded))
        return service.turn(text, thread=f'{user}-chat', actor=user, user=user, files=_files())

    chat_as('user-1', 'write: /memories/AGENTS.md: - Prefers copper')
    chat_as('user-2', 'hello')

    assert _written_memory(service.recorder.prompts[-1]) == '(No memory loaded)'
    assert accounts['user-1'].read('memories/AGENTS.md') == b'- Prefers copper'


def test_written_memory_loads_when_the_files_mount_is_still_pending_as_the_turn_starts(
    service: _Service, files_bucket: MountedFiles, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bot_writes_memory(monkeypatch)
    entered, release = threading.Event(), threading.Event()

    def mount(self: FilesMount, root: Path, excluded: object = ()) -> None:
        entered.set()
        assert release.wait(5)
        (root / 'memories').mkdir()
        (root / 'memories' / 'AGENTS.md').write_text('- Prefers copper')

    def mount_later() -> None:
        assert entered.wait(5)
        time.sleep(0.2)
        release.set()

    monkeypatch.setattr(FilesMount, 'pull', mount)
    mounting = threading.Thread(target=mount_later)
    mounting.start()
    try:
        events = service.turn('hello', files=_files())
    finally:
        release.set()
        mounting.join(5)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _written_memory(service.recorder.prompts[-1]) == '/memories/AGENTS.md\n\n- Prefers copper'


# -- Conversation state ----------------------------------------------------------


def test_without_a_checkpoint_path_conversations_are_kept_in_memory(service: _Service, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv('BOTCUBE_CHECKPOINT_PATH')
    workdir = tmp_path / 'workdir'
    workdir.mkdir()
    monkeypatch.chdir(workdir)

    service.turn('one')
    service.turn('two')

    assert service.recorder.heard[-1] == ['one', 'two']
    assert list(workdir.iterdir()) == []


LEGACY_ERROR = {
    'type': 'RUN_ERROR', 'code': 'SESSION_FORMAT_LEGACY',
    # Unlike the session API's graph, the Turn's declares no `files` channel.
    'message': 'Session thread-1 is in the legacy checkpoint format: its latest checkpoint stores no messages',
}


@pytest.fixture
def legacy_record(service: _Service, monkeypatch: pytest.MonkeyPatch) -> ReadCountingSaver:
    """The Harness on a record holding thread-1, a Session in the legacy checkpoint format."""
    saver = ReadCountingSaver()
    legacy_session(saver, 'thread-1')
    monkeypatch.setattr(serving, '_build_checkpointer', lambda: saver)
    return saver


def test_a_turn_on_a_legacy_format_session_fails_classified_without_walking_its_checkpoints(
    service: _Service, legacy_record: ReadCountingSaver,
) -> None:
    events = service.turn('hello')

    assert events[-1] == LEGACY_ERROR
    assert legacy_record.reads == ['get_tuple']
    assert service.recorder.heard == []


def test_a_warmup_of_a_legacy_format_session_fails_classified_without_walking_its_checkpoints(
    service: _Service, legacy_record: ReadCountingSaver,
) -> None:
    events = service.post({
        'threadId': 'thread-1', 'runId': 'warmup-1', 'messages': [], 'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1', 'warmup': True},
    })

    assert events[0] == LEGACY_ERROR
    assert events[-1]['value']['outcome'] == 'failed'
    assert legacy_record.reads == ['get_tuple']


# -- AgentCore Memory ------------------------------------------------------------


@pytest.mark.parametrize('warmup', [False, True])
def test_a_cold_agentcore_legacy_session_fails_classified_before_model_or_writes(
    service: _Service, monkeypatch: pytest.MonkeyPatch, warmup: bool,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    legacy = AgentCoreMemorySaver(MEMORY_ID, region_name='us-east-1')
    legacy.put({'configurable': {'thread_id': 'thread-1', 'actor_id': 'user-1'}},
               empty_checkpoint(), {'source': 'loop', 'step': 0, 'parents': {}}, {})
    saver = WarmSessionSaver(MEMORY_ID, memory)
    monkeypatch.setattr(serving, '_build_checkpointer', lambda: saver)
    writes = memory.create_event_calls

    events = service.post({
        'threadId': 'thread-1', 'runId': 'legacy-1',
        'messages': [] if warmup else [{'id': 'message-1', 'role': 'user', 'content': 'hello'}],
        'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1', 'warmup': warmup},
    })

    assert [event for event in events if event['type'] == 'RUN_ERROR'] == [{
        'type': 'RUN_ERROR', 'code': 'SESSION_FORMAT_LEGACY',
        'message': 'Session thread-1 is in the legacy checkpoint format',
    }]
    assert service.recorder.heard == []
    assert memory.create_event_calls == writes
    assert memory.listed == {'thread-1': 1}


class _ScopedMemory(FakeAgentCoreMemory):
    sts: FakeSts


@pytest.fixture
def agentcore_memory(service: _Service, monkeypatch: pytest.MonkeyPatch) -> _ScopedMemory:
    """Serve on AgentCore Memory in eu-west-1, reached with each Turn's tagged credentials."""
    memory = _ScopedMemory()
    memory.sts = install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(serving, 'AWS_REGION', 'eu-west-1')
    monkeypatch.setattr(memory_tools, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    return memory


def test_named_warmup_requires_a_turn_identity_and_reads_original_history(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload: dict[str, Any] = {
        'threadId': 'original-logical-session', 'runId': 'named-warmup',
        'messages': [], 'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'actorId': 'current-owner', 'sessionUserId': 'original-filing',
                           'memory': True, 'warmup': True, 'model': 'opus-4.6'},
    }
    events = service.post(payload, session='opaque-runtime-binding')
    error = {'code': 'TURN_IDENTITY_REJECTED',
             'message': 'Invocation carries no Turn identity; the Chat Service must forward turnIdentity'}
    assert events == [{'type': 'RUN_ERROR', **error},
                      {'type': 'CUSTOM', 'name': 'SESSION_PREPARATION', 'value': {
                          'runId': 'named-warmup', 'sessionId': 'original-logical-session',
                          'outcome': 'failed', 'error': error,
                      }}]
    assert service.recorder.builds == []

    service.turn('original visible history', thread='original-logical-session',
                 actor='current-owner', user='original-filing', memory=True,
                 session='opaque-runtime-binding')
    service.fed()
    for name, value in {'_AGENTS': {}, '_CHECKPOINTER': None, '_STORE': None}.items():
        monkeypatch.setattr(serving, name, value)
    operations = agentcore_memory.sts.memory_calls
    operations.clear()
    prompts = list(service.recorder.prompts)
    payload['forwardedProps']['turnIdentity'] = turn_identity('current-owner', 'original-filing', 'original-logical-session')
    events = service.post(payload, session='opaque-runtime-binding')
    assert events == [{'type': 'CUSTOM', 'name': 'SESSION_PREPARATION', 'value': {
        'runId': 'named-warmup', 'sessionId': 'original-logical-session', 'outcome': 'prepared',
    }}]
    assert service.recorder.prompts == prompts
    # The warmup writes nothing, but makes the opening Memory read, so the Turn finds the client's connections open.
    assert all(operation not in {'create_event', 'delete_event'} for operation, _ in operations)
    assert sorted(params['namespace'] for operation, params in operations if operation == 'list_memory_records') == [
        '/actors/current-owner/facts/', '/actors/current-owner/preferences/']
    # The snapshot checkpointer's writes-session prefix for the Session.
    writes = 'lgw-a3df2202f27feb0d3080068e6084400e-'
    session_reads = [params for operation, params in operations if operation == 'list_events' and (
        params['sessionId'] == 'original-logical-session' or params['sessionId'].startswith(writes))]
    assert session_reads
    assert all(read['actorId'] == 'original-filing' for read in session_reads)


def test_on_agentcore_the_turn_credential_exchange_overlaps_the_agent_build(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botcube_harness_deepagents.memory import agentcore

    building, exchanging = threading.Event(), threading.Event()
    get_agent, turn_memory = serving._get_agent, agentcore.turn_memory

    def build(**kwargs: Any) -> Any:
        building.set()
        assert exchanging.wait(5), 'The agent build waited for the credential exchange'
        return get_agent(**kwargs)

    def exchange(*args: Any, **kwargs: Any) -> Any:
        exchanging.set()
        assert building.wait(5), 'The credential exchange waited for the agent build'
        return turn_memory(*args, **kwargs)

    monkeypatch.setattr(serving, '_get_agent', build)
    monkeypatch.setattr(agentcore, 'turn_memory', exchange)

    events = service.turn('hello', actor='actor-1', user='filing-1', memory=True)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == 'Echo: hello'


def test_on_agentcore_a_later_turn_supersedes_one_still_preparing(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    from botcube_harness_deepagents.memory import agentcore

    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_timing')
    preparing, release = threading.Event(), threading.Event()
    turn_memory = agentcore.turn_memory
    exchanges: list[str] = []

    def exchange(*args: Any, **kwargs: Any) -> Any:
        exchanges.append(kwargs['run_id'])
        if len(exchanges) == 1:
            preparing.set()
            assert release.wait(5), 'The first Turn was never released'
        return turn_memory(*args, **kwargs)

    monkeypatch.setattr(agentcore, 'turn_memory', exchange)
    member: _Member = {'actor': 'actor-1', 'user': 'filing-1', 'memory': True}
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(service.turn, 'first', **member)
        try:
            assert preparing.wait(5), 'The first Turn never began preparing'
            later = service.turn('later', **member)
        finally:
            release.set()
        earlier = first.result(timeout=10)

    assert earlier[-1]['code'] == 'TURN_STOPPED'
    assert later[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.heard == [['later']]

    timings = [json.loads(record.message) for record in caplog.records
               if record.name == 'botcube_harness_deepagents.turn_timing'
               and json.loads(record.message).get('event') == 'harness_turn_timing']
    assert sorted(line['status'] for line in timings) == ['finished', 'stopped']


def test_on_agentcore_an_older_turns_late_worker_leaves_memory_signing_as_the_newer_turn(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botcube_harness_deepagents.memory import agentcore

    preparing, release = threading.Event(), threading.Event()
    turn_memory = agentcore.turn_memory
    exchanges: list[str] = []

    def exchange(*args: Any, **kwargs: Any) -> Any:
        exchanges.append(kwargs['run_id'])
        # The guest Turn's worker thread starts its exchange only after the claimed owner's has finished.
        if len(exchanges) == 1:
            preparing.set()
            assert release.wait(5), 'The guest Turn was never released'
        return turn_memory(*args, **kwargs)

    monkeypatch.setattr(agentcore, 'turn_memory', exchange)
    with ThreadPoolExecutor(max_workers=1) as pool:
        guest = pool.submit(service.turn, 'as guest', actor='guest-1', user='guest-1', memory=True)
        try:
            assert preparing.wait(5), 'The guest Turn never began preparing'
            claimed = service.turn('as owner', actor='user-1', user='guest-1', memory=True)
        finally:
            release.set()
        guest.result(timeout=10)

    assert claimed[-1]['type'] == 'RUN_FINISHED'
    assert agentcore._MEMORY is not None
    signing = agentcore._MEMORY[0].get_frozen_credentials().access_key
    assert agentcore_memory.sts.issued[str(signing)]['actorId'] == 'user-1'


def test_on_agentcore_a_failed_credential_exchange_fails_the_turn_after_the_build_settles(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botcube_harness_deepagents.memory import agentcore

    built = threading.Event()
    get_agent = serving._get_agent

    def build(**kwargs: Any) -> Any:
        agent = get_agent(**kwargs)
        built.set()
        return agent

    def rejected(*_args: Any, **_kwargs: Any) -> NoReturn:
        raise serving.TurnIdentityError('Turn identity rejected by STS')

    monkeypatch.setattr(serving, '_get_agent', build)
    monkeypatch.setattr(agentcore, 'turn_memory', rejected)

    events = service.turn('hello', actor='actor-1', user='filing-1', memory=True)

    assert events[-1] == {'type': 'RUN_ERROR', 'code': 'TURN_IDENTITY_REJECTED', 'message': 'Turn identity rejected by STS'}
    assert built.is_set()
    assert service.recorder.heard == []


def test_on_agentcore_an_edited_question_regenerates_its_answer(service: _Service, agentcore_memory: _ScopedMemory) -> None:
    member: _ThreadMember = {'thread': 'thread-a', 'actor': 'actor-1', 'user': 'filing-1', 'memory': True}
    service.turn('first question', message='question-1', **member)

    # Resent under the same ID with new text, the library rewinds the Session through its checkpoint history.
    edited = service.turn('edited question', message='question-1', **member)

    assert edited[-1]['type'] == 'RUN_FINISHED'
    assert _said(edited) == 'Echo: edited question'
    assert service.recorder.heard[-1] == ['edited question']


# Seconds of one AgentCore Memory call, scaled down from production's.
MEMORY_ROUND_TRIP = 0.1


@pytest.fixture
def small_executor(service: _Service) -> None:
    """Match Python 3.11's six-worker default on the two-CPU CI runner."""
    async def configure_pool() -> None:
        asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=6))

    assert service.client.portal is not None
    service.client.portal.call(configure_pool)


@pytest.fixture
def checkpoint_write_gate(
    agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, small_executor: None,
) -> Iterator[threading.Event]:
    model_started = threading.Event()
    expired = threading.Event()
    round_trip = agentcore_memory.round_trip

    def hold_background_write(operation: str) -> None:
        if operation == 'create_event' and not model_started.wait(timeout=30):
            expired.set()
        round_trip(operation)

    monkeypatch.setattr(agentcore_memory, 'round_trip', hold_background_write)
    try:
        yield model_started
    finally:
        model_started.set()
    assert not expired.is_set(), 'The model waited for a checkpoint write'


def test_on_agentcore_a_continuing_sessions_turn_reaches_its_model_after_one_memory_round_trip(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
    checkpoint_write_gate: threading.Event,
) -> None:
    pending_sessions = memory_document.pending_memory_session_ids
    monkeypatch.setattr(memory_document, 'pending_memory_session_ids',
                        lambda now: pending_sessions(now.replace(hour=12, minute=0)))
    reached: list[float] = []
    calls = agentcore_memory.sts.memory_calls
    before_model: list[tuple[str, str, bool]] = []
    stream = _ScriptedModel._stream

    def first_model_call(self: _ScriptedModel, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        reached.append(time.perf_counter())
        checkpoint_write_gate.set()
        if agentcore_memory.latency:
            before_model.extend((operation, params.get('sessionId', '')[:4], params.get('includePayloads', True))
                                for operation, params in calls if operation != 'create_event')
        # Only the wait before the model is measured: the Turn's writes go at test speed.
        agentcore_memory.latency = 0
        return stream(self, *args, **kwargs)

    monkeypatch.setattr(_ScriptedModel, '_stream', first_model_call)
    # A Memory block the Session keeps, so the second Turn loads no Memory records.
    agentcore_memory.records.append(_memory_record('Prefers tea', 'UserPreferences-1', 'actor-1'))
    # The member's own Session, so the Turn feed files its messages there too, as on Main Chat.
    member: _Member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
    assert service.turn('first question', **member)[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    agentcore_memory.latency = MEMORY_ROUND_TRIP
    calls.clear()
    agentcore_memory.round_trips.clear()
    checkpoint_write_gate.clear()

    events = service.turn('second question', **member)

    assert _said(events) == 'Echo: second question'
    assert service.recorder.heard[-1] == ['first question', 'second question']
    # The newest checkpoint's key without payloads, read alongside its pending writes; checkpoint writes run behind.
    # The Memory block reads alongside them too, though the Session keeps its block.
    session_reads = sorted(read for read in before_model if read[1] in ('lgw-', 'thre'))
    assert session_reads == [('list_events', 'lgw-', True), ('list_events', 'thre', False)]
    # Three reads of the Session, three ListEvents each, took nine round trips. Count the round trips the
    # model waited for one after another, not the wall time, which a busy CI host stretches: every Memory
    # read at once, under the Session's credentials, with no exchange for new ones (ADR 0067 §8).
    waited, depth = _waited_for(agentcore_memory, reached[-1])
    assert (sorted(waited), depth) == (['list_events'] * 7 + ['list_memory_records'] * 2, 1)


@pytest.mark.parametrize('slow_preparation', [False, True])
def test_on_agentcore_a_new_sessions_turn_reaches_its_model_after_two_serial_round_trips(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
    checkpoint_write_gate: threading.Event,
    slow_preparation: bool,
) -> None:
    if slow_preparation:
        from botcube_harness_deepagents.agent import _SchemaSkillsMiddleware

        modify_request = _SchemaSkillsMiddleware.modify_request

        def prepare_slowly(self: Any, request: Any) -> Any:
            time.sleep(3.5)
            return modify_request(self, request)

        monkeypatch.setattr(_SchemaSkillsMiddleware, 'modify_request', prepare_slowly)
    pending_sessions = memory_document.pending_memory_session_ids
    monkeypatch.setattr(memory_document, 'pending_memory_session_ids',
                        lambda now: pending_sessions(now.replace(hour=12, minute=0)))
    reached: list[float] = []
    stream = _ScriptedModel._stream

    def first_model_call(self: _ScriptedModel, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        reached.append(time.perf_counter())
        checkpoint_write_gate.set()
        agentcore_memory.latency = 0
        return stream(self, *args, **kwargs)

    monkeypatch.setattr(_ScriptedModel, '_stream', first_model_call)
    agentcore_memory.latency = MEMORY_ROUND_TRIP

    events = service.turn('first question', actor='actor-1', user='actor-1', memory=True)

    assert _said(events) == 'Echo: first question'
    # The Turn identity's exchange for credentials, then every Memory read at once.
    waited, depth = _waited_for(agentcore_memory, reached[0])
    assert (waited[0], sorted(waited[1:]), depth) == (
        'assume_role_with_web_identity', ['list_events'] * 6 + ['list_memory_records'] * 2, 2)


def _waited_for(memory: FakeAgentCoreMemory, reached: float) -> tuple[list[str], int]:
    """The round trips done before the model was reached, by start, and how many of them ran one after another."""
    waited = sorted((start, end, operation) for operation, start, end in memory.round_trips if end <= reached)
    depths: list[int] = []
    for start, _, _ in waited:
        depths.append(1 + max((depth for (_, end, _), depth in zip(waited, depths, strict=False) if end <= start), default=0))
    return [operation for _, _, operation in waited], max(depths, default=0)


@pytest.mark.parametrize('identity', [
    pytest.param(('actor-2', 'filing-1', 'thread-a'), id='another actor'),
    pytest.param(('actor-1', 'filing-1', 'thread-b'), id='another Session'),
    pytest.param(('actor-1', 'filing-2', 'thread-a'), id='another filing actor'),
])
def test_on_agentcore_a_turn_reaches_only_the_memory_its_identity_names(
    service: _Service, agentcore_memory: _ScopedMemory, identity: tuple[str, str, str],
) -> None:
    events = service.turn('hello', thread='thread-a', actor='actor-1', user='filing-1', memory=True,
                          turnIdentity=turn_identity(*identity))

    assert events[-1]['type'] == 'RUN_ERROR'
    assert events[-1]['code'] == 'MEMORY_ACCESS_DENIED'
    assert 'Not authorized' in events[-1]['message']
    assert not any(event['type'] == 'RUN_FINISHED' for event in events)


@pytest.mark.parametrize(('identity', 'message'), [
    pytest.param(None, 'Invocation carries no Turn identity; the Chat Service must forward turnIdentity', id='missing'),
    pytest.param(turn_identity('actor-1', 'user-1', 'thread-1', expires_in=-10),
                 'STS refused the Turn identity: ExpiredTokenException: Token expired', id='expired'),
    pytest.param(turn_identity('actor-1', 'user-1', 'thread-1', key=b'another-key'),
                 'STS refused the Turn identity: InvalidIdentityToken: Incorrect token audience or signature', id='forged'),
])
def test_on_agentcore_a_turn_without_a_valid_identity_fails_classified(
    service: _Service, agentcore_memory: _ScopedMemory, identity: str | None, message: str,
) -> None:
    events = service.turn('hello', turnIdentity=identity)

    assert events[-1] == {'type': 'RUN_ERROR', 'message': message, 'code': 'TURN_IDENTITY_REJECTED'}
    assert agentcore_memory.events == {}


def _memory_record(
    text: str, strategy_id: str, actor_id: str, record_id: str | None = None, created: datetime | None = None,
) -> dict[str, Any]:
    return {
        'memoryRecordId': record_id or f'record-{text}',
        'content': {'text': text},
        'memoryStrategyId': strategy_id,
        'namespaces': [f"/actors/{actor_id}/{'preferences' if strategy_id.startswith('UserPreference') else 'facts'}/"],
        'createdAt': created or datetime(2026, 7, 1, tzinfo=UTC),
    }


RECORD_REPLY = (
    '{"status": "success", "content": [{"text": "Saved to memory. A new conversation sees it right away, '
    'and it reaches long-term memory within about two minutes."}]}'
)


def test_on_agentcore_a_members_memory_opens_their_next_conversation(service: _Service, agentcore_memory: _ScopedMemory) -> None:
    agentcore_memory.records += [
        _memory_record('{"preference": "Prefers dark mode"}', 'UserPreferences-1', 'actor-1'),
        _memory_record('{"preference": "Prefers light mode"}', 'UserPreferences-1', 'actor-2'),
        _memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1'),
    ]
    # A claimed Session: filed under its original user, its Memory is the current account's.
    member: _Member = {'actor': 'actor-1', 'user': 'filing-1', 'memory': True}

    saved = service.turn('remember: prefers copper', thread='thread-a', **member)
    another_microvm()
    service.turn('hello', thread='thread-b', **member)

    assert _tool_output(saved) == RECORD_REPLY
    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n'
        '- record-{ Prefers dark mode\n'
        '\n'
        'semantic facts:\n'
        '- prefers copper\n'
        '- record-T Trades copper futures'
    )
    assert agentcore_memory.sts.regions == ['eu-west-1', 'eu-west-1']


def test_on_agentcore_a_sessions_memory_block_holds_the_newest_100_preferences_and_facts_and_says_more_exist(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    agentcore_memory.records += [
        _memory_record(f'{{"preference": "Preference {n}"}}', 'UserPreferences-1', 'actor-1',
                       created=datetime(2026, 7, 1, tzinfo=UTC) + timedelta(minutes=n))
        for n in range(1, 102)
    ] + [
        _memory_record(f'Fact {n}', 'SemanticFacts-1', 'actor-1', created=datetime(2026, 7, 1, tzinfo=UTC) + timedelta(minutes=n))
        for n in range(1, 102)
    ]

    service.turn('hello', thread='thread-a', actor='actor-1', user='actor-1', memory=True)

    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n' + ''.join(f'- record-{{ Preference {n}\n' for n in range(101, 1, -1))
        + '\nsemantic facts:\n' + ''.join(f'- record-F Fact {n}\n' for n in range(101, 1, -1))
        + '\n(1 more preferences; 1 more facts; use memory list or retrieve)'
    )


def test_on_agentcore_the_memory_tool_lists_retrieves_gets_and_deletes_only_the_members_records(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    agentcore_memory.records += [
        _memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1', COPPER),
        _memory_record('Trades copper options', 'SemanticFacts-1', 'actor-2', PARIS),
        _memory_record('Summary: copper desk review', 'Summaries-1', 'actor-1', DARK_MODE),
    ]
    agentcore_memory.records[-1]['namespaces'] = ['/actors/actor-1/summaries/thread-0/']
    member: _Member = {'actor': 'actor-1', 'user': 'filing-1', 'memory': True}

    def run(**args: str) -> Any:
        return json.loads(_tool_output(service.turn(f'memory: {json.dumps(args)}', **member)))

    assert run(action='list') == {'status': 'success', 'content': [
        {'text': '- copper-0 Trades copper futures'}, {'text': '- dark-mod Summary: copper desk review'},
    ]}
    assert run(action='retrieve', query='copper') == {'status': 'success', 'content': [
        {'text': '- copper-0 Trades copper futures'}, {'text': '- dark-mod Summary: copper desk review'},
    ]}
    assert run(action='get', memory_record_id=COPPER) == {'status': 'success', 'content': [{'text': 'Trades copper futures'}]}
    assert run(action='delete', memory_record_id=COPPER) == {
        'status': 'success', 'content': [{'text': f'Deleted memory record {COPPER}.'}],
    }
    assert [record['memoryRecordId'] for record in agentcore_memory.records] == [PARIS, DARK_MODE]


def _memory_operation(operation: str, user: str = 'actor-1', **fields: str) -> dict[str, Any]:
    response = TestClient(session_api.app).post('/invocations', json={'operation': operation, 'userId': user, **fields})
    assert response.status_code == 200, response.text
    return response.json()


# AgentCore memory record IDs are at least 40 characters.
DARK_MODE = 'mem-dark-mode-000000000000000000000000000'
COPPER = 'mem-copper-0000000000000000000000000000000'
PARIS = 'mem-paris-00000000000000000000000000000000'


def test_on_agentcore_a_memory_page_edit_reaches_the_next_session_and_leaves_the_current_ones_block_unchanged(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    agentcore_memory.records += [
        _memory_record('{"preference": "Prefers dark mode"}', 'UserPreferences-1', 'actor-1', DARK_MODE),
        _memory_record('{"preference": "Prefers light mode"}', 'UserPreferences-1', 'actor-2'),
        _memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1', COPPER),
        _memory_record('Lives in Paris', 'SemanticFacts-1', 'actor-1', PARIS),
    ]
    member: _Member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
    service.turn('hello', thread='thread-a', **member)
    opened = service.recorder.prompts[-1]

    document = _memory_operation('memory')
    _memory_operation('memory-edit', recordId=PARIS, text='Lives in London')
    _memory_operation('memory-delete', recordId=COPPER)
    service.turn('hello again', thread='thread-a', **member)
    continued = service.recorder.prompts[-1]
    another_microvm()
    service.turn('hello', thread='thread-b', **member)

    assert document == {
        'lines': [
            {'id': DARK_MODE, 'text': 'Prefers dark mode'},
            {'id': COPPER, 'text': 'Trades copper futures'},
            {'id': PARIS, 'text': 'Lives in Paris'},
        ]
    }
    assert continued == opened
    assert _memory_block(opened).endswith('semantic facts:\n- copper-0 Trades copper futures\n- paris-00 Lives in Paris')
    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n'
        '- dark-mod Prefers dark mode\n'
        '\n'
        'semantic facts:\n'
        '- paris-00 Lives in London\n'
        '\n'
        'Memory page corrections (authoritative):\n'
        'These corrections override conflicting memories above, including paraphrases and parts of compound saves. '
        'Each previousText is superseded by text; null means forgotten and must not be used. '
        'Keep unrelated facts from those saves.\n'
        '{"previousText": "Trades copper futures", "text": null}\n'
        '{"previousText": "Lives in Paris", "text": "Lives in London"}'
    )
    assert _memory_operation('memory') == {
        'lines': [{'id': DARK_MODE, 'text': 'Prefers dark mode'}, {'id': PARIS, 'text': 'Lives in London'}]
    }


def test_on_agentcore_a_scheduled_runs_summary_leaves_the_sessions_memory_block_unchanged(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    agentcore_memory.records += [_memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1', COPPER)]
    member: _Member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
    service.turn('hello', thread='thread-a', **member)
    opened = service.recorder.prompts[-1]

    # A reload would show the newer record.
    agentcore_memory.records.append(_memory_record('Lives in Paris', 'SemanticFacts-1', 'actor-1', PARIS))
    response = TestClient(session_api.app).post('/invocations', json={
        'operation': 'post', 'userId': 'actor-1', 'sessionId': 'thread-a', 'content': 'Copper closed up 2%',
    })
    service.turn('hello again', thread='thread-a', **member)

    assert response.status_code == 200, response.text
    assert _memory_block(opened) == 'semantic facts:\n- copper-0 Trades copper futures'
    assert service.recorder.prompts[-1] == opened


def test_on_agentcore_a_memory_page_edit_reaches_a_new_session_while_agentcore_lists_the_old_lines(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    agentcore_memory.records += [
        _memory_record('{"preference": "Prefers dark mode"}', 'UserPreferences-1', 'actor-1', DARK_MODE),
        _memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1', COPPER),
        _memory_record('Lives in Paris', 'SemanticFacts-1', 'actor-1', PARIS),
    ]
    member: _Member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
    service.turn('hello', thread='thread-a', **member)
    agentcore_memory.lag_listing()

    _memory_operation('memory-edit', recordId=PARIS, text='Lives in London')
    _memory_operation('memory-delete', recordId=COPPER)
    document = _memory_operation('memory')
    another_microvm()
    service.turn('hello', thread='thread-b', **member)

    assert document == {
        'lines': [{'id': DARK_MODE, 'text': 'Prefers dark mode'}, {'id': PARIS, 'text': 'Lives in London'}]
    }
    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n'
        '- dark-mod Prefers dark mode\n'
        '\n'
        'semantic facts:\n'
        '- paris-00 Lives in London\n'
        '\n'
        'Memory page corrections (authoritative):\n'
        'These corrections override conflicting memories above, including paraphrases and parts of compound saves. '
        'Each previousText is superseded by text; null means forgotten and must not be used. '
        'Keep unrelated facts from those saves.\n'
        '{"previousText": "Trades copper futures", "text": null}\n'
        '{"previousText": "Lives in Paris", "text": "Lives in London"}'
    )


def _fed_events(memory: FakeAgentCoreMemory, actor: str, thread: str) -> list[list[tuple[str, str]]]:
    """Each conversational event in the Session, as its (role, text) items."""
    return [
        [(item['conversational']['role'], item['conversational']['content']['text']) for item in event['payload']]
        for event in memory.events[(actor, thread)]
        if any('conversational' in item for item in event['payload'])
    ]


def test_on_agentcore_a_long_member_turn_feeds_one_untrimmed_event_per_message(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    # 40 steps: the question, 40 tool calls with 40 results, and the answer, 82 messages.
    service.turn('steps: 40', thread='thread-b', actor='actor-1', user='user-1', memory=True)
    service.fed()

    fed = _fed_events(agentcore_memory, 'actor-1', 'thread-b')
    # Assistant messages that only call a tool carry no text, so they feed nothing.
    assert [items[0][0] for items in fed] == ['USER', *['TOOL'] * 40, 'ASSISTANT']
    assert all(len(items) == 1 for items in fed)
    assert fed[0] == [('USER', 'steps: 40')]
    assert fed[-1] == [('ASSISTANT', 'Done after 40 steps')]
    assert not any('[truncated]' in text or 'omitted' in text for items in fed for _role, text in items)


def test_on_agentcore_the_response_finishes_before_the_turn_feed(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    feeding, release = threading.Event(), threading.Event()
    create_event = agentcore_memory.create_event

    def held(**params: Any) -> dict[str, Any]:
        if any('conversational' in item for item in params['payload']):
            feeding.set()
            assert release.wait(5), 'The test did not release the feed'
        return create_event(**params)

    monkeypatch.setattr(agentcore_memory, 'create_event', held)
    try:
        events = service.turn('hello', thread='thread-b', actor='actor-1', user='user-1', memory=True)
        assert events[-1]['type'] == 'RUN_FINISHED'
        assert feeding.wait(5)
        assert _fed_events(agentcore_memory, 'actor-1', 'thread-b') == []
    finally:
        release.set()
    service.fed()

    assert _fed_events(agentcore_memory, 'actor-1', 'thread-b') == [[('USER', 'hello')], [('ASSISTANT', 'Echo: hello')]]


def test_on_agentcore_a_throttled_turn_feed_preserves_the_answer_and_the_next_turn(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    create_event = agentcore_memory.create_event

    def failing(**params: Any) -> dict[str, Any]:
        if any('conversational' in item for item in params['payload']):
            raise ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'Busy'}}, 'CreateEvent')
        return create_event(**params)

    monkeypatch.setattr(agentcore_memory, 'create_event', failing)

    first = service.turn('hello', thread='thread-b', actor='actor-1', user='user-1', memory=True)
    service.fed()

    assert first[-1]['type'] == 'RUN_FINISHED'
    assert _fed_events(agentcore_memory, 'actor-1', 'thread-b') == []
    [logged] = [record for record in caplog.records if record.getMessage().startswith('Harness Turn feed failed')]
    assert logged.levelno == logging.ERROR
    assert 'code=TURN_FEED_FAILED' in logged.getMessage()
    assert any(event.get('delta') == 'Echo: hello' for event in first)
    monkeypatch.setattr(agentcore_memory, 'create_event', create_event)
    following = service.turn('again', thread='thread-b', actor='actor-1', user='user-1', memory=True)
    service.fed()
    assert following[-1]['type'] == 'RUN_FINISHED'
    assert not any(event['type'] == 'RUN_ERROR' for event in following)
    assert any(event.get('delta') == 'Echo: again' for event in following)


def test_on_agentcore_a_failed_memory_load_fails_the_sessions_first_turn_and_the_next_turn_loads_again(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agentcore_memory.records.append(_memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1'))
    list_events = agentcore_memory.list_events

    def throttled(**params: Any) -> dict[str, Any]:
        if params['sessionId'].startswith('pending-memory-'):
            raise RuntimeError('Memory throttled')
        return list_events(**params)

    monkeypatch.setattr(agentcore_memory, 'list_events', throttled)
    member: _Member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}

    [run_error] = [event for event in service.turn('hello', thread='thread-a', **member) if event['type'] == 'RUN_ERROR']
    monkeypatch.setattr(agentcore_memory, 'list_events', list_events)
    retried = service.turn('hello again', thread='thread-a', message='message-retry', **member)

    assert run_error['message'] == 'Memory throttled'
    assert retried[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- record-T Trades copper futures'


def test_on_agentcore_a_guests_turn_feeds_nothing(service: _Service, agentcore_memory: _ScopedMemory) -> None:
    events = service.turn('hello', thread='thread-b', actor='anonymous', user='anonymous', memory=False)
    service.fed()

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert all(not _fed_events(agentcore_memory, actor, thread) for actor, thread in agentcore_memory.events)


def test_on_agentcore_an_anonymous_actor_gets_no_memory_block_tool_or_memory_reads(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    agentcore_memory.records += [_memory_record('Trades copper futures', 'SemanticFacts-1', 'anonymous')]

    service.turn('hello', thread='thread-a', actor='anonymous', user='anonymous', memory=True)

    assert 'memory' not in service.recorder.tools[-1]
    assert '<extracted_memory>' not in service.recorder.prompts[-1]
    # Its credentials serve only the Session's checkpoints.
    writes = 'lgw-8b983fb92d2eb12751695722fdb4e498-'
    assert {operation for operation, _ in agentcore_memory.sts.memory_calls} <= {'create_event', 'list_events'}
    assert all(params['sessionId'] == 'thread-a' or params['sessionId'].startswith(writes)
               for _, params in agentcore_memory.sts.memory_calls)
    assert not [session for session in agentcore_memory.listed if session.startswith('pending-memory-')]


# -- Configuration and startup ---------------------------------------------------


def test_a_service_takes_one_bot(service: _Service) -> None:
    with pytest.raises(RuntimeError, match=r'^Harness bot is already configured$'):
        serving.configure_harness_definition(_definition([]))


@pytest.fixture
def start(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Callable[[], list[tuple[Any, dict[str, Any]]]]]:
    """Start the service with main() serving the settings-only bot a BotCube Config names, recording how uvicorn would serve it."""
    served: list[tuple[Any, dict[str, Any]]] = []
    monkeypatch.setattr(uvicorn, 'run', lambda app, **options: served.append((app, options)))
    monkeypatch.setattr(serving, '_prime_snapshot', lambda: None)
    monkeypatch.setattr(serving, '_bot', None)
    bot = tmp_path / 'bot.yaml'
    bot.write_text(json.dumps({
        'agentIdentity': {'name': 'test-agent', 'character': 'A test bot'},
        'accountKey': 'test',
        'models': [{'key': 'echo', 'label': 'Echo', 'provider': 'openai'}],
    }))
    deploy(monkeypatch, tmp_path)
    from botcube_harness_deepagents import bot_settings
    original = bot_settings.load_bot_settings
    monkeypatch.setattr(bot_settings, 'load_bot_settings', lambda path: original(bot))
    monkeypatch.delenv('PORT', raising=False)
    # main() configures process logging; restore it afterwards.
    cache_logger = logging.getLogger('botcube_harness_deepagents.prompt_cache')
    monkeypatch.setattr(cache_logger, 'handlers', list(cache_logger.handlers))
    monkeypatch.setattr(cache_logger, 'propagate', cache_logger.propagate)
    levels = {logger: logger.level for logger in (logging.root, cache_logger)}
    # A fresh process's root logger passes WARNING and above. setLevel, unlike assigning the
    # level, also drops every logger's cached answer to "is INFO enabled?".
    logging.root.setLevel(logging.WARNING)

    def start() -> list[tuple[Any, dict[str, Any]]]:
        # main() replaces the root handlers, including the one pytest adds for this phase.
        monkeypatch.setattr(logging.root, 'handlers', list(logging.root.handlers))
        serving.main()
        return served

    yield start
    for logger, level in levels.items():
        logger.setLevel(level)


def test_the_service_serves_on_every_interface_at_port_8080(start: Callable[[], list[tuple[Any, dict[str, Any]]]]) -> None:
    assert start() == [(serving.app, {'host': '0.0.0.0', 'port': 8080})]


@pytest.mark.parametrize('bundle', ['absent', 'not-pem'])
def test_the_service_fails_to_start_on_a_ca_bundle_it_cannot_load(
    start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch, tmp_path: Path, bundle: str,
) -> None:
    from botcube_harness_deepagents.botcube_config import BotCubeConfigError

    path = tmp_path / 'ca-bundle.pem'
    if bundle == 'not-pem':
        path.write_text('not a certificate\n')
    deploy(monkeypatch, tmp_path, caBundle=str(path))

    with pytest.raises(BotCubeConfigError, match=f'^caBundle {path}: '):
        start()


def test_the_service_serves_on_the_configured_port(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('PORT', '9123')

    assert start() == [(serving.app, {'host': '0.0.0.0', 'port': 9123})]


def test_the_service_serves_the_bot_its_botcube_config_names(start: Callable[[], list[tuple[Any, dict[str, Any]]]]) -> None:
    start()

    assert serving._require_bot().agent_name == 'test-agent'


def test_a_configured_service_starts_with_its_bot(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch) -> None:
    serving.configure_harness_definition(_definition([]))
    configured = serving._require_bot()
    monkeypatch.delenv('BOTCUBE_CONFIG')

    start()

    assert serving._require_bot() is configured


def test_the_service_logs_at_info_with_bare_prompt_cache_lines(start: Callable[[], list[tuple[Any, dict[str, Any]]]], capsys: pytest.CaptureFixture[str]) -> None:
    start()
    capsys.readouterr()
    service_log = logging.getLogger('botcube_harness_deepagents.serving')
    service_log.debug('hidden')
    service_log.info('ready')
    logging.getLogger('botcube_harness_deepagents.prompt_cache').info('{"cache_read": 1}')

    assert capsys.readouterr().err == 'botcube_harness_deepagents.serving ready\n{"cache_read": 1}\n'


def test_prompt_cache_lines_are_logged_under_a_quieter_package_logger(start: Callable[[], list[tuple[Any, dict[str, Any]]]], capsys: pytest.CaptureFixture[str]) -> None:
    package_log = logging.getLogger('botcube_harness_deepagents')
    level = package_log.level
    package_log.setLevel(logging.WARNING)
    try:
        start()
        capsys.readouterr()
        logging.getLogger('botcube_harness_deepagents.serving').info('ready')
        logging.getLogger('botcube_harness_deepagents.prompt_cache').info('{"cache_read": 1}')
    finally:
        package_log.setLevel(level)

    assert capsys.readouterr().err == '{"cache_read": 1}\n'


def test_a_failed_checkpoint_write_fails_its_turn_loud_and_the_next_turn_answers(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    service.turn('seed one', session='runtime-session-1')
    create_event = memory.create_event
    failed = False

    def fail_once(**params: Any) -> dict[str, Any]:
        nonlocal failed
        if not failed and params['sessionId'] == 'thread-1':
            failed = True
            raise RuntimeError('Transient checkpoint persistence failure')
        return create_event(**params)

    monkeypatch.setattr(memory, 'create_event', fail_once)

    events = service.turn('one', session='runtime-session-1')

    assert events[-1]['error'] == {
        'message': 'Transient checkpoint persistence failure', 'code': 'CHECKPOINT_WRITE_FAILED',
    }
    assert sum(event.get('type') == 'RUN_FINISHED' for event in events) == 1
    failed_next = service.turn('report the failed checkpoint', session='runtime-session-1')
    assert failed_next[-1]['code'] == 'CHECKPOINT_WRITE_FAILED'
    recovered = service.turn('two', session='runtime-session-1')
    assert recovered[-1]['type'] == 'RUN_FINISHED'
    assert _said(recovered) == 'Echo: two'
    assert _replay('user-1', 'thread-1')[-2:] == [('user', 'two'), ('assistant', 'Echo: two')]


def test_a_cold_turn_resumes_tools_and_rejects_a_corrupt_snapshot(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    assert service.turn('Large question ' * 1000)[-1]['type'] == 'RUN_FINISHED'
    fresh_warm_sessions(monkeypatch)

    events = service.turn('steps: 2')

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == 'Done after 2 steps'
    assert sum(event['type'] == 'TOOL_CALL_RESULT' for event in events) == 2
    assert _replay('user-1', 'thread-1')[-1] == ('assistant', 'Done after 2 steps')
    latest = next(event for event in reversed(memory.events[('user-1', 'thread-1')])
                  if event.get('metadata', {}).get('lc_kind') == {'stringValue': 'checkpoint'})
    for item in latest['payload']:
        blob = json.loads(item['blob'])
        if blob.get('channel') == 'messages':
            blob['value']['data'] = 'wQ=='
            item['blob'] = json.dumps(blob)
    fresh_warm_sessions(monkeypatch)
    calls, writes = len(service.recorder.prompts), memory.create_event_calls

    failed = service.turn('Read the damaged Session')

    assert failed[-1]['type'] == 'RUN_ERROR'
    assert 'Failed to deserialize value' in failed[-1]['message']
    assert len(service.recorder.prompts) == calls
    assert memory.create_event_calls == writes


@pytest.mark.parametrize("backend", ["sqlite", "inmem", "agentcore"])
def test_same_session_id_isolates_each_filing_user(
    service: _Service,
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
) -> None:
    if backend == "inmem":
        monkeypatch.delenv("BOTCUBE_CHECKPOINT_PATH")
    elif backend == "agentcore":
        memory = FakeAgentCoreMemory()
        install_tagged_memory(monkeypatch, memory)
        monkeypatch.setattr(serving, "AGENTCORE_MEMORY_ID", MEMORY_ID)
        monkeypatch.setattr(session_api, "AGENTCORE_MEMORY_ID", MEMORY_ID)
    first = service.turn(
        "synthetic A private marker",
        actor="owner-a",
        user="filing-a",
        thread="shared-session",
    )
    # Each filing user's Session is its own sandbox, on its own microVM.
    another_microvm()
    second = service.turn(
        "synthetic B question",
        actor="owner-b",
        user="filing-b",
        thread="shared-session",
    )
    assert first[-1]["type"] == second[-1]["type"] == "RUN_FINISHED"
    assert service.recorder.heard[-1] == ["synthetic B question"]
    another_microvm()
    service.turn(
        "synthetic A next", actor="owner-a", user="filing-a", thread="shared-session"
    )
    assert service.recorder.heard[-1] == [
        "synthetic A private marker",
        "synthetic A next",
    ]
    if backend != "inmem":
        assert _replay("filing-b", "shared-session") == [
            ("user", "synthetic B question"),
            ("assistant", "Echo: synthetic B question"),
        ]
        serving._AGENTS.clear()
        serving._BACKEND_BY_AGENT.clear()
        serving._CHECKPOINTER = serving._build_checkpointer()
        another_microvm()
        cold = service.turn(
            "synthetic B cold",
            actor="owner-b",
            user="filing-b",
            thread="shared-session",
        )
        assert cold[-1]["type"] == "RUN_FINISHED"
        assert service.recorder.heard[-1] == [
            "synthetic B question",
            "synthetic B cold",
        ]


def test_opaque_runtime_continuation_restores_original_history(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    original = service.turn(
        'before continuation', actor='original-owner', user='original-filing',
        thread='legacy-session', session='legacy-session',
    )
    assert original[-1]['type'] == 'RUN_FINISHED'
    serving._AGENTS.clear()
    serving._BACKEND_BY_AGENT.clear()
    serving._CHECKPOINTER = serving._build_checkpointer()

    continued = service.turn(
        'after continuation', actor='claimed-owner', user='original-filing',
        thread='legacy-session', session='runtime-00000000-0000-4000-8000-000000000001',
    )
    assert continued[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.heard[-1] == ['before continuation', 'after continuation']
    assert _replay('original-filing', 'legacy-session') == [
        ('user', 'before continuation'), ('assistant', 'Echo: before continuation'),
        ('user', 'after continuation'), ('assistant', 'Echo: after continuation'),
    ]


def test_a_finished_turns_history_reads_only_its_latest_checkpoint(
    service: _Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, "AGENTCORE_MEMORY_ID", MEMORY_ID)
    monkeypatch.setattr(session_api, "AGENTCORE_MEMORY_ID", MEMORY_ID)
    service.turn("hello", user="user-1", thread="thread-1")
    service.turn("again", user="user-1", thread="thread-1")
    memory.listed.clear()

    assert _replay("user-1", "thread-1") == [
        ("user", "hello"),
        ("assistant", "Echo: hello"),
        ("user", "again"),
        ("assistant", "Echo: again"),
    ]
    writes = "lgw-4b0a5fefc328e6b9257bc535e3c5d26f-"
    writes_reads = [session for session in memory.listed if session != "thread-1"]
    assert memory.listed["thread-1"] == 1
    assert len(writes_reads) == 1 and writes_reads[0].startswith(writes)


def test_a_new_session_is_readable_while_its_first_turn_runs(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    recorded = threading.Event()
    stored = WarmSessionSaver.put_with_writes

    def published(self: Any, config: Any, checkpoint: Any, *args: Any, **kwargs: Any) -> Any:
        result = stored(self, config, checkpoint, *args, **kwargs)
        if checkpoint['channel_values'].get('messages'):
            recorded.set()
        return result

    monkeypatch.setattr(WarmSessionSaver, 'put_with_writes', published)
    answering = threading.Event()
    release_answer = threading.Event()
    stream = _ScriptedModel._stream

    def held_answer(model: _ScriptedModel, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        answering.set()
        if not release_answer.wait(10):
            raise AssertionError('The test did not release the first answer')
        yield from stream(model, *args, **kwargs)

    monkeypatch.setattr(_ScriptedModel, '_stream', held_answer)
    with TestClient(session_api.app) as records:
        missing = records.post('/invocations', json={
            'operation': 'get', 'userId': 'user-1', 'sessionId': 'truly-missing',
        })
        assert missing.status_code == 404
        assert missing.json()['error'] == 'Session truly-missing has no record'
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(service.turn, 'First question', session='runtime-session-1')
            try:
                assert answering.wait(5), 'The first Turn did not reach the held model'
                assert recorded.wait(5), 'The initial question was never persisted'
                response = records.post('/invocations', json={
                    'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1',
                })
                assert not running.done(), 'The first Turn finished before its record was read'
                assert response.status_code == 200, response.text
                assert response.json()['messages'] == [
                    {'id': 'message-0', 'role': 'user', 'content': 'First question'},
                ]
            finally:
                release_answer.set()
                events = running.result(timeout=10)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _replay('user-1', 'thread-1') == [
        ('user', 'First question'), ('assistant', 'Echo: First question'),
    ]


def test_a_new_turn_whose_record_cannot_be_written_fails_loud(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)

    def unwritable(**_params: Any) -> NoReturn:
        raise RuntimeError('Initial record publication failed')

    monkeypatch.setattr(memory, 'create_event', unwritable)

    events = service.turn('First question', session='runtime-session-1')

    assert events[-1]['error'] == {
        'message': 'Initial record publication failed', 'code': 'CHECKPOINT_WRITE_FAILED',
    }
    assert sum(event.get('type') == 'RUN_FINISHED' for event in events) == 1
    failed_next = service.turn('report the failed record', session='runtime-session-1')
    assert failed_next[-1]['code'] == 'CHECKPOINT_WRITE_FAILED'


def test_claimed_session_keeps_its_filing_record_on_the_in_memory_backend(
    service: _Service,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BOTCUBE_CHECKPOINT_PATH")
    service.turn(
        "before claim",
        actor="anonymous-owner",
        user="original-filing",
        thread="claimed-session",
    )
    events = service.turn(
        "after claim",
        actor="claimed-owner",
        user="original-filing",
        thread="claimed-session",
    )
    assert events[-1]["type"] == "RUN_FINISHED"
    assert service.recorder.heard[-1] == ["before claim", "after claim"]


@pytest.mark.parametrize(('error', 'message'), [(RuntimeError('provider unavailable'), 'provider unavailable'), (RuntimeError(), 'RuntimeError')])
def test_upgraded_graph_classifies_ordinary_provider_failure(
    service: _Service, monkeypatch: pytest.MonkeyPatch, error: Exception, message: str,
) -> None:
    def unavailable(*_args: Any, **_kwargs: Any) -> NoReturn:
        raise error

    monkeypatch.setattr(_ScriptedModel, '_stream', unavailable)
    events = service.turn('hello')

    assert events[-1] == {'type': 'RUN_ERROR', 'message': message, 'code': 'INTERNAL_ERROR'}
    assert sum(event['type'] == 'RUN_STARTED' for event in events) == 1
    assert not any(event['type'] == 'RUN_FINISHED' for event in events)


def test_upgraded_write_file_replaces_existing_content(service: _Service) -> None:
    service.turn(f'write: {serving._workspace()}/plan.txt: first draft')
    events = service.turn(f'write: {serving._workspace()}/plan.txt: revised draft')

    assert (service.prepared[0] / 'plan.txt').read_text() == 'revised draft'
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert 'Error' not in _tool_output(events)


@pytest.mark.parametrize('stopped', [False, True])
def test_invocation_eof_waits_for_real_record_settlement_before_purge(
    service: _Service, monkeypatch: pytest.MonkeyPatch, stopped: bool,
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    service.turn('seed', session='physical-runtime')
    entered = threading.Event()
    release = threading.Event()
    model_started = threading.Event()
    if stopped:
        async def unfinished(self: _ScriptedModel, *_args: Any, **_kwargs: Any):
            yield _text('Visible unfinished answer')
            model_started.set()
            await asyncio.Future()

        monkeypatch.setattr(_ScriptedModel, '_astream', unfinished)
    create_event = memory.create_event
    held_from = memory.create_event_calls

    def held_write(**params: Any) -> dict[str, Any]:
        # The Turn's last checkpoint write: its answer, or the cut reply Stop keeps.
        if params['sessionId'] == 'thread-1' and memory.create_event_calls >= held_from:
            entered.set()
            assert release.wait(5), 'Checkpoint settlement was never released'
        return create_event(**params)

    monkeypatch.setattr(memory, 'create_event', held_write)
    payload = {
        'threadId': 'thread-1', 'runId': 'held-turn',
        'messages': [{'id': 'held-question', 'role': 'user', 'content': 'next question'}],
        'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1', 'memory': False,
                          'turnIdentity': turn_identity('actor-1', 'user-1', 'thread-1')},
    }
    with ThreadPoolExecutor(max_workers=1) as pool:
        response = pool.submit(service.client.post, '/invocations', json=payload,
                               headers={SESSION_HEADER: 'physical-runtime'})
        try:
            if stopped:
                assert model_started.wait(5), 'The graph never reached its unfinished answer'
                acknowledgement = service.client.post('/invocations', json={
                    **payload, 'forwardedProps': {'stop': True, 'sessionUserId': 'user-1'},
                }, headers={SESSION_HEADER: 'physical-runtime'})
                assert acknowledgement.status_code == 200
            assert entered.wait(5), 'The Turn never reached record settlement'
            with pytest.raises(TimeoutError):
                response.result(timeout=0.2)
        finally:
            release.set()
            answer = response.result(timeout=10)
    events = _sse_events(answer.text)
    if stopped:
        assert events[-1]['code'] == 'TURN_STOPPED'
        assert _replay('user-1', 'thread-1')[-1] == ('assistant', 'Visible unfinished answer')
    else:
        assert events[-1]['type'] == 'RUN_FINISHED'
        assert _replay('user-1', 'thread-1')[-1] == ('assistant', 'Echo: next question')
    assert _memory_operation('purge', user='user-1', sessionId='thread-1') == {}
    with pytest.raises(session_api.SessionApiError, match='has no record') as missing:
        _replay('user-1', 'thread-1')
    assert missing.value.code == 'SESSION_NOT_FOUND'
    assert not any(memory.events.values())


class _HeldAnswerWrite:
    def __init__(self, write: Callable[..., dict[str, Any]], fails: bool) -> None:
        self.write = write
        self.fails = fails
        self.entered = threading.Event()
        self.release = threading.Event()
        self.committed = threading.Event()
        self.premature_writes: list[str] = []

    def __call__(self, **params: Any) -> dict[str, Any]:
        if self.entered.is_set() and not self.committed.is_set():
            self.premature_writes.append(params['sessionId'])
        if not self.entered.is_set() and params['sessionId'] == 'thread-1' and self._carries_first_answer(params['payload']):
            self.entered.set()
            assert self.release.wait(5)
            if self.fails:
                raise RuntimeError('First answer was not published')
            result = self.write(**params)
            self.committed.set()
            return result
        return self.write(**params)

    @staticmethod
    def _carries_first_answer(payload: list[dict[str, str]]) -> bool:
        for item in payload:
            blob = json.loads(item['blob'])
            if blob.get('channel') == 'messages' and b'Echo: first question' in base64.b64decode(blob['value']['data']):
                return True
        return False


@pytest.mark.parametrize(('publication_fails', 'second_epoch'), [(False, 'writer-1'), (True, 'writer-1'), (False, 'writer-2')])
def test_following_turn_dispatches_during_checkpoint_settlement(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch, publication_fails: bool, second_epoch: str,
) -> None:
    history = [{'id': f'history-{index}', 'role': 'assistant' if index % 2 else 'user',
                'content': f'History entry {index}'} for index in range(202)]

    def send(run: str, messages: list[dict[str, str]]) -> list[dict[str, Any]]:
        response = service.client.post('/invocations', json={
            'threadId': 'thread-1', 'runId': run, 'messages': messages,
            'tools': [], 'context': [], 'state': {},
            'forwardedProps': {
                'actorId': 'actor-1', 'sessionUserId': 'user-1', 'memory': False,
                'sessionSnapshotEpoch': {'epoch': second_epoch if run == 'second' else 'writer-1', 'turnId': run},
                'turnIdentity': turn_identity('actor-1', 'user-1', 'thread-1', nonce=run),
            },
        }, headers={SESSION_HEADER: 'physical-runtime'})
        assert response.status_code == 200
        return _sse_events(response.text)

    assert send('seed', history)[-1]['type'] == 'RUN_FINISHED'
    held = _HeldAnswerWrite(agentcore_memory.create_event, publication_fails)
    stream = _ScriptedModel._stream
    dispatched = threading.Event()
    dispatch_at: list[float] = []

    def observe(
        model: _ScriptedModel, messages: list[BaseMessage], *args: Any, **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        if messages[-1].content == 'second question':
            assert messages[-2].content == 'Echo: first question'
            dispatch_at.append(time.perf_counter())
            dispatched.set()
        yield from stream(model, messages, *args, **kwargs)

    monkeypatch.setattr(agentcore_memory, 'create_event', held)
    monkeypatch.setattr(_ScriptedModel, '_stream', observe)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(send, 'first', [{'id': 'first', 'role': 'user', 'content': 'first question'}])
        try:
            assert held.entered.wait(5)
            started = time.perf_counter()
            second = pool.submit(send, 'second', [{'id': 'second', 'role': 'user', 'content': 'second question'}])
            started_during_write = dispatched.wait(1)
            assert not first.done()
            assert not second.done()
        finally:
            held.release.set()
        first_events = first.result(timeout=10)
        second_events = second.result(timeout=10)
    assert not held.premature_writes
    assert len(service.recorder.heard[-1]) == 103
    assert service.recorder.heard[-1][-2:] == ['first question', 'second question']
    assert started_during_write == (second_epoch == 'writer-1'), f'Following model dispatch took {dispatch_at[0] - started:.3f}s'
    if publication_fails:
        error = {'code': 'CHECKPOINT_WRITE_FAILED', 'message': 'First answer was not published'}
        assert first_events[-1]['error'] == error
        assert second_events[-1] == {'type': 'RUN_ERROR', **error}
        assert not any(event.get('type') == 'RUN_FINISHED' for event in second_events)
        monkeypatch.setattr(agentcore_memory, 'create_event', held.write)
        agentcore_memory.listed.clear()
        assert send('recovery', [{'id': 'recovery', 'role': 'user', 'content': 'recovery'}])[-1]['type'] == 'RUN_FINISHED'
        assert agentcore_memory.listed
        assert 'second question' not in service.recorder.heard[-1]
    else:
        assert first_events[-1]['type'] == second_events[-1]['type'] == 'RUN_FINISHED'
        monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
        assert _replay('user-1', 'thread-1')[-4:] == [
            ('user', 'first question'), ('assistant', 'Echo: first question'),
            ('user', 'second question'), ('assistant', 'Echo: second question'),
        ]


def test_a_sandbox_isolated_by_session_filing_keeps_its_own_rotating_token(service: _Service) -> None:
    service.turn('hello', user='first-filing', env={'TOKEN': 'first'})
    first_agent = next(iter(serving._AGENTS.values()))
    first_backend = serving._BACKEND_BY_AGENT[first_agent]
    service.turn('hello', user='second-filing', env={'TOKEN': 'second'})
    second_agent = list(serving._AGENTS.values())[-1]
    second_backend = serving._BACKEND_BY_AGENT[second_agent]

    assert first_backend is not second_backend
    assert first_backend._env['TOKEN'] == 'first'
    assert second_backend._env['TOKEN'] == 'second'
    service.turn('hello', user='first-filing', env={'TOKEN': 'refreshed'})
    assert first_backend._env['TOKEN'] == 'refreshed'
    assert second_backend._env['TOKEN'] == 'second'


def test_cached_warmup_skips_history_for_startup_and_leaves_live_token_unchanged(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    service.turn('hello', env={'TOKEN': 'live'})
    agent = next(iter(serving._AGENTS.values()))
    backend = serving._BACKEND_BY_AGENT[agent]
    builds = len(service.recorder.builds)
    reads: list[Any] = []
    assert serving._CHECKPOINTER is not None
    original = serving._CHECKPOINTER.aget_tuple

    async def read(config: Any) -> Any:
        reads.append(config)
        return await original(config)

    monkeypatch.setattr(serving._CHECKPOINTER, 'aget_tuple', read)
    startup = service.turn('hello', warmup=True, preparationScope='startup', env={'TOKEN': 'warmup'})
    assert startup[-1]['value']['outcome'] == 'prepared'
    assert reads == []
    recorded = service.turn('hello', warmup=True, preparationScope='recorded', env={'TOKEN': 'warmup'})
    assert recorded[-1]['value']['outcome'] == 'prepared'
    assert reads
    expected = turn_lifecycle.session_config(('user-1', 'thread-1')).get('configurable', {})
    assert all(all(config['configurable'][key] == value for key, value in expected.items()) for config in reads)
    assert backend._env['TOKEN'] == 'live'
    assert len(service.recorder.builds) == builds


def test_a_recorded_warmup_with_local_memory_prepares(service: _Service) -> None:
    service.turn('hello', memory=True)

    events = service.turn('hello', memory=True, warmup=True, preparationScope='recorded')

    assert events[-1]['value']['outcome'] == 'prepared'


def test_opening_turn_reaches_the_anthropic_messages_endpoint(service: _Service, monkeypatch: pytest.MonkeyPatch) -> None:
    requests = []

    def messages(request: httpx2.Request) -> httpx2.Response:
        payload = json.loads(request.content)
        requests.append((request.url.path, payload))
        if not payload['messages']:
            return httpx2.Response(400, json={'type': 'error', 'error': {
                'type': 'invalid_request_error', 'message': 'messages: at least one message is required',
            }})
        frames = [
            ('message_start', {'message': {'id': 'message-1', 'type': 'message', 'role': 'assistant',
                                            'content': [], 'model': 'claude-test', 'usage': {'input_tokens': 10, 'output_tokens': 0}}}),
            ('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': 'Welcome!'}}),
            ('content_block_stop', {'index': 0}),
            ('message_stop', {}),
        ]
        return httpx2.Response(200, headers={'content-type': 'text/event-stream'}, content=''.join(
            f'event: {kind}\ndata: {json.dumps(dict(data, type=kind))}\n\n' for kind, data in frames
        ))

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(messages))
    monkeypatch.setattr("langchain_anthropic.chat_models._get_default_async_httpx_client", lambda **_kwargs: client)
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: ChatAnthropic(
        model_name='claude-test', base_url='https://messages.test', api_key='fixture',
    ))
    events = service.post({
        'threadId': 'opening-messages', 'runId': 'opening-messages-1', 'messages': [], 'tools': [],
        'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1', 'opening': True},
    })
    assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
    assert _said(events) == 'Welcome!'
    [(path, payload)] = requests
    assert path == '/v1/messages'
    [instruction] = payload['messages']
    assert instruction['role'] == 'user'
    assert 'opening greeting instruction in <writing>' in str(instruction['content'])
    assert '<chat_opened>' not in str(payload['system'])
    assert _replay('user-1', 'opening-messages') == [('assistant', 'Welcome!')]


def test_opening_turn_streams_without_a_user_message_and_cannot_reopen_saved_history(service: _Service) -> None:
    run = {
        'threadId': 'opening-chat', 'runId': 'opening-1', 'messages': [], 'tools': [],
        'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1', 'opening': True},
    }
    events = service.post(run)
    assert events[0]['type'] == 'RUN_STARTED'
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert any(event.get('delta') == 'Hi! I can remember what matters to you.' for event in events)
    [[instruction]] = service.recorder.heard
    assert 'opening greeting instruction in <writing>' in instruction
    assert _replay('user-1', 'opening-chat') == [('assistant', 'Hi! I can remember what matters to you.')]
    assert 'opening greeting instruction in <writing>' not in service.recorder.prompts[0]
    reopened = service.post({**run, 'runId': 'opening-2'})
    assert reopened[-1] == {'type': 'RUN_ERROR', 'message': 'This Session already has a Turn',
                            'code': 'SESSION_OPENING_ALREADY_STARTED'}
    assert len(service.recorder.prompts) == 1
    continuing = service.turn('say: Thank you', thread='opening-chat')
    assert continuing[-1]['type'] == 'RUN_FINISHED'
    assert any(event.get('delta') == 'Thank you' for event in continuing)
    assert service.recorder.prompts[-1] == service.recorder.prompts[0]


def test_opening_turn_keeps_its_instruction_out_of_memory(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    thread = 'opening-with-memory'
    events = service.post({
        'threadId': thread, 'runId': 'opening-1', 'messages': [], 'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1', 'opening': True, 'memory': True,
                           'turnIdentity': turn_identity('actor-1', 'user-1', thread)},
    })
    assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
    assert _said(events) == 'Hi! I can remember what matters to you.'
    service.fed()
    assert _fed_events(agentcore_memory, 'actor-1', thread) == []

    events = service.turn('say: Thank you', thread=thread, memory=True)
    assert events[-1]['type'] == 'RUN_FINISHED', events[-1]
    service.fed()
    assert _fed_events(agentcore_memory, 'actor-1', thread) == [
        [('USER', 'say: Thank you')], [('ASSISTANT', 'Thank you')],
    ]


def test_opening_turn_rejects_a_synthetic_user_message(service: _Service) -> None:
    events = service.turn('hello', opening=True)
    assert events[-1] == {'type': 'RUN_ERROR', 'message': 'An opening Turn cannot contain messages',
                          'code': 'SESSION_OPENING_ALREADY_STARTED'}
    assert service.recorder.prompts == []


@pytest.mark.parametrize('first_name', ['Ada', None])
def test_opening_uses_the_page_name_and_skips_a_pitch_without_memory(service: _Service, first_name: str | None) -> None:
    events = service.post({
        'threadId': 'opening-with-profile', 'runId': 'opening-profile-1', 'messages': [],
        'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1', 'opening': True,
                           **({'openingFirstName': first_name} if first_name is not None else {})},
    })
    assert events[-1]['type'] == 'RUN_FINISHED'
    [[instruction]] = service.recorder.heard
    assert '<extracted_memory>' not in service.recorder.prompts[0]
    assert 'If Memory is empty, skip the Memory pitch; never invent one.' in instruction
    if first_name is not None:
        assert 'The user\'s first name is "Ada".' in instruction
    else:
        assert 'The user\'s first name is' not in instruction


def test_the_files_bound_serving_graph_registers_no_publish_tool(
    service: _Service, files_bucket: Any,
) -> None:
    events = service.turn('hello', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.tools[0] and 'publish' not in service.recorder.tools[0]


@pytest.mark.parametrize('kind', ['page', 'slides', 'doc', 'sheet', 'email'])
def test_the_artifact_type_file_reaches_the_agent(
    service: _Service, files_bucket: Any, kind: str,
) -> None:
    page = f'{artifact.SKILLS_SOURCE}artifacts/{kind}.md'

    events = service.turn(f'read: {page}', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    prompt = service.recorder.prompts[0]
    assert '- artifacts:' not in prompt
    assert page in prompt
    assert '- grounding:' in prompt
    read = _tool_output(events)
    assert read
    assert (artifact.SKILLS / 'artifacts' / f'{kind}.md').read_text().splitlines()[2] in read
    assert not any('SKILL.md' in key for key in _keys(files_bucket))
    refused = _tool_output(service.turn('write: /botcube-harness-deepagents/skills/artifacts/notes.md: mine', files=_files()))
    assert 'read-only' in refused
    assert not (artifact.SKILLS / 'artifacts' / 'notes.md').exists()


def test_steering_control_joins_the_running_turn_and_persists_inline(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered, release = threading.Event(), threading.Event()
    original = _ScriptedModel._stream

    def held(model: _ScriptedModel, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        yield from original(model, messages, *args, **kwargs)
        if len(model.recorder.heard) == 1:
            entered.set()
            assert release.wait(10), 'The test did not release the model'

    monkeypatch.setattr(_ScriptedModel, '_stream', held)
    control = {
        'threadId': 'thread-1', 'runId': 'steering-message',
        'messages': [{'id': 'steering-message', 'role': 'user', 'content': 'Use last month'}],
        'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'steering': True, 'sessionUserId': 'user-1'},
    }
    with ThreadPoolExecutor(max_workers=1) as pool:
        work = pool.submit(service.turn, 'run: echo work-kept')
        try:
            assert entered.wait(5)
            other = {**control, 'forwardedProps': {'steering': True, 'sessionUserId': 'another-user'}}
            response = service.client.post('/invocations', json=other)
            assert _sse_events(response.text)[0]['value'] == {'accepted': False}
            response = service.client.post('/invocations', json=control)
            assert _sse_events(response.text)[0]['value'] == {'accepted': True}
            assert not work.done()
        finally:
            release.set()
        events = work.result(timeout=10)
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.heard[-1] == ['run: echo work-kept', 'Use last month']
    assert any(event['type'] == 'TOOL_CALL_RESULT' and 'work-kept' in event['content'] for event in events)
    starts = [event for event in events if event['type'] == 'TEXT_MESSAGE_START' and event['role'] == 'user']
    assert [event['messageId'] for event in starts] == ['steering-message']
    replay = _replay('user-1', 'thread-1')
    assert ('user', 'Use last month') in replay
    assert ('assistant', 'Echo: Use last month') in replay
    late = service.client.post('/invocations', json=control)
    assert _sse_events(late.text)[0]['value'] == {'accepted': False}


def test_withdraw_control_removes_waiting_steering_until_a_model_step_takes_it(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    steps = [threading.Event(), threading.Event()]
    release = threading.Event()
    original = _ScriptedModel._stream

    def held(model: _ScriptedModel, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        yield from original(model, messages, *args, **kwargs)
        steps[len(model.recorder.heard) - 1].set()
        assert release.wait(10), 'The test did not release the model'
        release.clear()

    def control(props: dict[str, Any], message: dict[str, str] | None = None) -> Any:
        response = service.client.post('/invocations', json={
            'threadId': 'thread-1', 'runId': 'control', 'messages': [message] if message else [],
            'tools': [], 'context': [], 'state': {}, 'forwardedProps': {**props, 'sessionUserId': 'user-1'},
        })
        return _sse_events(response.text)[0]['value']

    def steer(message_id: str, content: str) -> Any:
        return control({'steering': True}, {'id': message_id, 'role': 'user', 'content': content})

    monkeypatch.setattr(_ScriptedModel, '_stream', held)
    with ThreadPoolExecutor(max_workers=1) as pool:
        work = pool.submit(service.turn, 'run: echo work-kept')
        try:
            assert steps[0].wait(5)
            assert steer('dropped', 'Use last year') == {'accepted': True}
            assert control({'withdrawSteering': 'dropped'}) == {'withdrawn': True}
            assert steer('dropped', 'Use last year') == {'accepted': True}
            assert steer('kept', 'Use last month') == {'accepted': True}
            release.set()
            assert steps[1].wait(5)
            assert control({'withdrawSteering': 'kept'}) == {'withdrawn': False}
        finally:
            release.set()
        events = work.result(timeout=10)
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.heard[-1] == ['run: echo work-kept', 'Use last month']
    starts = [event for event in events if event['type'] == 'TEXT_MESSAGE_START' and event['role'] == 'user']
    assert [event['messageId'] for event in starts] == ['kept']
    assert control({'withdrawSteering': 'kept'}) == {'withdrawn': True}


def test_plan_default_and_explicit_medium_do_not_share_a_cached_model(service: _Service) -> None:
    with serving_relay() as relay:
        service.turn('Say exactly: hello', model='openai-plan:gpt-6-luna', relay=relay.url)
        service.turn('Say exactly: hello', model='openai-plan:gpt-6-luna', effort='medium', relay=relay.url)
        service.turn('Say exactly: hello', model='openai-plan:gpt-6-luna', relay=relay.url)

    assert [call['body']['reasoning'] for call in relay.calls] == [
        {'summary': 'auto'}, {'summary': 'auto', 'effort': 'medium'}, {'summary': 'auto'},
    ]


@pytest.mark.parametrize(('answer', 'retained'), [
    ('Inventory outlook is unavailable. Authorization: Bearer synthetic-secret-token',
     'Inventory outlook is unavailable. Authorization: [redacted] [redacted]'),
    ('The market is strong. Authorization: Bearer synthetic-secret-token',
     'The market is strong. Authorization: [redacted] [redacted]'),
    ("printf '%s' 'Cookie: a=first-secret; ExampleLogin=opaque-cookie-secret' data=1.25",
     "printf '%s' 'Cookie: [redacted]' data=1.25"),
    ('printf "%s" "Cookie: a=first-secret; ExampleLogin=opaque-cookie-secret" data=1.25',
     'printf "%s" "Cookie: [redacted]" data=1.25'),
])
def test_retained_final_answer_has_the_turn_identity(
    service: _Service, caplog: pytest.LogCaptureFixture, answer: str, retained: str,
) -> None:
    from opentelemetry import trace
    from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_output')
    context = SpanContext(int('1' * 32, 16), int('2' * 16, 16), False, TraceFlags(1))
    with trace.use_span(NonRecordingSpan(context)):
        events = service.turn(f'say: {answer}')
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == answer
    rows = [json.loads(record.getMessage()) for record in caplog.records
            if record.name == 'botcube_harness_deepagents.turn_output']
    assert len(rows) == 1
    assert rows[0]['traceId'] == '1' * 32
    assert rows[0]['spanId'] == '2' * 16
    assert rows[0]['output'] == retained


@pytest.mark.parametrize('prompt', ['say: ', 'narrated work'])
def test_retained_final_answer_excludes_failed_turns_and_tool_narration(
    service: _Service, caplog: pytest.LogCaptureFixture, prompt: str,
) -> None:
    from opentelemetry import trace
    from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_output')
    context = SpanContext(1, 2, False, TraceFlags(1))
    with trace.use_span(NonRecordingSpan(context)):
        events = service.turn(prompt)
    rows = [json.loads(record.getMessage()) for record in caplog.records
            if record.name == 'botcube_harness_deepagents.turn_output']
    if prompt == 'say: ':
        assert events[-1]['type'] == 'RUN_ERROR'
        assert rows == []
    else:
        assert events[-1]['type'] == 'RUN_FINISHED'
        assert [row['output'] for row in rows] == ['Both checks finished.']


def test_retained_final_answer_strips_the_invocation_header(
    service: _Service, caplog: pytest.LogCaptureFixture,
) -> None:
    from opentelemetry import trace
    from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

    caplog.set_level(logging.INFO, logger='botcube_harness_deepagents.turn_output')
    context = SpanContext(1, 2, False, TraceFlags(1))
    with trace.use_span(NonRecordingSpan(context)):
        response = service.client.post('/invocations', json={
            'threadId': 'thread-1', 'runId': 'retained-output',
            'messages': [{'id': 'question', 'role': 'user', 'content': 'say: The value is opaque-private-invocation-value.'}],
            'tools': [], 'context': [], 'state': {},
            'forwardedProps': {'actorId': 'actor-1', 'sessionUserId': 'user-1'},
        }, headers={'X-BotCube-Credential-Invocation': 'opaque-private-invocation-value'})
    assert response.status_code == 200
    events = _sse_events(response.text)
    assert events[-1]['type'] == 'RUN_FINISHED'
    rows = [json.loads(record.getMessage()) for record in caplog.records
            if record.name == 'botcube_harness_deepagents.turn_output']
    assert [row['output'] for row in rows] == ['The value is [redacted].']


def test_unreachable_efs_finishes_plain_answers_and_bounds_file_tool_errors(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botcube_harness_deepagents import lazy_files
    from botcube_harness_deepagents.files_mount import FilesMount

    release = threading.Event()

    def unavailable(self: FilesMount, root: Path, excluded: object = ()) -> None:
        assert release.wait(2)

    monkeypatch.setattr(FilesMount, 'pull', unavailable)
    monkeypatch.setattr(lazy_files, 'EFS_READY_TIMEOUT', 0.02)
    files = {
        'fileSystemId': 'fs-00000000000000001', 'accessPointId': 'fsap-00000000000000001',
        'mountTargetIp': '192.0.2.12', 'region': 'us-east-1', 'accessKeyId': 'key',
        'secretAccessKey': 'secret', 'sessionToken': 'token', 'expiration': '2099-01-01T00:00:00Z',
    }
    try:
        plain = service.turn('hello', files=files)
        assert plain[-1]['type'] == 'RUN_FINISHED'
        assert _said(plain) == 'Echo: hello'
        failed = service.turn(f'ls: {serving._workspace()}', files=files)
        assert failed[-1]['type'] == 'RUN_ERROR'
        assert failed[-1]['code'] == 'FILES_MOUNT'
        assert 'deadline' in failed[-1]['message']
    finally:
        release.set()


def test_system_prompt_matches_the_approved_target_with_the_served_type_directory() -> None:
    target = Path(__file__).parent / 'fixtures/agent-system-prompt.txt'
    assert target.read_text().rstrip('\n').replace('{artifacts}', f'{artifact.SKILLS_SOURCE}artifacts') == serving.AGENT_SYSTEM_PROMPT


@pytest.mark.integration
def test_a_plan_turn_keeps_every_part_when_reasoning_items_restart_the_summary_index(service: _Service) -> None:
    expected = [
        '**Compare funding paths**\n\nThe first item has a complete summary. Discount every dated equity cash flow.',
        '**Check the tax branch**\n\nThe next item restarts its summary index at zero. Keep this whole paragraph.',
        '**Verify the final result**\n\nThe second part belongs to the next item. Its final sentence must survive replay.',
    ]
    with serving_relay() as relay:
        relay.reply = RelayReply(body=(Path(__file__).parent / 'fixtures' / 'openai-multi-item-reasoning-stream.sse').read_bytes())
        events = service.turn('Say exactly: hello', model='openai-plan:gpt-6.1-sol', relay=relay.url)

    assert events[-1]['type'] == 'RUN_FINISHED'
    streamed = {}
    for event in events:
        if event['type'] == 'REASONING_MESSAGE_CONTENT':
            key = event['messageId']
            streamed[key] = streamed.get(key, '') + event['delta']
    assert list(streamed.values()) == expected
    replay = asyncio.run(session_api.handle({'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1'}))['messages']
    thoughts = [message for message in replay if message['role'] == 'reasoning']
    assert [message['content'] for message in thoughts] == expected
    assert [message['id'] for message in thoughts] == list(streamed)
