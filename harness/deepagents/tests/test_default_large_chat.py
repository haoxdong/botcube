from __future__ import annotations

import boto3
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint
from langgraph_checkpoint_aws import AgentCoreMemorySaver

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory, fresh_warm_sessions
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.snapshot import (
    FragmentedSnapshotClient,
)
from botcube_harness_deepagents.memory.agentcore.warm_session import WarmSessionSaver


@pytest.mark.parametrize('writer', ['runtime', 'session-api', 'adapter'])
def test_a_main_chat_keeps_saving_after_growing_past_the_event_limit_by_default(
    monkeypatch: pytest.MonkeyPatch, writer: str,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    config: RunnableConfig = {'configurable': {'thread_id': 'main-chat', 'actor_id': 'user-1'}}
    messages = [HumanMessage('Start the Main Chat'), AIMessage('Ready')]

    turns = [
        [HumanMessage('small question')],
        [HumanMessage('x' * 25_000) for _ in range(404)],
        [HumanMessage('continue the chat')],
    ]
    for turn, additional in enumerate(turns, start=1):
        messages.extend([*additional, AIMessage(f'Answer {turn}')])
        checkpoint = empty_checkpoint()
        checkpoint['channel_values'] = {'messages': messages.copy()}
        checkpoint['channel_versions'] = {'messages': str(turn)}
        saver = (WarmSessionSaver(MEMORY_ID, memory) if writer == 'runtime'
                 else agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'))
        if writer == 'adapter':
            saver = AgentCoreMemorySaver(MEMORY_ID, checkpoint_format='snapshot', region_name='us-east-1')
            saver.checkpoint_event_client = FragmentedSnapshotClient(MEMORY_ID, saver.serializer, memory)
        saver.put(config, checkpoint, {'source': 'loop', 'step': turn, 'parents': {}}, {'messages': str(turn)})
        fresh_warm_sessions(monkeypatch)

        resumed = WarmSessionSaver(MEMORY_ID, memory).get_tuple(config)
        replayed = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').get_tuple(config)

        assert resumed is not None and resumed.checkpoint == checkpoint
        assert replayed == resumed
