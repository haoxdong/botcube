"""A Turn's RUN_FINISHED carries the token usage its model calls reported, as AG-UI defines it."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.messages.ai import UsageMetadata

from test_parallel_stream import _run


def _usage_chunk(run: str, output_tokens: int) -> dict[str, Any]:
    usage = UsageMetadata(input_tokens=100, output_tokens=output_tokens, total_tokens=100 + output_tokens)
    return {'event': 'on_chat_model_stream', 'run_id': run, 'parent_ids': ['root'],
            'data': {'chunk': AIMessageChunk(id=f'message-{run}', content='', usage_metadata=usage)}}


def test_run_finished_sums_each_model_calls_usage() -> None:
    events = _run([
        {'event': 'on_chat_model_start', 'run_id': 'call-1', 'parent_ids': ['root'], 'data': {}},
        _usage_chunk('call-1', 20),
        {'event': 'on_chat_model_end', 'run_id': 'call-1', 'parent_ids': ['root'], 'data': {}},
        {'event': 'on_chat_model_start', 'run_id': 'call-2', 'parent_ids': ['root'], 'data': {}},
        _usage_chunk('call-2', 30),
        {'event': 'on_chat_model_end', 'run_id': 'call-2', 'parent_ids': ['root'], 'data': {}},
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])

    finished = events[-1]
    assert finished['type'] == 'RUN_FINISHED'
    assert [(usage['input_tokens'], usage['output_tokens'], usage['total_tokens']) for usage in finished['usage']] == [(200, 50, 250)]


def test_run_finished_counts_an_in_turn_summary_it_hides() -> None:
    summary = {'metadata': {'lc_source': 'summarization'}}
    events = _run([
        {'event': 'on_chat_model_start', 'run_id': 'summary', 'parent_ids': ['root'], 'data': {}, **summary},
        {**_usage_chunk('summary', 30), **summary},
        {'event': 'on_chat_model_end', 'run_id': 'summary', 'parent_ids': ['root'], 'data': {}, **summary},
        {'event': 'on_chat_model_end', 'run_id': 'unstreamed-summary', 'parent_ids': ['root'], **summary,
         'data': {'output': AIMessage(content='internal', usage_metadata=UsageMetadata(input_tokens=50, output_tokens=5, total_tokens=55))}},
        {'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}},
    ])

    assert [event['type'] for event in events if 'TEXT_MESSAGE' in event['type']] == []
    assert [(usage['input_tokens'], usage['output_tokens']) for usage in events[-1]['usage']] == [(150, 35)]


def test_run_finished_omits_usage_no_model_reported() -> None:
    events = _run([{'event': 'on_chain_end', 'run_id': 'root', 'parent_ids': [], 'data': {'output': {}}}])

    assert events[-1]['type'] == 'RUN_FINISHED'
    assert 'usage' not in events[-1]
