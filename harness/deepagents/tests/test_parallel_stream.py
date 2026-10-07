"""Reconstruct the observed parallel stream from its fragments, not a full capture.

The captured stream shows read_file fragments `{\"`, `file`, `_path`, and `\":`.
QA evidence e4d6c7937, qa-2026-10-06/answers/P1.args.txt, shows their corruption.
The path, model run IDs, and missing fragments are synthetic test-only inputs.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

from ag_ui.core import RunAgentInput
from langchain_core.messages import AIMessageChunk, ToolMessage
from langchain_core.messages.tool import ToolCallChunk

from botcube_harness_deepagents.serving import _SessionAgent


class _EventGraph:
    nodes: dict[str, Any] = {}

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events

    async def aget_state(self, config: Any) -> Any:
        return SimpleNamespace(values={'messages': []}, tasks=(), next=(), metadata={})

    async def astream_events(self, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:
        for event in self.events:
            yield event


def _stream(run: str, content: Any = '', *, name: str | None = None,
            call: str | None = None, args: str | None = None) -> dict[str, Any]:
    chunks: list[ToolCallChunk] = [] if args is None else [{'name': name, 'id': call, 'args': args, 'index': 0}]
    return {'event': 'on_chat_model_stream', 'run_id': run, 'parent_ids': ['root'],
            'data': {'chunk': AIMessageChunk(id=f'message-{run}', content=content, tool_call_chunks=chunks)}}


def _end(run: str) -> dict[str, Any]:
    return {'event': 'on_chat_model_end', 'run_id': run, 'parent_ids': ['root'], 'data': {}}


def _run(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    async def collect() -> list[dict[str, Any]]:
        agent = _SessionAgent(name='replay', graph=_EventGraph(events))
        request = RunAgentInput(thread_id='session', run_id='client-turn', state={},
                                messages=[], tools=[], context=[], forwarded_props={})
        return [event.model_dump(exclude_none=True) async for event in agent.run(request)]
    return asyncio.run(collect())


def _tools(events: list[dict[str, Any]]) -> list[tuple[str, str, str | None]]:
    return [(event['type'], event['tool_call_id'], event.get('delta'))
            for event in events if event['type'] in {'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'}]


def test_parallel_children_keep_fragment_arguments_and_completion_on_their_own_call() -> None:
    events = _run([
        _stream('reader', name='read_file', call='read', args=''),
        _stream('reader', args='{"'),
        _stream('reader', args='file'),
        _stream('todos', name='write_todos', call='todos', args=''),
        _stream('todos', args='{"todos":[]'),
        _stream('reader', args='_path'),
        _stream('reader', args='":'),
        _stream('reader', args='"/skills/SKILL.md"}'),
        _end('reader'),
        {'event': 'on_tool_end', 'run_id': 'read-tool', 'parent_ids': ['root'],
         'name': 'read_file', 'data': {'input': {'file_path': '/skills/SKILL.md'},
                                     'output': ToolMessage(content='skill contents', tool_call_id='read')}},
        _stream('todos', args='}'),
        _end('todos'),
        _stream('answer', 'Done.'),
        _end('answer'),
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])
    assert _tools(events) == [
        ('TOOL_CALL_START', 'read', None),
        ('TOOL_CALL_ARGS', 'read', '{"'),
        ('TOOL_CALL_ARGS', 'read', 'file'),
        ('TOOL_CALL_START', 'todos', None),
        ('TOOL_CALL_ARGS', 'todos', '{"todos":[]'),
        ('TOOL_CALL_ARGS', 'read', '_path'),
        ('TOOL_CALL_ARGS', 'read', '":'),
        ('TOOL_CALL_ARGS', 'read', '"/skills/SKILL.md"}'),
        ('TOOL_CALL_END', 'read', None),
        ('TOOL_CALL_ARGS', 'todos', '}'),
        ('TOOL_CALL_END', 'todos', None),
    ]
    joined = {'read': '', 'todos': ''}
    for kind, call, delta in _tools(events):
        if kind == 'TOOL_CALL_ARGS':
            joined[call] += delta or ''
    assert joined == {'read': '{"file_path":"/skills/SKILL.md"}', 'todos': '{"todos":[]}'}
    assert [(e['type'], e['run_id']) for e in events if e['type'] in {'RUN_STARTED', 'RUN_FINISHED'}] == [
        ('RUN_STARTED', 'client-turn'), ('RUN_FINISHED', 'client-turn')]
    assert [(e['tool_call_id'], e['content']) for e in events if e['type'] == 'TOOL_CALL_RESULT'] == [('read', 'skill contents')]
    assert [(e['type'], e['message_id'], e.get('delta')) for e in events if e['type'].startswith('TEXT_MESSAGE')] == [
        ('TEXT_MESSAGE_START', 'message-answer', None),
        ('TEXT_MESSAGE_CONTENT', 'message-answer', 'Done.'),
        ('TEXT_MESSAGE_END', 'message-answer', None),
    ]


def test_sequential_models_keep_complete_tool_and_text_lifecycles() -> None:
    events = _run([
        _stream('first', name='read_file', call='read', args=''),
        _stream('first', args='{"file_path":"/skill.md"}'), _end('first'),
        _stream('second', 'Read complete.'), _end('second'),
        _stream('third', name='write_todos', call='todos', args=''),
        _stream('third', args='{"todos":[]}'), _end('third'),
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])
    assert _tools(events) == [
        ('TOOL_CALL_START', 'read', None), ('TOOL_CALL_ARGS', 'read', '{"file_path":"/skill.md"}'),
        ('TOOL_CALL_END', 'read', None), ('TOOL_CALL_START', 'todos', None),
        ('TOOL_CALL_ARGS', 'todos', '{"todos":[]}'), ('TOOL_CALL_END', 'todos', None),
    ]
    assert [e['delta'] for e in events if e['type'] == 'TEXT_MESSAGE_CONTENT'] == ['Read complete.']
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert events[-1]['run_id'] == 'client-turn'


def test_upstream_error_is_reported_to_the_client() -> None:
    events = _run([{'event': 'error', 'run_id': 'child', 'data': {'message': 'model stream failed'}}])
    assert [(e['type'], e.get('message')) for e in events if e['type'] in {'RUN_STARTED', 'RUN_ERROR'}] == [
        ('RUN_STARTED', None), ('RUN_ERROR', 'model stream failed')]


def test_parallel_text_and_reasoning_remain_with_their_model() -> None:
    events = _run([
        _stream('reader', [{'type': 'reasoning', 'reasoning': 'Read the skill.'}]),
        _stream('todos', [{'type': 'reasoning', 'reasoning': 'Plan the work.'}]),
        _stream('reader', 'Reading.'),
        _stream('todos', 'Planning.'),
        _end('reader'),
        _stream('todos', ' Ready.'),
        _end('todos'),
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])
    reasoning = [e for e in events if e['type'] == 'REASONING_MESSAGE_CONTENT']
    assert [e['delta'] for e in reasoning] == ['Read the skill.', 'Plan the work.']
    ids = [e['message_id'] for e in reasoning]
    assert len(set(ids)) == 2
    assert [(e['type'], e['message_id'], e.get('delta')) for e in events if e['type'].startswith('TEXT_MESSAGE')] == [
        ('TEXT_MESSAGE_START', 'message-reader', None),
        ('TEXT_MESSAGE_CONTENT', 'message-reader', 'Reading.'),
        ('TEXT_MESSAGE_START', 'message-todos', None),
        ('TEXT_MESSAGE_CONTENT', 'message-todos', 'Planning.'),
        ('TEXT_MESSAGE_END', 'message-reader', None),
        ('TEXT_MESSAGE_CONTENT', 'message-todos', ' Ready.'),
        ('TEXT_MESSAGE_END', 'message-todos', None),
    ]
    assert [e['message_id'] for e in events if e['type'] == 'REASONING_MESSAGE_END'] == ids
    assert [e['message_id'] for e in events if e['type'] == 'REASONING_END'] == ids


def test_closing_parallel_stream_clears_cursors_and_clone_starts_fresh() -> None:
    agent = _SessionAgent(name='replay', graph=_EventGraph([
        _stream('reader', name='read_file', call='read', args=''),
        _stream('todos', name='write_todos', call='todos', args=''),
        _stream('reader', args='{"file_path":"/skill.md"}'),
        _end('reader'), _stream('todos', args='{"todos":[]}'), _end('todos'),
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ]))

    async def exercise() -> list[dict[str, Any]]:
        request = RunAgentInput(thread_id='session', run_id='client-turn', state={},
                                messages=[], tools=[], context=[], forwarded_props={})
        stream = agent.run(request)
        async for event in stream:
            if event.type == 'TOOL_CALL_ARGS':
                break
        await stream.aclose()
        clone = agent.clone()
        return [event.model_dump(exclude_none=True) async for event in clone.run(request)]

    events = asyncio.run(exercise())
    assert agent.messages_in_process == {}
    assert _tools(events) == [
        ('TOOL_CALL_START', 'read', None), ('TOOL_CALL_START', 'todos', None),
        ('TOOL_CALL_ARGS', 'read', '{"file_path":"/skill.md"}'), ('TOOL_CALL_END', 'read', None),
        ('TOOL_CALL_ARGS', 'todos', '{"todos":[]}'), ('TOOL_CALL_END', 'todos', None),
    ]


def test_state_snapshot_waits_until_both_parallel_model_streams_finish() -> None:
    events = _run([
        _stream('reader', name='read_file', call='read', args=''),
        _stream('todos', name='write_todos', call='todos', args=''),
        {'event': 'on_custom_event', 'run_id': 'child', 'parent_ids': ['root'],
         'name': 'manually_emit_state', 'data': {'progress': 'complete'}},
        _end('reader'), _stream('todos', args='{"todos":[]}'), _end('todos'),
        _stream('answer', 'Done.'), _end('answer'),
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])
    visible = [(event['type'], event.get('tool_call_id')) for event in events
               if event['type'] == 'TOOL_CALL_END'
               or event['type'] == 'STATE_SNAPSHOT']
    assert visible == [('STATE_SNAPSHOT', None), ('TOOL_CALL_END', 'read'),
                       ('TOOL_CALL_END', 'todos'), ('STATE_SNAPSHOT', None), ('STATE_SNAPSHOT', None)]


def test_internal_summary_events_do_not_publish_or_close_an_active_answer() -> None:
    summary_metadata = {'metadata': {'lc_source': 'summarization'}}
    events = _run([
        _stream('answer', 'O'),
        _stream('summary', [{'type': 'reasoning', 'reasoning': 'Internal reasoning.'}]) | summary_metadata,
        _stream('summary', 'SESSION INTENT', name='internal_tool', call='internal', args='{}') | summary_metadata,
        _end('summary') | summary_metadata,
        _stream('answer', 'K'), _end('answer'),
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])
    assert [(e['type'], e['message_id'], e.get('delta')) for e in events if e['type'].startswith('TEXT_MESSAGE')] == [
        ('TEXT_MESSAGE_START', 'message-answer', None),
        ('TEXT_MESSAGE_CONTENT', 'message-answer', 'O'),
        ('TEXT_MESSAGE_CONTENT', 'message-answer', 'K'),
        ('TEXT_MESSAGE_END', 'message-answer', None),
    ]
    assert _tools(events) == []
    assert [e for e in events if e['type'].startswith('REASONING')] == []
    assert events[-1]['type'] == 'RUN_FINISHED'


def test_summary_looking_answer_from_an_ordinary_model_remains_visible() -> None:
    answer = 'SESSION INTENT\nSUMMARY\nARTIFACTS\nNEXT STEPS'
    events = _run([
        _stream('answer', answer) | {'metadata': {'lc_source': 'user-model'}}, _end('answer'),
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])
    assert [event['delta'] for event in events if event['type'] == 'TEXT_MESSAGE_CONTENT'] == [answer]
    assert events[-1]['type'] == 'RUN_FINISHED'


def test_internal_summary_failure_is_reported_to_the_client() -> None:
    events = _run([{
        'event': 'error', 'run_id': 'summary', 'metadata': {'lc_source': 'summarization'},
        'data': {'message': 'summary model failed'},
    }])
    assert [(e['type'], e.get('message')) for e in events if e['type'] in {'RUN_STARTED', 'RUN_ERROR'}] == [
        ('RUN_STARTED', None), ('RUN_ERROR', 'summary model failed'),
    ]
