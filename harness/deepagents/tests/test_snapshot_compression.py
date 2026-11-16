from __future__ import annotations

import json
import random

import boto3
import pytest
import zstandard
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph_checkpoint_aws import AgentCoreMemorySaver
from langgraph_checkpoint_aws.checkpoint.agentcore.constants import EventDecodingError

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory, fresh_warm_sessions
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.warm_session import WarmSessionSaver

CONFIG: RunnableConfig = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}


def test_a_cold_snapshot_transfers_less_than_half_its_message_bytes_without_losing_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    writer = WarmSessionSaver(MEMORY_ID, memory)
    checkpoint = empty_checkpoint()
    messages = [HumanMessage('Question ' * 1000), AIMessage('Answer ' * 1000)]
    checkpoint['channel_values'] = {'messages': messages}
    checkpoint['channel_versions'] = {'messages': '1'}
    saved = writer.put(CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'})
    writer.put_writes(saved, [('messages', [HumanMessage('Interrupted question ' * 300)])], 'task-1')
    fresh_warm_sessions(monkeypatch)

    loaded = WarmSessionSaver(MEMORY_ID, memory).get_tuple(CONFIG)
    replayed = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').get_tuple(CONFIG)

    assert loaded is not None and loaded == replayed
    assert loaded.checkpoint == checkpoint
    assert loaded.pending_writes == [('task-1', 'messages', [HumanMessage('Interrupted question ' * 300)])]
    stored_bytes = len(json.dumps(memory.events[('user-1', 'session-1')], default=str).encode())
    assert stored_bytes < sum(len(message.text) for message in messages) // 2


def test_new_readers_resume_existing_uncompressed_snapshots_and_pending_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    old = AgentCoreMemorySaver(MEMORY_ID, checkpoint_format='snapshot', region_name='us-east-1')
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('Existing question ' * 300)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    saved = old.put(CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'})
    old.put_writes(saved, [('messages', [AIMessage('Existing pending answer ' * 200)])], 'task-1')
    fresh_warm_sessions(monkeypatch)

    assert WarmSessionSaver(MEMORY_ID, memory).get_tuple(CONFIG) == old.get_tuple(CONFIG)
    assert agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').get_tuple(CONFIG) == old.get_tuple(CONFIG)

@pytest.mark.parametrize('reader', ['warm', 'replay'])
def test_corrupt_compressed_snapshots_fail_instead_of_disappearing(
    monkeypatch: pytest.MonkeyPatch, reader: str,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    writer = WarmSessionSaver(MEMORY_ID, memory)
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('Question ' * 1000)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    writer.put(CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'})
    [event] = memory.events[('user-1', 'session-1')]
    for item in event['payload']:
        blob = json.loads(item['blob'])
        if blob.get('channel') == 'messages':
            blob['value']['data'] = 'Y29ycnVwdA=='
            item['blob'] = json.dumps(blob)
    fresh_warm_sessions(monkeypatch)
    saver = (WarmSessionSaver(MEMORY_ID, memory) if reader == 'warm'
             else agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'))

    with pytest.raises(EventDecodingError, match='Failed to deserialize value'):
        saver.get_tuple(CONFIG)


def test_incompressible_bytes_stay_intact_without_expanding_the_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    checkpoint = empty_checkpoint()
    value = random.Random(3975).randbytes(8192)
    checkpoint['channel_values'] = {'binary': value}
    checkpoint['channel_versions'] = {'binary': '1'}
    metadata: CheckpointMetadata = {'source': 'loop', 'step': 1, 'parents': {}}
    stock = AgentCoreMemorySaver(MEMORY_ID, checkpoint_format='snapshot', region_name='us-east-1')
    stock.put(CONFIG, checkpoint, metadata, {'binary': '1'})
    original = json.dumps(memory.events[('user-1', 'session-1')], default=str)
    memory.events.clear()
    memory.created_by_token.clear()
    memory.create_event_calls = 0

    WarmSessionSaver(MEMORY_ID, memory).put(
        CONFIG, checkpoint, metadata, {'binary': '1'},
    )

    assert json.dumps(memory.events[('user-1', 'session-1')], default=str) == original
    fresh_warm_sessions(monkeypatch)
    loaded = WarmSessionSaver(MEMORY_ID, memory).get_tuple(CONFIG)
    assert loaded is not None and loaded.checkpoint['channel_values']['binary'] == value


class _CompressedSnapshotWriter(JsonPlusSerializer):
    def dumps_typed(self, obj: object) -> tuple[str, bytes]:
        kind, payload = super().dumps_typed(obj)
        return kind + '+zstd', zstandard.compress(payload, level=1)


@pytest.mark.parametrize('reader', ['warm', 'replay'])
def test_readers_resume_an_existing_compressed_snapshot(
    monkeypatch: pytest.MonkeyPatch, reader: str,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    old = AgentCoreMemorySaver(
        MEMORY_ID, checkpoint_format='snapshot', region_name='us-east-1', serde=_CompressedSnapshotWriter(),
    )
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'answer': 'Saved answer ' * 1000}
    checkpoint['channel_versions'] = {'answer': '1'}
    old.put(CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'answer': '1'})
    fresh_warm_sessions(monkeypatch)
    saver = (WarmSessionSaver(MEMORY_ID, memory) if reader == 'warm'
             else agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'))

    loaded = saver.get_tuple(CONFIG)

    assert loaded is not None and loaded.checkpoint == checkpoint
