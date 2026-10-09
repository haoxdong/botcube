"""Delegated checkpoints share their owning Session without mixing namespaces."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import boto3
import httpx
import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, BaseMessage
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.types import Command, interrupt
from langgraph_checkpoint_aws.checkpoint.agentcore.models import (
    ChannelDataEvent,
    CheckpointEvent,
    WriteItem,
    WritesEvent,
)

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.memory.agentcore import build_checkpointer
from botcube_harness_deepagents.memory.agentcore.snapshot_saver import reading_once
from botcube_harness_deepagents.memory.agentcore.turn_saver import TurnCheckpointSaver
from botcube_harness_deepagents.memory_broker import (
    MemoryCapability,
    _timestamps,
    turn_memory,
)
from conftest import ToolBindableFakeMessagesModel

SESSION = '1bbd3f2b-e731-4cf9-a81d-23a3e98f79dc'
NAMESPACE = 'tools:bd4cc803-fc2a-05ce-110f-0677b5fab944'


@pytest.fixture
def scoped_memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    memory = FakeAgentCoreMemory()

    def no_aws(*args: Any, **kwargs: Any) -> None:
        raise AssertionError('The Harness must not discover AWS credentials')

    def post(wire_request: httpx.Request) -> httpx.Response:
        request = json.loads(wire_request.content)
        params = _timestamps(request['params'])
        assert wire_request.headers['Authorization'] == 'Bearer literal-test-turn'
        if params['actorId'] != 'filing-fixture' or params['sessionId'] not in (SESSION, SESSION + '-messages'):
            return httpx.Response(403, json={'detail': 'Memory access is outside this Turn'})
        response = getattr(memory, request['operation'])(**params)
        return httpx.Response(200, content=json.dumps(response, default=lambda value: value.isoformat()))

    monkeypatch.setattr(boto3, 'client', no_aws)
    from botcube_harness_deepagents import memory_broker
    monkeypatch.setattr(memory_broker._http_client(), 'send', post)
    return memory


def config(namespace: str = '') -> dict[str, Any]:
    return {'configurable': {'thread_id': SESSION, 'actor_id': 'filing-fixture', 'checkpoint_ns': namespace}}


async def filtered_ids(saver: Any, run_config: dict[str, Any]) -> list[str]:
    return [item.checkpoint['id'] async for item in saver.alist(run_config, filter={'source': 'input'})]


def test_a_real_delegated_task_completes_and_resumes_inside_its_parent_session(
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
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True, wrapper=TurnCheckpointSaver)
    graph = build_agent(model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
                        skills=[], memory=[], subagents=[], checkpointer=saver)

    async def run() -> None:
        with turn_memory(MemoryCapability('https://chat.test/memory', 'literal-test-turn', 'account-fixture')):
            with reading_once():
                result = await graph.ainvoke({'messages': 'Check the result.'}, config())
                assert result['messages'][-1].content == 'The parent received the result.'
                await saver.aflush(('filing-fixture', SESSION))
            restored = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True)
            resumed = build_agent(model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
                                  skills=[], memory=[], subagents=[], checkpointer=restored)
            parent = await resumed.aget_state(config())
            assert parent.values['messages'][-1].content == 'The parent received the result.'

    asyncio.run(run())
    assert set(scoped_memory.events) == {('filing-fixture', SESSION)}


def test_an_interrupted_child_resumes_after_the_parent_and_saver_are_recreated(
    scoped_memory: FakeAgentCoreMemory, tmp_path: Path,
) -> None:
    def helper(state: MessagesState) -> dict[str, Any]:
        approved = interrupt('Approve this helper')
        return {'messages': [AIMessage(content=f'Helper resumed with {approved}.')]}

    def agent(saver: Any, responses: list[BaseMessage]) -> Any:
        child = StateGraph(MessagesState)
        child.add_node('helper', helper)
        child.add_edge(START, 'helper')
        child.add_edge('helper', END)
        return build_agent(
            model=ToolBindableFakeMessagesModel(responses=responses),
            backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], memory=[], checkpointer=saver,
            subagents=[{'name': 'helper', 'description': 'Checks the result.', 'runnable': child.compile()}],
        )

    async def run() -> None:
        with turn_memory(MemoryCapability('https://chat.test/memory', 'literal-test-turn', 'account-fixture')):
            first = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True, wrapper=TurnCheckpointSaver)
            graph = agent(first, [AIMessage(content='Delegate.', tool_calls=[{
                'id': 'delegate-1', 'name': 'task', 'args': {'description': 'Check.', 'subagent_type': 'helper'},
            }])])
            result = await graph.ainvoke({'messages': 'Check the result.'}, config())
            assert result['__interrupt__'][0].value == 'Approve this helper'
            await first.aflush(('filing-fixture', SESSION))
            second = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True, wrapper=TurnCheckpointSaver)
            resumed = agent(second, [AIMessage(content='The parent received the resumed helper.')])
            result = await resumed.ainvoke(Command(resume='approved'), config())
            assert result['messages'][-1].content == 'The parent received the resumed helper.'
            assert any(message.content == 'Helper resumed with approved.' for message in result['messages'])
            await second.aflush(('filing-fixture', SESSION))

    asyncio.run(run())
    assert set(scoped_memory.events) == {('filing-fixture', SESSION)}


def test_delta_replay_collects_later_channel_and_pending_write_pages(scoped_memory: FakeAgentCoreMemory) -> None:
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True)
    saver.max_results = 1
    with turn_memory(MemoryCapability('https://chat.test/memory', 'literal-test-turn', 'account-fixture')):
        client = saver.checkpoint_event_client
        for event in [
            WritesEvent(checkpoint_id='ancestor', writes=[WriteItem(task_id='task-old', channel='value', value='later-page-write')]),
            ChannelDataEvent(channel='value', version='1', value='complete-seed', thread_id=SESSION, checkpoint_ns=NAMESPACE),
            CheckpointEvent(checkpoint_id='ancestor', checkpoint_data={**empty_checkpoint(), 'id': 'ancestor',
                            'channel_values': {}, 'channel_versions': {'value': '1'}}, metadata={},
                            thread_id=SESSION, checkpoint_ns=NAMESPACE),
        ]:
            client.store_blob_event(event, SESSION, 'filing-fixture')
        saver.put({'configurable': {**config(NAMESPACE)['configurable'], 'checkpoint_id': 'ancestor'}},
                  {**empty_checkpoint(), 'id': 'latest'}, {}, {})
        assert saver.get_delta_channel_history(config=config(NAMESPACE), channels=['value']) == {
            'value': {'seed': 'complete-seed', 'writes': [('task-old', 'value', 'later-page-write')]},
        }


def test_overlapping_children_share_the_saver_and_cache_without_sharing_state(scoped_memory: FakeAgentCoreMemory) -> None:
    async def run() -> None:
        barrier = asyncio.Barrier(2)
        saver = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True, wrapper=TurnCheckpointSaver)

        async def child(name: str) -> None:
            checkpoint = {**empty_checkpoint(), 'id': f'checkpoint-{name}',
                          'channel_values': {'value': name}, 'channel_versions': {'value': '1'}}
            saved = await saver.aput(config(f'tools:{name}'), checkpoint,
                                     {'source': 'loop', 'step': 1, 'parents': {}}, {'value': '1'})
            await barrier.wait()
            await saver.aput_writes(saved, [('pending', name)], f'task-{name}')
            state = await saver.aget_tuple(config(f'tools:{name}'))
            assert state.checkpoint['channel_values'] == {'value': name}
            assert state.pending_writes == [(f'task-{name}', 'pending', name)]

        async def cold_child(restored: Any, name: str) -> None:
            state = await restored.aget_tuple(config(f'tools:{name}'))
            assert state.checkpoint['channel_values'] == {'value': name}
            assert state.pending_writes == [(f'task-{name}', 'pending', name)]

        with turn_memory(MemoryCapability('https://chat.test/memory', 'literal-test-turn', 'account-fixture')):
            with reading_once():
                await asyncio.gather(child('child-A'), child('child-B'))
                await saver.aflush(('filing-fixture', SESSION))
            restored = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True)
            with reading_once():
                await asyncio.gather(cold_child(restored, 'child-A'), cold_child(restored, 'child-B'))
                assert await restored.aget_tuple(config()) is None

    asyncio.run(run())
    assert set(scoped_memory.events) == {('filing-fixture', SESSION)}


@pytest.mark.parametrize('buffered', [False, True])
def test_parent_and_children_with_matching_channel_versions_remain_separate_and_purge_together(
    scoped_memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, buffered: bool,
) -> None:
    saver = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True,
                              wrapper=TurnCheckpointSaver if buffered else None)
    namespaces = ['', NAMESPACE, 'tools:other-child']
    with turn_memory(MemoryCapability('https://chat.test/memory', 'literal-test-turn', 'account-fixture')):
        for index, namespace in enumerate(namespaces):
            checkpoint = {**empty_checkpoint(), 'id': f'checkpoint-{index}',
                          'channel_values': {'value': f'value-{index}'}, 'channel_versions': {'value': '1'}}
            saved = saver.put(config(namespace), checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'value': '1'})
            saver.put_writes(saved, [('pending', f'write-{index}')], f'task-{index}')
        if buffered:
            asyncio.run(saver.aflush(('filing-fixture', SESSION)))
        restored = build_checkpointer(MEMORY_ID, region_name='us-east-1', broker=True)
        scoped_memory.list_events_calls = 0
        with reading_once():
            for index, namespace in enumerate(namespaces):
                checkpoint_tuple = restored.get_tuple(config(namespace))
                assert checkpoint_tuple is not None
                assert checkpoint_tuple.checkpoint['channel_values'] == {'value': f'value-{index}'}
                assert checkpoint_tuple.pending_writes == [(f'task-{index}', 'pending', f'write-{index}')]
        assert scoped_memory.list_events_calls == 1
        for index, namespace in enumerate(namespaces):
            assert [item.checkpoint['id'] for item in restored.list(config(namespace))] == [f'checkpoint-{index}']
            assert list(restored.list(config(namespace), filter={'source': 'input'})) == []
            assert list(restored.list(config(namespace), before={'configurable': {'checkpoint_id': f'checkpoint-{index}'}})) == []
            assert list(restored.list(config(namespace), limit=0)) == []
            assert list(saver.list(config(namespace), filter={'source': 'input'})) == []
            assert asyncio.run(filtered_ids(saver, config(namespace))) == []
        monkeypatch.setattr('botcube_harness_deepagents.memory.agentcore.purge._pace', lambda: None)
        asyncio.run(restored.adelete_session('filing-fixture', SESSION))
        for namespace in namespaces:
            assert restored.get_tuple(config(namespace)) is None
    assert all(not events for events in scoped_memory.events.values())
