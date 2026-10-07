from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.store.memory import InMemoryStore

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.memory import agentcore, inmem, local
from botcube_harness_deepagents.memory_tools import MemoryToolResult
from conftest import ToolBindableFakeModel

SLOTS = {
    'build_checkpointer',
    'build_store',
    'build_memory_tools',
    'prewarm_ltm',
}


def test_memory_backends_expose_the_four_documented_factory_slots() -> None:
    for backend in (agentcore, inmem, local):
        assert {name for name in dir(backend) if callable(getattr(backend, name))} >= SLOTS


def test_inmem_factories_require_no_aws_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('AWS_ACCESS_KEY_ID', raising=False)
    monkeypatch.delenv('AWS_SECRET_ACCESS_KEY', raising=False)
    monkeypatch.delenv('AGENTCORE_MEMORY_ID', raising=False)

    checkpointer = inmem.build_checkpointer()
    store = inmem.build_store()
    tools, middleware = inmem.build_memory_tools(
        store=store,
        actor_id='actor-1',
        thread_id='thread-1',
    )

    assert checkpointer is not None
    assert store is not None
    assert len(tools) == 1
    assert middleware == []
    assert inmem.prewarm_ltm(store, 'actor-1', thread_id='thread-1') is None


def test_inmem_memory_tool_round_trips_into_the_next_prewarm() -> None:
    store = inmem.build_store()
    [memory_tool], _ = inmem.build_memory_tools(
        store=store,
        actor_id='actor-1',
        thread_id='thread-1',
    )

    recorded = memory_tool.invoke({'action': 'record', 'content': 'Prefers concise answers'})

    assert recorded['status'] == 'success'
    assert inmem.prewarm_ltm(store, 'actor-1', thread_id='thread-2') == (
        '- Prefers concise answers'
    )
    assert inmem.prewarm_ltm(store, 'actor-2', thread_id='thread-2') is None


def test_harness_graph_runs_end_to_end_on_the_inmem_backend(tmp_path: Path) -> None:
    checkpointer = inmem.build_checkpointer()
    store = inmem.build_store()
    tools, middleware = inmem.build_memory_tools(
        store=store,
        actor_id='actor-1',
        thread_id='thread-1',
    )
    graph = build_agent(
        model=ToolBindableFakeModel(responses=['First answer', 'Second answer']),
        backend=LocalShellBackend(
            root_dir=tmp_path,
            virtual_mode=True,
            inherit_env=False,
        ),
        skills=[],
        tools=tools,
        middleware=middleware,
        memory=[],
        checkpointer=checkpointer,
        store=store,
    )
    config = {'configurable': {'thread_id': 'thread-1', 'actor_id': 'actor-1'}}

    first = graph.invoke({'messages': [('user', 'First')]}, config=config)
    second = graph.invoke({'messages': [('user', 'Second')]}, config=config)

    assert first['messages'][-1].content == 'First answer'
    assert second['messages'][-1].content == 'Second answer'
    assert any(message.content == 'First answer' for message in second['messages'])


def test_local_checkpointer_resumes_after_process_replacement(tmp_path: Path) -> None:
    path = tmp_path / 'checkpoints.sqlite3'
    config = {'configurable': {'thread_id': 'thread-1', 'actor_id': 'actor-1'}}

    async def run() -> None:
        first_checkpointer = local.build_checkpointer(path)
        first_graph = build_agent(
            model=ToolBindableFakeModel(responses=['First answer']),
            backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[],
            memory=[],
            checkpointer=first_checkpointer,
        )
        await first_graph.ainvoke({'messages': [('user', 'First')]}, config=config)
        await first_checkpointer.aclose()

        second_checkpointer = local.build_checkpointer(path)
        second_graph = build_agent(
            model=ToolBindableFakeModel(responses=['Second answer']),
            backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[],
            memory=[],
            checkpointer=second_checkpointer,
        )
        resumed = await second_graph.ainvoke(
            {'messages': [('user', 'Second')]}, config=config
        )

        assert [message.content for message in resumed['messages'] if message.type == 'human'] == [
            'First',
            'Second',
        ]
        await second_checkpointer.aclose()

    asyncio.run(run())


def _user_config(user_id: str, checkpoint_id: str | None = None) -> Any:
    configurable = {'thread_id': 'thread-1', 'checkpoint_ns': '', 'actor_id': user_id}
    if checkpoint_id:
        configurable['checkpoint_id'] = checkpoint_id
    return {'configurable': configurable}


def test_local_checkpointer_keeps_each_users_session_record_apart(tmp_path: Path) -> None:
    checkpointer = local.build_checkpointer(tmp_path / 'not' / 'yet' / 'checkpoints.sqlite3')
    metadata: Any = {'source': 'loop', 'step': 0, 'parents': {}}

    async def run() -> None:
        first = await checkpointer.aput(
            _user_config('user-1'), {**empty_checkpoint(), 'id': 'checkpoint-1'}, metadata, {}
        )
        second = await checkpointer.aput(
            first, {**empty_checkpoint(), 'id': 'checkpoint-2'}, {'source': 'loop', 'step': 1, 'parents': {}}, {}
        )
        await checkpointer.aput_writes(second, [('messages', 'from b')], 'task-b')
        await checkpointer.aput_writes(second, [('messages', 'from a')], 'task-a', 'path-z')
        other_thread: Any = {'configurable': {**_user_config('user-1')['configurable'], 'thread_id': 'thread-2'}}
        await checkpointer.aput(other_thread, {**empty_checkpoint(), 'id': 'checkpoint-3'}, metadata, {})

        assert first == _user_config('user-1', 'checkpoint-1')
        assert second == _user_config('user-1', 'checkpoint-2')
        latest = await checkpointer.aget_tuple(_user_config('user-1'))
        assert latest is not None
        assert (latest.config, latest.parent_config) == (second, first)
        assert latest.pending_writes == [('task-a', 'messages', 'from a'), ('task-b', 'messages', 'from b')]
        assert await checkpointer.aget_tuple(_user_config('user-2')) is None

        async def listed(**kwargs: Any) -> list[tuple[RunnableConfig, RunnableConfig | None]]:
            return [
                (t.config, t.parent_config)
                async for t in checkpointer.alist(_user_config('user-1'), **kwargs)
            ]

        assert await listed() == [(second, first), (first, None)]
        assert await listed(limit=1) == [(second, first)]
        assert await listed(before=second) == [(first, None)]
        assert await listed(filter={'step': 0}) == [(first, None)]

        await checkpointer.adelete_session('user-1', 'thread-1')
        assert await checkpointer.aget_tuple(_user_config('user-1')) is None
        remaining = await checkpointer.aget_tuple(other_thread)
        assert remaining is not None and remaining.checkpoint['id'] == 'checkpoint-3'

        await checkpointer.aclose()
        # A closed record stays closed rather than quietly reopening.
        with pytest.raises(ValueError, match='no active connection'):
            await checkpointer.aget_tuple(_user_config('user-1'))

    asyncio.run(run())


def test_local_checkpointer_needs_one_user_and_session_per_call(tmp_path: Path) -> None:
    checkpointer = local.build_checkpointer(tmp_path / 'checkpoints.sqlite3')

    async def run() -> None:
        with pytest.raises(ValueError, match='^The local Session record needs configurable.actor_id$'):
            await checkpointer.aget_tuple({'configurable': {'thread_id': 'thread-1'}})
        with pytest.raises(ValueError, match='^The local Session record lists one user and Session at a time$'):
            async for _ in checkpointer.alist(None):
                pass

    asyncio.run(run())


def _inmem_memory_tool(store: InMemoryStore, actor_id: str = 'actor-1'):
    [memory_tool], _ = inmem.build_memory_tools(store=store, actor_id=actor_id, thread_id='thread-1')
    return memory_tool


def _said(status: Literal['success', 'error'], text: str) -> MemoryToolResult:
    return {'status': status, 'content': [{'text': text}]}


def test_inmem_memory_tool_answers_each_action_for_the_actor_only() -> None:
    store = inmem.build_store()
    memory_tool = _inmem_memory_tool(store)
    other_actor = _inmem_memory_tool(store, 'actor-2')

    assert memory_tool.invoke({'action': 'list'}) == _said('success', 'No memories found')
    assert memory_tool.invoke(
        {'action': 'record', 'content': 'Prefers copper', 'memory_record_id': 'pref-1'}
    ) == _said('success', 'Recorded memory pref-1')
    memory_tool.invoke({'action': 'record', 'content': 'Trades in New York', 'memory_record_id': 'fact-1'})
    other_actor.invoke({'action': 'record', 'content': 'Prefers zinc', 'memory_record_id': 'pref-1'})

    listed = _said('success', 'Prefers copper\nTrades in New York')
    assert memory_tool.invoke({'action': 'list'}) == listed
    assert memory_tool.invoke({'action': 'retrieve', 'query': 'zinc'}) == listed
    assert memory_tool.invoke({'action': 'get', 'memory_record_id': 'pref-1'}) == _said('success', 'Prefers copper')
    assert memory_tool.invoke({'action': 'get', 'memory_record_id': 'pref-2'}) == _said('success', 'Memory not found')
    assert memory_tool.invoke({'action': 'delete', 'memory_record_id': 'pref-1'}) == _said(
        'success', 'Deleted memory pref-1'
    )
    assert memory_tool.invoke({'action': 'list'}) == _said('success', 'Trades in New York')
    assert other_actor.invoke({'action': 'get', 'memory_record_id': 'pref-1'}) == _said('success', 'Prefers zinc')
    assert memory_tool.invoke({'action': 'forget'}) == _said('error', 'Unknown action: forget')


def test_inmem_memory_tool_names_a_recorded_memory_it_can_read_back() -> None:
    memory_tool = _inmem_memory_tool(inmem.build_store())

    recorded = memory_tool.invoke({'action': 'record', 'content': 'Prefers copper'})
    record_id = recorded['content'][0]['text'].removeprefix('Recorded memory ')

    assert len(record_id) == 32 and int(record_id, 16) >= 0
    assert memory_tool.invoke({'action': 'get', 'memory_record_id': record_id}) == _said('success', 'Prefers copper')


def test_inmem_prewarm_lists_each_non_blank_memory() -> None:
    store = inmem.build_store()
    memory_tool = _inmem_memory_tool(store)
    for content in ('Prefers copper ', '  ', 'Trades in New York'):
        memory_tool.invoke({'action': 'record', 'content': content})

    assert inmem.prewarm_ltm(store, 'actor-1') == '- Prefers copper\n- Trades in New York'


def test_inmem_session_record_refuses_unscoped_reads_and_deletes() -> None:
    saver = inmem.build_checkpointer()
    with pytest.raises(ValueError, match="needs configurable.actor_id"):
        saver.get_tuple({"configurable": {"thread_id": "shared-session"}})
    with pytest.raises(ValueError, match="lists one user and Session at a time"):
        list(saver.list(None))
    with pytest.raises(ValueError, match="needs a user ID to delete a Session"):
        saver.delete_thread("shared-session")
