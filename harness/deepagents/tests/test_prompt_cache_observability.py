from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Unpack

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.messages.ai import InputTokenDetails, UsageMetadata

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.prompt_cache_observability import (
    PromptCacheUsageMiddleware,
    prompt_cache_turn,
)
from conftest import ToolBindableFakeMessagesModel


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
        middleware.after_answer(state, None)

    assert len(caplog.records) == 1
    line = caplog.records[0].message
    payload = json.loads(line)
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
    }
    for message in state['messages']:
        assert message.content not in line


def _log_turn(caplog: pytest.LogCaptureFixture, messages: list[BaseMessage]) -> dict[str, object]:
    middleware = PromptCacheUsageMiddleware(thread_id='thread-1', model='us.anthropic.claude-sonnet-4-6', effort='low')
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        middleware.after_answer({'messages': messages}, None)
    return json.loads(caplog.records[0].message)


def _usage(tokens: int, **details: Unpack[InputTokenDetails]) -> UsageMetadata:
    return {'input_tokens': tokens, 'output_tokens': 1, 'total_tokens': tokens + 1, 'input_token_details': details}


def test_a_turn_without_cache_counters_logs_zeros_and_no_ratio(caplog: pytest.LogCaptureFixture) -> None:
    payload = _log_turn(caplog, [HumanMessage('q'), AIMessage('a', usage_metadata=_usage(10))])

    assert (payload['cache_read_input_tokens'], payload['cache_creation_input_tokens']) == (0, 0)
    assert payload['cache_read_to_creation_ratio'] is None


def test_the_ratio_divides_by_a_single_written_token(caplog: pytest.LogCaptureFixture) -> None:
    payload = _log_turn(caplog, [HumanMessage('q'), AIMessage('a', usage_metadata=_usage(10, cache_read=5, cache_creation=1))])

    assert payload['cache_read_to_creation_ratio'] == 5.0


def test_a_turn_without_usage_logs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(thread_id='thread-1', model='us.anthropic.claude-sonnet-4-6', effort='low')
    state = {'messages': [HumanMessage('q'), AIMessage('a')]}

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        middleware.after_answer(state, None)

    assert caplog.records == []


def test_a_synchronous_turn_logs_the_usage_of_its_model_calls(caplog: pytest.LogCaptureFixture) -> None:
    middleware = PromptCacheUsageMiddleware(thread_id='thread-1', model='us.anthropic.claude-sonnet-4-6', effort='low')
    model = ToolBindableFakeMessagesModel(responses=[
        AIMessage('delegated', usage_metadata=_usage(300, cache_read=120)),
    ])
    state = {'messages': [HumanMessage('q'), AIMessage('a', usage_metadata=_usage(100))]}

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        response = model.invoke('delegate')
        middleware.after_answer(state, None)

    assert response.content == 'delegated'
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
        middleware.after_answer(state, None)

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

    model = ToolBindableFakeMessagesModel(responses=[parent_message, subagent_message])

    async def run_turn() -> None:
        await model.ainvoke('parent')
        await model.ainvoke('delegate')
        middleware.after_answer(state, None)

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        asyncio.run(run_turn())

    payload = json.loads(caplog.records[0].message)
    assert payload['input_tokens'] == 400
    assert payload['output_tokens'] == 40
    assert payload['total_tokens'] == 440
    assert payload['cache_read_input_tokens'] == 160
    assert payload['cache_creation_input_tokens'] == 80
    assert payload['cache_read_to_creation_ratio'] == 2.0


def test_prompt_cache_usage_counts_summary_and_main_graph_calls(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    model = ToolBindableFakeMessagesModel(responses=[
        AIMessage('summary', usage_metadata={
            'input_tokens': 300, 'output_tokens': 30, 'total_tokens': 330,
            'input_token_details': {'cache_read': 120, 'cache_creation': 60},
        }),
        AIMessage('assistant answer', usage_metadata={
            'input_tokens': 1000, 'output_tokens': 20, 'total_tokens': 1020,
            'input_token_details': {'cache_read': 700, 'cache_creation': 300},
        }),
    ])
    graph = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], middleware=[
            PromptCacheUsageMiddleware(thread_id='thread-1', model='deepseek.v3.2', effort='medium'),
        ],
    )

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        model.invoke('summarize this', config={'metadata': {'lc_source': 'summarization'}})
        result = graph.invoke({'messages': 'answer this'})

    assert result['messages'][-1].text == 'assistant answer'
    payload = json.loads(caplog.records[0].message)
    assert payload['input_tokens'] == 1300
    assert payload['output_tokens'] == 50
    assert payload['total_tokens'] == 1350
    assert payload['cache_read_input_tokens'] == 820
    assert payload['cache_creation_input_tokens'] == 360


def test_usage_preserves_reasoning_and_non_cache_input_details() -> None:
    from botcube_harness_deepagents.prompt_cache_observability import (
        prompt_cache_usage_from_messages,
    )

    usage = prompt_cache_usage_from_messages([
        AIMessage('first', usage_metadata={
            'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15,
            'input_token_details': {'audio': 2, 'cache_read': 3},
            'output_token_details': {'reasoning': 4},
        }),
        AIMessage('second', usage_metadata={
            'input_tokens': 20, 'output_tokens': 6, 'total_tokens': 26,
            'input_token_details': {'audio': 3, 'cache_creation': 7},
            'output_token_details': {'reasoning': 5},
        }),
    ])

    assert usage == {
        'input_tokens': 30, 'output_tokens': 11, 'total_tokens': 41,
        'input_token_details': {'audio': 5, 'cache_read': 3, 'cache_creation': 7},
        'output_token_details': {'reasoning': 9},
    }


def test_turn_observer_preserves_existing_model_callbacks(caplog: pytest.LogCaptureFixture) -> None:
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.outputs import LLMResult

    ended: list[LLMResult] = []

    class ExistingCallback(BaseCallbackHandler):
        def on_llm_end(self, response: LLMResult, **kwargs: object) -> None:
            ended.append(response)

    callback = ExistingCallback()
    model = ToolBindableFakeMessagesModel(responses=[AIMessage('answer', usage_metadata=_usage(25))], callbacks=[callback])
    middleware = PromptCacheUsageMiddleware(thread_id='thread', model='fake', effort='low')
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        message = model.invoke('question')
        middleware.after_answer({'messages': [HumanMessage('question'), message]}, None)

    assert len(ended) == 1
    assert model.callbacks == [callback]
    assert json.loads(caplog.records[0].message)['input_tokens'] == 25
