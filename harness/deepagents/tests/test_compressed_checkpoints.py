from __future__ import annotations

import json
from typing import Any

import boto3
import pytest
import zstandard
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph_checkpoint_aws import AgentCoreMemorySaver

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory, fresh_warm_sessions
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.warm_session import WarmSessionSaver

CONFIG: RunnableConfig = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}


class _ReleasedCompressingSerializer(JsonPlusSerializer):
    def dumps_typed(self, obj: Any) -> tuple[str, bytes]:
        kind, payload = super().dumps_typed(obj)
        return kind + '+zstd', zstandard.compress(payload, level=1)


def _readers(memory: FakeAgentCoreMemory) -> dict[str, AgentCoreMemorySaver]:
    return {
        'runtime': WarmSessionSaver(MEMORY_ID, memory),
        'session-api': agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'),
    }


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    return memory


@pytest.mark.parametrize('reader', ['runtime', 'session-api'])
def test_a_compressed_snapshot_and_pending_write_still_load(
    monkeypatch: pytest.MonkeyPatch, memory: FakeAgentCoreMemory, reader: str,
) -> None:
    released = AgentCoreMemorySaver(
        MEMORY_ID, checkpoint_format='snapshot', region_name='us-east-1', serde=_ReleasedCompressingSerializer(),
    )
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('Compressed question ' * 300)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    saved = released.put(CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'})
    released.put_writes(saved, [('messages', [AIMessage('Compressed pending answer ' * 200)])], 'task-1')
    assert '+zstd' in json.dumps(memory.events[('user-1', 'session-1')], default=str)
    fresh_warm_sessions(monkeypatch)

    loaded = _readers(memory)[reader].get_tuple(CONFIG)

    assert loaded is not None
    assert loaded.checkpoint == checkpoint
    assert loaded.pending_writes == [('task-1', 'messages', [AIMessage('Compressed pending answer ' * 200)])]


@pytest.mark.parametrize('writer', ['runtime', 'session-api'])
def test_new_writes_are_uncompressed(memory: FakeAgentCoreMemory, writer: str) -> None:
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('New question ' * 1000)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    saver = _readers(memory)[writer]

    saved = saver.put(CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'})
    saver.put_writes(saved, [('messages', [AIMessage('New pending answer ' * 1000)])], 'task-1')

    assert '+zstd' not in json.dumps(memory.events[('user-1', 'session-1')], default=str)
