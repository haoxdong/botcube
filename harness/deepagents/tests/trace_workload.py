from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import langsmith.utils
from ag_ui.core import EventType, RunAgentInput, UserMessage
from langchain.agents import AgentState
from langchain_core.language_models.fake_chat_models import (
    FakeListChatModel,
)
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from opentelemetry import baggage, trace
from opentelemetry.sdk.trace import TracerProvider

from botcube_harness_deepagents import serving


@tool
async def lookup(value: str) -> str:
    """Look up a value."""
    await asyncio.sleep(0.01)
    if value == 'tool-error':
        raise ValueError('lookup failed')
    return 'found ' + value


async def exercise(session_id: str, mode: str) -> None:
    entered = asyncio.Event()
    settled = asyncio.Event()
    turns = serving._SessionTurns()

    async def reply(state: Any) -> dict[str, Any]:
        entered.set()
        model = FakeListChatModel(responses=['answer'], error_on_chunk_number=0 if mode == 'model-error' else None)
        async for _chunk in model.astream('question'):
            await asyncio.sleep(0.001)
        result = await lookup.ainvoke({'value': mode})
        return {'messages': [AIMessage(result)]}

    async def snapshot(*args: Any) -> None:
        assert baggage.get_baggage('session.id') == session_id
        settled.set()

    serving._snapshot_messages = snapshot
    serving._require_cartridge = lambda: SimpleNamespace(skills=())
    graph = StateGraph(AgentState)
    graph.add_node('model', reply)
    graph.add_edge(START, 'model')
    graph.add_edge('model', END)
    agent = serving._SessionAgent(name='test', graph=graph.compile(checkpointer=MemorySaver()))
    inputs = RunAgentInput(thread_id=session_id, run_id=mode, messages=[UserMessage(id='question', role='user', content='question')], tools=[], context=[], state={}, forwarded_props={})
    stream = turns.stream(('owner', session_id), agent, inputs, None, Path('.'), serving._RequestContext(session_id))
    events = []

    async def drain() -> None:
        async for event in stream:
            events.append(event.type)
            if mode == 'disconnect' and entered.is_set():
                await stream.aclose()
                break

    await drain()
    if mode.endswith('error'):
        assert events[-1] == EventType.RUN_ERROR
    await asyncio.wait_for(settled.wait(), 5)
    while turns._turns:
        await asyncio.sleep(0)
    if mode == 'success':
        assert events[-1] == EventType.RUN_FINISHED
    assert baggage.get_baggage('session.id') is None


async def main() -> None:
    assert not langsmith.utils.tracing_is_enabled()
    for mode in ('success', 'tool-error', 'model-error', 'disconnect'):
        await exercise('agentcore-' + mode, mode)


if __name__ == '__main__':
    asyncio.run(main())
    cast(TracerProvider, trace.get_tracer_provider()).force_flush()
