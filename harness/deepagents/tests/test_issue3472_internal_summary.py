from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import deepagents.graph
import pytest
from ag_ui.core import RunAgentInput, UserMessage
from deepagents.backends import LocalShellBackend
from deepagents.middleware.summarization import SummarizationMiddleware
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.messages_snapshot import conversation
from botcube_harness_deepagents.serving import _SessionAgent
from conftest import ToolBindableFakeModel


@pytest.mark.parametrize('cross_threshold', [False, True])
def test_internal_summary_stays_out_of_live_and_reloaded_answer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cross_threshold: bool,
) -> None:
    summary = 'SESSION INTENT\nAnswer briefly.\nSUMMARY\nEarlier chat.\nARTIFACTS\nNone.\nNEXT STEPS\nReply OK.'
    monkeypatch.setattr(
        deepagents.graph, 'create_summarization_middleware',
        lambda _model, backend: SummarizationMiddleware(
            model=FakeListChatModel(responses=[summary]), backend=backend,
            trigger=('messages', 4), keep=('messages', 2),
        ),
    )
    graph = build_agent(
        model=ToolBindableFakeModel(responses=['OK']),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], tools=[], memory=[], checkpointer=InMemorySaver(),
    )
    config: RunnableConfig = {'configurable': {'thread_id': 'summary-session'}}

    async def exercise() -> tuple[list[dict[str, Any]], list[dict[str, Any]], Any]:
        if cross_threshold:
            await graph.aupdate_state(config, {'messages': [
                HumanMessage('Earlier question one'), AIMessage('Earlier answer one'),
                HumanMessage('Earlier question two'), AIMessage('Earlier answer two'),
            ]}, as_node='model')
        agent = _SessionAgent(name='summary-regression', graph=graph)
        request = RunAgentInput(
            thread_id='summary-session', run_id='turn', state={},
            messages=[UserMessage(id='new-question', content='Reply OK.')],
            tools=[], context=[], forwarded_props={},
        )
        events = [event.model_dump(exclude_none=True) async for event in agent.run(request)]
        state = await graph.aget_state(config)
        return events, conversation(state.values['messages']), state.values

    events, reloaded, values = asyncio.run(exercise())
    assert reloaded[-1]['content'] == 'OK'
    assert [message['content'] for message in reloaded if message['role'] == 'assistant'] == (
        ['Earlier answer one', 'Earlier answer two', 'OK'] if cross_threshold else ['OK']
    )
    if cross_threshold:
        assert summary in values['_summarization_event']['summary_message'].content
    assert ''.join(event['delta'] for event in events if event['type'] == 'TEXT_MESSAGE_CONTENT') == 'OK'
    assert [event['type'] for event in events if event['type'].startswith('TEXT_MESSAGE')] == [
        'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
    ]
    assert events[-1]['type'] == 'RUN_FINISHED'
