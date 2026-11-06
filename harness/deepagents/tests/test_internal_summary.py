from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from ag_ui.core import RunAgentInput, UserMessage
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver

from botcube_harness_deepagents import agent as agent_module
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.compaction import BackgroundCompaction
from botcube_harness_deepagents.conversation import conversation
from botcube_harness_deepagents.serving import _SessionAgent
from botcube_harness_deepagents.turn_memory import collecting_turn_feeds
from conftest import ToolBindableFakeModel


@pytest.mark.parametrize('cross_threshold, emergency', [(False, False), (True, False), (True, True)])
def test_internal_summary_stays_out_of_live_and_reloaded_answer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cross_threshold: bool, emergency: bool,
) -> None:
    summary = 'SESSION INTENT\nAnswer briefly.\nSUMMARY\nEarlier chat.\nARTIFACTS\nNone.\nNEXT STEPS\nReply OK.'
    monkeypatch.setattr(
        agent_module, 'BackgroundCompaction',
        lambda *, model, backend, **_kwargs: BackgroundCompaction(
            model=model, backend=backend, trim_tokens_to_summarize=None,
            trigger=('messages', 4), keep=('messages', 2),
        ),
    )
    responses = [summary, 'OK', 'OK'] if emergency else ['OK', summary, 'OK']
    graph = build_agent(
        model=ToolBindableFakeModel(
            responses=responses if cross_threshold else ['OK'],
            profile={'max_input_tokens': 60000} if emergency else None,
        ),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], tools=[], checkpointer=InMemorySaver(),
    )
    config: RunnableConfig = {'configurable': {'thread_id': 'summary-session'}}

    events, reloaded, values = asyncio.run(_run_summary_turns(graph, config, cross_threshold, emergency))
    assert reloaded[-1]['content'] == 'OK'
    assert [message['content'] for message in reloaded if message['role'] == 'assistant'] == (
        ['Earlier answer one', 'Earlier answer two', 'OK', 'OK'] if cross_threshold else ['OK', 'OK']
    )
    if cross_threshold:
        assert summary in values['_summarization_event']['summary_message'].content
    assert ''.join(event['delta'] for event in events if event['type'] == 'TEXT_MESSAGE_CONTENT') == 'OK'
    assert [event['type'] for event in events if event['type'].startswith('TEXT_MESSAGE')] == [
        'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
    ]
    assert events[-1]['type'] == 'RUN_FINISHED'


async def _run_summary_turns(graph: Any, config: RunnableConfig, cross_threshold: bool, emergency: bool) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Any]:
    if cross_threshold:
        await graph.aupdate_state(config, {'messages': [
            HumanMessage('Earlier question one' + (' copper' * 40000 if emergency else '')), AIMessage('Earlier answer one'),
            HumanMessage('Earlier question two'), AIMessage('Earlier answer two'),
        ]}, as_node='model')
    agent = _SessionAgent(name='summary-regression', graph=graph)
    request = RunAgentInput(
        thread_id='summary-session', run_id='turn', state={},
        messages=[UserMessage(id='new-question', content='Reply OK.')],
        tools=[], context=[], forwarded_props={},
    )
    with collecting_turn_feeds() as feeds:
        events = [event.model_dump(exclude_none=True) async for event in agent.run(request)]
    for feed in feeds:
        await feed()
    following = request.model_copy(update={
        'run_id': 'following', 'messages': [UserMessage(id='follow-up', content='Reply OK again.')],
    })
    with collecting_turn_feeds():
        following_events = [event async for event in agent.run(following)]
    assert ''.join(event.delta for event in following_events if event.type == 'TEXT_MESSAGE_CONTENT') == 'OK'
    state = await graph.aget_state(config)
    return events, conversation(state.values['messages']), state.values
