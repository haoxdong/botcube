"""A delegated task checkpoints nowhere outside its Session and the Session's writes sessions."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any, cast

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage

from agentcore_fake import (
    MEMORY_ID,
    FakeAgentCoreMemory,
    install_tagged_memory,
    turn_identity,
)
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore import turn_memory
from botcube_harness_deepagents.memory.agentcore.purge import purge_session
from conftest import ToolBindableFakeMessagesModel

SESSION = '1bbd3f2b-e731-4cf9-a81d-23a3e98f79dc'
WRITES_PREFIX = f'lgw-{hashlib.sha256(SESSION.encode()).hexdigest()[:32]}-'


@pytest.fixture
def scoped_memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    """AgentCore Memory under a Turn's tagged credentials, which serve the filing ID only the Session and its writes sessions."""
    memory = FakeAgentCoreMemory()
    install_tagged_memory(monkeypatch, memory)
    return memory


def config() -> dict[str, Any]:
    return {'configurable': {'thread_id': SESSION, 'actor_id': 'filing-fixture'}}


def test_a_delegated_task_completes_and_resumes_writing_only_its_session_and_writes_sessions(
    scoped_memory: FakeAgentCoreMemory, tmp_path: Path,
) -> None:
    model = ToolBindableFakeMessagesModel(responses=[
        AIMessage(content='Delegate.', tool_calls=[{
            'id': 'delegate-1', 'name': 'task',
            'args': {'description': 'Check the result.', 'subagent_type': 'general-purpose'},
        }]),
        AIMessage(content='The helper checked it.'),
        AIMessage(content='The parent received the result.'),
    ])

    def agent() -> Any:
        saver, _ = turn_memory(MEMORY_ID, turn_identity('account-fixture', 'filing-fixture', SESSION),
                               region_name='us-east-1', run_id='run-1', turn=0)
        return build_agent(model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
                           skills=[], subagents=[], checkpointer=saver)

    async def run() -> None:
        result = await agent().ainvoke({'messages': 'Check the result.'}, config())
        assert result['messages'][-1].content == 'The parent received the result.'
        parent = await agent().aget_state(config())
        assert parent.values['messages'][-1].content == 'The parent received the result.'

    asyncio.run(run())
    sessions = {session for (actor, session), events in scoped_memory.events.items() if events and actor == 'filing-fixture'}
    assert SESSION in sessions
    assert all(session == SESSION or session.startswith(WRITES_PREFIX) for session in sessions), sessions
    assert len(sessions) > 1, 'the run filed no pending writes'

    # A purge finds writes sessions only through root-namespace checkpoints: a subgraph's would be left behind.
    saver = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    saver.checkpoint_event_client.client = cast(Any, scoped_memory)
    purge_session(saver, 'filing-fixture', SESSION)
    assert not any(events for (actor, session), events in scoped_memory.events.items() if actor == 'filing-fixture')
