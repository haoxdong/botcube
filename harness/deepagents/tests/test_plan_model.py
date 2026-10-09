"""A plan model's calls go to the Credential Service relay under the Turn's invocation token (ADR 0078)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator

import openai
import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from botcube_harness_deepagents.llm import ModelRelay, PlanUsageError, build_model
from relay_fake import (
    FakeRelay,
    RelayReply,
    failing_stream,
    plan_usage_error,
    serving_relay,
)


@pytest.fixture
def relay() -> Iterator[FakeRelay]:
    with serving_relay() as fake:
        yield fake


def _relay(fake: FakeRelay, token: str = 'invocation-1') -> ModelRelay:
    return ModelRelay(
        base_url=fake.url,
        token=token,
        headers={'X-Account-Id': 'acct-1', 'X-Session-Id': 'thread-1'},
        session_id='thread-1',
    )


def test_a_plan_model_streams_its_reply_through_the_relay(relay: FakeRelay) -> None:
    model = build_model(model='openai-plan:gpt-6-astra', max_tokens=16000, relay=lambda: _relay(relay))

    reply = model.invoke([SystemMessage('Be brief.'), HumanMessage('Say exactly: hello')])

    assert reply.text == 'hello'
    [call] = relay.calls
    assert call['path'] == '/openai/v1/responses'


def test_a_plan_model_calls_the_relay_under_the_invocation_token_and_its_session(relay: FakeRelay) -> None:
    model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: _relay(relay))

    model.invoke([HumanMessage('Say exactly: hello')])

    [call] = relay.calls
    headers = {name.lower(): value for name, value in call['headers'].items()}
    assert headers['authorization'] == 'Bearer invocation-1'
    assert headers['x-account-id'] == 'acct-1'
    assert headers['x-session-id'] == 'thread-1'


def test_a_cached_plan_model_takes_each_turns_invocation_token(relay: FakeRelay) -> None:
    current = {'token': 'invocation-1'}
    model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: _relay(relay, current['token']))

    model.invoke([HumanMessage('Say exactly: hello')])
    current['token'] = 'invocation-2'
    model.invoke([HumanMessage('Say exactly: hello')])

    assert [call['headers']['Authorization'] for call in relay.calls] == ['Bearer invocation-1', 'Bearer invocation-2']


def test_plan_requests_follow_the_plan_request_rules(relay: FakeRelay) -> None:
    model = build_model(model='openai-plan:gpt-6-astra', max_tokens=16000, effort='high', relay=lambda: _relay(relay))

    model.invoke([SystemMessage('Be brief.'), HumanMessage('Say exactly: hello')])

    [call] = relay.calls
    body = call['body']
    assert body['model'] == 'gpt-6-astra'
    assert body['stream'] is True
    assert body['store'] is False
    assert 'temperature' not in body
    assert 'max_output_tokens' not in body
    assert [item['role'] for item in body['input']] == ['developer', 'user']


def test_plan_history_replays_tool_calls_results_and_images_as_responses_json(relay: FakeRelay) -> None:
    model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: _relay(relay))
    tool = {'type': 'function', 'function': {
        'name': 'lookup', 'description': 'Look up a symbol',
        'parameters': {'type': 'object', 'properties': {'symbol': {'type': 'string'}}, 'required': ['symbol']},
    }}
    messages = [
        SystemMessage('Be brief.'),
        HumanMessage('Look up copper.'),
        AIMessage('', tool_calls=[{'id': 'lookup-1', 'name': 'lookup', 'args': {'symbol': 'HG'}}]),
        ToolMessage('Copper result', tool_call_id='lookup-1'),
        HumanMessage([{'type': 'text', 'text': 'Read this chart.'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,dGVzdA=='}}]),
    ]

    asyncio.run(model.bind_tools([tool]).ainvoke(messages))

    [call] = relay.calls
    assert call['body']['input'] == [
        {'type': 'message', 'role': 'developer', 'content': 'Be brief.'},
        {'type': 'message', 'role': 'user', 'content': 'Look up copper.'},
        {'type': 'function_call', 'name': 'lookup', 'arguments': '{"symbol": "HG"}', 'call_id': 'lookup-1'},
        {'type': 'function_call_output', 'output': 'Copper result', 'call_id': 'lookup-1'},
        {'type': 'message', 'role': 'user', 'content': [
            {'type': 'input_text', 'text': 'Read this chart.'},
            {'type': 'input_image', 'image_url': 'data:image/png;base64,dGVzdA=='},
        ]},
    ]
    assert call['body']['tools'] == [{
        'type': 'function', 'name': 'lookup', 'description': 'Look up a symbol',
        'parameters': {'type': 'object', 'properties': {'symbol': {'type': 'string'}}, 'required': ['symbol']},
    }]
    assert 'extra_body' not in call['body']


def test_every_step_of_a_session_asks_for_the_prompt_cache_under_the_sessions_key(relay: FakeRelay) -> None:
    model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: _relay(relay))

    model.invoke([HumanMessage('Say exactly: hello')])
    model.invoke([HumanMessage('Say exactly: hello'), HumanMessage('Say it again')])

    assert [call['body']['prompt_cache_key'] for call in relay.calls] == ['thread-1', 'thread-1']


def test_a_plan_model_asks_for_its_reasoning_summaries_at_the_plans_default_effort(relay: FakeRelay) -> None:
    model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: _relay(relay))

    model.invoke([HumanMessage('Say exactly: hello')])

    [call] = relay.calls
    assert call['body']['reasoning'] == {'summary': 'auto'}


def test_a_plan_model_without_the_relay_fails_loud() -> None:
    with pytest.raises(RuntimeError) as raised:
        build_model(model='openai-plan:gpt-6-astra')

    assert str(raised.value) == (
        'Model "openai-plan:gpt-6-astra" runs on Plan Usage, which needs the Credential Service relay; '
        'this Turn has none'
    )


LIMIT = plan_usage_error(
    'PLAN_USAGE_LIMIT_REACHED',
    "Your ChatGPT plan's usage limit is reached; wait, or check ChatGPT Settings > Usage "
    '(OpenAI subscription_sharing_usage_limit_exceeded).',
)


def _ask(relay: FakeRelay) -> object:
    model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: _relay(relay))
    return asyncio.run(model.ainvoke([HumanMessage('Say exactly: hello')]))


def test_a_classified_error_before_the_stream_is_a_plan_usage_error(relay: FakeRelay) -> None:
    relay.reply = RelayReply(429, json.dumps(LIMIT).encode(), 'application/json')

    with pytest.raises(PlanUsageError) as raised:
        _ask(relay)

    assert raised.value.code == 'PLAN_USAGE_LIMIT_REACHED'
    assert str(raised.value) == LIMIT['error']['message']


def test_the_relays_provider_timeout_ends_the_model_call_with_its_code_issue_3284(relay: FakeRelay) -> None:
    timeout = plan_usage_error(
        'MODEL_PROVIDER_TIMEOUT', 'OpenAI did not respond to the model call; try again (no response within 300 s).',
    )
    relay.reply = RelayReply(504, json.dumps(timeout).encode(), 'application/json')

    with pytest.raises(PlanUsageError) as raised:
        _ask(relay)

    assert raised.value.code == 'MODEL_PROVIDER_TIMEOUT'
    assert str(raised.value) == timeout['error']['message']


def test_a_classified_error_mid_stream_is_a_plan_usage_error(relay: FakeRelay) -> None:
    relay.reply = RelayReply(body=failing_stream(LIMIT))

    with pytest.raises(PlanUsageError) as raised:
        _ask(relay)

    assert raised.value.code == 'PLAN_USAGE_LIMIT_REACHED'
    assert str(raised.value) == LIMIT['error']['message']


def test_an_error_plan_usage_does_not_name_stays_openais(relay: FakeRelay) -> None:
    relay.reply = RelayReply(403, b'{"detail":"Direct routing is not permitted in this region"}', 'application/json')

    with pytest.raises(openai.PermissionDeniedError):
        _ask(relay)


def test_async_cached_plan_model_correlates_each_turn_and_step(relay: FakeRelay) -> None:
    from opentelemetry import baggage, context

    model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: _relay(relay))

    async def ask(run: str) -> None:
        token = context.attach(baggage.set_baggage('run.id', run))
        try:
            await model.ainvoke([HumanMessage('Say exactly: hello')])
        finally:
            context.detach(token)

    asyncio.run(ask('turn-1'))
    asyncio.run(ask('turn-2'))
    headers = [{name.lower(): value for name, value in call['headers'].items()} for call in relay.calls]
    assert [item['x-botcube-run-id'] for item in headers] == ['turn-1', 'turn-2']
    steps = [item['x-botcube-model-step-id'] for item in headers]
    assert all(steps)
    assert steps[0] != steps[1]
