from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
import pytest
import uvicorn
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents import memory_document, session_api
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


def test_the_session_record_is_the_configured_agentcore_memory_in_its_region(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-west-2')
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', 'memory_1-0123456789')
    monkeypatch.setattr(session_api, 'AGENTCORE_REGION', 'eu-west-1')

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


def test_a_session_replays_sonnets_reasoning_before_the_answer_it_led_to_issue_3007(local_record: None) -> None:
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


def test_a_get_reads_the_sessions_record_once_issue_3278(agentcore_record: FakeAgentCoreMemory) -> None:
    async def scenario() -> dict[str, Any]:
        await _turn(HumanMessage('hello', id='user-message-1'))
        await _turn(HumanMessage('again', id='user-message-2'))
        agentcore_record.listed.clear()
        return await session_api.handle(GET)

    replayed = asyncio.run(scenario())['messages']

    assert [(message['role'], message['content']) for message in replayed] == [
        ('user', 'hello'), ('assistant', 'Echo: hello'), ('user', 'again'), ('assistant', 'Echo: again'),
    ]
    # The format check's read of the latest checkpoint, then the state read's.
    assert agentcore_record.listed['session-1'] == 2


def test_each_get_reads_the_record_as_the_harness_left_it_issue_3278(agentcore_record: FakeAgentCoreMemory) -> None:
    """Each read is the Session's latest checkpoint, not an earlier read's."""
    harness = build_agent(
        model=EchoChatModel(),
        backend=None,
        skills=[],
        memory=[],
        checkpointer=agentcore.build_checkpointer(MEMORY_ID, region_name=session_api.AGENTCORE_REGION),
    )
    config = {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1'}}

    async def scenario() -> list[dict[str, Any]]:
        await harness.ainvoke({'messages': [HumanMessage('hello', id='user-message-1')]}, config)
        await session_api.handle(GET)
        await harness.ainvoke({'messages': [HumanMessage('again', id='user-message-2')]}, config)
        return (await session_api.handle(GET))['messages']

    assert [message['content'] for message in asyncio.run(scenario())] == ['hello', 'Echo: hello', 'again', 'Echo: again']


def test_a_post_reaches_the_sessions_history_under_the_id_given_issue_3354(
    agentcore_record: FakeAgentCoreMemory,
) -> None:
    """A scheduled run's result reaches the Main Chat's history without a Turn."""

    async def scenario() -> list[dict[str, Any]]:
        await _turn(HumanMessage('hello', id='user-message-1'))
        await session_api.handle(
            {'operation': 'post', 'sessionId': 'session-1', 'userId': 'user-1', 'content': 'Brief', 'messageId': 'post-1'}
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


def test_a_scheduled_runs_post_replays_with_its_run_card_issue_3859(local_record: None) -> None:
    """The card is stored with the message, so it shows after a reload and after the chat's next Turn."""
    card = {
        'sideChat': 'task-1', 'messageId': 'run-request-1', 'title': 'Rates brief',
        'ranAt': '2026-10-12T07:00:00.000Z', 'status': 'done', 'text': 'The 10y yield fell 5bp.',
    }

    async def scenario() -> list[dict[str, Any]]:
        await session_api.handle({
            'operation': 'post', 'sessionId': 'session-1', 'userId': 'user-1',
            'content': 'Scheduled task "Rates brief": The 10y yield fell 5bp.', 'messageId': 'post-1', 'scheduledRun': card,
        })
        await _post('Plain brief')
        await _turn(HumanMessage('hello', id='user-message-1'))
        return await _replay()

    replayed = asyncio.run(scenario())

    assert [(message['id'], message.get('metadata')) for message in replayed if message['role'] == 'assistant'][:2] == [
        ('post-1', {'scheduledRun': card}),
        (replayed[1]['id'], None),
    ]
    assert replayed[0]['content'] == 'Scheduled task "Rates brief": The 10y yield fell 5bp.'


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
        model=EchoChatModel(), backend=None, skills=[], memory=[], checkpointer=saver,
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
    monkeypatch.setattr(session_api, 'SESSION_READ_SECONDS', 0.05)
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
    monkeypatch.setattr(session_api, 'AGENTCORE_REGION', 'eu-west-1')
    monkeypatch.setattr(
        boto3,
        'client',
        lambda service, *, region_name: fake if (service, region_name) == ('bedrock-agentcore', 'eu-west-1') else None,
    )
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    return fake


def test_the_memory_page_shows_the_users_preferences_then_facts_and_no_one_elses(
    client: TestClient, memory: FakeAgentCoreMemory
) -> None:
    memory.records += [
        _record('mem-preference-000000000000000000000000000', 'Prefers tea', 'user-1', 'preferences'),
        _record('mem-summary-0000000000000000000000000000000', 'Discussed copper', 'user-1', 'summaries/session-1'),
        _record('mem-others-preference-00000000000000000000', 'Prefers coffee', OTHER_USER, 'preferences'),
    ]

    assert _memory(client) == (200, {'lines': [
        {'id': 'mem-preference-000000000000000000000000000', 'text': 'Prefers tea'},
        {'id': OWN_RECORD, 'text': 'Trades copper'},
    ]})


@pytest.mark.parametrize(
    'event',
    [
        {'operation': 'memory-edit', 'userId': 'user-1', 'recordId': OTHERS_RECORD, 'text': 'Trades silver'},
        {'operation': 'memory-delete', 'userId': 'user-1', 'recordId': OTHERS_RECORD},
    ],
)
def test_a_user_cannot_touch_a_record_outside_their_memory(
    client: TestClient, memory: FakeAgentCoreMemory, event: dict[str, str]
) -> None:
    response = client.post('/invocations', json=event)

    assert response.status_code == 404
    assert response.json() == {'error': f'Memory has no line {OTHERS_RECORD}', 'code': 'MEMORY_LINE_NOT_FOUND'}
    assert [record['content']['text'] for record in memory.records] == ['Trades copper', 'Trades gold']


@pytest.mark.parametrize(
    ('event', 'error'),
    [
        ({'operation': 'memory'}, 'userId is required'),
        ({'operation': 'memory-delete', 'userId': 'user-1'}, 'recordId is required'),
        ({'operation': 'memory-edit', 'userId': 'user-1', 'recordId': OWN_RECORD, 'text': ' '}, 'text is required'),
    ],
)
def test_malformed_memory_events_are_rejected(
    client: TestClient, memory: FakeAgentCoreMemory, event: dict[str, str], error: str
) -> None:
    response = client.post('/invocations', json=event)

    assert response.status_code == 400
    assert response.json() == {'error': error, 'code': 'INVALID_REQUEST'}
    assert [record['content']['text'] for record in memory.records] == ['Trades copper', 'Trades gold']


@pytest.mark.parametrize(
    ('failed', 'reason'),
    [
        ({'memoryRecordId': OWN_RECORD, 'status': 'FAILED', 'errorCode': 500, 'errorMessage': 'Throttled'}, 'Throttled'),
        # errorMessage is optional in AgentCore's response: the status still says why.
        ({'memoryRecordId': OWN_RECORD, 'status': 'FAILED'}, 'FAILED'),
    ],
)
def test_a_record_agentcore_fails_to_update_fails_the_edit(
    client: TestClient, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, failed: dict[str, Any], reason: str
) -> None:
    monkeypatch.setattr(
        memory, 'batch_update_memory_records', lambda **_params: {'successfulRecords': [], 'failedRecords': [failed]}
    )

    with pytest.raises(RuntimeError, match=f'^Updating memory record {OWN_RECORD} failed: {reason}$'):
        client.post(
            '/invocations', json={'operation': 'memory-edit', 'userId': 'user-1', 'recordId': OWN_RECORD, 'text': 'x'}
        )


@pytest.mark.parametrize('boundary', ['http', 'lambda'])
def test_editing_a_deleted_line_still_listed_by_agentcore_is_not_found_issue_3484(
    client: TestClient, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, boundary: str
) -> None:
    listed = client.post('/invocations', json={'operation': 'memory', 'userId': 'user-1'})
    assert listed.json() == {'lines': [{'id': OWN_RECORD, 'text': 'Trades copper'}]}
    monkeypatch.setattr(
        memory,
        'batch_update_memory_records',
        lambda **_params: {
            'successfulRecords': [],
            'failedRecords': [{
                'memoryRecordId': OWN_RECORD,
                'status': 'FAILED',
                'errorCode': 404,
                'errorMessage': 'Memory record not found',
            }],
        },
    )
    event = {'operation': 'memory-edit', 'userId': 'user-1', 'recordId': OWN_RECORD, 'text': 'Trades silver'}

    if boundary == 'lambda':
        result = session_api.lambda_handler(event, None)
    else:
        response = client.post('/invocations', json=event)
        result = {'statusCode': response.status_code, 'body': response.json()}

    assert result == {
        'statusCode': 404,
        'body': {'error': f'Memory has no line {OWN_RECORD}', 'code': 'MEMORY_LINE_NOT_FOUND'},
    }


def _memory(client: TestClient, operation: str = 'memory', **fields: str) -> Any:
    response = client.post('/invocations', json={'operation': operation, 'userId': 'user-1', **fields})
    return response.status_code, response.json()


def test_a_reload_shows_a_saved_edit_while_agentcore_lists_the_old_line_issue_3483(
    client: TestClient, memory: FakeAgentCoreMemory
) -> None:
    memory.lag_listing()

    _memory(client, 'memory-edit', recordId=OWN_RECORD, text='Trades silver')
    memory.list_events_calls = 0
    reloaded = _memory(client)

    assert reloaded == (200, {'lines': [{'id': OWN_RECORD, 'text': 'Trades silver'}]})
    assert memory.list_events_calls == 2


def test_a_reload_drops_a_deleted_line_while_agentcore_still_lists_it_issue_3483(
    client: TestClient, memory: FakeAgentCoreMemory
) -> None:
    memory.lag_listing()

    _memory(client, 'memory-delete', recordId=OWN_RECORD)

    assert _memory(client) == (200, {'lines': []})
    assert _memory(client, 'memory-edit', recordId=OWN_RECORD, text='Trades silver') == (
        404, {'error': f'Memory has no line {OWN_RECORD}', 'code': 'MEMORY_LINE_NOT_FOUND'}
    )


def test_a_reload_shows_the_latest_of_two_saved_edits_issue_3483(client: TestClient, memory: FakeAgentCoreMemory) -> None:
    memory.lag_listing()

    _memory(client, 'memory-edit', recordId=OWN_RECORD, text='Trades silver')
    _memory(client, 'memory-edit', recordId=OWN_RECORD, text='Trades platinum')

    assert _memory(client) == (200, {'lines': [{'id': OWN_RECORD, 'text': 'Trades platinum'}]})


def test_a_saved_edit_never_reaches_memory_extraction_issue_3483(client: TestClient, memory: FakeAgentCoreMemory) -> None:
    _memory(client, 'memory-edit', recordId=OWN_RECORD, text='Trades silver')
    _memory(client, 'memory-delete', recordId=OWN_RECORD)

    assert list(memory.extraction_modes.values()) == [['SKIP', 'SKIP']]


def test_five_minutes_after_a_save_the_listing_alone_says_what_memory_holds_issue_3483(
    client: TestClient, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    saved_at = datetime(2026, 10, 6, 11, 39, 59, tzinfo=UTC)
    monkeypatch.setattr(memory_document, 'utc_now', lambda: saved_at)
    _memory(client, 'memory-edit', recordId=OWN_RECORD, text='Trades silver')
    # Another writer, such as Memory extraction, rewrites the line after the save.
    [own] = [record for record in memory.records if record['memoryRecordId'] == OWN_RECORD]
    own['content'] = {'text': 'Trades platinum'}

    monkeypatch.setattr(memory_document, 'utc_now', lambda: saved_at + timedelta(minutes=5))
    within = _memory(client)
    monkeypatch.setattr(memory_document, 'utc_now', lambda: saved_at + timedelta(minutes=5, seconds=1))
    after = _memory(client)

    assert within == (200, {'lines': [{'id': OWN_RECORD, 'text': 'Trades silver'}]})
    assert after == (200, {'lines': [{'id': OWN_RECORD, 'text': 'Trades platinum'}]})


def test_memory_needs_agentcore_memory(client: TestClient) -> None:
    response = client.post('/invocations', json={'operation': 'memory', 'userId': 'user-1'})

    assert response.status_code == 503
    assert response.json() == {
        'error': 'Memory needs AgentCore Memory: set AGENTCORE_MEMORY_ID',
        'code': 'MEMORY_NOT_CONFIGURED',
    }


def test_an_edit_stamps_the_record_with_the_time_in_utc(
    client: TestClient, memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch
) -> None:
    updates: list[dict[str, Any]] = []
    monkeypatch.setattr(
        memory,
        'batch_update_memory_records',
        lambda **params: updates.append(params) or {'successfulRecords': [], 'failedRecords': []},
    )

    client.post('/invocations', json={'operation': 'memory-edit', 'userId': 'user-1', 'recordId': OWN_RECORD, 'text': 'x'})

    [[record]] = [update['records'] for update in updates]
    assert record['timestamp'].utcoffset() == timedelta(0)
