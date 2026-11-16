"""Recorded Responses replay with summary markers preserves live and saved boundaries."""
from __future__ import annotations

import json
from functools import reduce
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, message_chunk_to_message
from langchain_core.outputs import ChatGenerationChunk
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from botcube_harness_deepagents import message_times
from botcube_harness_deepagents.conversation import conversation, reasoning_blocks
from botcube_harness_deepagents.serving import _SessionAgent, _Thinking


def _with_encrypted_completion(body: bytes) -> bytes:
    frames = []
    for frame in body.decode().split('\n\n'):
        if frame.startswith('event: response.output_item.done'):
            heading, data = frame.split('\ndata: ')
            event = json.loads(data)
            if event['item']['type'] == 'reasoning':
                event['item']['encrypted_content'] = 'opaque'
            frame = heading + '\ndata: ' + json.dumps(event)
        frames.append(frame)
    return '\n\n'.join(frames).encode()


@pytest.mark.parametrize('encrypted', [False, True])
def test_recorded_reasoning_starts_before_its_late_summary_words(monkeypatch: Any, encrypted: bool) -> None:
    monkeypatch.setenv('LANGCHAIN_OPENAI_TCP_KEEPALIVE', '0')
    body = (Path(__file__).parent / 'fixtures' / 'openai-plan-reasoning-stream.sse').read_bytes()
    if encrypted:
        body = _with_encrypted_completion(body)
    transport = httpx.MockTransport(lambda _: httpx.Response(
        200, headers={'content-type': 'text/event-stream'}, content=body,
    ))
    with httpx.Client(transport=transport) as client:
        model = ChatOpenAI(model='gpt-6-astra', api_key='fixture', base_url='http://recorded.test/v1',
                           use_responses_api=True, reasoning={'summary': 'auto'}, http_client=client)
        chunks = list(model.stream('Say hello'))
    tick = 0
    monkeypatch.setattr(message_times, 'now', lambda: tick)
    run = UUID('00000000-0000-0000-0000-000000000001')
    clock = message_times._ModelClock()
    clock.on_chat_model_start({}, [[]], run_id=run)
    # Provider item, empty part, late words, next empty part, late words, public output.
    at = [0, 1000, 12775, 12776, 13000, 20000, 20001, 20003, 20004]
    if encrypted:
        at.insert(6, 20000)
    agent = _SessionAgent(name='boundary', graph=StateGraph(BaseModel).add_edge(START, END).compile())
    thinking = _Thinking()
    live = []
    for index, chunk in enumerate(chunks):
        tick = at[index] if index < len(at) else 20005
        clock.on_llm_new_token('', chunk=ChatGenerationChunk(message=chunk), run_id=run)
        if reasoning_blocks(chunk):
            live.extend(agent._thought_chunk({}, str(run), thinking, chunk) or [])
    assert [event.message_id for event in live if event.type == 'REASONING_MESSAGE_START'] == [
        f'{run}-reasoning-0', f'{run}-reasoning-1',
    ]
    answer = message_chunk_to_message(reduce(lambda a, b: a + b, chunks))
    assert isinstance(answer, AIMessage)
    reply = clock.stamped(answer, 20005)
    thoughts = [message for message in conversation([reply]) if message['role'] == 'reasoning']
    assert [message['id'] for message in thoughts] == [f'{run}-reasoning-0', f'{run}-reasoning-1']
    assert [message['metadata'] for message in thoughts] == [
        {'started_at': 1000, 'ended_at': 13000},
        {'started_at': 13000, 'ended_at': 20003},
    ]


def test_live_thought_starts_on_empty_summary_and_closes_before_the_next() -> None:
    agent = _SessionAgent(name='boundary', graph=StateGraph(BaseModel).add_edge(START, END).compile())
    thought = _Thinking()
    opened = agent._reasoning_chunk('lane', thought, {'type': 'reasoning', 'index': 0, 'id': 'provider-item'})
    assert [(event.type, event.message_id) for event in opened] == [
        ('REASONING_START', 'lane-reasoning-0'), ('REASONING_MESSAGE_START', 'lane-reasoning-0'),
    ]
    words = agent._reasoning_chunk('lane', thought, {'type': 'reasoning', 'index': 0, 'reasoning': 'Late summary'})
    assert [(event.type, event.delta) for event in words] == [('REASONING_MESSAGE_CONTENT', 'Late summary')]
    following = agent._reasoning_chunk('lane', thought, {'type': 'reasoning', 'index': 1, 'reasoning': ''})
    assert [(event.type, event.message_id) for event in following] == [
        ('REASONING_MESSAGE_END', 'lane-reasoning-0'), ('REASONING_END', 'lane-reasoning-0'),
        ('REASONING_START', 'lane-reasoning-1'), ('REASONING_MESSAGE_START', 'lane-reasoning-1'),
    ]


@pytest.mark.parametrize('block', [
    {'type': 'reasoning', 'reasoning': '', 'index': 0},
    {'type': 'reasoning', 'id': 'provider-item', 'summary': [], 'index': 0},
])
def test_an_empty_summary_keeps_its_own_saved_span(monkeypatch: Any, block: dict[str, Any]) -> None:
    tick = 1000
    monkeypatch.setattr(message_times, 'now', lambda: tick)
    run = UUID('00000000-0000-0000-0000-000000000001')
    clock = message_times._ModelClock()
    clock.on_chat_model_start({}, [[]], run_id=run)
    clock.on_llm_new_token('', chunk=ChatGenerationChunk(message=AIMessageChunk(content=[block])), run_id=run)
    tick = 4000
    clock.on_llm_new_token('Answer', chunk=ChatGenerationChunk(message=AIMessageChunk(content='Answer')), run_id=run)
    reply = clock.stamped(AIMessage(content=[block, {'type': 'text', 'text': 'Answer'}]), 4100)
    [thought] = [message for message in conversation([reply]) if message['role'] == 'reasoning']
    assert thought['content'] == ''
    assert thought['id'] == f'{run}-reasoning-0'
    assert thought['metadata'] == {'started_at': 1000, 'ended_at': 4000}


def test_legacy_untimed_empty_summary_does_not_create_a_replayed_thought() -> None:
    from botcube_harness_deepagents.conversation import MESSAGE_TIMES

    reply = AIMessage(content=[{'type': 'reasoning', 'reasoning': ''}, {'type': 'text', 'text': 'Answer'}],
                      response_metadata={MESSAGE_TIMES: {
                          'started_at': 4000, 'ended_at': 4100, 'reasoning': [], 'tool_calls': {},
                      }})
    assert [message['role'] for message in conversation([reply])] == ['assistant']


def test_legacy_empty_summary_does_not_take_the_following_saved_span() -> None:
    from botcube_harness_deepagents.conversation import MESSAGE_TIMES

    reply = AIMessage(content=[{'type': 'reasoning', 'reasoning': ''},
                               {'type': 'reasoning', 'reasoning': 'Summary'},
                               {'type': 'text', 'text': 'Answer'}], response_metadata={MESSAGE_TIMES: {
        'started_at': 4000, 'ended_at': 4100, 'tool_calls': {},
        'reasoning': [{'id': 'kept-thought', 'started_at': 2000, 'ended_at': 4000}],
    }})
    [thought] = [message for message in conversation([reply]) if message['role'] == 'reasoning']
    assert thought['id'] == 'kept-thought'
    assert thought['content'] == 'Summary'
    assert thought['metadata'] == {'started_at': 2000, 'ended_at': 4000}


@pytest.mark.parametrize('content', [[], [{'type': 'redacted_thinking', 'data': 'opaque'}]])
def test_metadata_or_redacted_content_does_not_create_a_thought(monkeypatch: Any, content: list[Any]) -> None:
    monkeypatch.setattr(message_times, 'now', lambda: 1000)
    clock = message_times._ModelClock()
    run = UUID('00000000-0000-0000-0000-000000000001')
    clock.on_chat_model_start({}, [[]], run_id=run)
    clock.on_llm_new_token('', chunk=ChatGenerationChunk(message=AIMessageChunk(content=content)), run_id=run)
    reply = clock.stamped(AIMessage(content=[*content, {'type': 'text', 'text': 'Answer'}]), 4000)
    assert not [message for message in conversation([reply]) if message['role'] == 'reasoning']
