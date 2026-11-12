from __future__ import annotations

import random

import boto3
import pytest
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import CheckpointMetadata, empty_checkpoint
from langgraph_checkpoint_aws import AgentCoreMemorySaver
from langgraph_checkpoint_aws.checkpoint.agentcore.constants import EventDecodingError
from langgraph_checkpoint_aws.checkpoint.deferred_saver import PendingWrite

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory, fresh_warm_sessions
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.warm_session import WarmSessionSaver

CONFIG: RunnableConfig = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}


@pytest.fixture(autouse=True)
def enable_fragment_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_FRAGMENT_CHECKPOINTS', '1')


@pytest.mark.parametrize('compress', [False, True])
@pytest.mark.parametrize('writer', ['runtime', 'session-api'])
def test_a_large_chat_survives_a_cold_resume_and_session_api_replay(
    monkeypatch: pytest.MonkeyPatch, compress: bool, writer: str,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setenv('BOTCUBE_COMPRESS_CHECKPOINTS', '1' if compress else '0')
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    content = random.Random(7029).randbytes(8_000_000).hex() if compress else 'x' * 7_500_000
    messages = [HumanMessage(content[index:index + 25_000]) for index in range(0, len(content), 25_000)]
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': messages}
    checkpoint['channel_versions'] = {'messages': '1'}

    saver = (WarmSessionSaver(MEMORY_ID, memory) if writer == 'runtime'
             else agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'))
    saver.put(
        CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'},
    )
    warm = saver.get_tuple(CONFIG)
    assert warm is not None and warm.checkpoint == checkpoint
    fresh_warm_sessions(monkeypatch)

    resumed = WarmSessionSaver(MEMORY_ID, memory).get_tuple(CONFIG)
    replayed = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').get_tuple(CONFIG)
    assert resumed is not None
    assert resumed.checkpoint == checkpoint
    assert replayed == resumed
    history = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').list(CONFIG)
    assert [item.checkpoint for item in history] == [checkpoint]


@pytest.mark.parametrize('bundled', [False, True])
def test_large_pending_writes_survive_a_cold_resume(
    monkeypatch: pytest.MonkeyPatch, bundled: bool,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    checkpoint = empty_checkpoint()
    saver = WarmSessionSaver(MEMORY_ID, memory)
    messages = [HumanMessage('pending ' * 50_000)]
    writes = [('messages', messages)]
    metadata: CheckpointMetadata = {'source': 'loop', 'step': 1, 'parents': {}}
    if bundled:
        saver.put_with_writes(CONFIG, checkpoint, metadata, {}, [PendingWrite(CONFIG, writes, 'task-1', '')])
    else:
        saved = saver.put(CONFIG, checkpoint, metadata, {})
        saver.put_writes(saved, writes, 'task-1')
    fresh_warm_sessions(monkeypatch)

    loaded = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').get_tuple(CONFIG)

    assert loaded is not None
    assert loaded.pending_writes == [('task-1', 'messages', messages)]


@pytest.mark.parametrize('damage', ['missing', 'corrupt'])
def test_a_damaged_fragment_fails_instead_of_returning_partial_history(
    monkeypatch: pytest.MonkeyPatch, damage: str,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    monkeypatch.delenv('BOTCUBE_COMPRESS_CHECKPOINTS', raising=False)
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('x' * 200_000)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    WarmSessionSaver(MEMORY_ID, memory).put(
        CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'},
    )
    events = memory.events[('user-1', 'session-1')]
    fragment = next(event for event in events if event.get('metadata', {}).get('lc_kind', {}).get('stringValue') == 'blob_fragment')
    if damage == 'missing':
        events.remove(fragment)
    else:
        fragment['payload'][0]['blob'] = 'Y29ycnVwdA=='
    fresh_warm_sessions(monkeypatch)
    reader = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1')
    error = memory.exceptions.ResourceNotFoundException if damage == 'missing' else EventDecodingError

    with pytest.raises(error):
        reader.get_tuple(CONFIG)


@pytest.mark.parametrize('failure', ['fragment', 'publication'])
def test_an_incomplete_snapshot_keeps_the_preceding_checkpoint(
    monkeypatch: pytest.MonkeyPatch, failure: str,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    monkeypatch.delenv('BOTCUBE_COMPRESS_CHECKPOINTS', raising=False)
    saver = WarmSessionSaver(MEMORY_ID, memory)
    previous = empty_checkpoint()
    saved = saver.put(CONFIG, previous, {'source': 'loop', 'step': 1, 'parents': {}}, {})
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('x' * 7_500_000)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    create = memory.create_event
    fragment_calls = 0

    def fail_publish(**params):
        nonlocal fragment_calls
        kind = params.get('metadata', {}).get('lc_kind', {}).get('stringValue')
        if kind == 'blob_fragment':
            fragment_calls += 1
        if ((failure == 'fragment' and kind == 'blob_fragment' and fragment_calls == 2)
                or (failure == 'publication' and kind == 'checkpoint')):
            raise RuntimeError('snapshot write failed')
        return create(**params)

    monkeypatch.setattr(memory, 'create_event', fail_publish)
    with pytest.raises(RuntimeError, match='snapshot write failed'):
        saver.put(saved, checkpoint, {'source': 'loop', 'step': 2, 'parents': {}}, {'messages': '1'})
    fresh_warm_sessions(monkeypatch)

    loaded = WarmSessionSaver(MEMORY_ID, memory).get_tuple(CONFIG)

    assert loaded is not None
    assert loaded.checkpoint == previous


@pytest.mark.parametrize('writer', ['runtime', 'session-api'])
def test_the_decoder_rollout_keeps_writes_readable_by_the_previous_release(
    monkeypatch: pytest.MonkeyPatch, writer: str,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    monkeypatch.delenv('BOTCUBE_FRAGMENT_CHECKPOINTS')
    monkeypatch.delenv('BOTCUBE_COMPRESS_CHECKPOINTS', raising=False)
    saver = (WarmSessionSaver(MEMORY_ID, memory) if writer == 'runtime'
             else agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1'))
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('x' * 70_000)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    saver.put(CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'})
    previous = AgentCoreMemorySaver(MEMORY_ID, checkpoint_format='snapshot', region_name='us-east-1')

    assert previous.get_tuple(CONFIG) == saver.get_tuple(CONFIG)


def test_disabling_fragment_writes_still_reads_fragmented_checkpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    monkeypatch.delenv('BOTCUBE_COMPRESS_CHECKPOINTS', raising=False)
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('x' * 200_000)]}
    checkpoint['channel_versions'] = {'messages': '1'}
    WarmSessionSaver(MEMORY_ID, memory).put(
        CONFIG, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'},
    )
    fresh_warm_sessions(monkeypatch)
    monkeypatch.setenv('BOTCUBE_FRAGMENT_CHECKPOINTS', '0')

    loaded = agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1').get_tuple(CONFIG)

    assert loaded is not None and loaded.checkpoint == checkpoint
