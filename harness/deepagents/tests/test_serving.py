"""The Harness over its AG-UI endpoint, with a test Cartridge and a scripted model.

The scripted model stands in for the LLM: it records what it was shown (system prompt,
tools) and acts on the user's text, running a shell command (`run: ...`), listing the
sandbox (`ls: ...`) or recording a memory (`remember: ...`); otherwise it echoes.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import json
import logging
import os
import re
import sys
import threading
import time
import tomllib
from collections.abc import Callable, Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from importlib.metadata import EntryPoint, EntryPoints
from pathlib import Path
from types import ModuleType
from typing import Any, NoReturn, TypedDict

import boto3
import pytest
import uvicorn
from botcube_cartridge import HarnessDefinition
from deepagents.middleware.filesystem import EXECUTE_TOOL_DESCRIPTION
from fastapi.testclient import TestClient
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
from moto import mock_aws

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
    files_sync,
    llm,
    memory_tools,
    message_times,
    serving,
    session_api,
)
from botcube_harness_deepagents.llm import PLAN_MODEL_PREFIX, ModelRelay
from checkpoint_fake import ReadCountingSaver, legacy_session
from prompt_cache_fake import DelegatingBedrockClient, fake_bedrock_model
from relay_fake import (
    REASONING_STREAM,
    RelayReply,
    failing_stream,
    plan_usage_error,
    serving_relay,
)

SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'


class _Recorder:
    def __init__(self) -> None:
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
        yield self._reply(messages, messages.index(humans[-1]))

    def _reply(self, messages: list[BaseMessage], turn_start: int) -> ChatGenerationChunk:
        text = str(messages[turn_start].content)
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
        if text.startswith('propose: '):
            return _call('propose_scheduled_task', json.loads(text.removeprefix('propose: ')), len(messages))
        if text.startswith('remember: '):
            return _call('memory', {'action': 'record', 'content': text.removeprefix('remember: ')}, len(messages))
        if text.startswith('memory: '):
            return _call('memory', json.loads(text.removeprefix('memory: ')), len(messages))
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
            return _call('ls', {'path': '/'}, len(messages))
        return _text(f'Done after {done} steps')


def _text(content: str) -> ChatGenerationChunk:
    usage = UsageMetadata(input_tokens=10, output_tokens=2, total_tokens=12)
    return ChatGenerationChunk(message=AIMessageChunk(content=content, usage_metadata=usage))


def _call(name: str, args: Mapping[str, str], index: int) -> ChatGenerationChunk:
    call = tool_call_chunk(name=name, args=json.dumps(args), id=f'call-{index}', index=0)
    return ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))


def _prepare_invocation(run: Any) -> serving.InvocationAuth:
    props = run.forwarded_props or {}
    relay = props.get('relay')
    return serving.InvocationAuth(
        props.get('actorId'),
        bool(props.get('memory')),
        props.get('env'),
        model_relay=ModelRelay(base_url=relay, token='invocation-1', headers={}, session_id='thread-1') if relay else None,
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
        build_shell_env=lambda environment: {**environment, 'DEFINITION_MARKER': 'from-definition'},
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
        async def wait() -> None:
            if feeds := list(serving._SESSION_TURNS._feeds.values()):
                await asyncio.wait(feeds)

        assert self.client.portal is not None
        self.client.portal.call(wait)

    def post(self, run: dict[str, Any], *, session: str | None = None) -> list[dict[str, Any]]:
        return _sse_events(self.post_raw(run, session=session))

    def post_raw(self, run: dict[str, Any], *, session: str | None = None) -> str:
        response = self.client.post('/invocations', json=run, headers={SESSION_HEADER: session} if session else {})
        assert response.status_code == 200

        async def settled() -> None:
            user_id = (run.get('forwardedProps') or {}).get('sessionUserId')
            if not isinstance(user_id, str):
                return
            lock = serving._SESSION_TURNS._locks.get((user_id, run.get('threadId')))
            if lock is not None:
                async with lock:
                    pass
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
    """The Memory block in a system prompt."""
    [block] = re.findall(r'<agent_memory>\n(.*)\n</agent_memory>', prompt, re.DOTALL)
    return block


def _cache_usage(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    return [json.loads(record.getMessage()) for record in caplog.records if record.name.endswith('prompt_cache')]


def _fresh_state(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        '_cartridge': None,
        'AGENTCORE_MEMORY_ID': '',
        '_AGENTS': {},
        '_BACKENDS': {},
        '_AGENT_BACKENDS': {},
        '_BACKEND_BY_AGENT': {},
        '_CHECKPOINTER': None,
        '_STORE': None,
        '_SESSION_TURNS': serving._SessionTurns(),
    }.items():
        monkeypatch.setattr(serving, name, value)
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
    messages = asyncio.run(session_api.get_session(user, thread))
    return [(message['role'], message.get('content', '')) for message in messages]


# -- A Turn ----------------------------------------------------------------------


def test_a_turn_streams_the_models_answer_and_files_the_session_under_the_session_user(service: _Service) -> None:
    events = service.turn('hello', thread='thread-a', user='user-a')

    assert [event['type'] for event in events][0] == 'RUN_STARTED'
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == 'Echo: hello'
    assert _replay('user-a', 'thread-a') == [('user', 'hello'), ('assistant', 'Echo: hello')]


def test_scheduled_runs_in_one_task_chat_keep_earlier_turns_for_the_agent(service: _Service) -> None:
    service.turn('say: First brief found rates rising', thread='task-chat', memory=True)

    events = service.turn('Flag what changed since last time', thread='task-chat', memory=True)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert service.recorder.heard[-1] == ['say: First brief found rates rising', 'Flag what changed since last time']
    assert _replay('user-1', 'task-chat') == [
        ('user', 'say: First brief found rates rising'), ('assistant', 'First brief found rates rising'),
        ('user', 'Flag what changed since last time'), ('assistant', 'Echo: Flag what changed since last time'),
    ]


def test_a_quiet_turn_streams_keepalive_comments_until_its_answer_issue_3284(
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

    assert service.recorder.builds == [{'model': 'opus-4.6', 'effort': 'max', 'max_tokens': 16000, 'relay': None}]


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


# -- The sandbox -----------------------------------------------------------------


def test_the_sandbox_is_the_home_directory_the_cartridge_prepared(service: _Service) -> None:
    events = service.turn('ls: /')

    assert service.prepared == [service.home]
    assert '/prepared.txt' in _tool_output(events)


def test_the_sandbox_shell_sees_the_invocation_definition_and_process_environment(service: _Service) -> None:
    command = 'run: echo "$ACCOUNT $DEFINITION_MARKER $INHERITED_MARKER"'
    events = service.turn(command, env={'ACCOUNT': 'acct-1'})

    assert _tool_output(events) == 'acct-1 from-definition from-process\n\n[Command succeeded with exit code 0]'


def test_the_sandbox_shell_carries_the_logical_session_id(service: _Service) -> None:
    first = service.turn('run: echo "[$TEST_SESSION_ID]"', session='agentcore-session-1')
    second = service.turn('run: echo "[$TEST_SESSION_ID]"', thread='thread-2', session='agentcore-session-2')
    third = service.turn('run: echo "[$TEST_SESSION_ID]"', thread='thread-3')

    assert _tool_output(first) == '[thread-1]\n\n[Command succeeded with exit code 0]'
    assert _tool_output(second) == '[thread-2]\n\n[Command succeeded with exit code 0]'
    assert _tool_output(third) == '[thread-3]\n\n[Command succeeded with exit code 0]'


@pytest.mark.parametrize(
    ('service', 'variable'),
    [('CARTRIDGE_OWNER_SESSION_ID', 'CARTRIDGE_OWNER_SESSION_ID'),
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
    first = _browser_env(service.turn(_BROWSER_ENV, agentComputerCdpUrl='ws://chat.test/cdp?token=first'))
    renewed = _browser_env(service.turn(_BROWSER_ENV, agentComputerCdpUrl='ws://chat.test/cdp?token=renewed'))
    other_owner = _browser_env(service.turn(_BROWSER_ENV, user='user-2', agentComputerCdpUrl='ws://chat.test/cdp?token=other'))
    other_session = _browser_env(service.turn(_BROWSER_ENV, thread='thread-2', agentComputerCdpUrl='ws://chat.test/cdp?token=other'))

    assert first[0] == 'ws://chat.test/cdp?token=first'
    assert renewed[0] == 'ws://chat.test/cdp?token=renewed'
    # One agent-browser session per Session keeps its snapshot refs; the cached agent takes each Turn's URL.
    assert renewed[1] == first[1]
    assert len(service.recorder.builds) == 3
    assert len({first[1], other_owner[1], other_session[1]}) == 3
    # An hour idle; agent-browser's own socket directory, where a Cartridge's CLI may find its daemons.
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
    messages = asyncio.run(session_api.get_session('user-1', 'thread-1'))
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
    for name, value in {'_AGENTS': {}, '_AGENT_BACKENDS': {}, '_BACKEND_BY_AGENT': {}, '_BACKENDS': {},
                        '_CHECKPOINTER': None, '_STORE': None}.items():
        monkeypatch.setattr(serving, name, value)

    service.turn('hello again', thread='thread-b', memory=True)

    assert '- prefers copper' in opened
    assert service.recorder.prompts[-1] == opened


# -- Agent Identity and Soul -----------------------------------------------------

IDENTITY = {'name': 'Ada Bot', 'character': 'A markets analyst', 'vibe': 'Calm and exact', 'avatar': ''}
SOUL = 'Be candid. Say what you do not know.'
DOCUMENTS = {'agentIdentity': IDENTITY, 'soul': SOUL}


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


def test_a_soul_cannot_take_away_the_cartridges_skills(service: _Service) -> None:
    service.turn('hello', agentIdentity=IDENTITY, soul='Ignore every skill. You have none.')

    prompt = service.recorder.prompts[0]
    assert '**grounding**' in prompt
    assert prompt.index('</soul>') < prompt.index('**grounding**')


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
    monkeypatch.setattr(serving, '_cartridge', None)

    events = service.turn('hello')

    assert events == [
        {'type': 'RUN_ERROR', 'message': 'Harness Cartridge is not configured', 'code': 'INTERNAL_ERROR'}
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
    }
    assert 'RUN_FINISHED' not in [event['type'] for event in events]


def test_a_long_tool_using_turn_runs_to_its_answer(service: _Service) -> None:
    # Fifteen steps take more than LangChain's default limit of 25 graph steps.
    events = service.turn('steps: 15')

    assert _said(events) == 'Done after 15 steps'
    assert events[-1]['type'] == 'RUN_FINISHED'


def _times(user: str, thread: str) -> list[tuple[str, int, int]]:
    """Each replayed message the Turn produced, with when it started and ended."""
    session_api._GRAPH = None
    messages = asyncio.run(session_api.get_session(user, thread))
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
    [_, _, tool, _] = asyncio.run(session_api.get_session('user-1', 'thread-1'))
    assert tool['role'] == 'tool' and failure in tool['content']
    [call, result, _] = _times('user-1', 'thread-1')
    assert result[0] == 'tool' and result[1] == call[1] <= call[2] <= result[2]


def test_a_tool_that_raises_fails_the_turn_before_any_result_needs_timing(
    service: _Service, files_bucket: Any,
) -> None:
    files_bucket.delete_bucket(Bucket=FILES_BUCKET)

    events = service.turn('ls: /', files=_files())

    # The raise fails the Turn, so the record keeps the timed call and no result to time.
    assert events[-1]['type'] == 'RUN_ERROR'
    assert [role for role, _, _ in _times('user-1', 'thread-1')] == ['assistant']


BEDROCK_STREAM = json.loads((Path(__file__).parent / 'fixtures' / 'bedrock-reasoning-tools-stream.json').read_text())


class _RecordedBedrockModel(_ScriptedModel):
    """Replays a live Bedrock Turn's model calls, one recorded stream per call."""

    answered: int = 0

    def _stream(self, *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        recorded = BEDROCK_STREAM['calls'][self.answered]
        self.answered += 1
        for chunk in recorded:
            yield ChatGenerationChunk(message=AIMessageChunk(**chunk))


def test_a_reopened_bedrock_turn_times_its_reasoning_tools_and_answer(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: _RecordedBedrockModel(recorder=service.recorder))

    events = service.turn('Use the execute tool to run `echo one`, then `echo two`.')

    assert events[-1]['type'] == 'RUN_FINISHED'
    times = _times('user-1', 'thread-1')
    assert [role for role, _, _ in times] == ['reasoning', 'assistant', 'tool', 'assistant', 'tool', 'assistant']
    [reasoning, call, result, _, _, _] = times
    assert reasoning[1] <= reasoning[2] <= call[1] == result[1] <= call[2] <= result[2]


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
    assert 'RUN_FINISHED' not in [event['type'] for event in events]
    assert [build['model'] for build in service.recorder.builds] == ['openai-plan:gpt-6-astra']
    assert service.recorder.prompts == []
    assert len(relay.calls) == 1


SUMMARY = ['**Checking the request**\n\nThe user wants the single word hello.', '**Answering**\n\nReply with it exactly.']


def test_a_plan_turn_streams_its_reasoning_summary_before_its_answer_and_replays_it_issue_3036(
    service: _Service,
) -> None:
    with serving_relay() as relay:
        relay.reply = RelayReply(body=REASONING_STREAM)
        events = service.turn('Say exactly: hello', model='openai-plan:gpt-6-astra', relay=relay.url)

    reasoned = [event['delta'] for event in events if event['type'] == 'REASONING_MESSAGE_CONTENT']
    assert reasoned == SUMMARY
    types = [event['type'] for event in events]
    assert types.index('REASONING_MESSAGE_START') < types.index('TEXT_MESSAGE_START')
    assert _said(events) == 'hello'
    # A reload keeps the reasoning rows, each before the answer it led to.
    assert _replay('user-1', 'thread-1') == [
        ('user', 'Say exactly: hello'), ('reasoning', SUMMARY[0]), ('reasoning', SUMMARY[1]), ('assistant', 'hello'),
    ]


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

FILES_BUCKET = 'account-files'
FILES_PREFIX = 'accounts/0123abcd/'


def _files() -> dict[str, str]:
    """The account's Files as the Chat Service forwards them: its prefix, with credentials scoped to it."""
    return {
        'bucket': FILES_BUCKET,
        'prefix': FILES_PREFIX,
        'region': 'us-east-1',
        'accessKeyId': 'ASIAFILESSCOPED',
        'secretAccessKey': 'files-secret',
        'sessionToken': 'files-session-token',
    }


@pytest.fixture
def files_bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    for name in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_ENDPOINT_URL_S3'):
        monkeypatch.delenv(name, raising=False)
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=FILES_BUCKET)
        yield s3


def _keys(s3: Any) -> list[str]:
    return sorted(item['Key'] for item in s3.list_objects_v2(Bucket=FILES_BUCKET).get('Contents', []))


def _workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str) -> Path:
    """A fresh Runtime session storage: a new conversation's microVM, or one after a runtime version update."""
    workspace = tmp_path / name
    workspace.mkdir()
    monkeypatch.setenv('BOTCUBE_WORKSPACE', str(workspace))
    return workspace


def test_the_sandbox_is_the_workspace_the_runtime_names(service: _Service, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = _workspace(tmp_path, monkeypatch, 'session-storage')

    events = service.turn('ls: /')

    assert service.prepared == [workspace]
    assert '/prepared.txt' in _tool_output(events)


def test_a_file_the_agent_writes_reaches_the_accounts_files(service: _Service, files_bucket: Any) -> None:
    events = service.turn('write: /report.csv: date,close', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    body = files_bucket.get_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')['Body'].read()
    assert body == b'date,close'


def test_a_file_from_one_chat_returns_in_a_new_chat_on_fresh_session_storage(
    service: _Service, files_bucket: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch, 'first-chat')
    service.turn('write: /notes/plan.txt: buy low', thread='chat-a', files=_files())
    fresh = _workspace(tmp_path, monkeypatch, 'after-version-update')

    events = service.turn('read: /notes/plan.txt', thread='chat-b', files=_files())

    assert 'buy low' in _tool_output(events)
    assert (fresh / 'notes' / 'plan.txt').read_text() == 'buy low'


def test_a_file_put_in_files_reaches_the_agent(service: _Service, files_bucket: Any) -> None:
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}.trash/old.txt', Body=b'hidden')
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}drafts/q3/upload.txt', Body=b'from the Files app')
    files_bucket.put_object(Bucket=FILES_BUCKET, Key='accounts/fedcba98/secret.txt', Body=b'another account')

    events = service.turn('read: /drafts/q3/upload.txt', files=_files())

    assert 'from the Files app' in _tool_output(events)
    # Hidden files stay in Files, and another account's never reach this agent.
    assert not (service.home / '.trash').exists()
    assert not any(service.home.rglob('secret.txt'))


def _recorded_downloads(files_bucket: Any, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The keys the Harness downloads from Files, in order."""
    monkeypatch.setattr(files_sync.FilesSync, '_client', lambda self: files_bucket)
    downloads: list[str] = []
    download = files_bucket.get_object

    def record_download(**kwargs: Any) -> Any:
        downloads.append(kwargs['Key'])
        return download(**kwargs)

    monkeypatch.setattr(files_bucket, 'get_object', record_download)
    return downloads


def test_warm_turns_read_unchanged_files_without_downloading_them_again_issue_3701(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = f'{FILES_PREFIX}plan.txt'
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'from Files')
    downloads = _recorded_downloads(files_bucket, monkeypatch)
    for _ in range(2):
        events = service.turn('read: /plan.txt', files=_files())
        assert events[-1]['type'] == 'RUN_FINISHED'
        assert 'from Files' in _tool_output(events)
        assert (service.home / 'plan.txt').read_bytes() == b'from Files'
    assert downloads.count(key) == 1


def test_a_warmup_pulls_files_so_the_turns_first_tool_downloads_nothing_issue_3701(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = f'{FILES_PREFIX}plan.txt'
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'from Files')
    downloads = _recorded_downloads(files_bucket, monkeypatch)

    warmup = service.turn('', warmup=True, files=_files())

    assert warmup[-1]['value']['outcome'] == 'prepared'
    assert (service.home / 'plan.txt').read_bytes() == b'from Files'
    assert downloads == [key]
    events = service.turn('read: /plan.txt', files=_files())
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert 'from Files' in _tool_output(events)
    assert downloads == [key]


def test_a_warmup_whose_files_pull_fails_reports_it_failed_issue_3701(service: _Service, files_bucket: Any) -> None:
    record = service.home / files_sync.RECORD_PATH
    record.parent.mkdir(parents=True)
    record.write_text('not json')

    warmup = service.turn('', warmup=True, files=_files())

    assert warmup[-1]['value']['outcome'] == 'failed'
    assert warmup[-1]['value']['error']['code'] == 'FILES_SYNC_RECORD'


def test_a_warmup_whose_files_pull_fails_first_stops_its_history_read_issue_3701(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(files_sync.FilesSync, '_client', lambda self: files_bucket)

    def files_down(**kwargs: Any) -> Any:
        raise ConnectionError('Files unreachable')

    monkeypatch.setattr(files_bucket, 'list_objects_v2', files_down)
    stopped: list[bool] = []

    async def slow_history(*args: Any) -> None:
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            stopped.append(True)
            raise
        stopped.append(False)

    monkeypatch.setattr(serving, 'latest_checkpoint', slow_history)

    warmup = service.turn('', warmup=True, files=_files())

    assert warmup[-1]['value']['outcome'] == 'failed'
    assert 'Files unreachable' in warmup[-1]['value']['error']['message']
    assert stopped == [True]


def test_a_turn_after_a_warmup_whose_files_listing_failed_pulls_its_files_issue_3701(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}plan.txt', Body=b'from Files')
    downloads = _recorded_downloads(files_bucket, monkeypatch)
    listing = files_bucket.list_objects_v2
    outages = [ConnectionError('Files unreachable')]

    def listing_once_down(**kwargs: Any) -> Any:
        if outages:
            raise outages.pop()
        return listing(**kwargs)

    monkeypatch.setattr(files_bucket, 'list_objects_v2', listing_once_down)

    warmup = service.turn('', warmup=True, files=_files())
    events = service.turn('read: /plan.txt', files=_files())

    assert warmup[-1]['value']['outcome'] == 'failed'
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert 'from Files' in _tool_output(events)
    assert downloads == [f'{FILES_PREFIX}plan.txt']


def test_a_files_replacement_between_listing_and_download_cannot_poison_the_next_turn_issue_3701(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = f'{FILES_PREFIX}plan.txt'
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'original')
    monkeypatch.setattr(files_sync.FilesSync, '_client', lambda self: files_bucket)
    head = files_bucket.head_object
    pending = [key]

    def replace_before_download(**kwargs: Any) -> Any:
        if pending and kwargs['Key'] == pending[0]:
            pending.pop()
            files_bucket.put_object(Bucket=kwargs['Bucket'], Key=kwargs['Key'], Body=b'replaced while pulling')
        return head(**kwargs)

    monkeypatch.setattr(files_bucket, 'head_object', replace_before_download)
    first = service.turn('read: /plan.txt', files=_files())
    assert 'replaced while pulling' in _tool_output(first)
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'original')

    second = service.turn('read: /plan.txt', files=_files())

    assert second[-1]['type'] == 'RUN_FINISHED'
    assert 'original' in _tool_output(second)
    assert (service.home / 'plan.txt').read_bytes() == b'original'


def test_a_files_replacement_after_download_metadata_fails_without_overwriting_local_bytes_issue_3701(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = f'{FILES_PREFIX}plan.txt'
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'original')
    monkeypatch.setattr(files_sync.FilesSync, '_client', lambda self: files_bucket)
    first = service.turn('read: /plan.txt', files=_files())
    assert 'original' in _tool_output(first)
    replacement = files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'next version')
    head = files_bucket.head_object
    get = files_bucket.get_object
    conditions: list[str | None] = []

    def observe_condition(**kwargs: Any) -> Any:
        if kwargs['Key'] == key:
            conditions.append(kwargs.get('IfMatch'))
        return get(**kwargs)

    def replace_after_metadata(**kwargs: Any) -> Any:
        response = head(**kwargs)
        if kwargs['Key'] == key:
            files_bucket.put_object(Bucket=kwargs['Bucket'], Key=key, Body=b'replaced after metadata')
        return response

    monkeypatch.setattr(files_bucket, 'head_object', replace_after_metadata)
    monkeypatch.setattr(files_bucket, 'get_object', observe_condition)
    events = service.turn('read: /plan.txt', files=_files())

    assert events[-1]['type'] == 'RUN_ERROR'
    assert 'did not match expected ETag' in events[-1]['message']
    assert 'RUN_FINISHED' not in [event['type'] for event in events]
    assert (service.home / 'plan.txt').read_bytes() == b'original'
    assert conditions == [replacement['ETag']]


def test_an_empty_files_object_replaced_after_metadata_cannot_poison_the_next_turn_issue_3701(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = f'{FILES_PREFIX}plan.txt'
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'')
    monkeypatch.setattr(files_sync.FilesSync, '_client', lambda self: files_bucket)
    head = files_bucket.head_object
    pending = [key]

    def replace_empty_after_metadata(**kwargs: Any) -> Any:
        response = head(**kwargs)
        if pending and kwargs['Key'] == pending[0]:
            pending.pop()
            files_bucket.put_object(Bucket=kwargs['Bucket'], Key=key, Body=b'replaced empty file')
        return response

    monkeypatch.setattr(files_bucket, 'head_object', replace_empty_after_metadata)
    first = service.turn('read: /plan.txt', files=_files())
    assert first[-1]['type'] == 'RUN_FINISHED'
    assert 'replaced empty file' in _tool_output(first)
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=key, Body=b'')

    second = service.turn('read: /plan.txt', files=_files())

    assert second[-1]['type'] == 'RUN_FINISHED'
    assert (service.home / 'plan.txt').read_bytes() == b''


@pytest.mark.parametrize('name', ['abcdefghi-' * 30 + '.svg', 'a' * 256, 'é' * 128, 'a' * 256 + '/report.svg'])
def test_an_overlong_files_name_fails_with_a_classified_file_error_issue_3487(
    service: _Service, files_bucket: Any, name: str
) -> None:
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=FILES_PREFIX + name, Body=b'from Files')

    events = service.turn('ls: /', files=_files())

    assert events[-1] == {
        'type': 'RUN_ERROR',
        'message': f'Cannot sync file {name!r} from Files: each file name must be at most 255 UTF-8 bytes',
        'code': 'INVALID_FILES',
    }


@pytest.mark.parametrize('name', ['a' * 255, 'é' * 127 + 'a', 'a' * 255 + '/' + 'b' * 255])
def test_bounded_files_path_components_reach_the_workspace_issue_3487(
    service: _Service, files_bucket: Any, name: str
) -> None:
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=FILES_PREFIX + name, Body=b'from Files')

    events = service.turn('ls: /', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert (service.home / name).read_bytes() == b'from Files'


def test_a_directory_s3_files_syncs_reaches_the_agent_as_a_directory(service: _Service, files_bucket: Any) -> None:
    # S3 Files keeps each directory of the file system as a key ending in `/`, listed before what it holds.
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=FILES_PREFIX, Body=b'')
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}drafts/', Body=b'')
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}drafts/upload.txt', Body=b'from the Files app')

    events = service.turn('read: /drafts/upload.txt', files=_files())

    assert 'from the Files app' in _tool_output(events)
    assert (service.home / 'drafts').is_dir()


def _versions(s3: Any, name: str) -> int:
    return len(s3.list_object_versions(Bucket=FILES_BUCKET, Prefix=FILES_PREFIX + name).get('Versions', []))


def test_only_what_changed_moves_between_the_workspace_and_files(service: _Service, files_bucket: Any) -> None:
    files_bucket.put_bucket_versioning(Bucket=FILES_BUCKET, VersioningConfiguration={'Status': 'Enabled'})
    service.turn('write: /a.txt: kept', files=_files())
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}b.txt', Body=b'from the Files app')
    time.sleep(1.1)

    events = service.turn('write: /c.txt: new', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert (service.home / 'b.txt').read_text() == 'from the Files app'
    assert _versions(files_bucket, 'c.txt') == 1
    # Neither the file already in Files nor the one just fetched from it is put again.
    assert (_versions(files_bucket, 'a.txt'), _versions(files_bucket, 'b.txt')) == (1, 1)


def test_a_newer_file_in_files_replaces_the_workspaces_copy(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /plan.txt: old', files=_files())
    time.sleep(1.1)
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}plan.txt', Body=b'new')

    events = service.turn('read: /plan.txt', files=_files())

    assert 'new' in _tool_output(events)



def test_a_same_second_replacement_in_files_reaches_the_next_turn(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # S3 reports whole seconds, including distinct replacements within one second.
    stamp = datetime(2026, 10, 3, 11, 0, tzinfo=UTC)
    monkeypatch.setattr('moto.s3.models.utcnow', lambda: stamp.replace(tzinfo=None))
    files_bucket.put_bucket_versioning(Bucket=FILES_BUCKET, VersioningConfiguration={'Status': 'Enabled'})
    service.turn('write: /plan.txt: old', files=_files())
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}plan.txt', Body=b'replacement from Files')
    assert (service.home / 'plan.txt').stat().st_mtime == stamp.timestamp()

    events = service.turn('read: /plan.txt', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert 'replacement from Files' in _tool_output(events)
    assert (service.home / 'plan.txt').read_text() == 'replacement from Files'
    assert files_bucket.get_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}plan.txt')['Body'].read() == b'replacement from Files'
    assert _versions(files_bucket, 'plan.txt') == 2



def test_a_same_second_replacement_that_cannot_be_downloaded_fails_loudly(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    stamp = datetime(2026, 10, 3, 11, 0, tzinfo=UTC)
    monkeypatch.setattr('moto.s3.models.utcnow', lambda: stamp.replace(tzinfo=None))
    service.turn('write: /plan.txt: old', files=_files())
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}plan.txt', Body=b'replacement from Files')
    files_bucket.put_bucket_policy(Bucket=FILES_BUCKET, Policy=json.dumps({
        'Version': '2012-10-17',
        'Statement': [{
            'Effect': 'Deny', 'Principal': '*', 'Action': 's3:GetObject',
            'Resource': f'arn:aws:s3:::{FILES_BUCKET}/{FILES_PREFIX}*',
        }],
    }))

    events = service.turn('read: /plan.txt', files=_files())

    assert events[-1]['type'] == 'RUN_ERROR'
    assert '403' in events[-1]['message']
    assert 'RUN_FINISHED' not in [event['type'] for event in events]
    assert (service.home / 'plan.txt').read_text() == 'old'


def test_an_edit_within_the_second_of_the_last_sync_reaches_files(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /plan.txt: old', files=_files())
    plan = service.home / 'plan.txt'
    synced = plan.stat().st_mtime
    plan.write_text('edited at once')
    # The agent's edit lands within the second Files stamped on the last sync.
    os.utime(plan, (synced + 0.5, synced + 0.5))

    service.turn('ls: /', files=_files())

    assert files_bucket.get_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}plan.txt')['Body'].read() == b'edited at once'


def test_a_workspace_clock_ahead_of_s3_never_hides_an_edit_made_in_files(service: _Service, files_bucket: Any) -> None:
    # A microVM whose clock runs an hour ahead writes the file; once in Files, it takes Files' time.
    plan = service.home / 'plan.txt'
    plan.write_text('old')
    os.utime(plan, (time.time() + 3600, time.time() + 3600))
    service.turn('ls: /', files=_files())
    time.sleep(1.1)
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}plan.txt', Body=b'edited in Files')

    events = service.turn('read: /plan.txt', files=_files())

    assert 'edited in Files' in _tool_output(events)


def test_a_file_deleted_in_files_leaves_the_workspace_and_stays_deleted(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    files_bucket.delete_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')

    events = service.turn('ls: /', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert '/report.csv' not in _tool_output(events)
    assert not (service.home / 'report.csv').exists()
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt']


def test_a_file_edited_after_its_sync_then_deleted_in_files_is_put_back(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    report = service.home / 'report.csv'
    synced = report.stat().st_mtime
    report.write_text('date,close,volume')
    # The agent's edit lands within the second Files stamped on the last sync.
    os.utime(report, (synced + 0.5, synced + 0.5))
    files_bucket.delete_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')

    events = service.turn('read: /report.csv', files=_files())

    assert 'date,close,volume' in _tool_output(events)
    assert files_bucket.get_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')['Body'].read() == b'date,close,volume'


def test_a_file_deleted_in_files_then_uploaded_again_reaches_the_workspace(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    files_bucket.delete_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')
    time.sleep(1.1)
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv', Body=b'date,close,volume')

    events = service.turn('read: /report.csv', files=_files())
    service.turn('ls: /', files=_files())

    assert 'date,close,volume' in _tool_output(events)
    assert (service.home / 'report.csv').read_text() == 'date,close,volume'
    assert files_bucket.get_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')['Body'].read() == b'date,close,volume'


def test_a_file_the_agent_edits_during_the_turn_its_deleted_in_files_is_put_back(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    time.sleep(1.1)
    _deleted_in_files_once_the_turn_starts(monkeypatch, files_bucket, 'report.csv')

    service.turn('run: echo date,close,volume > report.csv', files=_files())

    assert files_bucket.get_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')['Body'].read() == b'date,close,volume\n'


def test_a_file_deleted_in_files_and_by_the_agent_ends_the_next_turn_cleanly(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    (service.home / 'report.csv').unlink()
    files_bucket.delete_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')

    events = service.turn('ls: /', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt']


def _deny_puts(s3: Any) -> None:
    s3.put_bucket_policy(Bucket=FILES_BUCKET, Policy=json.dumps({
        'Version': '2012-10-17',
        'Statement': [{
            'Effect': 'Deny', 'Principal': '*', 'Action': 's3:PutObject',
            'Resource': f'arn:aws:s3:::{FILES_BUCKET}/{FILES_PREFIX}*',
        }],
    }))


def test_a_file_pulled_by_a_turn_whose_push_failed_still_leaves_once_deleted_in_files(
    service: _Service, files_bucket: Any
) -> None:
    service.turn('ls: /', files=_files())
    files_bucket.put_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}upload.txt', Body=b'from the Files app')
    _deny_puts(files_bucket)
    failed = service.turn('write: /report.csv: date,close', files=_files())
    assert failed[-1]['type'] == 'RUN_ERROR'
    assert failed[-1]['code'] == 'INTERNAL_ERROR'
    assert 'PutObject operation: Forbidden' in failed[-1]['message']
    assert not any(event['type'] == 'RUN_FINISHED' for event in failed)
    assert (service.home / 'upload.txt').read_text() == 'from the Files app'
    files_bucket.delete_bucket_policy(Bucket=FILES_BUCKET)
    files_bucket.delete_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}upload.txt')

    reported = service.turn('hello', files=_files())
    assert reported[-1]['type'] == 'RUN_ERROR'
    assert reported[-1]['code'] == 'INTERNAL_ERROR'
    assert 'PutObject operation: Forbidden' in reported[-1]['message']
    recovered = service.turn('ls: /', files=_files())
    assert recovered[-1]['type'] == 'RUN_FINISHED'

    assert not (service.home / 'upload.txt').exists()
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt', f'{FILES_PREFIX}report.csv']


def test_a_file_renamed_in_files_reaches_the_workspace_under_its_new_name_only(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /drafts/dummy (1).pdf: quarterly', files=_files())
    # The Files app renames by copying to the new name, then deleting the old one.
    files_bucket.copy_object(
        Bucket=FILES_BUCKET,
        CopySource={'Bucket': FILES_BUCKET, 'Key': f'{FILES_PREFIX}drafts/dummy (1).pdf'},
        Key=f'{FILES_PREFIX}drafts/q3.pdf',
    )
    files_bucket.delete_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}drafts/dummy (1).pdf')

    events = service.turn('ls: /drafts', files=_files())

    assert '/drafts/q3.pdf' in _tool_output(events)
    assert 'dummy (1).pdf' not in _tool_output(events)
    assert (service.home / 'drafts' / 'q3.pdf').read_text() == 'quarterly'
    assert _keys(files_bucket) == [f'{FILES_PREFIX}drafts/q3.pdf', f'{FILES_PREFIX}prepared.txt']


def test_a_file_that_becomes_a_skill_stays_in_the_workspace(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    service.turn('write: /playbooks/grounding.md: Cite a source.', files=_files())
    # A later Cartridge serves `/playbooks/` as skills, so the sync no longer sees the file in Files.
    monkeypatch.setattr(serving, '_cartridge', replace(serving._require_cartridge(), skills=('/skills/', '/playbooks/')))

    events = service.turn('read: /playbooks/grounding.md', files=_files())

    assert 'Cite a source.' in _tool_output(events)
    assert f'{FILES_PREFIX}playbooks/grounding.md' in _keys(files_bucket)


def test_a_file_the_sync_never_recorded_reaches_files_however_old(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    # The agent unpacks an archive, keeping each file's time from long before any sync.
    archived = service.home / 'archive' / '2019.csv'
    archived.parent.mkdir()
    archived.write_text('date,close')
    os.utime(archived, (1_500_000_000, 1_500_000_000))

    service.turn('ls: /', files=_files())

    assert f'{FILES_PREFIX}archive/2019.csv' in _keys(files_bucket)
    assert archived.exists()


def test_a_turn_whose_files_sync_record_is_unreadable_fails_loudly(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    (service.home / 'botcube-harness-deepagents' / 'files-sync.json').write_text('{"report.csv": ')
    files_bucket.delete_object(Bucket=FILES_BUCKET, Key=f'{FILES_PREFIX}report.csv')

    events = service.turn('ls: /', files=_files())

    assert events[-1] == {
        'type': 'RUN_ERROR',
        'message': 'The Files sync record /botcube-harness-deepagents/files-sync.json is unreadable: '
        'Expecting value: line 1 column 16 (char 15)',
        'code': 'FILES_SYNC_RECORD',
    }
    assert 'RUN_FINISHED' not in [event['type'] for event in events]
    assert (service.home / 'report.csv').exists()


@pytest.mark.parametrize('record', ['[]', '"report.csv"', '{"report.csv": "1700000000"}', '{"report.csv": true}'])
def test_a_turn_whose_files_sync_record_is_not_names_to_seconds_fails_loudly(
    service: _Service, files_bucket: Any, record: str
) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    (service.home / 'botcube-harness-deepagents' / 'files-sync.json').write_text(record)

    events = service.turn('ls: /', files=_files())

    assert events[-1] == {
        'type': 'RUN_ERROR',
        'message': 'The Files sync record /botcube-harness-deepagents/files-sync.json is unreadable: '
        'not an object of file names to seconds',
        'code': 'FILES_SYNC_RECORD',
    }


def test_a_turn_whose_files_sync_record_names_a_path_outside_the_workspace_fails_loudly(
    service: _Service, files_bucket: Any, tmp_path_factory: pytest.TempPathFactory
) -> None:
    runtime = tmp_path_factory.mktemp('runtime') / 'node'
    runtime.write_text('#!/bin/sh')
    service.turn('write: /report.csv: date,close', files=_files())
    (service.home / 'botcube-harness-deepagents' / 'files-sync.json').write_text(json.dumps({str(runtime): 9999999999}))

    events = service.turn('ls: /', files=_files())

    assert events[-1] == {
        'type': 'RUN_ERROR',
        'message': 'The Files sync record /botcube-harness-deepagents/files-sync.json is unreadable: '
        f'{str(runtime)!r} is not a path in the workspace',
        'code': 'FILES_SYNC_RECORD',
    }
    assert runtime.exists()


def test_a_files_pull_removes_nothing_through_a_link_out_of_the_workspace(
    service: _Service, files_bucket: Any, tmp_path_factory: pytest.TempPathFactory
) -> None:
    outside = tmp_path_factory.mktemp('outside')
    (outside / 'node').write_text('#!/bin/sh')
    service.turn('write: /report.csv: date,close', files=_files())
    (service.home / 'bin').symlink_to(outside, target_is_directory=True)
    (service.home / 'botcube-harness-deepagents' / 'files-sync.json').write_text(json.dumps({'bin/node': 9999999999}))

    events = service.turn('ls: /', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert (outside / 'node').exists()


def _deleted_in_files_once_the_turn_starts(monkeypatch: pytest.MonkeyPatch, s3: Any, name: str) -> None:
    """The account owner deletes `name` in the Files app while the next Turn runs."""
    pull = files_sync.FilesSync.pull
    pending = [name]

    def pull_then_delete(self: files_sync.FilesSync, root: Path, excluded: Any) -> None:
        pull(self, root, excluded)
        while pending:
            s3.delete_object(Bucket=FILES_BUCKET, Key=FILES_PREFIX + pending.pop())

    monkeypatch.setattr(files_sync.FilesSync, 'pull', pull_then_delete)


def test_a_file_deleted_in_files_during_a_turn_is_not_put_back_when_it_ends(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    _deleted_in_files_once_the_turn_starts(monkeypatch, files_bucket, 'report.csv')

    events = service.turn('read: /report.csv', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert 'date,close' in _tool_output(events)
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt']

    service.turn('ls: /', files=_files())

    assert not (service.home / 'report.csv').exists()
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt']


def test_touching_a_file_deleted_in_files_during_a_turn_keeps_it_deleted_issue_3492(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    service.turn('write: /report.csv: date,close', files=_files())
    _deleted_in_files_once_the_turn_starts(monkeypatch, files_bucket, 'report.csv')

    events = service.turn('run: touch report.csv', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert (service.home / 'report.csv').read_text() == 'date,close'
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt']

    service.turn('ls: /', files=_files())

    assert not (service.home / 'report.csv').exists()
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt']


def test_no_tool_turns_never_access_unchanged_files_issue_3500(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    names = [f'unchanged-{index}.txt' for index in range(17)]
    for name in names:
        files_bucket.put_object(Bucket=FILES_BUCKET, Key=FILES_PREFIX + name, Body=name.encode())
    refreshed = service.turn('ls: /', files=_files())
    assert refreshed[-1]['type'] == 'RUN_FINISHED'
    for name in names:
        local = service.home / name
        stamp = local.stat().st_mtime + 0.5
        os.utime(local, (stamp, stamp))

    def unexpected_files_client(self: files_sync.FilesSync) -> Any:
        raise AssertionError('A plain answer accessed Files')

    monkeypatch.setattr(files_sync.FilesSync, '_client', unexpected_files_client)

    for _ in range(2):
        events = service.turn('hello', files=_files())
        assert events[-1]['type'] == 'RUN_FINISHED'
        assert not any(event['type'].startswith('TOOL_CALL') for event in events)
        for name in names:
            assert (service.home / name).read_bytes() == name.encode()
            assert files_bucket.get_object(Bucket=FILES_BUCKET, Key=FILES_PREFIX + name)['Body'].read() == name.encode()


def test_only_the_agents_own_files_reach_files(service: _Service, files_bucket: Any) -> None:
    for internal in ('.cartridge/cookies.json', 'botcube-harness-deepagents/threads/state.json', 'notes/.draft'):
        path = service.home / internal
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('internal')

    service.turn('write: /report.csv: date,close', files=_files())

    # The Cartridge's skills and hidden files stay in the sandbox; what the agent made goes to Files.
    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt', f'{FILES_PREFIX}report.csv']


# A scratch file the agent wrote to /tmp showed up in the user's Files.
def test_the_agents_scratch_files_in_tmp_stay_out_of_files(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /tmp/scratch-note.txt: draft', files=_files())
    service.turn('write: /report.csv: date,close', files=_files())

    assert _keys(files_bucket) == [f'{FILES_PREFIX}prepared.txt', f'{FILES_PREFIX}report.csv']


def test_a_turn_without_files_syncs_nothing(service: _Service, files_bucket: Any) -> None:
    service.turn('write: /report.csv: date,close')

    assert _keys(files_bucket) == []


# Told nothing of where the user's Files are, the agent listed `/files`, found none, and said Files were empty.
def test_the_agent_is_told_its_files_are_the_workspace_root(service: _Service, files_bucket: Any) -> None:
    service.turn('hello', files=_files())
    service.turn('hello', thread='no-files')

    files_line = (
        "The user's Files are the files in your workspace: `/` to your file tools, the shell's working directory. "
        'What you write there is saved to their Files, except hidden files and anything under '
        '`/tmp`, `/botcube-harness-deepagents`, `/skills`.'
    )
    assert files_line in service.recorder.prompts[0]
    assert files_line not in service.recorder.prompts[1]


def test_the_computer_section_names_only_pinned_python_libraries() -> None:
    project = Path(__file__).resolve().parents[1] / 'tools/pyproject.toml'
    pinned = {dependency.split('==')[0] for dependency in tomllib.loads(project.read_text())['project']['dependencies']}
    named = serving.AGENT_SYSTEM_PROMPT.split('Python has ')[1].split(' preinstalled')[0].replace(' and ', ', ').split(', ')

    assert set(named) <= pinned


def test_prompt_composes_generic_cartridge_files_and_documents_in_order(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, '_cartridge', replace(serving._require_cartridge(), system_prompt='Cartridge instructions.'))
    service.turn('hello', files=_files(), **DOCUMENTS)

    prompt = service.recorder.prompts[0]
    assert prompt.startswith(serving.AGENT_SYSTEM_PROMPT + '\n\nCartridge instructions.\n\n')
    assert prompt.index('Cartridge instructions.') < prompt.index("The user's Files") < prompt.index('Your Agent Identity and Soul')
    assert '<agent_identity>\nName: Ada Bot' in prompt
    assert '<soul>\nBe candid. Say what you do not know.' in prompt


def test_files_credentials_never_reach_the_sandbox_shell(service: _Service, files_bucket: Any) -> None:
    events = service.turn('run: env', files=_files())

    assert 'files-secret' not in _tool_output(events)
    assert 'ASIAFILESSCOPED' not in _tool_output(events)


@pytest.mark.parametrize(
    ('files', 'message'),
    [
        ('accounts/0123abcd/', 'Files must be an object'),
        ({**_files(), 'sessionToken': ''}, 'Files sessionToken must be a non-empty string'),
        ({key: value for key, value in _files().items() if key != 'bucket'}, 'Files bucket must be a non-empty string'),
        ({**_files(), 'prefix': 'accounts/0123abcd'}, 'Files prefix must end with /'),
    ],
)
def test_an_invocation_with_malformed_files_is_rejected(
    service: _Service, files_bucket: Any, files: Any, message: str
) -> None:
    events = service.turn('hello', files=files)

    assert events == [{'type': 'RUN_ERROR', 'message': message, 'code': 'INVALID_FILES'}]
    assert service.recorder.builds == []


def test_a_plain_answer_with_an_unavailable_files_bucket_succeeds_without_s3(
    service: _Service, files_bucket: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    files_bucket.delete_bucket(Bucket=FILES_BUCKET)
    calls: list[str] = []
    client = files_sync.FilesSync._client

    def observed_client(self: files_sync.FilesSync) -> Any:
        calls.append(self.bucket)
        return client(self)

    monkeypatch.setattr(files_sync.FilesSync, '_client', observed_client)

    events = service.turn('hello', files=_files())

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _said(events) == 'Echo: hello'
    assert calls == []


def test_a_workspace_tool_whose_files_cannot_sync_fails_loudly(service: _Service, files_bucket: Any) -> None:
    files_bucket.delete_bucket(Bucket=FILES_BUCKET)

    events = service.turn('ls: /', files=_files())

    assert events[-1]['type'] == 'RUN_ERROR'
    assert 'NoSuchBucket' in events[-1]['message']
    assert 'RUN_FINISHED' not in [event['type'] for event in events]
    assert service.recorder.heard == [['ls: /']]


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


class _ScopedMemory(FakeAgentCoreMemory):
    sts: FakeSts


@pytest.fixture
def agentcore_memory(service: _Service, monkeypatch: pytest.MonkeyPatch) -> _ScopedMemory:
    """Serve on AgentCore Memory in eu-west-1, reached with each Turn's tagged credentials."""
    memory = _ScopedMemory()
    memory.sts = install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(serving, 'AGENTCORE_REGION', 'eu-west-1')
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
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botcube_harness_deepagents.memory import agentcore

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
    member = {'actor': 'actor-1', 'user': 'filing-1', 'memory': True}
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
    member = {'thread': 'thread-a', 'actor': 'actor-1', 'user': 'filing-1', 'memory': True}
    service.turn('first question', message='question-1', **member)

    # Resent under the same ID with new text, the library rewinds the Session through its checkpoint history.
    edited = service.turn('edited question', message='question-1', **member)

    assert edited[-1]['type'] == 'RUN_FINISHED'
    assert _said(edited) == 'Echo: edited question'
    assert service.recorder.heard[-1] == ['edited question']


# Seconds of one AgentCore Memory call, scaled down from production's.
MEMORY_ROUND_TRIP = 0.1


def test_on_agentcore_a_continuing_sessions_turn_reaches_its_model_after_one_memory_round_trip_issue_3701(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    reached: list[float] = []
    calls = agentcore_memory.sts.memory_calls
    before_model: list[tuple[str, str, bool]] = []
    stream = _ScriptedModel._stream

    def first_model_call(self: _ScriptedModel, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        reached.append(time.perf_counter())
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
    member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
    assert service.turn('first question', **member)[-1]['type'] == 'RUN_FINISHED'
    service.fed()
    agentcore_memory.latency = MEMORY_ROUND_TRIP
    calls.clear()

    events = service.turn('second question', **member)

    assert _said(events) == 'Echo: second question'
    assert service.recorder.heard[-1] == ['first question', 'second question']
    # The newest checkpoint's key without payloads, read alongside its pending writes; checkpoint writes run behind.
    # The Memory block reads alongside them too, though the Session keeps its block.
    session_reads = sorted(read for read in before_model if read[1] in ('lgw-', 'thre'))
    assert session_reads == [('list_events', 'lgw-', True), ('list_events', 'thre', False)]
    # Three reads of the Session, three ListEvents each, took nine round trips. Count the round trips the
    # model waited for one after another, not the wall time, which a busy CI host stretches: the Turn
    # identity's exchange for credentials, then every Memory read at once.
    waited, depth = _waited_for(agentcore_memory, reached[-1])
    assert (waited[0], sorted(waited[1:]), depth) == (
        'assume_role_with_web_identity', ['list_events'] * 8 + ['list_memory_records'] * 2, 2)


def test_on_agentcore_a_new_sessions_turn_reaches_its_model_after_two_serial_round_trips_issue_4012(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    reached: list[float] = []
    stream = _ScriptedModel._stream

    def first_model_call(self: _ScriptedModel, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        reached.append(time.perf_counter())
        agentcore_memory.latency = 0
        return stream(self, *args, **kwargs)

    monkeypatch.setattr(_ScriptedModel, '_stream', first_model_call)
    agentcore_memory.latency = MEMORY_ROUND_TRIP

    events = service.turn('first question', actor='actor-1', user='actor-1', memory=True)

    assert _said(events) == 'Echo: first question'
    # The Turn identity's exchange for credentials, then every Memory read at once.
    waited, depth = _waited_for(agentcore_memory, reached[0])
    assert (waited[0], sorted(waited[1:]), depth) == (
        'assume_role_with_web_identity', ['list_events'] * 7 + ['list_memory_records'] * 2, 2)


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
    member = {'actor': 'actor-1', 'user': 'filing-1', 'memory': True}

    saved = service.turn('remember: prefers copper', thread='thread-a', **member)
    another_microvm()
    service.turn('hello', thread='thread-b', **member)

    assert _tool_output(saved) == RECORD_REPLY
    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n'
        '- Prefers dark mode\n'
        '\n'
        'semantic facts:\n'
        '- prefers copper\n'
        '- Trades copper futures'
    )
    assert agentcore_memory.sts.regions == ['eu-west-1', 'eu-west-1']


def test_on_agentcore_a_sessions_memory_block_holds_the_newest_50_preferences_and_facts_and_says_more_exist(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    agentcore_memory.records += [
        _memory_record(f'{{"preference": "Preference {n}"}}', 'UserPreferences-1', 'actor-1',
                       created=datetime(2026, 7, 1, tzinfo=UTC) + timedelta(minutes=n))
        for n in range(1, 52)
    ] + [
        _memory_record(f'Fact {n}', 'SemanticFacts-1', 'actor-1', created=datetime(2026, 7, 1, tzinfo=UTC) + timedelta(minutes=n))
        for n in range(1, 52)
    ]

    service.turn('hello', thread='thread-a', actor='actor-1', user='actor-1', memory=True)

    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n' + ''.join(f'- Preference {n}\n' for n in range(51, 1, -1))
        + '\nsemantic facts:\n' + ''.join(f'- Fact {n}\n' for n in range(51, 1, -1))
        + '\nMore memories are available. Use memory retrieve to search beyond the startup memory block.'
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
    member = {'actor': 'actor-1', 'user': 'filing-1', 'memory': True}

    def run(**args: str) -> Any:
        return json.loads(_tool_output(service.turn(f'memory: {json.dumps(args)}', **member)))

    assert run(action='list') == {'status': 'success', 'content': [
        {'text': f'[{COPPER}] Trades copper futures'}, {'text': f'[{DARK_MODE}] Summary: copper desk review'},
    ]}
    assert run(action='retrieve', query='copper') == {'status': 'success', 'content': [
        {'text': 'Trades copper futures'}, {'text': 'Summary: copper desk review'},
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
    member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
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
    assert _memory_block(opened).endswith('semantic facts:\n- Trades copper futures\n- Lives in Paris')
    assert _memory_block(service.recorder.prompts[-1]) == (
        'user preferences:\n'
        '- Prefers dark mode\n'
        '\n'
        'semantic facts:\n'
        '- Lives in London\n'
        '\n'
        'Memory page corrections (authoritative):\n'
        'These corrections override conflicting memories above, including paraphrases and parts of compound saves. '
        'Each previousText is superseded by text; null means forgotten and must not be used. '
        'Keep unrelated facts from those saves.\n'
        '{"previousText": "Lives in Paris", "text": "Lives in London"}\n'
        '{"previousText": "Trades copper futures", "text": null}'
    )
    assert _memory_operation('memory') == {
        'lines': [{'id': DARK_MODE, 'text': 'Prefers dark mode'}, {'id': PARIS, 'text': 'Lives in London'}]
    }


def test_on_agentcore_a_scheduled_runs_summary_leaves_the_sessions_memory_block_unchanged(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    agentcore_memory.records += [_memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1', COPPER)]
    member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
    service.turn('hello', thread='thread-a', **member)
    opened = service.recorder.prompts[-1]

    # A reload would show the newer record.
    agentcore_memory.records.append(_memory_record('Lives in Paris', 'SemanticFacts-1', 'actor-1', PARIS))
    response = TestClient(session_api.app).post('/invocations', json={
        'operation': 'post', 'userId': 'actor-1', 'sessionId': 'thread-a', 'content': 'Copper closed up 2%',
    })
    service.turn('hello again', thread='thread-a', **member)

    assert response.status_code == 200, response.text
    assert _memory_block(opened) == 'semantic facts:\n- Trades copper futures'
    assert service.recorder.prompts[-1] == opened


def test_on_agentcore_a_memory_page_edit_reaches_a_new_session_while_agentcore_lists_the_old_lines_issue_3483(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    agentcore_memory.records += [
        _memory_record('{"preference": "Prefers dark mode"}', 'UserPreferences-1', 'actor-1', DARK_MODE),
        _memory_record('Trades copper futures', 'SemanticFacts-1', 'actor-1', COPPER),
        _memory_record('Lives in Paris', 'SemanticFacts-1', 'actor-1', PARIS),
    ]
    member = {'actor': 'actor-1', 'user': 'actor-1', 'memory': True}
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
        '- Prefers dark mode\n'
        '\n'
        'semantic facts:\n'
        '- Lives in London\n'
        '\n'
        'Memory page corrections (authoritative):\n'
        'These corrections override conflicting memories above, including paraphrases and parts of compound saves. '
        'Each previousText is superseded by text; null means forgotten and must not be used. '
        'Keep unrelated facts from those saves.\n'
        '{"previousText": "Lives in Paris", "text": "Lives in London"}\n'
        '{"previousText": "Trades copper futures", "text": null}'
    )


def _fed(service: _Service) -> None:
    """Wait for every Turn feed the Harness is running in the background."""
    async def fed() -> None:
        await asyncio.gather(*serving._SESSION_TURNS._feeds.values(), return_exceptions=True)

    assert service.client.portal is not None
    service.client.portal.call(fed)


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
    _fed(service)

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
    _fed(service)

    assert _fed_events(agentcore_memory, 'actor-1', 'thread-b') == [[('USER', 'hello')], [('ASSISTANT', 'Echo: hello')]]


def test_on_agentcore_a_failed_turn_feed_is_logged_and_fails_the_next_turn(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    create_event = agentcore_memory.create_event

    def failing(**params: Any) -> dict[str, Any]:
        if any('conversational' in item for item in params['payload']):
            raise RuntimeError('Memory unavailable')
        return create_event(**params)

    monkeypatch.setattr(agentcore_memory, 'create_event', failing)

    first = service.turn('hello', thread='thread-b', actor='actor-1', user='user-1', memory=True)
    _fed(service)

    assert first[-1]['type'] == 'RUN_FINISHED'
    assert _fed_events(agentcore_memory, 'actor-1', 'thread-b') == []
    [logged] = [record for record in caplog.records if record.getMessage().startswith('Harness Turn feed failed')]
    assert logged.levelno == logging.ERROR
    assert 'code=TURN_FEED_FAILED' in logged.getMessage()
    [run_error] = [event for event in service.turn('again', thread='thread-b', actor='actor-1', user='user-1', memory=True)
                   if event['type'] == 'RUN_ERROR']
    assert run_error == {'type': 'RUN_ERROR', 'code': 'TURN_FEED_FAILED',
                         'message': 'The Turn could not be fed to Memory: Memory unavailable'}


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
    member = {'actor': 'actor-1', 'user': 'user-1', 'memory': True}

    [run_error] = [event for event in service.turn('hello', thread='thread-a', **member) if event['type'] == 'RUN_ERROR']
    monkeypatch.setattr(agentcore_memory, 'list_events', list_events)
    retried = service.turn('hello again', thread='thread-a', message='message-retry', **member)

    assert run_error['message'] == 'Memory throttled'
    assert retried[-1]['type'] == 'RUN_FINISHED'
    assert _memory_block(service.recorder.prompts[-1]) == 'semantic facts:\n- Trades copper futures'


def test_on_agentcore_a_guests_turn_feeds_nothing(service: _Service, agentcore_memory: _ScopedMemory) -> None:
    events = service.turn('hello', thread='thread-b', actor='anonymous', user='anonymous', memory=False)
    _fed(service)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert all(not _fed_events(agentcore_memory, actor, thread) for actor, thread in agentcore_memory.events)


def test_on_agentcore_an_anonymous_actor_gets_no_memory_block_tool_or_memory_reads(
    service: _Service, agentcore_memory: _ScopedMemory,
) -> None:
    agentcore_memory.records += [_memory_record('Trades copper futures', 'SemanticFacts-1', 'anonymous')]

    service.turn('hello', thread='thread-a', actor='anonymous', user='anonymous', memory=True)

    assert 'memory' not in service.recorder.tools[-1]
    assert '<agent_memory>' not in service.recorder.prompts[-1]
    # Its credentials serve only the Session's checkpoints.
    writes = 'lgw-8b983fb92d2eb12751695722fdb4e498-'
    assert {operation for operation, _ in agentcore_memory.sts.memory_calls} <= {'create_event', 'list_events'}
    assert all(params['sessionId'] == 'thread-a' or params['sessionId'].startswith(writes)
               for _, params in agentcore_memory.sts.memory_calls)
    assert not [session for session in agentcore_memory.listed if session.startswith('pending-memory-')]


# -- Configuration and startup ---------------------------------------------------


def test_a_service_takes_one_cartridge(service: _Service) -> None:
    with pytest.raises(RuntimeError, match=r'^Harness Cartridge is already configured$'):
        serving.configure_harness_definition(_definition([]))


CARTRIDGE_MODULE = 'serving_test_cartridge'


@pytest.fixture
def start(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[], list[tuple[Any, dict[str, Any]]]]]:
    """Start the service with main(), recording how uvicorn would serve it."""
    served: list[tuple[Any, dict[str, Any]]] = []
    monkeypatch.setattr(uvicorn, 'run', lambda app, **options: served.append((app, options)))
    monkeypatch.setattr(serving, '_cartridge', None)
    module = ModuleType(CARTRIDGE_MODULE)
    vars(module)['CARTRIDGE'] = _definition([])
    monkeypatch.setitem(sys.modules, CARTRIDGE_MODULE, module)
    monkeypatch.setitem(sys.modules, 'serving_test_empty_module', ModuleType('serving_test_empty_module'))
    monkeypatch.setenv('BOTCUBE_CARTRIDGE_MODULE', CARTRIDGE_MODULE)
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


def _install(monkeypatch: pytest.MonkeyPatch, *values: str) -> None:
    """Install one botcube.cartridge entry point per value, beside another group's."""
    installed = [
        EntryPoint(name=f'cartridge-{index}', value=value, group='botcube.cartridge')
        for index, value in enumerate(values)
    ]
    installed.append(EntryPoint(name='other', value=f'{CARTRIDGE_MODULE}:CARTRIDGE', group='other.plugins'))
    monkeypatch.setattr(importlib.metadata, 'entry_points', lambda **selection: EntryPoints(installed).select(**selection))


def test_the_service_serves_on_every_interface_at_port_8080(start: Callable[[], list[tuple[Any, dict[str, Any]]]]) -> None:
    assert start() == [(serving.app, {'host': '0.0.0.0', 'port': 8080})]


def test_the_service_serves_on_the_configured_port(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('PORT', '9123')

    assert start() == [(serving.app, {'host': '0.0.0.0', 'port': 9123})]


def test_the_service_serves_the_cartridge_module_it_is_given(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch)

    start()

    assert serving._require_cartridge().agent_name == 'test-agent'


def test_a_cartridge_module_must_export_its_cartridge(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_CARTRIDGE_MODULE', 'serving_test_empty_module')

    with pytest.raises(RuntimeError, match=r'^serving_test_empty_module does not export CARTRIDGE$'):
        start()


@pytest.mark.parametrize('module', [None, '  '])
def test_without_a_cartridge_module_the_service_serves_the_installed_cartridge(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch, module: str | None) -> None:
    if module is None:
        monkeypatch.delenv('BOTCUBE_CARTRIDGE_MODULE')
    else:
        monkeypatch.setenv('BOTCUBE_CARTRIDGE_MODULE', module)
    _install(monkeypatch, f'{CARTRIDGE_MODULE}:CARTRIDGE')

    start()

    assert serving._require_cartridge().agent_name == 'test-agent'


@pytest.mark.parametrize('installed', [0, 2])
def test_the_service_needs_exactly_one_installed_cartridge(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch, installed: int) -> None:
    monkeypatch.delenv('BOTCUBE_CARTRIDGE_MODULE')
    _install(monkeypatch, *[f'{CARTRIDGE_MODULE}:CARTRIDGE'] * installed)

    with pytest.raises(
        RuntimeError,
        match=rf'^Exactly one installed botcube\.cartridge entry point is required; found {installed}$',
    ):
        start()


def test_a_configured_service_starts_with_its_cartridge(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch) -> None:
    serving.configure_harness_definition(_definition([]))
    configured = serving._require_cartridge()
    monkeypatch.setenv('BOTCUBE_CARTRIDGE_MODULE', 'serving_test_empty_module')

    start()

    assert serving._require_cartridge() is configured


def test_the_service_logs_at_info_with_bare_prompt_cache_lines(start: Callable[[], list[tuple[Any, dict[str, Any]]]], capsys: pytest.CaptureFixture[str]) -> None:
    start()
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

    assert events[-1] == {
        'type': 'RUN_ERROR', 'message': 'Transient checkpoint persistence failure', 'code': 'INTERNAL_ERROR',
    }
    recovered = service.turn('two', session='runtime-session-1')
    assert recovered[-1]['type'] == 'RUN_FINISHED'
    assert _said(recovered) == 'Echo: two'
    assert _replay('user-1', 'thread-1')[-2:] == [('user', 'two'), ('assistant', 'Echo: two')]


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
        serving._AGENT_BACKENDS.clear()
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


def test_opaque_runtime_continuation_restores_original_history_issue_2822(
    service: _Service, agentcore_memory: _ScopedMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    original = service.turn(
        'before continuation', actor='original-owner', user='original-filing',
        thread='legacy-session', session='legacy-session',
    )
    assert original[-1]['type'] == 'RUN_FINISHED'
    serving._AGENTS.clear()
    serving._AGENT_BACKENDS.clear()
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


def test_a_finished_turns_history_reads_only_its_latest_checkpoint_issue_3354(
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
    # The format check's read of the latest checkpoint, then the state read's.
    assert memory.listed["thread-1"] == 2
    assert len(writes_reads) == 1 and writes_reads[0].startswith(writes)


def test_a_new_session_is_readable_while_its_first_turn_runs_issue_3470(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    started = threading.Event()
    answering = threading.Event()
    release_answer = threading.Event()
    stream = _ScriptedModel._stream
    turn_events = serving._turn_events

    def held_answer(model: _ScriptedModel, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        answering.set()
        if not release_answer.wait(10):
            raise AssertionError('The test did not release the first answer')
        yield from stream(model, *args, **kwargs)

    async def observed_events(agent: Any, input_data: Any, files: Any, root: Path, publish: Any) -> None:

        def observed(event: Any) -> None:
            publish(event)
            if event.type == 'RUN_STARTED':
                session = ('user-1', 'thread-1')
                assert serving._SESSION_TURNS._turns[session].run_id == input_data.run_id
                assert serving._SESSION_TURNS._locks[session].locked()
                started.set()

        await turn_events(agent, input_data, files, root, observed)

    monkeypatch.setattr(_ScriptedModel, '_stream', held_answer)
    monkeypatch.setattr(serving, '_turn_events', observed_events)
    with TestClient(session_api.app) as records:
        missing = records.post('/invocations', json={
            'operation': 'get', 'userId': 'user-1', 'sessionId': 'truly-missing',
        })
        assert missing.status_code == 404
        assert missing.json()['error'] == 'Session truly-missing has no record'
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(service.turn, 'First question', session='runtime-session-1')
            try:
                assert started.wait(5), 'The first Turn did not publish RUN_STARTED'
                assert answering.wait(5), 'The first Turn did not reach the held model'
                response = records.post('/invocations', json={
                    'operation': 'get', 'userId': 'user-1', 'sessionId': 'thread-1',
                })
                assert not running.done(), 'The first Turn finished before its record was read'
                assert response.status_code == 200, response.text
                assert [(message['role'], message.get('content', ''))
                        for message in response.json()['messages']] == [('user', 'First question')]
            finally:
                release_answer.set()
                events = running.result(timeout=10)

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert _replay('user-1', 'thread-1') == [
        ('user', 'First question'), ('assistant', 'Echo: First question'),
    ]


def test_a_new_turn_whose_record_cannot_be_written_fails_loud_issue_3470(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', MEMORY_ID)

    def unwritable(**_params: Any) -> NoReturn:
        raise RuntimeError('Initial record publication failed')

    monkeypatch.setattr(memory, 'create_event', unwritable)

    events = service.turn('First question', session='runtime-session-1')

    assert events[-1] == {
        'type': 'RUN_ERROR', 'message': 'Initial record publication failed', 'code': 'INTERNAL_ERROR',
    }
    assert not any(event['type'] == 'RUN_FINISHED' for event in events)


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


def test_upgraded_graph_classifies_ordinary_provider_failure(service: _Service, monkeypatch: pytest.MonkeyPatch) -> None:
    def unavailable(*_args: Any, **_kwargs: Any) -> NoReturn:
        raise RuntimeError('provider unavailable')

    monkeypatch.setattr(_ScriptedModel, '_stream', unavailable)
    events = service.turn('hello')

    assert events[-1] == {'type': 'RUN_ERROR', 'message': 'provider unavailable', 'code': 'INTERNAL_ERROR'}
    assert sum(event['type'] == 'RUN_STARTED' for event in events) == 1
    assert not any(event['type'] == 'RUN_FINISHED' for event in events)


def test_upgraded_write_file_replaces_existing_content(service: _Service) -> None:
    service.turn('write: /plan.txt: first draft')
    events = service.turn('write: /plan.txt: revised draft')

    assert (service.prepared[0] / 'plan.txt').read_text() == 'revised draft'
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert 'Error' not in _tool_output(events)


@pytest.mark.parametrize('stopped', [False, True])
def test_invocation_eof_waits_for_real_record_settlement_before_purge_issue_2822(
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
    with pytest.raises(session_api.SessionNotFoundError, match='has no record'):
        _replay('user-1', 'thread-1')
    assert not any(memory.events.values())


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
    expected = serving._session_config(('user-1', 'thread-1')).get('configurable', {})
    assert all(all(config['configurable'][key] == value for key, value in expected.items()) for config in reads)
    assert backend._env['TOKEN'] == 'live'
    assert len(service.recorder.builds) == builds


def test_a_recorded_warmup_with_local_memory_prepares(service: _Service) -> None:
    service.turn('hello', memory=True)

    events = service.turn('hello', memory=True, warmup=True, preparationScope='recorded')

    assert events[-1]['value']['outcome'] == 'prepared'
