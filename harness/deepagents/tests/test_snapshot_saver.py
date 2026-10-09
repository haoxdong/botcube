from __future__ import annotations

from typing import Any

import boto3
import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents.memory.agentcore import build_checkpointer
from botcube_harness_deepagents.memory.agentcore.snapshot_saver import reading_once


def test_repeated_state_reads_reconstruct_each_namespace_once(monkeypatch: pytest.MonkeyPatch) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1')
    configs = [
        {'configurable': {'actor_id': actor, 'thread_id': session, 'checkpoint_ns': namespace}}
        for actor, session, namespace in [
            ('actor-1', 'session-1', ''), ('actor-1', 'session-1', 'child'),
            ('actor-1', 'session-2', ''), ('actor-2', 'session-1', ''),
        ]
    ]
    for index, config in enumerate(configs):
        parent = saver.put(config, {**empty_checkpoint(), 'id': f'checkpoint-{index}-1',
                           'channel_values': {'value': f'seed-{index}'},
                           'channel_versions': {'value': '1'}}, {}, {'value': '1'})
        saver.put_writes(parent, [('value', f'pending-{index}')], 'task-1')
        saver.put(parent, {**empty_checkpoint(), 'id': f'checkpoint-{index}-2'}, {}, {})
    built = 0
    original = saver.processor.build_checkpoint_tuple

    def build(*args: Any, **kwargs: Any) -> Any:
        nonlocal built
        built += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(saver.processor, 'build_checkpoint_tuple', build)
    for scope in range(2):
        with reading_once():
            for index, config in enumerate(configs):
                for _ in range(3):
                    assert saver.get_tuple(config).checkpoint['id'] == f'checkpoint-{index}-2'
                    assert saver.get_delta_channel_history(config=config, channels=['value']) == {
                        'value': {'seed': f'seed-{index}', 'writes': [('task-1', 'value', f'pending-{index}')]},
                    }
                    prior = saver.get_tuple({'configurable': {**config['configurable'], 'checkpoint_id': f'checkpoint-{index}-1'}})
                    assert prior.checkpoint['channel_values'] == {'value': f'seed-{index}'}
        assert built == (scope + 1) * 8
    assert memory.list_events_calls == 6


@pytest.mark.parametrize('present', [False, True], ids=['missing-version', 'empty-channel'])
def test_channel_validation_distinguishes_missing_and_empty_versions(
    monkeypatch: pytest.MonkeyPatch, present: bool,
) -> None:
    from langgraph_checkpoint_aws.checkpoint.agentcore.constants import (
        EMPTY_CHANNEL_VALUE,
        EventNotFoundError,
    )
    from langgraph_checkpoint_aws.checkpoint.agentcore.models import (
        ChannelDataEvent,
        CheckpointEvent,
    )

    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1')
    config: RunnableConfig = {'configurable': {'actor_id': 'actor-1', 'thread_id': 'session-1'}}
    events = [
        CheckpointEvent(checkpoint_id='checkpoint-1', checkpoint_data={**empty_checkpoint(), 'id': 'checkpoint-1',
                        'channel_versions': {'value': '1'}}, metadata={}, thread_id='session-1', checkpoint_ns=''),
        ChannelDataEvent(channel='value', version='1', value=EMPTY_CHANNEL_VALUE,
                         thread_id='session-1', checkpoint_ns='' if present else 'other-namespace'),
    ]
    for event in events:
        saver.checkpoint_event_client.store_blob_event(event, 'session-1', 'actor-1')
    with reading_once():
        if present:
            assert saver.get_tuple(config).checkpoint['channel_values'] == {}
        else:
            with pytest.raises(EventNotFoundError, match='missing referenced channel/version blobs'):
                saver.get_tuple(config)


def test_cold_latest_read_is_retained_without_promoting_a_historical_read(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from botcube_harness_deepagents.memory.agentcore.turn_saver import (
        TurnCheckpointSaver,
    )

    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    stored = build_checkpointer(MEMORY_ID, region_name='us-east-1')
    config: RunnableConfig = {'configurable': {'actor_id': 'actor-1', 'thread_id': 'session-1'}}
    first = stored.put(config, {**empty_checkpoint(), 'id': 'checkpoint-1'}, {}, {})
    stored.put(first, {**empty_checkpoint(), 'id': 'checkpoint-2'}, {}, {})
    restored = TurnCheckpointSaver(stored)
    historical = restored.get_tuple(first)
    assert historical is not None and historical.checkpoint['id'] == 'checkpoint-1'
    latest = asyncio.run(restored.aget_tuple(config))
    assert latest is not None and latest.checkpoint['id'] == 'checkpoint-2'
    reads = memory.list_events_calls
    historical = restored.get_tuple(first)
    assert historical is not None and historical.checkpoint['id'] == 'checkpoint-1'
    latest = restored.get_tuple(config)
    assert latest is not None and latest.checkpoint['id'] == 'checkpoint-2'
    latest = asyncio.run(restored.aget_tuple(config))
    assert latest is not None and latest.checkpoint['id'] == 'checkpoint-2'
    assert memory.list_events_calls == reads
