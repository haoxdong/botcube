from __future__ import annotations

import boto3
import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import ChannelVersions, empty_checkpoint
from langgraph.checkpoint.memory import InMemorySaver
from langgraph_checkpoint_aws import AgentCoreMemorySaver
from langgraph_checkpoint_aws.checkpoint.deferred_saver import DeferredCheckpointSaver

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.one_pass_saver import (
    OnePassAgentCoreMemorySaver,
)
from botcube_harness_deepagents.memory.agentcore.turn_saver import TurnCheckpointSaver

CONFIG: RunnableConfig = {
    'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1', 'checkpoint_ns': ''}
}


@pytest.mark.parametrize('local', [False, True], ids=['upstream-deferred', 'local-turn'])
def test_flush_preserves_the_parent_chain_only_with_the_local_turn_saver(
    monkeypatch: pytest.MonkeyPatch, local: bool
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    if local:
        record = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
        saver = TurnCheckpointSaver(record)
    else:
        record = InMemorySaver()
        saver = DeferredCheckpointSaver(record)
    config = CONFIG
    for checkpoint_id in ('checkpoint-1', 'checkpoint-2', 'checkpoint-3'):
        config = saver.put(
            config, {**empty_checkpoint(), 'id': checkpoint_id},
            {'source': 'loop', 'step': 0, 'parents': {}}, {},
        )
    saver.flush()

    latest = record.get_tuple(CONFIG)
    assert latest is not None
    assert latest.checkpoint['id'] == 'checkpoint-3'
    assert latest.parent_config is not None
    assert latest.parent_config.get('configurable', {})['checkpoint_id'] == 'checkpoint-2'
    parent = record.get_tuple(latest.parent_config)
    assert [entry.checkpoint['id'] for entry in record.list(CONFIG)] == (
        ['checkpoint-3', 'checkpoint-2', 'checkpoint-1'] if local else ['checkpoint-3']
    )
    if local:
        assert parent is not None
        assert parent.checkpoint['id'] == 'checkpoint-2'
    else:
        assert parent is None


@pytest.mark.parametrize('local', [False, True], ids=['upstream-agentcore', 'local-one-pass'])
def test_delta_history_replays_the_same_values_with_fewer_record_reads_locally(
    monkeypatch: pytest.MonkeyPatch, local: bool
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    saver_type = OnePassAgentCoreMemorySaver if local else AgentCoreMemorySaver
    saver = saver_type(MEMORY_ID, region_name='us-east-1')
    config = CONFIG
    for checkpoint_id, value in (
        ('checkpoint-1', {'topic': 'copper'}),
        ('checkpoint-2', {}),
        ('checkpoint-3', {}),
    ):
        versions: ChannelVersions = {'topic': saver.get_next_version(None, None)} if value else {}
        checkpoint = empty_checkpoint()
        checkpoint['id'] = checkpoint_id
        checkpoint['channel_values'] = value
        checkpoint['channel_versions'] = versions
        config = saver.put(
            config, checkpoint,
            {'source': 'loop', 'step': 0, 'parents': {}}, versions,
        )
        if checkpoint_id == 'checkpoint-2':
            saver.put_writes(config, [('topic', 'zinc')], 'task-2')
    memory.list_events_calls = 0

    assert saver.get_delta_channel_history(config=config, channels=['topic']) == {
        'topic': {'seed': 'copper', 'writes': [('task-2', 'topic', 'zinc')]}
    }
    assert memory.list_events_calls == (2 if local else 3)
