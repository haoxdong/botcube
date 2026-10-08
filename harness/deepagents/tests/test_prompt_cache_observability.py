from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Unpack
from unittest.mock import Mock

import pytest
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.messages.ai import InputTokenDetails, UsageMetadata

from botcube_harness_deepagents.prompt_cache_observability import (
    PromptCacheUsageCollectorMiddleware,
    PromptCacheUsageMiddleware,
    install_prompt_cache_usage_callback,
    prompt_cache_turn,
)


def test_prompt_cache_usage_middleware_emits_structured_turn_counters(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(
        thread_id='thread-1',
        model='us.anthropic.claude-sonnet-4-6',
        effort='medium',
    )
    state = {
        'messages': [
            HumanMessage(content='previous turn'),
            AIMessage(
                content='old answer',
                usage_metadata={
                    'input_tokens': 1,
                    'output_tokens': 1,
                    'total_tokens': 2,
                    'input_token_details': {'cache_read': 1, 'cache_creation': 1},
                },
            ),
            HumanMessage(content='current turn'),
            AIMessage(
                content='first current answer',
                usage_metadata={
                    'input_tokens': 1000,
                    'output_tokens': 20,
                    'total_tokens': 1020,
                    'input_token_details': {
                        'cache_read': 700,
                        'cache_creation': 300,
                    },
                },
            ),
            AIMessage(
                content='second current answer',
                usage_metadata={
                    'input_tokens': 500,
                    'output_tokens': 10,
                    'total_tokens': 510,
                    'input_token_details': {
                        'cache_read': 250,
                        'cache_creation': 50,
                    },
                },
            ),
        ]
    }

    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'),
        prompt_cache_turn('agentcore-session-1'),
    ):
        asyncio.run(middleware.aafter_agent(state, runtime=object()))

    assert len(caplog.records) == 1
    payload = json.loads(caplog.records[0].message)
    assert list(payload) == sorted(payload)
    assert payload == {
        'event': 'bedrock_prompt_cache_usage',
        'thread_id': 'thread-1',
        'model': 'us.anthropic.claude-sonnet-4-6',
        'effort': 'medium',
        'agentcore_session_id': 'agentcore-session-1',
        'input_tokens': 1500,
        'output_tokens': 30,
        'total_tokens': 1530,
        'cache_read_input_tokens': 950,
        'cache_creation_input_tokens': 350,
        'cache_read_to_creation_ratio': 2.714286,
        'input_message': 'current turn',
        'output_message': 'second current answer',
    }


def test_prompt_cache_usage_middleware_logs_bounded_text_messages(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(
        thread_id='thread-1',
        model='us.anthropic.claude-sonnet-4-6',
        effort='medium',
    )
    state = {
        'messages': [
            HumanMessage(content='prior turn'),
            AIMessage(content='prior answer'),
            HumanMessage(content=[
                {'type': 'text', 'text': '  current\ninput  '},
                {'type': 'image_url', 'image_url': {'url': 'private-image'}},
                {'type': 'text', 'text': 'windows\r\nline\rold mac line'},
            ]),
            AIMessage(content='', tool_calls=[{
                'name': 'lookup',
                'args': {'secret': 'tool payload'},
                'id': 'call-1',
                'type': 'tool_call',
            }]),
            ToolMessage(content='private tool result', tool_call_id='call-1'),
            AIMessage(
                content='  final\nanswer  ' + ('x' * 2_100),
                usage_metadata={
                    'input_tokens': 10,
                    'output_tokens': 2,
                    'total_tokens': 12,
                },
            ),
        ]
    }

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        asyncio.run(middleware.aafter_agent(state, runtime=object()))

    payload = json.loads(caplog.records[0].message)
    assert payload['input_message'] == '  current input   windows line old mac line'
    assert payload['output_message'] == '  final answer  ' + 'x' * 1_981 + '...'
    assert (payload['input_tokens'], payload['cache_read_input_tokens'], payload['cache_creation_input_tokens']) == (
        10,
        0,
        0,
    )
    assert payload['cache_read_to_creation_ratio'] is None


def _log_turn(caplog: pytest.LogCaptureFixture, messages: list[BaseMessage]) -> dict[str, object]:
    middleware = PromptCacheUsageMiddleware(thread_id='thread-1', model='us.anthropic.claude-sonnet-4-6', effort='low')
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        middleware.after_agent({'messages': messages}, runtime=object())
    return json.loads(caplog.records[0].message)


def _usage(tokens: int, **details: Unpack[InputTokenDetails]) -> UsageMetadata:
    return {'input_tokens': tokens, 'output_tokens': 1, 'total_tokens': tokens + 1, 'input_token_details': details}


def test_a_message_at_the_log_limit_is_logged_whole(caplog: pytest.LogCaptureFixture) -> None:
    payload = _log_turn(caplog, [HumanMessage('q'), AIMessage('y' * 2_000, usage_metadata=_usage(10))])

    assert payload['output_message'] == 'y' * 2_000


def test_a_turn_without_a_text_reply_logs_an_empty_output_message(caplog: pytest.LogCaptureFixture) -> None:
    ask = AIMessage('', tool_calls=[{'name': 'ls', 'args': {}, 'id': 'call-1', 'type': 'tool_call'}], usage_metadata=_usage(10))

    assert _log_turn(caplog, [HumanMessage('q'), ask])['output_message'] == ''


def test_the_ratio_divides_by_a_single_written_token(caplog: pytest.LogCaptureFixture) -> None:
    payload = _log_turn(caplog, [HumanMessage('q'), AIMessage('a', usage_metadata=_usage(10, cache_read=5, cache_creation=1))])

    assert payload['cache_read_to_creation_ratio'] == 5.0


def test_a_turn_without_usage_logs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(thread_id='thread-1', model='us.anthropic.claude-sonnet-4-6', effort='low')
    state = {'messages': [HumanMessage('q'), AIMessage('a')]}

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        middleware.after_agent(state, runtime=object())

    assert caplog.records == []


def test_a_synchronous_turn_logs_the_usage_of_its_model_calls(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(thread_id='thread-1', model='us.anthropic.claude-sonnet-4-6', effort='low')
    collector = PromptCacheUsageCollectorMiddleware()
    request = Mock(spec=ModelRequest)
    responses: dict[Any, ModelResponse] = {
        request: ModelResponse(result=[AIMessage('delegated', usage_metadata=_usage(300, cache_read=120))])
    }

    def handler(sent: ModelRequest) -> ModelResponse:
        return responses[sent]

    state = {'messages': [HumanMessage('q'), AIMessage('a', usage_metadata=_usage(100))]}

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        response = collector.wrap_model_call(request, handler)
        middleware.after_agent(state, runtime=object())

    assert response is responses[request]
    payload = json.loads(caplog.records[0].message)
    assert (payload['input_tokens'], payload['cache_read_input_tokens']) == (300, 120)


def test_prompt_cache_usage_middleware_accepts_bedrock_usage_aliases(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(
        thread_id='thread-1',
        model='us.anthropic.claude-opus-4-6-v1',
        effort='max',
    )
    state = {
        'messages': [
            HumanMessage(content='current turn'),
            AIMessage(
                content='ok',
                usage_metadata={
                    'input_tokens': 200,
                    'output_tokens': 10,
                    'total_tokens': 210,
                    'cacheReadInputTokens': 125,
                    'cacheWriteInputTokens': 75,
                },
            ),
        ]
    }

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        asyncio.run(middleware.aafter_agent(state, runtime=object()))

    payload = json.loads(caplog.records[0].message)
    assert payload['cache_read_input_tokens'] == 125
    assert payload['cache_creation_input_tokens'] == 75
    assert payload['cache_read_to_creation_ratio'] == 1.666667


def test_prompt_cache_usage_middleware_includes_delegated_model_calls(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(
        thread_id='thread-1',
        model='us.anthropic.claude-sonnet-4-6',
        effort='medium',
    )
    collector = PromptCacheUsageCollectorMiddleware()
    parent_message = AIMessage(
        content='parent answer',
        usage_metadata={
            'input_tokens': 100,
            'output_tokens': 10,
            'total_tokens': 110,
            'input_token_details': {'cache_read': 40, 'cache_creation': 20},
        },
    )
    subagent_message = AIMessage(
        content='delegated answer',
        usage_metadata={
            'input_tokens': 300,
            'output_tokens': 30,
            'total_tokens': 330,
            'input_token_details': {'cache_read': 120, 'cache_creation': 60},
        },
    )
    state = {'messages': [HumanMessage(content='current turn'), parent_message]}

    parent_request = Mock(spec=ModelRequest)
    subagent_request = Mock(spec=ModelRequest)
    responses: dict[object, ModelResponse] = {
        parent_request: ModelResponse(result=[parent_message]),
        subagent_request: ModelResponse(result=[subagent_message]),
    }

    async def handler(request: ModelRequest) -> ModelResponse:
        return responses[request]

    async def run_turn() -> None:
        await collector.awrap_model_call(parent_request, handler)
        await collector.awrap_model_call(subagent_request, handler)
        await middleware.aafter_agent(state, runtime=object())

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        asyncio.run(run_turn())

    payload = json.loads(caplog.records[0].message)
    assert payload['input_tokens'] == 400
    assert payload['output_tokens'] == 40
    assert payload['total_tokens'] == 440
    assert payload['cache_read_input_tokens'] == 160
    assert payload['cache_creation_input_tokens'] == 80
    assert payload['cache_read_to_creation_ratio'] == 2.0


def test_prompt_cache_usage_keeps_main_turn_when_only_summary_callback_fires(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Unmapped Bedrock Converse models (ADR 0018) never get the collector
    middleware, so ``wrap_model_call`` does not record the main turn.  A
    summarization run still installs its usage through the callback.  The
    emitted payload must add that summary to the main-turn message usage rather
    than replacing (and dropping) the assistant response.
    """
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult

    class FakeSummarizationModel(BaseChatModel):
        @property
        def _llm_type(self) -> str:
            return 'fake-summary-model'

        def _generate(
            self,
            messages: list[BaseMessage],
            stop: list[str] | None = None,
            run_manager: CallbackManagerForLLMRun | None = None,
            **kwargs: object,
        ):
            # A summary run costs 300 input tokens; any other run 7.
            tokens = 300 if messages[-1].content == 'summarize this' else 7
            return ChatResult(generations=[
                ChatGeneration(message=AIMessage(
                    content='summary',
                    usage_metadata={
                        'input_tokens': tokens,
                        'output_tokens': 30,
                        'total_tokens': 330,
                        'input_token_details': {'cache_read': 120, 'cache_creation': 60},
                    },
                ))
            ])

    middleware = PromptCacheUsageMiddleware(
        thread_id='thread-1',
        model='us.deepseek.r1',
        effort='medium',
    )
    model = install_prompt_cache_usage_callback(FakeSummarizationModel())
    state = {
        'messages': [
            HumanMessage(content='current turn'),
            AIMessage(
                content='assistant answer',
                usage_metadata={
                    'input_tokens': 1000,
                    'output_tokens': 20,
                    'total_tokens': 1020,
                    'input_token_details': {'cache_read': 700, 'cache_creation': 300},
                },
            ),
        ]
    }

    async def run_turn() -> None:
        # Summarization runs the model directly (outside wrap_model_call); the
        # installed callback records its usage.  No collector middleware fires.
        model.invoke(
            'summarize this',
            config={'metadata': {'lc_source': 'summarization'}},
        )
        # Its other runs are the main turn's, which the turn's messages count.
        model.invoke('answer this')
        await middleware.aafter_agent(state, runtime=object())

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        asyncio.run(run_turn())

    payload = json.loads(caplog.records[0].message)
    assert payload['input_tokens'] == 1300
    assert payload['output_tokens'] == 50
    assert payload['total_tokens'] == 1350
    assert payload['cache_read_input_tokens'] == 820
    assert payload['cache_creation_input_tokens'] == 360
