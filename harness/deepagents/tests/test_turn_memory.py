from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from botcube_harness_deepagents.turn_memory import (
    TurnMemoryMiddleware,
    latest_turn_messages,
    record_turn_memory_event,
)


def test_record_turn_memory_event_writes_one_event_with_user_assistant_and_tool() -> None:
    store = MagicMock()
    messages = [
        HumanMessage(content='Remember that I prefer copper.'),
        AIMessage(
            content='',
            tool_calls=[{
                'id': 'call-1',
                'name': 'execute',
                'args': {'command': 'echo copper'},
            }],
        ),
        ToolMessage(content='Copper futures curve output', tool_call_id='call-1'),
        AIMessage(content='I will check copper futures.'),
    ]

    record_turn_memory_event(
        store,
        memory_id='memory-1',
        actor_id='jane.doe_ny',
        session_id='thread-1',
        messages=messages,
        now=datetime(2026, 7, 2, 12, 0, tzinfo=UTC),
    )

    store.client.create_event.assert_called_once_with(
        memoryId='memory-1',
        actorId='jane.doe_ny',
        sessionId='thread-1',
        eventTimestamp=datetime(2026, 7, 2, 12, 0, tzinfo=UTC),
        payload=[
            {
                'conversational': {
                    'content': {'text': 'Remember that I prefer copper.'},
                    'role': 'USER',
                },
            },
            {
                'conversational': {
                    'content': {
                        'text': (
                            'Tool call: execute '
                            '{"command": "echo copper"}'
                        ),
                    },
                    'role': 'ASSISTANT',
                },
            },
            {
                'conversational': {
                    'content': {'text': 'Copper futures curve output'},
                    'role': 'TOOL',
                },
            },
            {
                'conversational': {
                    'content': {'text': 'I will check copper futures.'},
                    'role': 'ASSISTANT',
                },
            },
        ],
    )


# -- against the bedrock-agentcore API ------------------------------------------
#
# A real client whose transport is a botocore Stubber: each request is validated against
# the service model and must equal the expected request; each response matches its shape.

MEMORY_ID = 'memory_1-0123456789'
NOW = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)


class _RecentUtc:
    """Equals a timezone-aware timestamp within a few seconds of the current UTC time."""

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, datetime)
            and other.tzinfo is not None
            and abs(other - datetime.now(UTC)) < timedelta(seconds=5)
        )


def _event_request(texts_and_roles: list[tuple[str, str]], timestamp: object = NOW) -> dict[str, object]:
    return {
        'memoryId': MEMORY_ID,
        'actorId': 'jane.doe_ny',
        'sessionId': 'thread-1',
        'eventTimestamp': timestamp,
        'payload': [
            {'conversational': {'content': {'text': text}, 'role': role}} for text, role in texts_and_roles
        ],
    }


def _event_response(request: dict[str, object]) -> dict[str, dict[str, object]]:
    return {'event': {**request, 'eventId': '1#abc', 'eventTimestamp': NOW}}


@pytest.fixture
def agentcore(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, Stubber, list[float]]]:
    client = boto3.client(
        'bedrock-agentcore', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test'
    )
    sleeps: list[float] = []
    monkeypatch.setattr('botcube_harness_deepagents.turn_memory.time.sleep', sleeps.append)
    with Stubber(client) as stubber:
        yield SimpleNamespace(client=client), stubber, sleeps
        stubber.assert_no_pending_responses()


def _record(store: Any, messages: list[BaseMessage]) -> None:
    record_turn_memory_event(
        store, memory_id=MEMORY_ID, actor_id='jane.doe_ny', session_id='thread-1', messages=messages, now=NOW
    )


def test_record_turn_memory_event_retries_retryable_agentcore_conflict(agentcore: tuple[Any, Stubber, list[float]]) -> None:
    store, stubber, sleeps = agentcore
    request = _event_request([('Remember copper.', 'USER'), ('Noted.', 'ASSISTANT')])
    stubber.add_client_error('create_event', 'RetryableConflictException', 'checkpoint flush owns this session')
    stubber.add_response('create_event', _event_response(request), request)

    _record(store, [HumanMessage(content='Remember copper.'), AIMessage(content='Noted.')])

    assert sleeps == [0.25]


def test_record_turn_memory_event_reraises_after_retry_exhaustion(agentcore: tuple[Any, Stubber, list[float]]) -> None:
    store, stubber, sleeps = agentcore
    for _ in range(6):
        stubber.add_client_error('create_event', 'RetryableConflictException', 'still flushing')

    with pytest.raises(ClientError, match='still flushing'):
        _record(store, [HumanMessage(content='Remember copper.')])

    assert sleeps == [0.25, 0.5, 1.0, 2.0, 4.0]


def test_record_turn_memory_event_reraises_an_agentcore_error_without_an_error_body(monkeypatch: pytest.MonkeyPatch) -> None:
    sleeps: list[float] = []
    monkeypatch.setattr('botcube_harness_deepagents.turn_memory.time.sleep', sleeps.append)
    store = MagicMock()
    error = ClientError({}, 'CreateEvent')
    store.client.create_event.side_effect = error

    with pytest.raises(ClientError) as raised:
        _record(store, [HumanMessage(content='Remember copper.')])

    assert raised.value is error
    assert sleeps == []


def test_record_turn_memory_event_does_not_retry_another_agentcore_error(agentcore: tuple[Any, Stubber, list[float]]) -> None:
    store, stubber, sleeps = agentcore
    stubber.add_client_error('create_event', 'ThrottledException', 'Rate exceeded')

    with pytest.raises(ClientError, match='Rate exceeded'):
        _record(store, [HumanMessage(content='Remember copper.')])

    assert sleeps == []


def test_turn_memory_middleware_writes_the_latest_turn_stamped_now(agentcore: tuple[Any, Stubber, list[float]]) -> None:
    store, stubber, _sleeps = agentcore
    request = _event_request([('I prefer copper.', 'USER'), ('Noted.', 'ASSISTANT')], _RecentUtc())
    stubber.add_response('create_event', _event_response(request), request)
    middleware = TurnMemoryMiddleware(memory_id=MEMORY_ID, actor_id='jane.doe_ny', session_id='thread-1')
    state = {
        'messages': [
            HumanMessage(content='Old question'),
            AIMessage(content='Old answer'),
            HumanMessage(content='I prefer copper.'),
            AIMessage(content='Noted.'),
        ],
    }

    async def run() -> None:
        await middleware.aafter_agent(state, SimpleNamespace(store=store))

    asyncio.run(run())


def _payload(store: MagicMock) -> list[tuple[str, str]]:
    return [
        (item['conversational']['content']['text'], item['conversational']['role'])
        for item in store.client.create_event.call_args.kwargs['payload']
    ]


def test_turn_memory_event_renders_tool_calls_and_content_blocks() -> None:
    store = MagicMock()
    _record(store, [
        HumanMessage(content='Check copper and zinc.'),
        AIMessage(content='', tool_calls=[
            {'id': 'call-1', 'name': 'quote', 'args': {'symbol': 'HG', 'as_of': 'today'}},
            {'id': 'call-2', 'name': 'quote', 'args': {'symbol': 'ZN'}},
        ]),
        ToolMessage(content='', tool_call_id='call-1'),
        ToolMessage(content=['HG 4.50', {'type': 'text', 'text': 'ZN 2.80'}], tool_call_id='call-2'),
        AIMessage(content=[
            {'type': 'text', 'text': 'Copper is up.'},
            {'type': 'tool_use', 'id': 'call-3', 'name': 'chart', 'input': {}},
        ], tool_calls=[{'id': 'call-3', 'name': 'chart', 'args': {}}]),
    ])

    assert _payload(store) == [
        ('Check copper and zinc.', 'USER'),
        ('Tool call: quote {"as_of": "today", "symbol": "HG"}\nTool call: quote {"symbol": "ZN"}', 'ASSISTANT'),
        ('HG 4.50\nZN 2.80', 'TOOL'),
        ('Copper is up.\nTool call: chart {}', 'ASSISTANT'),
    ]


def test_turn_memory_event_at_the_content_limit_is_sent_whole() -> None:
    store = MagicMock()
    _record(store, [HumanMessage(content='u' * 15_990), AIMessage(content='a' * 10)])

    assert _payload(store) == [('u' * 15_990, 'USER'), ('a' * 10, 'ASSISTANT')]


def test_turn_memory_event_shares_the_content_limit_fairly() -> None:
    store = MagicMock()
    _record(store, [
        HumanMessage(content='u' * 3_000),
        AIMessage(content='a' * 20_000),
        ToolMessage(content='t' * 20_000, tool_call_id='call-1'),
    ])

    # 16,000 / 3 leaves the short question whole; the other two split the rest.
    assert _payload(store) == [
        ('u' * 3_000, 'USER'),
        ('a' * 6_488 + '\n[truncated]', 'ASSISTANT'),
        ('t' * 6_488 + '\n[truncated]', 'TOOL'),
    ]


def test_turn_memory_event_keeps_a_message_that_exactly_fills_its_share() -> None:
    store = MagicMock()
    _record(store, [HumanMessage(content='u' * 8_000), AIMessage(content='a' * 9_000)])

    assert _payload(store) == [('u' * 8_000, 'USER'), ('a' * 7_988 + '\n[truncated]', 'ASSISTANT')]


def _alternating_turn(count: int) -> list[BaseMessage]:
    """A question, then answers and tool results alternating: `count` messages in all."""
    messages: list[BaseMessage] = [HumanMessage(content='q')]
    for index in range(1, count):
        if index % 2:
            messages.append(AIMessage(content=f'a{index}'))
        else:
            messages.append(ToolMessage(content=f't{index}', tool_call_id=f'call-{index}'))
    return messages


def _alternating(first: int, last: int) -> list[tuple[str, str]]:
    return [(f'a{i}', 'ASSISTANT') if i % 2 else (f't{i}', 'TOOL') for i in range(first, last + 1)]


def test_turn_memory_event_at_the_item_limit_is_sent_as_is() -> None:
    store = MagicMock()
    _record(store, [*_alternating_turn(98), AIMessage(content='a98'), AIMessage(content='a99')])

    assert _payload(store) == [
        ('q', 'USER'),
        *_alternating(1, 97),
        ('a98', 'ASSISTANT'),
        ('a99', 'ASSISTANT'),
    ]


def test_turn_memory_event_over_the_item_limit_joins_adjacent_same_role_messages() -> None:
    store = MagicMock()
    _record(store, [*_alternating_turn(99), AIMessage(content='a99'), AIMessage(content='a100')])

    assert _payload(store) == [('q', 'USER'), *_alternating(1, 98), ('a99\na100', 'ASSISTANT')]


def test_turn_memory_event_over_the_item_limit_omits_the_middle_of_the_turn() -> None:
    store = MagicMock()
    _record(store, _alternating_turn(151))

    assert _payload(store) == [
        ('q', 'USER'),
        *_alternating(1, 49),
        ('[52 turn messages omitted to fit AgentCore payload item limit]', 'TOOL'),
        *_alternating(102, 150),
    ]


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


def test_turn_memory_middleware_waits_for_its_event_and_propagates_failure() -> None:
    store = MagicMock()
    middleware = TurnMemoryMiddleware(memory_id=MEMORY_ID, actor_id='jane.doe_ny', session_id='thread-1')
    state = {'messages': [HumanMessage(content='I prefer copper.'), AIMessage(content='Noted.')]}
    asyncio.run(middleware.aafter_agent(state, SimpleNamespace(store=store)))
    assert store.client.create_event.call_args.kwargs['payload'] == [
        {'conversational': {'content': {'text': 'I prefer copper.'}, 'role': 'USER'}},
        {'conversational': {'content': {'text': 'Noted.'}, 'role': 'ASSISTANT'}},
    ]
    store.client.create_event.side_effect = RuntimeError('Memory unavailable')
    with pytest.raises(RuntimeError, match='Memory unavailable'):
        asyncio.run(middleware.aafter_agent(state, SimpleNamespace(store=store)))


def test_turn_memory_middleware_waits_for_write_before_fake_model_graph_completes(tmp_path: Path) -> None:
    import threading

    from deepagents.backends import LocalShellBackend

    from botcube_harness_deepagents.agent import build_agent
    from conftest import ToolBindableFakeMessagesModel

    class BlockingClient:
        def __init__(self) -> None:
            self.started = threading.Event()
            self.release = threading.Event()
            self.finished = threading.Event()

        def create_event(self, **kwargs: object) -> None:
            self.started.set()
            self.release.wait(timeout=2)
            self.finished.set()

    client = BlockingClient()
    agent = build_agent(
        model=ToolBindableFakeMessagesModel(responses=[AIMessage(content='Noted.')]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=[], skills=[], subagents=[], store=SimpleNamespace(client=client),
        middleware=[TurnMemoryMiddleware(memory_id=MEMORY_ID, actor_id='jane.doe_ny', session_id='thread-1')],
    )

    async def run_graph() -> None:
        work = asyncio.create_task(agent.ainvoke({'messages': [HumanMessage(content='I prefer copper.')]}))
        await asyncio.to_thread(client.started.wait, 1)
        assert not work.done()
        client.release.set()
        result = await asyncio.wait_for(work, 2)
        assert result['messages'][-1].content == 'Noted.'
        assert client.finished.is_set()

    asyncio.run(run_graph())
