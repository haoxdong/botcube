"""A Session with no recorded messages accepts its first incoming message."""

from __future__ import annotations

from ag_ui.core import RunAgentInput
from langchain.agents import AgentState
from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph

from botcube_harness_deepagents.serving import _SessionAgent


def test_a_first_turn_merges_into_a_session_without_a_messages_channel() -> None:
    graph = StateGraph(AgentState)
    graph.add_node('reply', lambda state: {})
    graph.add_edge(START, 'reply')
    graph.add_edge('reply', END)
    agent = _SessionAgent(name='agent', graph=graph.compile())
    message = HumanMessage('Hello', id='user-1')
    run = RunAgentInput.model_validate({
        'thread_id': 'session-1',
        'run_id': 'run-1',
        'messages': [],
        'tools': [],
        'context': [],
        'state': {},
        'forwarded_props': {},
    })

    merged = agent.langgraph_default_merge_state({}, [message], run)

    assert [(item.id, item.content) for item in merged['messages']] == [('user-1', 'Hello')]
