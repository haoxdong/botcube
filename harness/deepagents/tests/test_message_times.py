"""A tool result's times, read from the agent message that made its call."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from botcube_harness_deepagents.message_times import MessageTimesMiddleware
from botcube_harness_deepagents.messages_snapshot import MESSAGE_TIMES

CALL = {'name': 'ls', 'args': {'path': '/'}, 'id': 'call-1', 'type': 'tool_call'}


def _answered(messages: list[BaseMessage], result: ToolMessage | Command[Any]) -> ToolMessage | Command[Any]:
    request = ToolCallRequest(tool_call=CALL, tool=None, state={'messages': messages}, runtime=None)  # type: ignore[arg-type]

    async def handler(_request: ToolCallRequest) -> ToolMessage | Command[Any]:
        return result

    return asyncio.run(MessageTimesMiddleware().awrap_tool_call(request, handler))


@pytest.mark.parametrize('messages', [
    pytest.param([AIMessage('', tool_calls=[CALL])], id='call recorded before stamping'),
    pytest.param([], id='call no agent message made'),
])
def test_a_result_whose_call_was_never_timed_stays_untimed(messages: list[BaseMessage]) -> None:
    result = ToolMessage('listed', tool_call_id='call-1')

    assert _answered(messages, result) == result


def test_a_result_landing_in_a_command_is_timed_from_its_calls_start() -> None:
    timed = AIMessage('', tool_calls=[CALL], response_metadata={MESSAGE_TIMES: {
        'started_at': 1000, 'ended_at': 1500, 'reasoning': [], 'tool_calls': {'call-1': 1200},
    }})
    todos = [{'content': 'List the files', 'status': 'completed'}]
    result = Command(update={'todos': todos, 'messages': [ToolMessage('Updated todos', tool_call_id='call-1')]})

    answered = _answered([timed], result)

    assert isinstance(answered, Command) and isinstance(answered.update, dict)
    assert answered.update['todos'] == todos
    [message] = answered.update['messages']
    assert message.content == 'Updated todos'
    assert message.response_metadata[MESSAGE_TIMES]['started_at'] == 1200
    assert message.response_metadata[MESSAGE_TIMES]['ended_at'] >= 1500
