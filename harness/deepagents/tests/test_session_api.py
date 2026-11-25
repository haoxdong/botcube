from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier, Lock
from typing import Any

import boto3
import pytest
import uvicorn
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint
from langgraph_checkpoint_aws.checkpoint.deferred_saver import PendingWrite

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents import session_api
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.llm import EchoChatModel
from botcube_harness_deepagents.memory import agentcore
from checkpoint_fake import ReadCountingSaver, legacy_session


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', '')
    monkeypatch.setattr(session_api, '_GRAPH', None)
    monkeypatch.setenv('BOTCUBE_CHECKPOINT_PATH', str(tmp_path / 'checkpoints.sqlite3'))
    with TestClient(session_api.app) as client:
        yield client


def test_contract_covers_dispatch_errors_and_deadlines() -> None:
    contract = session_api.CONTRACT
    operations = contract['operations']
    assert operations.keys() == session_api.HANDLERS.keys()
    assert {code for operation in operations.values() for code in operation['errors']} == contract['errors'].keys()
    assert contract['clientGraceSeconds'] > 0
    assert all(
        0 < contract['deadlines'][operation['deadline']] <= contract['deadlines']['invocation']
        for operation in operations.values()
    )


def test_get_of_a_session_without_a_record_is_not_found(client: TestClient) -> None:
    response = client.post(
        '/invocations', json={'operation': 'get', 'sessionId': 'missing', 'userId': 'user-1'}
    )

    assert response.status_code == 404
    assert response.json() == {'error': 'Session missing has no record', 'code': 'SESSION_NOT_FOUND'}


@pytest.mark.parametrize(
    ('event', 'error'),
    [
        ({'operation': 'get', 'sessionId': 'session-1'}, 'userId is required'),
        ({'operation': 'get', 'sessionId': ' ', 'userId': 'user-1'}, 'sessionId is required'),
        ({'operation': 'purge', 'sessionId': 'session-1'}, 'userId is required'),
        (
            {'operation': 'activity', 'sessions': [{'sessionId': 'session-1', 'userId': 'user-1'}]},
            "Unknown session API operation: 'activity'",
        ),
        (
            {'operation': 'rename', 'sessionId': 'session-1', 'userId': 'user-1'},
            "Unknown session API operation: 'rename'",
        ),
        (['not', 'an', 'event'], 'Expected a JSON object'),
    ],
)
def test_malformed_events_are_rejected(client: TestClient, event: object, error: str) -> None:
    response = client.post('/invocations', json=event)

    assert response.status_code == 400
    assert response.json() == {'error': error, 'code': 'INVALID_REQUEST'}


def test_the_session_api_refuses_to_start_without_a_shared_session_record(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', '')
    monkeypatch.setattr(session_api, '_GRAPH', None)
    monkeypatch.delenv('BOTCUBE_CHECKPOINT_PATH', raising=False)

    with pytest.raises(
        RuntimeError,
        match=r'^The session API needs the Session record: set AGENTCORE_MEMORY_ID or BOTCUBE_CHECKPOINT_PATH$',
    ):
        session_api._graph()


@pytest.mark.integration
def test_the_session_api_reads_its_memory_in_aws_region_the_name_lambda_sets() -> None:
    script = ('from botcube_harness_deepagents import session_api\n'
              'print(session_api._build_checkpointer().checkpoint_event_client.client.meta.region_name)')
    env = {**os.environ, 'AWS_ACCESS_KEY_ID': 'test', 'AWS_SECRET_ACCESS_KEY': 'test', 'AGENTCORE_MEMORY_ID': 'memory_1-0123456789',
           'AWS_REGION': 'eu-west-1', 'AGENTCORE_REGION': 'ap-south-1'}

    result = subprocess.run([sys.executable, '-c', script], env=env, capture_output=True, text=True, check=True)

    assert result.stdout.strip() == 'eu-west-1'


def test_the_session_record_is_the_configured_agentcore_memory_in_its_region(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-west-2')
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', 'memory_1-0123456789')
    monkeypatch.setattr(session_api, 'AWS_REGION', 'eu-west-1')

    events = session_api._build_checkpointer().checkpoint_event_client

    assert (events.memory_id, events.client.meta.region_name) == ('memory_1-0123456789', 'eu-west-1')


@pytest.fixture
def local_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', '')
    monkeypatch.setattr(session_api, '_GRAPH', None)
    # A fresh execution environment: the function has not run yet.
    monkeypatch.setattr(session_api, '_LOOP', None)
    monkeypatch.setenv('BOTCUBE_CHECKPOINT_PATH', str(tmp_path / 'checkpoints.sqlite3'))


def test_a_session_replays_without_the_system_context_a_run_carried(local_record: None) -> None:
    """Sessions recorded by the earlier CopilotKit serving stack hold CopilotKit's App Context as a system message."""
    config = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}
    recorded = [SystemMessage('App Context', id='context-1'), HumanMessage('hello', id='user-message-1')]

    async def record_and_replay() -> dict[str, Any]:
        await session_api._graph().ainvoke({'messages': recorded}, config)
        return await session_api.handle({'operation': 'get', 'sessionId': 'session-1', 'userId': 'user-1'})

    replayed = asyncio.run(record_and_replay())['messages']

    assert [(message['id'], message['role'], message['content']) for message in replayed] == [
        ('user-message-1', 'user', 'hello'),
        (replayed[1]['id'], 'assistant', 'Echo: hello'),
    ]


def test_a_session_replays_sonnets_reasoning_before_the_answer_it_led_to(local_record: None) -> None:
    config = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}
    answer = AIMessage(
        [
            {'type': 'reasoning_content', 'reasoning_content': {'text': 'Plot the five points.', 'signature': 'sig'}},
            {'type': 'text', 'text': 'Here is the chart.'},
        ],
        id='answer-1',
        response_metadata={'model_provider': 'bedrock_converse'},
    )

    async def record_and_replay() -> dict[str, Any]:
        await session_api._graph().ainvoke({'messages': [HumanMessage('Chart these', id='ask-1'), answer]}, config)
        return await session_api.handle({'operation': 'get', 'sessionId': 'session-1', 'userId': 'user-1'})

    replayed = asyncio.run(record_and_replay())['messages']

    assert replayed[:3] == [
        {'id': 'ask-1', 'role': 'user', 'content': 'Chart these'},
        {'id': 'answer-1-reasoning-0', 'role': 'reasoning', 'content': 'Plot the five points.'},
        {'id': 'answer-1', 'role': 'assistant', 'content': 'Here is the chart.'},
    ]


@pytest.fixture
def agentcore_record(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    fake = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *_args, **_kwargs: fake)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setattr(session_api, '_GRAPH', None)
    return fake


GET = {'operation': 'get', 'sessionId': 'session-1', 'userId': 'user-1'}


def test_a_get_reads_the_sessions_record_once(agentcore_record: FakeAgentCoreMemory) -> None:
    async def scenario() -> dict[str, Any]:
        await _turn(HumanMessage('hello', id='user-message-1'))
        await _turn(HumanMessage('again', id='user-message-2'))
        agentcore_record.listed.clear()
        return await session_api.handle(GET)

    replayed = asyncio.run(scenario())['messages']

    assert [(message['role'], message['content']) for message in replayed] == [
        ('user', 'hello'), ('assistant', 'Echo: hello'), ('user', 'again'), ('assistant', 'Echo: again'),
    ]
    assert agentcore_record.listed['session-1'] == 1


@pytest.mark.parametrize('pending_count', [98, 99], ids=['single-event', 'chunked'])
@pytest.mark.parametrize('allow_get_event', [False, True], ids=['get-denied', 'get-allowed'])
def test_session_history_reads_snapshot_chunks(
    agentcore_record: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
    pending_count: int, allow_get_event: bool,
) -> None:
    config: RunnableConfig = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}
    checkpoint = empty_checkpoint()
    checkpoint['channel_values'] = {'messages': [HumanMessage('Saved question', id='saved-question')]}
    checkpoint['channel_versions'] = {'messages': '1'}
    writer = agentcore.build_checkpointer(MEMORY_ID, region_name=session_api.AWS_REGION)
    writer.put_with_writes(
        config, checkpoint, {'source': 'loop', 'step': 1, 'parents': {}}, {'messages': '1'},
        [PendingWrite(config, [('messages', [HumanMessage(f'Pending {index}')])], f'task-{index}', '')
         for index in range(pending_count)],
    )
    if not allow_get_event:
        def denied(**_params: Any) -> Any:
            raise ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'GetEvent denied'}}, 'GetEvent')

        monkeypatch.setattr(agentcore_record, 'get_event', denied)
    if pending_count == 99 and not allow_get_event:
        with pytest.raises(ClientError, match='AccessDeniedException'):
            asyncio.run(session_api.handle(GET))
    else:
        replayed = asyncio.run(session_api.handle(GET))['messages']
        assert [(message['role'], message['content']) for message in replayed] == [('user', 'Saved question')]


def test_each_get_reads_the_record_as_the_harness_left_it(agentcore_record: FakeAgentCoreMemory) -> None:
    """Each read is the Session's latest checkpoint, not an earlier read's."""
    harness = build_agent(
        model=EchoChatModel(),
        backend=None,
        skills=[],
        checkpointer=agentcore.build_checkpointer(MEMORY_ID, region_name=session_api.AWS_REGION),
    )
    config = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}

    async def scenario() -> list[dict[str, Any]]:
        await harness.ainvoke({'messages': [HumanMessage('hello', id='user-message-1')]}, config)
        await session_api.handle(GET)
        await harness.ainvoke({'messages': [HumanMessage('again', id='user-message-2')]}, config)
        return (await session_api.handle(GET))['messages']

    assert [message['content'] for message in asyncio.run(scenario())] == ['hello', 'Echo: hello', 'again', 'Echo: again']


@pytest.mark.parametrize('empty_filtered_page', [False, True])
def test_history_does_not_fetch_old_snapshot_payloads_after_a_non_checkpoint_event(
    agentcore_record: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, empty_filtered_page: bool,
) -> None:
    fetched_snapshots: list[str] = []
    list_events = agentcore_record.list_events
    empty_pages = [empty_filtered_page]

    def measured_list(**params: Any) -> dict[str, Any]:
        if params.get('filter') and empty_pages and empty_pages.pop():
            return {'events': [], 'nextToken': '0'}
        response = list_events(**params)
        fetched_snapshots.extend(
            event['eventId'] for event in response['events']
            if event.get('metadata', {}).get('lc_kind', {}).get('stringValue') == 'checkpoint'
        )
        return response

    async def scenario() -> list[dict[str, Any]]:
        for index in range(8):
            await session_api.post_message('user-1', 'session-1', f'Brief {index}', f'brief-{index}')
        agentcore_record.seed('user-1', 'session-1')
        monkeypatch.setattr(agentcore_record, 'list_events', measured_list)
        return (await session_api.handle(GET))['messages']

    assert [message['content'] for message in asyncio.run(scenario())] == [
        'Brief 0', 'Brief 1', 'Brief 2', 'Brief 3', 'Brief 4', 'Brief 5', 'Brief 6', 'Brief 7',
    ]
    assert len(fetched_snapshots) <= 4


def test_small_checkpoint_pages_still_read_all_pending_writes(agentcore_record: FakeAgentCoreMemory) -> None:
    async def scenario() -> Any:
        await session_api.post_message('user-1', 'session-1', 'Saved answer')
        saver = session_api._graph().checkpointer
        config = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}
        saved = await saver.aget_tuple(config)
        for index in range(7):
            await saver.aput_writes(
                saved.config, [('messages', [AIMessage(f'Pending {index}')])], f'task-{index}',
            )
        return await saver.aget_tuple(config)

    replayed = asyncio.run(scenario())

    assert [messages[0].content for _task, channel, messages in sorted(replayed.pending_writes)
            if channel == 'messages'] == [
        'Pending 0', 'Pending 1', 'Pending 2', 'Pending 3', 'Pending 4', 'Pending 5', 'Pending 6',
    ]


def test_a_post_reaches_the_sessions_history_under_the_id_given(
    agentcore_record: FakeAgentCoreMemory,
) -> None:
    """A scheduled run's result reaches the Main Chat's history without a Turn."""

    async def scenario() -> list[dict[str, Any]]:
        await _turn(HumanMessage('hello', id='user-message-1'))
        await session_api.handle(
            {'operation': 'post', 'sessionId': 'session-1', 'userId': 'user-1', 'content': 'Brief', 'messageId': 'post-1'}
        )
        await session_api.handle(
            {'operation': 'post', 'sessionId': 'session-1', 'userId': 'user-1', 'content': 'Retry', 'messageId': 'post-1'}
        )
        return (await session_api.handle(GET))['messages']

    replayed = asyncio.run(scenario())

    assert [(message['id'], message['content']) for message in replayed[2:]] == [('post-1', 'Brief')]


async def _turn(*messages: Any, **options: Any) -> None:
    config = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}
    await session_api._graph().ainvoke({'messages': list(messages)}, config, **options)


async def _post(content: str, session_id: str = 'session-1') -> dict[str, Any]:
    return await session_api.handle(
        {'operation': 'post', 'sessionId': session_id, 'userId': 'user-1', 'content': content}
    )


async def _replay(session_id: str = 'session-1') -> list[dict[str, Any]]:
    replayed = await session_api.handle({'operation': 'get', 'sessionId': session_id, 'userId': 'user-1'})
    return replayed['messages']


def _said(messages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [(message['role'], message['content']) for message in messages]


def test_a_post_follows_the_sessions_turns_as_the_agents_message(local_record: None) -> None:
    async def scenario() -> tuple[dict[str, Any], list[dict[str, Any]]]:
        await _turn(HumanMessage('hello', id='user-message-1'))
        posted = await _post('Morning brief: markets are up.')
        return posted, await _replay()

    posted, replayed = asyncio.run(scenario())

    assert posted == {}
    assert _said(replayed) == [
        ('user', 'hello'),
        ('assistant', 'Echo: hello'),
        ('assistant', 'Morning brief: markets are up.'),
    ]


def test_each_post_replays_under_its_own_message_id(local_record: None) -> None:
    """The web keys a Session's messages by ID, so posts without one showed as one message."""

    async def scenario() -> list[dict[str, Any]]:
        await _turn(HumanMessage('hello', id='user-message-1'))
        await _post('Oil brief: Brent up 2%.')
        await _post('Oil brief: Brent flat.')
        return await _replay()

    replayed = asyncio.run(scenario())

    assert len({message['id'] for message in replayed}) == len(replayed)


@pytest.mark.parametrize('answer', ['The 10y yield fell 5bp.', 'x' * 40_000])
def test_a_scheduled_runs_post_replays_with_its_run_card(local_record: None, answer: str) -> None:
    """The card is stored with the message, so it shows after a reload and after the chat's next Turn."""
    card = {
        'sideChat': 'task-1', 'messageId': 'run-request-1', 'title': 'Rates brief',
        'ranAt': '2026-10-12T07:00:00.000Z', 'status': 'done', 'text': answer,
    }

    content = f'Scheduled task "Rates brief": {answer}'

    async def scenario() -> list[dict[str, Any]]:
        await session_api.handle({
            'operation': 'post', 'sessionId': 'session-1', 'userId': 'user-1',
            'content': content, 'messageId': 'post-1', 'scheduledRun': card,
        })
        await _post('Plain brief')
        await _turn(HumanMessage('hello', id='user-message-1'))
        return await _replay()

    replayed = asyncio.run(scenario())

    placeholder = 'Large message content is stored in the Session record.'
    expected_text = placeholder if len(answer) == 40_000 else answer
    assert [(message['id'], message.get('metadata')) for message in replayed if message['role'] == 'assistant'][:2] == [
        ('post-1', {'scheduledRun': {**card, 'text': expected_text}}),
        (replayed[1]['id'], None),
    ]
    assert replayed[0]['content'] == (placeholder if expected_text == placeholder else content)


def test_a_post_opens_a_session_that_had_no_turns(local_record: None) -> None:
    async def scenario() -> list[dict[str, Any]]:
        await _post('Morning brief: markets are up.')
        return await _replay()

    assert _said(asyncio.run(scenario())) == [('assistant', 'Morning brief: markets are up.')]


def test_a_post_without_content_is_rejected(client: TestClient) -> None:
    response = client.post(
        '/invocations', json={'operation': 'post', 'sessionId': 'session-1', 'userId': 'user-1', 'content': ' '}
    )

    assert response.status_code == 400
    assert response.json() == {'error': 'content is required', 'code': 'INVALID_REQUEST'}


def test_the_session_graph_carries_no_memory_source(local_record: None) -> None:
    assert not any(node.startswith('MemoryMiddleware') for node in session_api._graph().nodes)


def test_the_function_entrypoint_answers_with_the_status_the_http_mode_uses(local_record: None) -> None:
    missing = session_api.lambda_handler(
        {'operation': 'get', 'sessionId': 'missing', 'userId': 'user-1'}, None
    )
    malformed = session_api.lambda_handler({'operation': 'get', 'sessionId': 'session-1'}, None)
    purged = session_api.lambda_handler(
        {'operation': 'purge', 'sessionId': 'missing', 'userId': 'user-1'}, None
    )

    assert missing == {
        'statusCode': 404,
        'body': {'error': 'Session missing has no record', 'code': 'SESSION_NOT_FOUND'},
    }
    assert malformed == {'statusCode': 400, 'body': {'error': 'userId is required', 'code': 'INVALID_REQUEST'}}
    assert purged == {'statusCode': 200, 'body': {}}


@pytest.fixture
def legacy_record(local_record: None, monkeypatch: pytest.MonkeyPatch) -> ReadCountingSaver:
    """The session API on a record holding `legacy-1`, a Session in the legacy checkpoint format."""
    saver = ReadCountingSaver()
    legacy_session(saver, 'legacy-1')
    monkeypatch.setattr(session_api, '_GRAPH', build_agent(
        model=EchoChatModel(), backend=None, skills=[], checkpointer=saver,
    ))
    return saver


LEGACY = {
    'error': 'Session legacy-1 is in the legacy checkpoint format: its latest checkpoint stores no files, messages',
    'code': 'SESSION_FORMAT_LEGACY',
}


@pytest.mark.parametrize('event', [
    pytest.param({'operation': 'get'}, id='get'),
    pytest.param({'operation': 'post', 'content': 'Copper closed up 2%'}, id='post'),
])
def test_a_legacy_format_session_is_gone_without_walking_its_checkpoints(
    legacy_record: ReadCountingSaver, event: dict[str, str],
) -> None:
    result = session_api.lambda_handler({**event, 'sessionId': 'legacy-1', 'userId': 'user-1'}, None)

    assert result == {'statusCode': 410, 'body': LEGACY}
    assert legacy_record.reads == ['get_tuple']


def test_a_session_read_that_outlives_the_chat_services_wait_times_out(
    local_record: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def stalled(*_args: Any, **_kwargs: Any) -> None:
        await asyncio.sleep(5)

    graph = session_api._graph()
    monkeypatch.setitem(session_api.CONTRACT['deadlines'], 'request', 0.05)
    monkeypatch.setattr(graph.checkpointer, 'aget_tuple', stalled)
    events = [{'operation': 'get'}, {'operation': 'post', 'content': 'Copper closed up 2%'}]

    results = [session_api.lambda_handler({**event, 'sessionId': 'session-1', 'userId': 'user-1'}, None)
               for event in events]

    assert results == [{'statusCode': 504, 'body': {
        'error': 'The session API gave up reading Session session-1 after 0.05 s', 'code': 'SESSION_READ_TIMEOUT',
    }}] * 2


def test_the_function_entrypoint_serves_repeated_invocations(local_record: None) -> None:
    event = {'operation': 'get', 'sessionId': 'session-1', 'userId': 'user-1'}

    assert session_api.lambda_handler(event, None)['statusCode'] == 404
    assert session_api.lambda_handler(event, None)['statusCode'] == 404


def test_session_api_timing_splits_history_reads_without_logging_content(
    local_record: None, caplog: pytest.LogCaptureFixture,
) -> None:
    session_api.lambda_handler({**GET, 'operation': 'post', 'content': 'private answer'}, None)
    caplog.clear()

    result = session_api.lambda_handler(GET, None)

    assert result['statusCode'] == 200
    records = [json.loads(record.message) for record in caplog.records if 'session_api_timing' in record.message]
    assert len(records) == 1
    record = records[0]
    assert record['operation'] == 'get'
    assert record['statusCode'] == 200
    assert record['messageCount'] == 1
    assert record['durationMs'] >= sum(record['phasesMs'].values())
    assert set(record['phasesMs']) == {'graph', 'checkpoint', 'state', 'conversation'}
    assert all(duration >= 0 for duration in record['phasesMs'].values())
    assert 'private answer' not in caplog.text
    assert 'user-1' not in caplog.text
    assert record['sessionId'] == 'session-1'
    assert record['responseBytes'] == len(json.dumps(result['body'], separators=(',', ':')).encode())


@pytest.mark.parametrize('unexpected', [False, True])
def test_session_api_timing_preserves_classified_and_unexpected_failures(
    local_record: None, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch, unexpected: bool,
) -> None:
    ticks = iter([0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0])
    monkeypatch.setattr(session_api, 'perf_counter', lambda: next(ticks))
    if unexpected:
        async def broken(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError('private failure')

        monkeypatch.setattr(session_api._graph().checkpointer, 'aget_tuple', broken)
        with pytest.raises(RuntimeError, match='private failure'):
            session_api.lambda_handler(GET, None)
    else:
        assert session_api.lambda_handler(GET, None)['statusCode'] == 404

    records = [json.loads(record.message) for record in caplog.records if 'session_api_timing' in record.message]
    assert len(records) == 1
    assert records[0]['statusCode'] == (500 if unexpected else 404)
    assert records[0]['errorCode'] == ('INTERNAL_ERROR' if unexpected else 'SESSION_NOT_FOUND')
    assert records[0]['durationMs'] == 7000
    assert records[0]['phasesMs'] == {'graph': 1000, 'checkpoint': 1000, 'state': 2000}
    assert 'private failure' not in caplog.text


@pytest.mark.parametrize(('operation', 'status'), [
    ('post', 200), ('purge', 200), ('private invalid operation', 400),
])
def test_session_api_timing_attributes_other_operations(
    local_record: None, caplog: pytest.LogCaptureFixture, operation: str, status: int,
) -> None:
    if operation == 'purge':
        session_api.lambda_handler({**GET, 'operation': 'post', 'content': 'private answer'}, None)
        caplog.clear()
    result = session_api.lambda_handler({
        **GET, 'operation': operation, 'content': 'private answer', 'text': 'private memory', 'recordId': 'line-1',
    }, None)

    assert result['statusCode'] == status
    records = [json.loads(record.message) for record in caplog.records if 'session_api_timing' in record.message]
    assert len(records) == 1
    assert records[0]['operation'] == (operation if status != 400 else 'invalid')
    assert records[0]['statusCode'] == status
    assert records[0]['phasesMs'] == {}
    assert 'messageCount' not in records[0]
    assert 'private' not in caplog.text


@pytest.fixture
def start(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[], list[tuple[Any, dict[str, Any]]]]]:
    """Start the local session API with main(), recording how uvicorn would serve it."""
    served: list[tuple[Any, dict[str, Any]]] = []
    monkeypatch.setattr(uvicorn, 'run', lambda app, **options: served.append((app, options)))
    monkeypatch.delenv('PORT', raising=False)
    # main() configures the root logger of a fresh process: WARNING and above, no handler.
    level = logging.root.level
    logging.root.setLevel(logging.WARNING)

    def start() -> list[tuple[Any, dict[str, Any]]]:
        # Drops the handlers pytest adds for this phase; main() adds its own.
        monkeypatch.setattr(logging.root, 'handlers', [])
        session_api.main()
        return served

    yield start
    logging.root.setLevel(level)


def test_the_local_session_api_serves_on_every_interface_at_port_8081(start: Callable[[], list[tuple[Any, dict[str, Any]]]]) -> None:
    assert start() == [(session_api.app, {'host': '0.0.0.0', 'port': 8081})]


def test_the_local_session_api_serves_on_the_configured_port(start: Callable[[], list[tuple[Any, dict[str, Any]]]], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('PORT', '9124')

    assert start() == [(session_api.app, {'host': '0.0.0.0', 'port': 9124})]


def test_the_local_session_api_logs_at_info_with_the_logger_name(start: Callable[[], list[tuple[Any, dict[str, Any]]]], capsys: pytest.CaptureFixture[str]) -> None:
    start()
    log = logging.getLogger('botcube_harness_deepagents.session_api')
    log.debug('hidden')
    log.info('ready')

    assert capsys.readouterr().err == 'botcube_harness_deepagents.session_api ready\n'


# -- Memory ----------------------------------------------------------------------

# AgentCore memory record IDs are at least 40 characters.
OWN_RECORD = 'mem-own-000000000000000000000000000000000'
OTHERS_RECORD = 'mem-others-00000000000000000000000000000000'
# The other user's ID starts with user-1's: only the trailing slash keeps their records apart.
OTHER_USER = 'user-12'


def _record(record_id: str, text: str, actor: str, kind: str = 'facts') -> dict[str, Any]:
    return {
        'memoryRecordId': record_id,
        'content': {'text': text},
        'memoryStrategyId': 'SemanticFacts-1',
        'namespaces': [f'/actors/{actor}/{kind}/'],
        'createdAt': datetime(2026, 7, 1, tzinfo=UTC),
    }


@pytest.fixture
def memory(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    fake = FakeAgentCoreMemory()
    fake.records += [_record(OWN_RECORD, 'Trades copper', 'user-1'), _record(OTHERS_RECORD, 'Trades gold', OTHER_USER)]
    monkeypatch.setattr(session_api, 'AWS_REGION', 'eu-west-1')
    monkeypatch.setattr(
        boto3,
        'client',
        lambda service, *, region_name, **_: fake if (service, region_name) == ('bedrock-agentcore', 'eu-west-1') else None,
    )
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    return fake


def _memory(client: TestClient, operation: str, **fields: str) -> Any:
    response = client.post('/invocations', json={'operation': operation, 'userId': 'user-1', **fields})
    return response.status_code, response.json()


def test_concurrent_session_purges_both_succeed(
    client: TestClient, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory.seed('user-1', 'session-1')
    delete = memory.delete_event
    deleting = Barrier(2)
    lock = Lock()

    def delete_listed_event(**params: Any) -> dict[str, Any]:
        deleting.wait(timeout=5)
        with lock:
            try:
                memory.get_event(**params)
            except memory.exceptions.ResourceNotFoundException as error:
                raise memory.exceptions.ResourceNotFoundException(
                    {'Error': {'Code': 'ResourceNotFoundException',
                               'Message': f"Event not found with id: {params['eventId']}"}},
                    'DeleteEvent',
                ) from error
            return delete(**params)

    monkeypatch.setattr(memory, 'delete_event', delete_listed_event)
    event = {'operation': 'purge', 'sessionId': 'session-1', 'userId': 'user-1'}
    with ThreadPoolExecutor(2) as workers:
        replies = list(workers.map(lambda _: client.post('/invocations', json=event), range(2)))

    assert [reply.status_code for reply in replies] == [200, 200]
    assert not memory.events[('user-1', 'session-1')]


# -- Forget ----------------------------------------------------------------------

# Every kind of record AgentCore extracts under an actor, the Session-scoped ones nested a level deeper.
EXTRACTED_KINDS = ('preferences', 'facts', 'summaries/session-1', 'episodes/session-2', 'episodes')


def _extracted(actor: str, count: int) -> list[dict[str, Any]]:
    return [
        _record(f'mem-{actor}-{index:035d}', f'Extracted {index}', actor, EXTRACTED_KINDS[index % len(EXTRACTED_KINDS)])
        for index in range(count)
    ]


def _actor_records(memory: FakeAgentCoreMemory, actor: str) -> list[str]:
    return [record['memoryRecordId'] for record in memory.records if record['namespaces'][0].startswith(f'/actors/{actor}/')]


def test_forget_deletes_every_extracted_record_of_the_user_and_no_one_elses(
    client: TestClient, memory: FakeAgentCoreMemory
) -> None:
    # More than two pages of records under the User's actor namespaces.
    memory.records += _extracted('user-1', 250)
    others = _actor_records(memory, OTHER_USER)

    assert _memory(client, 'forget') == (200, {})
    assert _actor_records(memory, 'user-1') == []
    assert _actor_records(memory, OTHER_USER) == others


def test_a_forget_that_fails_part_way_finishes_when_retried(client: TestClient, memory: FakeAgentCoreMemory) -> None:
    memory.records += _extracted('user-1', 120)
    others = _actor_records(memory, OTHER_USER)
    memory.lag_listing()
    memory.deletes_before_throttling = 50

    with pytest.raises(ClientError, match='Rate exceeded'):
        _memory(client, 'forget')
    assert len(_actor_records(memory, 'user-1')) == 71

    memory.deletes_before_throttling = None
    # While the listing lags, it still lists the records the first try deleted.
    with pytest.raises(ClientError, match='Memory record not found'):
        _memory(client, 'forget')
    memory.catch_up_listing()

    assert _memory(client, 'forget') == (200, {})
    assert _actor_records(memory, 'user-1') == []
    assert _actor_records(memory, OTHER_USER) == others


def test_forget_without_agentcore_memory_has_no_extracted_memory_to_delete(client: TestClient) -> None:
    assert _memory(client, 'forget') == (200, {})
