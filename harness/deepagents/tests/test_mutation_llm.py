"""Plan calls retain tool bindings and fail a transient relay error without retrying (ADR 0078)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import openai
import pytest
from langchain_core.messages import HumanMessage

from botcube_harness_deepagents.llm import ModelRelay, build_model
from relay_fake import RelayReply, serving_relay

LOOKUP = {
    'type': 'function',
    'function': {
        'name': 'lookup',
        'description': 'Look up the requested item.',
        'parameters': {'type': 'object', 'properties': {}, 'required': []},
    },
}


@pytest.mark.parametrize('asynchronous', [False, True])
def test_plan_calls_send_the_agents_bound_tools_to_the_relay(asynchronous: bool) -> None:
    with serving_relay() as relay:
        model = build_model(
            model='openai-plan:gpt-6-astra',
            relay=lambda: ModelRelay(relay.url, 'invocation-1', {'X-Session-Id': 'thread-1'}, 'thread-1'),
        ).bind_tools([LOOKUP])

        if asynchronous:
            async def ask() -> Any:
                return await model.ainvoke([HumanMessage('Look up the item.')])

            reply = asyncio.run(ask())
        else:
            reply = model.invoke([HumanMessage('Look up the item.')])

        assert reply.text == 'hello'
        [call] = relay.calls
        assert call['body']['tools'] == [{
            'type': 'function',
            'name': 'lookup',
            'description': 'Look up the requested item.',
            'parameters': {'type': 'object', 'properties': {}, 'required': []},
        }]


def test_a_transient_relay_failure_ends_the_turn_without_retrying() -> None:
    with serving_relay() as relay:
        relay.reply = RelayReply(
            status=500,
            body=json.dumps({'error': {'type': 'server_error', 'message': 'Relay unavailable'}}).encode(),
            content_type='application/json',
        )
        model = build_model(
            model='openai-plan:gpt-6-astra',
            relay=lambda: ModelRelay(relay.url, 'invocation-1', {'X-Session-Id': 'thread-1'}, 'thread-1'),
        )

        async def ask() -> Any:
            return await model.ainvoke([HumanMessage('Say hello.')])

        with pytest.raises(openai.InternalServerError, match='Relay unavailable'):
            asyncio.run(ask())

        assert len(relay.calls) == 1
