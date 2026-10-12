from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, cast

import pytest
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph_checkpoint_aws import AgentCoreMemoryStore

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents.turn_memory import (
    TurnFeedError,
    TurnMemoryMiddleware,
    collecting_turn_feeds,
    feed_turn,
    latest_turn_messages,
)

NAMESPACE = ('jane_doe_ny', 'thread-1')


def _store(memory: FakeAgentCoreMemory) -> AgentCoreMemoryStore:
    store = AgentCoreMemoryStore(memory_id=MEMORY_ID, region_name='us-east-1',
                                 aws_access_key_id='test', aws_secret_access_key='test')
    store.client = cast(Any, memory)
    return store


def _fed(memory: FakeAgentCoreMemory, messages: list[BaseMessage]) -> list[list[tuple[str, str]]]:
    asyncio.run(feed_turn(_store(memory), NAMESPACE, messages))
    return [
        [(item['conversational']['role'], item['conversational']['content']['text']) for item in event['payload']]
        for event in memory.events[NAMESPACE]
    ]


def test_a_turn_feeds_one_event_per_message_with_text_in_order() -> None:
    call = {'id': 'call-1', 'name': 'execute', 'args': {'command': 'echo copper'}}
    messages = [
        HumanMessage(content='Remember that I prefer copper.'),
        AIMessage(content='', tool_calls=[call]),
        ToolMessage(content='Copper futures curve output', tool_call_id='call-1'),
        AIMessage(content=[{'type': 'text', 'text': 'I checked copper.'}], tool_calls=[{**call, 'id': 'call-2'}]),
        ToolMessage(content='', tool_call_id='call-2'),
        AIMessage(content='Copper is up.'),
    ]

    assert _fed(FakeAgentCoreMemory(), messages) == [
        [('USER', 'Remember that I prefer copper.')],
        [('TOOL', 'Copper futures curve output')],
        [('ASSISTANT', 'I checked copper.')],
        [('ASSISTANT', 'Copper is up.')],
    ]


def test_a_message_at_agentcores_limit_is_fed_whole() -> None:
    text = 'x' * 100_000

    assert _fed(FakeAgentCoreMemory(), [HumanMessage(content='Read it'), ToolMessage(content=text, tool_call_id='c')]) == [
        [('USER', 'Read it')], [('TOOL', text)],
    ]


def test_a_message_over_agentcores_limit_fails_the_feed_before_any_write() -> None:
    memory = FakeAgentCoreMemory()
    messages = [HumanMessage(content='Read it'), ToolMessage(content='x' * 100_001, tool_call_id='c')]

    with pytest.raises(TurnFeedError, match="A tool message of 100001 characters is over AgentCore's 100000-character limit") as raised:
        asyncio.run(feed_turn(_store(memory), NAMESPACE, messages))

    assert raised.value.code == 'TURN_FEED_FAILED'
    assert memory.create_event_calls == 0


def test_a_failed_write_fails_the_feed_with_its_cause() -> None:
    memory = FakeAgentCoreMemory()

    def unavailable(**_params: object) -> None:
        raise RuntimeError('Memory unavailable')

    memory.create_event = unavailable  # type: ignore[method-assign]

    with pytest.raises(TurnFeedError, match='^The Turn could not be fed to Memory: Memory unavailable$') as raised:
        asyncio.run(feed_turn(_store(memory), NAMESPACE, [HumanMessage(content='hello')]))

    assert isinstance(raised.value.__cause__, RuntimeError)


def test_the_middleware_hands_the_latest_turn_to_its_collector() -> None:
    memory = FakeAgentCoreMemory()
    middleware = TurnMemoryMiddleware(actor_id='jane_doe_ny', session_id='thread-1')
    state = {'messages': [HumanMessage(content='Old'), AIMessage(content='Old answer'),
                          HumanMessage(content='I prefer copper.'), AIMessage(content='Noted.')]}

    async def run() -> None:
        with collecting_turn_feeds() as feeds:
            await middleware.aafter_agent(state, SimpleNamespace(store=_store(memory)))
        assert memory.create_event_calls == 0
        [feed] = feeds
        await feed()

    asyncio.run(run())

    assert [event['payload'] for event in memory.events[NAMESPACE]] == [
        [{'conversational': {'content': {'text': 'I prefer copper.'}, 'role': 'USER'}}],
        [{'conversational': {'content': {'text': 'Noted.'}, 'role': 'ASSISTANT'}}],
    ]


def test_the_middleware_outside_a_collector_fails_loud() -> None:
    middleware = TurnMemoryMiddleware(actor_id='jane_doe_ny', session_id='thread-1')

    with pytest.raises(TurnFeedError, match='outside collecting_turn_feeds'):
        asyncio.run(middleware.aafter_agent({'messages': [HumanMessage(content='hi')]}, SimpleNamespace(store=None)))


def test_latest_turn_messages_excludes_prior_conversation_history() -> None:
    messages = [
        HumanMessage(content='Old question'),
        AIMessage(content='Old answer'),
        HumanMessage(content='New question'),
        AIMessage(
            content='',
            tool_calls=[{
                'id': 'call-1',
                'name': 'execute',
                'args': {'command': 'echo status'},
            }],
        ),
        ToolMessage(content='status output', tool_call_id='call-1'),
        AIMessage(content='New answer'),
    ]

    assert latest_turn_messages(messages) == messages[2:]


def test_latest_turn_messages_starts_at_the_last_of_several_questions() -> None:
    messages = [
        HumanMessage(content='First'),
        HumanMessage(content='Second'),
        AIMessage(content='Answer'),
        HumanMessage(content='Third'),
        SystemMessage(content='Summarized context'),
        AIMessage(content='Latest answer'),
    ]

    assert latest_turn_messages(messages) == [messages[3], messages[5]]


def test_latest_turn_messages_without_a_question_is_empty() -> None:
    assert latest_turn_messages([AIMessage(content='Greeting')]) == []
