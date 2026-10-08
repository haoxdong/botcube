import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, BaseMessage
from pydantic import SecretStr

from botcube_harness_deepagents.agent import AgentResponseError, ask, build_agent
from conftest import KwargsRecorder, ToolBindableFakeModel


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
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY',
        'ANTHROPIC_API_KEY',
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
        memory=[],
    )

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
    monkeypatch.setenv('BOTCUBE_MAX_TOKENS', '32')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    monkeypatch.delenv('BOTCUBE_EFFORT', raising=False)

    build_model()

    assert calls == [
        {
            'model': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
            'temperature': None,
            'max_tokens': 32,
            'region_name': 'us-east-1',
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive'},
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
    monkeypatch.delenv('BOTCUBE_MAX_TOKENS', raising=False)
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'eu-west-1')

    build_model()

    assert calls == [{'model': 'deepseek.v3.2', 'temperature': 0, 'max_tokens': 128, 'region_name': 'eu-west-1'}]


def test_model_uses_openai_constructor_for_openai_models(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_openai = _fake_module('langchain_openai', ChatOpenAI=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_openai', fake_langchain_openai)
    monkeypatch.setenv('BOTCUBE_MODEL', 'openai:gpt-5.5')

    result = build_model()

    assert isinstance(result, kwargs_recorder)
    assert calls == [
        {
            'model': 'openai.gpt-5.5',
            'temperature': 0,
            'max_tokens': 128,
            'use_responses_api': True,
        }
    ]


def test_llm_factory_uses_openrouter_for_openrouter_models(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.llm import build_model

    calls = kwargs_recorder.calls
    fake_langchain_openai = _fake_module('langchain_openai', ChatOpenAI=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_openai', fake_langchain_openai)
    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-key')

    build_model(model='openrouter:anthropic/claude-sonnet-4.6', max_tokens=256)

    assert calls == [{
        'model': 'anthropic/claude-sonnet-4.6',
        'base_url': 'https://openrouter.ai/api/v1',
        'api_key': 'test-key',
        'max_tokens': 256,
    }]


def test_llm_factory_uses_direct_anthropic_for_anthropic_models(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.llm import build_model

    calls = kwargs_recorder.calls
    fake_langchain_anthropic = _fake_module('langchain_anthropic', ChatAnthropic=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_anthropic', fake_langchain_anthropic)

    build_model(model='anthropic:claude-sonnet-4-6', max_tokens=256)

    assert calls == [{
        'model': 'claude-sonnet-4-6',
        'max_tokens': 256,
    }]


def test_model_resolves_ui_alias_and_effort(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    """Copilot model keys ('opus-4.6') resolve to Bedrock IDs."""
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)
    monkeypatch.delenv('BOTCUBE_EFFORT', raising=False)
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)

    build_model(model='opus-4.6', effort='high', max_tokens=4096)

    assert calls == [
        {
            'model': 'us.anthropic.claude-opus-4-6-v1',
            'temperature': None,
            'max_tokens': 4096,
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive'},
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
    monkeypatch.delenv('BOTCUBE_EFFORT', raising=False)

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
    monkeypatch.delenv('BOTCUBE_EFFORT', raising=False)

    result = build_model()

    assert isinstance(result, kwargs_recorder)
    assert calls == [
        {
            'model': 'us.anthropic.claude-sonnet-4-6',
            'temperature': None,
            'max_tokens': 128,
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive'},
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
    monkeypatch.delenv('BOTCUBE_MAX_TOKENS', raising=False)
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)

    build_model()

    assert calls == [
        {
            'model': 'deepseek.v3.2',
            'temperature': 0,
            'max_tokens': 128,
        }
    ]


def test_model_enables_adaptive_thinking_with_effort(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)
    monkeypatch.delenv('BOTCUBE_EFFORT', raising=False)

    build_model(effort='medium')

    assert calls == [
        {
            'model': 'us.anthropic.claude-sonnet-4-6',
            'temperature': None,
            'max_tokens': 128,
            'additional_model_request_fields': {
                'thinking': {'type': 'adaptive'},
                'output_config': {'effort': 'medium'},
            },
        }
    ]


def test_model_effort_from_env(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.delenv('BOTCUBE_MODEL', raising=False)
    monkeypatch.setenv('BOTCUBE_EFFORT', 'low')

    build_model()

    assert calls[0]['additional_model_request_fields'] == {
        'thinking': {'type': 'adaptive'},
        'output_config': {'effort': 'low'},
    }
    assert calls[0]['temperature'] is None


def test_model_no_thinking_for_non_anthropic(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    from botcube_harness_deepagents.agent import build_model

    calls = kwargs_recorder.calls
    fake_langchain_aws = _fake_module('langchain_aws', ChatBedrockConverse=kwargs_recorder)
    monkeypatch.setitem(sys.modules, 'langchain_aws', fake_langchain_aws)
    monkeypatch.setenv('BOTCUBE_MODEL', 'deepseek.v3.2')
    monkeypatch.delenv('BOTCUBE_MAX_TOKENS', raising=False)
    monkeypatch.delenv('AWS_REGION', raising=False)
    monkeypatch.delenv('AWS_DEFAULT_REGION', raising=False)
    monkeypatch.delenv('BOTCUBE_EFFORT', raising=False)

    build_model()

    assert 'additional_model_request_fields' not in calls[0]
    assert calls[0]['temperature'] == 0


def test_model_effort_invalid_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BOTCUBE_EFFORT', raising=False)

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
        skills=[], memory=[], subagents=[helper] if helper else [],
    )

    assert ask(agent, 'Check the result.') == 'The helper checked the result.'
    assert len(bound_tools) == 3
    for tools in bound_tools:
        assert {'read_file', 'write_file', 'execute'} <= tools
        assert 'delete' not in tools
    assert 'write_todos' in bound_tools[0]
    assert 'write_todos' not in bound_tools[1]
    assert 'write_todos' in bound_tools[2]


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
        skills=['/skills/'], memory=[], subagents=[helper] if helper else [], checkpointer=InMemorySaver(),
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
    assert set(graph.get_output_jsonschema()['properties']) == {'messages', 'structured_response', 'todos'}
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
        skills=[], memory=[], subagents=[helper] if helper else [],
    )
    turn_usage = PromptCacheUsageMiddleware(thread_id='cache-turn', model=model_id, effort='medium')
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        result = agent.invoke({'messages': 'Check the result.'})
        turn_usage.after_agent(result, runtime=object())
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
            skills=[], memory=[], middleware=[SyncOnlyMiddleware()],
        )
        result = asyncio.run(agent.ainvoke({'messages': 'Start.'}))
        assert [message.content for message in result['messages']] == ['Start.', 'The sync hook ran.', 'Done.']
    finally:
        if enabled:
            instrumentor.uninstrument()
        for name, method in hooks.items():
            setattr(AgentMiddleware, name, method)
