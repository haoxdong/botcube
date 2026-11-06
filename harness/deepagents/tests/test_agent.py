import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from deepagents.backends import LocalShellBackend
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage
from pydantic import SecretStr

from botcube_harness_deepagents import aws_clients
from botcube_harness_deepagents.agent import AgentResponseError, ask, build_agent
from conftest import KwargsRecorder, ToolBindableFakeModel, prepared

# The Bedrock clients every model shares; the real ones fetch the runtime's credentials.
SHARED_CLIENTS = {'client': object(), 'bedrock_client': object()}


@pytest.fixture(autouse=True)
def shared_bedrock_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(aws_clients, 'bedrock', lambda _: (SHARED_CLIENTS['client'], SHARED_CLIENTS['bedrock_client']))


def test_agent_answers_simple_query_with_injected_cube_dependencies(tmp_path: Path) -> None:
    model = ToolBindableFakeModel(responses=['2 + 2 is 4.'])
    backend = LocalShellBackend(
        root_dir=tmp_path,
        virtual_mode=True,
        inherit_env=False,
    )
    agent = build_agent(model=model, backend=backend, skills=[])

    answer = ask(agent, 'What is 2+2?')

    assert '4' in answer


def test_local_echo_model_runs_without_provider_credentials(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv('BOTCUBE_MODEL', 'echo')
    for name in (
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
    ):
        monkeypatch.delenv(name, raising=False)
    backend = LocalShellBackend(
        root_dir=tmp_path,
        virtual_mode=True,
        inherit_env=False,
    )

    answer = ask(build_agent(backend=backend, skills=[]), 'hello cube')

    assert answer == 'Echo: hello cube'


def _fake_module(name: str, **attributes: object) -> ModuleType:
    module = ModuleType(name)
    module.__dict__.update(attributes)
    return module


def test_agent_requires_cartridge_backend_and_skills() -> None:
    model = ToolBindableFakeModel(responses=['unused'])

    # Deliberately incomplete keywords: the call must fail at runtime.
    incomplete: dict[str, Any] = {'model': model}
    with pytest.raises(TypeError, match="missing 2 required keyword-only arguments: 'backend' and 'skills'"):
        build_agent(**incomplete)


def test_ask_rejects_empty_agent_messages() -> None:
    class EmptyAgent:
        def invoke(self, _input: object) -> dict[str, list[BaseMessage]]:
            return {'messages': []}

    with pytest.raises(AgentResponseError, match='^Agent returned an empty response$'):
        ask(EmptyAgent(), 'What is 2+2?')


def test_ask_rejects_blank_agent_text() -> None:
    class BlankMessage:
        content = '   '

    class BlankAgent:
        def invoke(self, _input: object):
            return {'messages': [BlankMessage()]}

    with pytest.raises(AgentResponseError, match='^Agent returned an empty response$'):
        ask(BlankAgent(), 'What is 2+2?')


def test_ask_answers_with_the_text_blocks_of_a_content_block_reply() -> None:
    class BlockAgent:
        def invoke(self, _input: object):
            reply = AIMessage(
                content=[
                    {'type': 'reasoning', 'reasoning': 'The user wants a sum.'},
                    {'type': 'text', 'text': '2 + 2'},
                    {'type': 'text', 'text': 'is 4.'},
                ]
            )
            return {'messages': [reply]}

    assert ask(BlockAgent(), 'What is 2+2?') == '2 + 2\nis 4.'


def test_the_agent_gets_the_skills_and_subagents_it_is_built_with(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, kwargs_recorder: type[KwargsRecorder]
) -> None:
    from botcube_harness_deepagents import agent as agent_module

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)
    built = kwargs_recorder.calls
    researcher = {'name': 'researcher', 'description': 'Researches.', 'system_prompt': 'Research.'}

    build_agent(
        model=ToolBindableFakeModel(responses=['unused']),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=('/skills/',),
        subagents=(researcher,),
    )

    assert 'memory' not in built[0]
    assert built[0]['skills'] == ['/skills/']
    assert {key: value for key, value in built[0]['subagents'][0].items() if key != 'middleware'} == researcher


def test_model_uses_env_overrides_for_converse(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.setenv(
        'BOTCUBE_MODEL',
        'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    )
    monkeypatch.setenv('AWS_REGION', 'us-east-1')

    build_model(max_tokens=32)

    assert calls == [
        {
            'model': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
            'temperature': None,
            'max_tokens': 32,
            'region_name': 'us-east-1',
            **SHARED_CLIENTS,
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive', 'display': 'summarized'},
                'output_config': {'effort': 'medium'},
            },
        }
    ]


def test_model_falls_back_to_the_default_aws_region(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.setenv('BOTCUBE_MODEL', 'deepseek.v3.2')
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'eu-west-1')

    build_model()

    assert calls == [{
        'model': 'deepseek.v3.2', 'temperature': 0, 'max_tokens': 128, 'region_name': 'eu-west-1', **SHARED_CLIENTS,
        'additional_model_request_fields': {'reasoning_config': 'high'},
    }]


def test_model_resolves_ui_alias_and_effort(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    """Copilot model keys ('opus-4.6') resolve to Bedrock IDs."""
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)

    build_model(model='opus-4.6', effort='high', max_tokens=4096)

    assert calls == [
        {
            'model': 'us.anthropic.claude-opus-4-6-v1',
            'temperature': None,
            'max_tokens': 4096,
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive', 'display': 'summarized'},
                'output_config': {'effort': 'high'},
            },
        }
    ]


def test_model_passes_max_effort_through(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    """'max' effort reaches the request unchanged on Sonnet and Opus alike."""
    from botcube_harness_deepagents.agent import build_model
    from botcube_harness_deepagents.llm import resolve_effort

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)

    build_model(model='sonnet-4.6', effort='max', max_tokens=4096)
    build_model(model='opus-4.6', effort='max', max_tokens=4096)

    assert calls[0]['additional_model_request_fields']['output_config'] == {'effort': 'max'}
    assert calls[1]['additional_model_request_fields']['output_config'] == {'effort': 'max'}

    assert resolve_effort('max') == 'max'
    assert resolve_effort('low') == 'low'


def test_model_defaults_to_sonnet(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)

    result = build_model()

    assert isinstance(result, kwargs_recorder)
    assert calls == [
        {
            'model': 'us.anthropic.claude-sonnet-4-6',
            'temperature': None,
            'max_tokens': 128,
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive', 'display': 'summarized'},
                'output_config': {'effort': 'medium'},
            },
        }
    ]


def test_model_falls_back_to_converse_for_non_openai(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.setenv('BOTCUBE_MODEL', 'deepseek.v3.2')
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)

    build_model()

    assert calls == [
        {
            'model': 'deepseek.v3.2',
            'temperature': 0,
            'max_tokens': 128,
            'additional_model_request_fields': {'reasoning_config': 'high'},
        }
    ]


def test_model_enables_adaptive_thinking_with_effort(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)

    build_model(effort='medium')

    assert calls == [
        {
            'model': 'us.anthropic.claude-sonnet-4-6',
            'temperature': None,
            'max_tokens': 128,
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive', 'display': 'summarized'},
                'output_config': {'effort': 'medium'},
            },
        }
    ]


def test_model_effort_argument(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)

    build_model(effort='low')

    assert calls[0]['additional_model_request_fields'] == {
        'thinking': {'type': 'adaptive', 'display': 'summarized'},
        'output_config': {'effort': 'low'},
    }
    assert calls[0]['temperature'] is None


def test_deepseek_reasons_at_the_only_level_bedrock_honours(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.setenv('BOTCUBE_MODEL', 'deepseek.v3.2')
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)

    build_model(effort='low')

    # Bedrock's DeepSeek accepts "low" and "medium" but reasons only at "high".
    assert calls[0]['additional_model_request_fields'] == {'reasoning_config': 'high'}
    assert calls[0]['temperature'] == 0


def test_model_effort_invalid_raises() -> None:
    with pytest.raises(ValueError, match='Invalid effort level'):
        from botcube_harness_deepagents.agent import build_model
        build_model(effort='turbo')


@pytest.mark.skipif(
    os.environ.get('RUN_BEDROCK_SMOKE') != '1',
    reason='set RUN_BEDROCK_SMOKE=1 with AWS Bedrock credentials to run',
)
def test_agent_answers_simple_query_with_bedrock(tmp_path: Path) -> None:
    answer = ask(
        build_agent(
            backend=LocalShellBackend(
                root_dir=tmp_path,
                virtual_mode=True,
                inherit_env=False,
            ),
            skills=[],
        ),
        'What is 2+2? Reply in one sentence.',
    )

    assert answer.strip()


@pytest.mark.parametrize('helper', [None, {'name': 'helper', 'description': 'Checks the result.', 'system_prompt': 'Check.'}])
def test_upgraded_main_and_subagent_keep_file_tools_without_recursive_delete(
    tmp_path: Path, helper: dict[str, Any] | None,
) -> None:
    from collections.abc import Sequence

    from conftest import ToolBindableFakeMessagesModel

    bound_tools: list[set[str]] = []

    class CapturingModel(ToolBindableFakeMessagesModel):
        def bind_tools(self, tools: Sequence[Any], *, tool_choice: str | None = None, **kwargs: Any) -> 'CapturingModel':
            bound_tools.append({tool.name for tool in tools})
            return self

    model = CapturingModel(responses=[
        AIMessage(content='I will check with a helper.', tool_calls=[{
            'id': 'delegate-1', 'name': 'task', 'args': {
                'description': 'Check the result.', 'subagent_type': helper['name'] if helper else 'general-purpose',
            },
        }]),
        AIMessage(content='Checked.'),
        AIMessage(content='The helper checked the result.'),
    ])
    agent = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], subagents=[helper] if helper else [],
    )

    assert ask(agent, 'Check the result.') == 'The helper checked the result.'
    assert len(bound_tools) == 3
    for tools in bound_tools:
        assert {'read_file', 'write_file', 'execute'} <= tools
        assert 'delete' in tools
    assert not any('write_todos' in tools for tools in bound_tools)


@pytest.mark.parametrize('files_available', [True, False])
def test_default_general_purpose_subagent_reads_files_and_publishes_its_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, files_available: bool,
) -> None:
    import asyncio
    from types import SimpleNamespace

    import boto3
    from ag_ui.core import EventType, RunAgentInput, UserMessage
    from botocore.exceptions import ClientError
    from langchain_core.messages import ToolMessage
    from langchain_core.outputs import ChatResult
    from langgraph.checkpoint.memory import InMemorySaver
    from moto import mock_aws

    from botcube_harness_deepagents import serving
    from botcube_harness_deepagents.files_sync import FilesSync
    from conftest import ToolBindableFakeMessagesModel

    tool_results: list[str] = []

    class CapturingModel(ToolBindableFakeMessagesModel):
        def _generate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> ChatResult:
            tool_results.extend(message.text for message in messages if isinstance(message, ToolMessage))
            return super()._generate(messages, *args, **kwargs)

    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
    model = CapturingModel(responses=[
        AIMessage(content='', tool_calls=[{
            'id': 'delegate', 'name': 'task', 'args': {
                'description': 'Read source.txt and write answer.txt.', 'subagent_type': 'general-purpose',
            },
        }]),
        AIMessage(content='', tool_calls=[{
            'id': 'read-source', 'name': 'read_file', 'args': {'file_path': '/source.txt'},
        }]),
        AIMessage(content='', tool_calls=[{
            'id': 'write-answer', 'name': 'write_file', 'args': {'file_path': '/answer.txt', 'content': 'Copied from Files'},
        }]),
        AIMessage(content='Read the source and wrote the answer.'),
        AIMessage(content='The delegated work is complete.'),
    ])
    graph = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], checkpointer=InMemorySaver(),
    )
    agent = serving._SessionAgent(name='delegated-files', graph=graph)
    request = RunAgentInput(
        thread_id='delegated-files', run_id='delegated-run',
        messages=[UserMessage(id='question', role='user', content='Delegate reading source.txt and writing answer.txt.')],
        tools=[], context=[], state={}, forwarded_props={},
    )

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='delegated-files')
        if files_available:
            s3.put_object(Bucket='delegated-files', Key='owner/source.txt', Body=b'Original from Files')
        else:
            s3.delete_bucket(Bucket='delegated-files')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('delegated-files', 'owner/', 'us-east-1', {})

        async def exercise() -> None:
            stream = serving._SessionTurns().stream(
                ('owner', 'delegated-files'), prepared(agent, tmp_path), request, files, serving._RequestContext(None),
            )
            if not files_available:
                with pytest.raises(ClientError, match='NoSuchBucket'):
                    _ = [event async for event in stream]
                assert not (tmp_path / 'answer.txt').exists()
                return
            events = [event async for event in stream]
            assert events[-1].type == EventType.RUN_FINISHED
            assert any('Original from Files' in result for result in tool_results), tool_results
            assert s3.get_object(Bucket='delegated-files', Key='owner/answer.txt')['Body'].read() == b'Copied from Files'

        asyncio.run(exercise())


@pytest.mark.parametrize('helper', [
    None,
    {'name': 'helper', 'description': 'Checks the result.', 'system_prompt': 'Check.', 'skills': ['/helper-skills/']},
    {'name': 'helper', 'description': 'Checks the result.', 'mode': 'fork'},
])
def test_upgraded_skills_keep_the_complete_schema_and_each_agents_sources(
    tmp_path: Path, helper: dict[str, Any] | None,
) -> None:
    from langchain_core.outputs import ChatResult
    from langgraph.checkpoint.memory import InMemorySaver

    from conftest import ToolBindableFakeMessagesModel

    for folder, name in [('skills', 'main-cue'), ('helper-skills', 'helper-cue')]:
        source = tmp_path / folder / name
        source.mkdir(parents=True)
        (source / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Checks the result.\n---\nCheck the result.\n')
    prompts: list[str] = []

    class CapturingModel(ToolBindableFakeMessagesModel):
        def _generate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> ChatResult:
            prompts.append(messages[0].text)
            return super()._generate(messages, *args, **kwargs)

    model = CapturingModel(responses=[
        AIMessage(content='I will ask a helper.', tool_calls=[{
            'id': 'delegate-1', 'name': 'task', 'args': {
                'description': 'Check the result.', 'subagent_type': helper['name'] if helper else 'general-purpose',
            },
        }]),
        AIMessage(content='Checked.'),
        AIMessage(content='The helper checked the result.'),
    ])
    graph = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=['/skills/'], subagents=[helper] if helper else [], checkpointer=InMemorySaver(),
    )
    input_schema = graph.get_input_jsonschema()
    assert set(input_schema['properties']) == {'messages', 'skills_metadata'}
    metadata = input_schema['$defs']['_SkillMetadata']
    assert set(metadata['properties']) == {
        'path', 'name', 'description', 'license', 'compatibility', 'metadata', 'allowed_tools',
    }
    assert set(metadata['required']) == {
        'path', 'name', 'description', 'license', 'compatibility', 'metadata', 'allowed_tools',
    }
    assert set(graph.get_output_jsonschema()['properties']) == {'messages', 'structured_response'}
    config = {'configurable': {'thread_id': 'schema-turn'}}
    result = graph.invoke({'messages': 'Check the result.'}, config)

    assert result['messages'][-1].content == 'The helper checked the result.'
    assert len(prompts) == 3
    assert 'main-cue' in prompts[0] and 'helper-cue' not in prompts[0]
    own_sources = helper is not None and 'skills' in helper
    assert ('helper-cue' in prompts[1]) is own_sources
    assert ('main-cue' in prompts[1]) is not own_sources
    state = graph.get_state(config).values
    assert state['skills_metadata'] == [{
        'path': '/skills/main-cue/SKILL.md', 'name': 'main-cue', 'description': 'Checks the result.',
        'license': None, 'compatibility': None, 'metadata': {}, 'allowed_tools': [],
    }]
    assert state['skills_load_errors'] == []
    assert state['_skill_tools_disclosed'] == {}


def _bedrock_delegation_response(call: int, subagent_type: str) -> dict[str, Any]:
    content = [{'text': 'Checked.' if call == 2 else 'The helper checked the result.'}]
    if call == 1:
        content = [{'toolUse': {'toolUseId': 'delegate-1', 'name': 'task', 'input': {
            'description': 'Check the result.', 'subagent_type': subagent_type,
        }}}]
    return {
        'output': {'message': {'role': 'assistant', 'content': content}},
        'stopReason': 'tool_use' if call == 1 else 'end_turn',
        'usage': {'inputTokens': 40, 'outputTokens': 10, 'totalTokens': 110,
                  'cacheReadInputTokens': 40, 'cacheWriteInputTokens': 20},
        'metrics': {'latencyMs': 1},
    }


@pytest.mark.parametrize('helper', [None, {'name': 'helper', 'description': 'Checks the result.', 'system_prompt': 'Check.'}])
@pytest.mark.parametrize('model_id', ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-opus-4-6-v1'])
def test_bedrock_delegation_uses_native_cache_points_and_collects_with_outer_turn_lifecycle(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, helper: dict[str, Any] | None, model_id: str,
) -> None:
    import json
    import logging

    from langchain_aws import ChatBedrockConverse

    from botcube_harness_deepagents.prompt_cache_observability import (
        PromptCacheUsageMiddleware,
        prompt_cache_turn,
    )

    requests: list[dict[str, Any]] = []

    class Client:
        def converse(self, **kwargs: Any) -> dict[str, Any]:
            requests.append(kwargs)
            return _bedrock_delegation_response(len(requests), helper['name'] if helper else 'general-purpose')

    model = ChatBedrockConverse(
        model=model_id, region_name='us-east-1', disable_streaming=True,
        aws_access_key_id=SecretStr('test'), aws_secret_access_key=SecretStr('test'), client=Client(),
    )
    agent = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], subagents=[helper] if helper else [],
    )
    turn_usage = PromptCacheUsageMiddleware(thread_id='cache-turn', model=model_id, effort='medium')
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        result = agent.invoke({'messages': 'Check the result.'})
        turn_usage.after_answer(result, None)
        assert result['messages'][-1].text == 'The helper checked the result.'

    assert len(requests) == 3
    for request in requests:
        assert sum('cachePoint' in block for block in request['system']) == 1
        assert sum('cachePoint' in block for block in request['toolConfig']['tools']) == 1
        assert sum('cachePoint' in block for message in request['messages'] for block in message['content']) == (2 if len(request['messages']) >= 2 else 1)
    payload = json.loads(next(record.message for record in caplog.records if record.name == 'botcube_harness_deepagents.prompt_cache'))
    assert {key: payload[key] for key in (
        'input_tokens', 'output_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
    )} == {
        'input_tokens': 300, 'output_tokens': 30, 'total_tokens': 330,
        'cache_read_input_tokens': 120, 'cache_creation_input_tokens': 60,
    }


def test_instrumented_sync_only_before_model_runs_during_async_invocation(tmp_path: Path) -> None:
    import asyncio

    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.messages import HumanMessage
    from opentelemetry.instrumentation.langchain import LangchainInstrumentor

    class SyncOnlyMiddleware(AgentMiddleware):
        def before_model(self, state: Any, runtime: Any) -> dict[str, Any]:
            return {'messages': [HumanMessage(content='The sync hook ran.')]}

    instrumentor = LangchainInstrumentor()
    hooks = {name: getattr(AgentMiddleware, name) for name in (
        'before_agent', 'abefore_agent', 'before_model', 'abefore_model',
        'after_agent', 'aafter_agent', 'after_model', 'aafter_model',
    )}
    enabled = not instrumentor.is_instrumented_by_opentelemetry
    if enabled:
        instrumentor.instrument()
    try:
        agent = build_agent(
            model=ToolBindableFakeModel(responses=['Done.']),
            backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], middleware=[SyncOnlyMiddleware()],
        )
        result = asyncio.run(agent.ainvoke({'messages': 'Start.'}))
        assert [message.content for message in result['messages']] == ['Start.', 'The sync hook ran.', 'Done.']
    finally:
        if enabled:
            instrumentor.uninstrument()
        for name, method in hooks.items():
            setattr(AgentMiddleware, name, method)


@pytest.mark.parametrize(('key', 'model_id', 'anthropic'), [
    ('sonnet-4.6', 'us.anthropic.claude-sonnet-4-6', True),
    ('opus-4.6', 'us.anthropic.claude-opus-4-6-v1', True),
    ('opus-5.5', 'us.anthropic.claude-opus-5-5', True),
    ('sonnet-5.5', 'us.anthropic.claude-sonnet-5-5', True),
    ('deepseek-v3.2', 'deepseek.v3.2', False),
])
def test_staged_model_keys_reach_bedrock(
    key: str, model_id: str, anthropic: bool,
    monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder],
) -> None:
    from botcube_harness_deepagents.llm import build_model

    monkeypatch.setitem(sys.modules, 'langchain_aws', _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder))
    build_model(model=key, region_name='us-east-1', effort='high', max_tokens=4096)

    expected: dict[str, Any] = {
        'model': model_id, 'region_name': 'us-east-1',
        'max_tokens': 4096, 'temperature': None if anthropic else 0, **SHARED_CLIENTS,
    }
    expected['additional_model_request_fields'] = {
        'thinking': {'type': 'adaptive', 'display': 'summarized'}, 'output_config': {'effort': 'high'},
    } if anthropic else {'reasoning_config': 'high'}
    assert kwargs_recorder.calls == [expected]


@pytest.mark.parametrize('hook', ['after_agent', 'after_model'])
def test_a_middleware_that_adds_a_step_after_the_answer_is_refused(tmp_path: Path, hook: str) -> None:
    exit_step = type('ExitStep', (AgentMiddleware,), {hook: lambda self, state, runtime: None})
    with pytest.raises(ValueError, match=f'ExitStep.{hook}'):
        build_agent(model=GenericFakeChatModel(messages=iter([])),
                    backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
                    skills=[], middleware=[exit_step()])
