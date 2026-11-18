from __future__ import annotations

import asyncio
import json
from itertools import pairwise
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from ag_ui.core import (
    RunFinishedEvent,
    RunStartedEvent,
    ToolCallArgsEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from langchain_core.messages import AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGenerationChunk

from botcube_harness_deepagents import message_times
from botcube_harness_deepagents.graph_stream import clock_events

BOUNDARIES = json.loads((Path(__file__).parent / 'fixtures/tool-argument-clock-boundaries.json').read_text())


async def _frames(boundary: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    at = boundary['started_at']
    monkeypatch.setattr(message_times, 'now', lambda: at)
    call_id = boundary['call_id']
    model_id = UUID(boundary['model_id'])

    async def source():
        nonlocal at
        message_times.asked(HumanMessage('Compare markets', id='question'), boundary['question_started_at'], canonical=True)
        yield RunStartedEvent(thread_id='session', run_id='run')
        callback = message_times._ModelClock()
        callback.on_chat_model_start({}, [], run_id=model_id)
        chunk = AIMessageChunk(content='', tool_call_chunks=[{'name': 'execute', 'id': call_id, 'args': '', 'index': 0}])
        callback.on_llm_new_token('', chunk=ChatGenerationChunk(message=chunk), run_id=model_id)
        yield ToolCallStartEvent(tool_call_id=call_id, tool_call_name='execute')
        for tick in range(boundary['started_at'] + 200, boundary['arguments_ended_at'], 200):
            at = tick
            yield ToolCallArgsEvent(tool_call_id=call_id, delta='x')
        at = boundary['ended_at']
        shared = message_times._turn_clock.get()
        assert shared is not None
        shared.tool_finished(call_id, at)
        yield ToolCallResultEvent(message_id='result', tool_call_id=call_id, content='Done')
        yield RunFinishedEvent(thread_id='session', run_id='run')

    events = [event async for event in clock_events(source(), lambda: str(model_id), canonical=True)]
    return [operation['value'] for event in events if event.type == 'STATE_DELTA'
            for operation in event.model_dump(mode='json')['delta']]


@pytest.mark.parametrize('boundary', BOUNDARIES, ids=lambda boundary: str(boundary['ended_at']))
def test_continuous_recorded_tool_arguments_keep_clock_progress(boundary: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    frames = asyncio.run(_frames(boundary, monkeypatch))
    progress = [frame['at'] for frame in frames if boundary['started_at'] < frame['at'] < boundary['arguments_ended_at']]
    assert progress, 'continuous tool arguments must not starve canonical clock heartbeats'
    times = [boundary['started_at'], *progress, boundary['ended_at']]
    assert max(b - a for a, b in pairwise(times)) <= 2000
