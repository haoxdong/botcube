"""Tool failures are results the agent can act on."""

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool
from openai import RateLimitError

from botcube_harness_deepagents.agent import build_agent
from conftest import ToolBindableFakeMessagesModel


@pytest.mark.parametrize('asynchronous', [False, True])
@pytest.mark.parametrize('error_type', [RuntimeError, ValueError])
def test_tool_exception_returns_to_agent(tmp_path: Path, asynchronous: bool, error_type: type[Exception]) -> None:
    @tool
    def broken_tool() -> str:
        """Read an unavailable external service."""
        raise error_type('Service unavailable')

    graph = build_agent(
        model=ToolBindableFakeMessagesModel(responses=[
            AIMessage(content='', tool_calls=[{'name': 'broken_tool', 'args': {}, 'id': 'broken'}]),
            AIMessage(content='The service is unavailable.'),
        ]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], tools=[broken_tool],
    )
    request = {'messages': 'Read the service.'}
    result = asyncio.run(graph.ainvoke(request)) if asynchronous else graph.invoke(request)
    errors = [message for message in result['messages'] if isinstance(message, ToolMessage)]
    assert len(errors) == 1
    assert errors[0].status == 'error'
    assert errors[0].tool_call_id == 'broken'
    assert errors[0].name == 'broken_tool'
    assert 'Service unavailable' in errors[0].content
    assert result['messages'][-1].content == 'The service is unavailable.'


@pytest.mark.parametrize('asynchronous', [False, True])
def test_subagent_model_429_returns_to_parent(tmp_path: Path, asynchronous: bool) -> None:
    class RateLimitedModel(ToolBindableFakeMessagesModel):
        def _generate(self, *args: Any, **kwargs: Any) -> Any:
            raise RateLimitError(
                'Subagent rate limited',
                response=httpx.Response(429, request=httpx.Request('POST', 'https://model.test')),
                body={'error': 'rate_limit'},
            )

    graph = build_agent(
        model=ToolBindableFakeMessagesModel(responses=[
            AIMessage(content='', tool_calls=[{
                'name': 'task', 'id': 'delegate',
                'args': {'description': 'Check the service.', 'subagent_type': 'helper'},
            }]),
            AIMessage(content='The helper is rate limited.'),
        ]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], subagents=[{
            'name': 'helper', 'description': 'Check services.', 'system_prompt': 'Check the service.',
            'model': RateLimitedModel(responses=[AIMessage(content='unused')]),
        }],
    )
    request = {'messages': 'Ask the helper.'}
    result = asyncio.run(graph.ainvoke(request)) if asynchronous else graph.invoke(request)
    errors = [message for message in result['messages'] if isinstance(message, ToolMessage)]
    assert len(errors) == 1
    assert errors[0].status == 'error'
    assert errors[0].tool_call_id == 'delegate'
    assert errors[0].name == 'task'
    assert 'Subagent rate limited' in errors[0].content
    assert result['messages'][-1].content == 'The helper is rate limited.'


@pytest.mark.parametrize('model_hook', [False, True])
@pytest.mark.parametrize('delegated', [False, True])
@pytest.mark.parametrize('asynchronous', [False, True])
def test_harness_middleware_failure_ends_turn(
    tmp_path: Path, asynchronous: bool, delegated: bool, model_hook: bool,
) -> None:
    from langchain.agents.middleware import AgentMiddleware

    class BrokenHarness(AgentMiddleware):
        def wrap_model_call(self, request: Any, handler: Any) -> Any:
            if model_hook:
                raise RuntimeError('Harness failed')
            return handler(request)

        async def awrap_model_call(self, request: Any, handler: Any) -> Any:
            if model_hook:
                raise RuntimeError('Harness failed')
            return await handler(request)

        def wrap_tool_call(self, request: Any, handler: Any) -> Any:
            raise RuntimeError('Harness failed')

        async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
            raise RuntimeError('Harness failed')

    responses = [
        AIMessage(content='', tool_calls=[{'name': 'ls', 'args': {'path': '/'}, 'id': 'list'}]),
        AIMessage(content='Must not answer.'),
    ]
    if delegated:
        responses.insert(0, AIMessage(content='', tool_calls=[{
            'name': 'task', 'id': 'delegate',
            'args': {'description': 'List files.', 'subagent_type': 'helper'},
        }]))
    graph = build_agent(
        model=ToolBindableFakeMessagesModel(responses=responses),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], middleware=[] if delegated else [BrokenHarness()],
        subagents=[{
            'name': 'helper', 'description': 'List files.', 'system_prompt': 'List files.',
            'middleware': [BrokenHarness()],
        }] if delegated else [],
    )
    request = {'messages': 'List files.'}
    with pytest.raises(RuntimeError, match='Harness failed'):
        if asynchronous:
            asyncio.run(graph.ainvoke(request))
        else:
            graph.invoke(request)


@pytest.mark.parametrize('asynchronous', [False, True])
def test_tool_interrupt_remains_graph_control_flow(tmp_path: Path, asynchronous: bool) -> None:
    from langgraph.types import interrupt

    @tool
    def approval() -> str:
        """Ask for approval before continuing."""
        return interrupt('Approve?')

    graph = build_agent(
        model=ToolBindableFakeMessagesModel(responses=[
            AIMessage(content='', tool_calls=[{'name': 'approval', 'args': {}, 'id': 'approval'}]),
            AIMessage(content='Must not answer.'),
        ]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], tools=[approval],
    )
    request = {'messages': 'Ask for approval.'}
    result = asyncio.run(graph.ainvoke(request)) if asynchronous else graph.invoke(request)
    assert result['__interrupt__'][0].value == 'Approve?'
    assert not any(isinstance(message, ToolMessage) for message in result['messages'])
