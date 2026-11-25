"""The AgentCore memory backend's factory slots, against the bedrock-agentcore API."""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.awsrequest import AWSResponse, HTTPHeaders
from botocore.credentials import Credentials
from botocore.exceptions import ConnectionClosedError
from langchain_core.messages import HumanMessage
from langgraph_checkpoint_aws.checkpoint.agentcore.snapshot import (
    _writes_session_prefix,
)

from agentcore_fake import (
    USER_MEMORY_ROLE_ARN,
    FakeAgentCoreMemory,
    FakeSts,
    turn_identity,
)
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.session_memory import SessionMemoryMiddleware
from botcube_harness_deepagents.turn_memory import (
    TurnFeedError,
    TurnMemoryMiddleware,
    feed_turn,
)

MEMORY_ID = 'memory_1-0123456789'


@pytest.fixture(autouse=True)
def aws_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    agentcore.sts_client.cache_clear()
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-west-2')
    monkeypatch.setenv('AWS_ENDPOINT_URL_BEDROCK_AGENTCORE', 'http://127.0.0.1:1')


def test_the_checkpointers_writes_prefix_is_the_one_the_chat_service_signs() -> None:
    # The Session ID and prefix of botcube/chat's turn-identity.test.ts: the Memory role allows `${writesPrefix}-*`.
    assert _writes_session_prefix('3f2b8c1e-5d4a-4f6b-9c2d-1a2b3c4d5e6f') == 'lgw-3d005e2ccf2461767eb01d780463736c-'


def test_the_checkpointer_reads_the_configured_memory_in_the_configured_region() -> None:
    events = agentcore.build_checkpointer(MEMORY_ID, region_name='eu-west-1').checkpoint_event_client

    assert (events.memory_id, events.client.meta.region_name) == (MEMORY_ID, 'eu-west-1')


def test_the_store_reads_the_configured_memory_in_the_configured_region() -> None:
    store = agentcore.build_store(MEMORY_ID, region_name='eu-west-1')

    assert (store.memory_id, store.client.meta.region_name) == (MEMORY_ID, 'eu-west-1')


def test_the_actor_gets_one_memory_tool_its_turns_recorded_and_memory_loaded_once() -> None:
    tools, middleware = agentcore.build_memory_tools(actor_id='jane.doe_ny', thread_id='thread-1')

    assert [tool.name for tool in tools] == ['memory']
    turns, session = middleware
    assert isinstance(turns, TurnMemoryMiddleware)
    assert (turns.actor_id, turns.session_id) == ('jane.doe_ny', 'thread-1')
    assert isinstance(session, SessionMemoryMiddleware)



@pytest.fixture
def microvm(monkeypatch: pytest.MonkeyPatch) -> FakeSts:
    """A new microVM, whose STS exchange answers from the fake."""
    sts = FakeSts()
    real_client = boto3.client
    monkeypatch.setattr(boto3, 'client', lambda service_name, **options: sts if service_name == 'sts' else real_client(service_name, **options))
    monkeypatch.setattr(agentcore, '_MEMORY', None)
    monkeypatch.setattr(agentcore, '_SPARE', None)
    monkeypatch.setattr(agentcore, 'USER_MEMORY_ROLE_ARN', USER_MEMORY_ROLE_ARN)
    return sts


def _signed_keys(store: Any) -> list[str]:
    """The access keys the store's Memory client signs each later request with."""
    signed: list[str] = []

    def answer(request: Any, **_: Any) -> Any:
        signed.append(request.headers['Authorization'].decode().split('Credential=')[1].split('/')[0])
        return AWSResponse(request.url, 200, HTTPHeaders(), _Body(b'{"memoryRecordSummaries": []}'))

    store.client.meta.events.register('before-send.bedrock-agentcore', answer)
    return signed


def test_a_continuing_turn_reuses_the_sessions_credentials_and_calls_no_sts(microvm: FakeSts) -> None:
    clients, signed = [], None
    for run in ('run-1', 'run-2', 'run-3'):
        # The Chat Service signs a new JWT for each Turn, with the same tags.
        saver, store = agentcore.turn_memory(MEMORY_ID, turn_identity(), region_name='us-west-2', run_id=run, turn=agentcore.next_turn())
        signed = signed if signed is not None else _signed_keys(store)
        store.client.list_memory_records(memoryId=MEMORY_ID, namespace='/actor/user-1/facts')
        clients.append((saver.checkpoint_event_client.client._client, store.client))

    assert len(microvm.calls) == 1
    assert signed == list(microvm.issued) * 3
    assert all(client is clients[0][1] for pair in clients for client in pair)


def _assumed(actor: str, key: str, *, session: str = 'thread-1') -> dict[str, str]:
    """Credentials the Chat Service assumed for a Turn with a session policy (the `assume-role` adapter)."""
    return {
        'actorId': actor, 'filingActorId': actor, 'sessionId': session, 'writesPrefix': 'lgw-0123456789abcdef0123456789abcdef',
        'turnId': f'turn-{key}', 'accessKeyId': key, 'secretAccessKey': 'secret', 'sessionToken': f'token-{key}',
        'expiration': (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    }


def test_assumed_turn_credentials_sign_memory_calls_without_sts(microvm: FakeSts) -> None:
    _saver, store = agentcore.turn_memory(MEMORY_ID, _assumed('user-1', 'ASIAUSER1'), region_name='us-west-2', run_id='run-1', turn=agentcore.next_turn())
    signed = _signed_keys(store)
    store.client.list_memory_records(memoryId=MEMORY_ID, namespace='/actors/user-1/facts/')

    assert microvm.calls == []
    assert signed == ['ASIAUSER1']
    assert agentcore.finished_snapshot_epoch(_assumed('user-1', 'ASIAUSER1'), agentcore.SnapshotEpoch(epoch='e-1', turn_id='turn-ASIAUSER1')) == 'e-1'
    with pytest.raises(agentcore.MemorySandboxError):
        agentcore.turn_memory(MEMORY_ID, _assumed('user-2', 'ASIAUSER2'), region_name='us-west-2', run_id='run-2', turn=agentcore.next_turn())


def test_turn_credentials_missing_a_field_are_refused() -> None:
    incomplete = {key: value for key, value in _assumed('user-1', 'ASIAUSER1').items() if key != 'sessionToken'}

    with pytest.raises(agentcore.TurnIdentityError, match='The Turn credentials lack sessionToken'):
        agentcore.require_turn_identity(incomplete)


def test_a_turn_exchanges_its_jwt_when_the_held_credentials_expire_within_five_minutes(microvm: FakeSts) -> None:
    # The fake issues credentials that expire with the JWT.
    agentcore.turn_memory(MEMORY_ID, turn_identity(expires_in=299), region_name='us-west-2', run_id='run-1', turn=agentcore.next_turn())
    _, store = agentcore.turn_memory(MEMORY_ID, turn_identity(), region_name='us-west-2', run_id='run-2', turn=agentcore.next_turn())
    signed = _signed_keys(store)
    store.client.list_memory_records(memoryId=MEMORY_ID, namespace='/actor/user-1/facts')
    agentcore.turn_memory(MEMORY_ID, turn_identity(), region_name='us-west-2', run_id='run-3', turn=agentcore.next_turn())

    assert len(microvm.calls) == 2
    assert signed == [list(microvm.issued)[1]]


def test_account_claim_keeps_the_microvms_memory_client_for_the_new_actor(microvm: FakeSts) -> None:
    _, before = agentcore.turn_memory(MEMORY_ID, turn_identity('guest-1'), region_name='us-west-2', run_id='run-1', turn=agentcore.next_turn())
    _, after = agentcore.turn_memory(MEMORY_ID, turn_identity('user-1', filing='guest-1'), region_name='us-west-2', run_id='run-2', turn=agentcore.next_turn())
    signed = _signed_keys(after)
    after.client.list_memory_records(memoryId=MEMORY_ID, namespace='/actors/user-1/facts/')

    assert after.client is before.client
    # The new actor's tags differ, so its JWT is exchanged and the client signs with its credentials.
    assert [microvm.issued[key]['actorId'] for key in signed] == ['user-1']


def test_a_turn_whose_sts_exchange_finishes_last_keeps_the_newer_turns_credentials(microvm: FakeSts, monkeypatch: pytest.MonkeyPatch) -> None:
    exchanging, exchanged = threading.Event(), threading.Event()
    issue = microvm.assume_role_with_web_identity

    def exchange(**params: Any) -> dict[str, Any]:
        if threading.current_thread().name == 'guest-turn':
            exchanging.set()
            exchanged.wait(5)
        return issue(**params)

    monkeypatch.setattr(microvm, 'assume_role_with_web_identity', exchange)
    guest = threading.Thread(
        target=agentcore.turn_memory, args=(MEMORY_ID, turn_identity('guest-1')),
        kwargs={'region_name': 'us-west-2', 'run_id': 'run-1', 'turn': agentcore.next_turn()}, name='guest-turn')
    guest.start()
    assert exchanging.wait(5)
    # The Account Claim Turn arrives next, and its STS exchange finishes first.
    _, store = agentcore.turn_memory(MEMORY_ID, turn_identity('user-1', filing='guest-1'), region_name='us-west-2', run_id='run-2', turn=agentcore.next_turn())
    exchanged.set()
    guest.join(5)
    signed = _signed_keys(store)
    store.client.list_memory_records(memoryId=MEMORY_ID, namespace='/actors/user-1/facts/')

    assert [microvm.issued[key]['actorId'] for key in signed] == ['user-1']


def test_an_older_turns_exchange_finishing_last_keeps_the_credentials_a_newer_turn_reused(microvm: FakeSts, monkeypatch: pytest.MonkeyPatch) -> None:
    exchanging, exchanged = threading.Event(), threading.Event()
    issue = microvm.assume_role_with_web_identity

    def exchange(**params: Any) -> dict[str, Any]:
        if threading.current_thread().name == 'claim-turn':
            exchanging.set()
            exchanged.wait(5)
        return issue(**params)

    agentcore.turn_memory(MEMORY_ID, turn_identity('guest-1'), region_name='us-west-2', run_id='run-1', turn=agentcore.next_turn())
    monkeypatch.setattr(microvm, 'assume_role_with_web_identity', exchange)
    claim = threading.Thread(
        target=agentcore.turn_memory, args=(MEMORY_ID, turn_identity('user-1', filing='guest-1')),
        kwargs={'region_name': 'us-west-2', 'run_id': 'run-2', 'turn': agentcore.next_turn()}, name='claim-turn')
    claim.start()
    assert exchanging.wait(5)
    # A newer guest Turn reuses the held credentials while the older Turn's exchange is still running.
    _, store = agentcore.turn_memory(MEMORY_ID, turn_identity('guest-1'), region_name='us-west-2', run_id='run-3', turn=agentcore.next_turn())
    exchanged.set()
    claim.join(5)
    signed = _signed_keys(store)
    store.client.list_memory_records(memoryId=MEMORY_ID, namespace='/actors/guest-1/facts/')

    assert [microvm.issued[key]['actorId'] for key in signed] == ['guest-1']


@pytest.mark.parametrize('identity', [turn_identity(session='thread-2'), turn_identity('user-2')], ids=['other-session', 'other-actor'])
def test_a_turn_for_another_session_sandbox_fails_on_the_microvm(microvm: FakeSts, identity: str) -> None:
    agentcore.turn_memory(MEMORY_ID, turn_identity(), region_name='us-west-2', run_id='run-1', turn=agentcore.next_turn())

    with pytest.raises(agentcore.MemorySandboxError) as failure:
        agentcore.turn_memory(MEMORY_ID, identity, region_name='us-west-2', run_id='run-2', turn=agentcore.next_turn())

    assert failure.value.code == 'MEMORY_SANDBOX_MISMATCH'


# A restored V2 microVM built its Memory client 1.4-1.7 s slower than V1, so the snapshot holds one, bound to no
# Session until the first Turn names its sandbox.
def test_the_first_turn_binds_the_snapshots_spare_memory_client_and_signs_with_its_own_credentials(
    microvm: FakeSts, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agentcore.prime_spare(MEMORY_ID, 'us-west-2')
    spare = agentcore._SPARE
    assert spare is not None
    monkeypatch.setattr(agentcore, 'build_store', lambda *_, **__: pytest.fail('the first Turn must use the spare'))

    _, store = agentcore.turn_memory(MEMORY_ID, turn_identity(), region_name='us-west-2', run_id='run-1', turn=agentcore.next_turn())
    signed = _signed_keys(store)
    store.client.list_memory_records(memoryId=MEMORY_ID, namespace='/actor/user-1/facts')

    assert store is spare[0]
    assert signed == list(microvm.issued)
    assert agentcore._SPARE is None


@pytest.mark.parametrize('identity', [turn_identity(session='thread-2'), turn_identity('user-2')], ids=['other-session', 'other-actor'])
def test_a_turn_for_another_session_sandbox_fails_on_a_microvm_that_bound_its_spare(microvm: FakeSts, identity: str) -> None:
    agentcore.prime_spare(MEMORY_ID, 'us-west-2')
    agentcore.turn_memory(MEMORY_ID, turn_identity(), region_name='us-west-2', run_id='run-1', turn=agentcore.next_turn())

    with pytest.raises(agentcore.MemorySandboxError) as failure:
        agentcore.turn_memory(MEMORY_ID, identity, region_name='us-west-2', run_id='run-2', turn=agentcore.next_turn())

    assert failure.value.code == 'MEMORY_SANDBOX_MISMATCH'


def test_a_spare_signs_for_no_sandbox_until_bound_and_binds_once(microvm: FakeSts) -> None:
    agentcore.prime_spare(MEMORY_ID, 'us-west-2')
    spare = agentcore._SPARE
    assert spare is not None
    signing = spare[1]
    issued = Credentials('A', 'S', 'T'), datetime.now(UTC) + timedelta(hours=1)
    tags = {'filingActorId': ['user-1'], 'sessionId': ['session-1']}

    with pytest.raises(agentcore.MemorySandboxError):
        signing.take(tags, issued, 1)
    signing.bind(tags, issued, 1)
    with pytest.raises(agentcore.MemorySandboxError):
        signing.bind(tags, issued, 2)


class _Body:
    def __init__(self, content: bytes) -> None:
        self._content = content

    def stream(self) -> Iterator[bytes]:
        yield self._content


@pytest.mark.parametrize('exhausted', [False, True])
def test_turn_feed_retries_throttled_create_event_with_the_same_token(
    microvm: FakeSts, exhausted: bool,
) -> None:
    _, store = agentcore.turn_memory(
        MEMORY_ID, turn_identity(), region_name='us-west-2', run_id='run-feed', turn=agentcore.next_turn(),
    )
    requests: list[dict[str, Any]] = []
    memory = FakeAgentCoreMemory()

    def answer(request: Any, **_: Any) -> Any:
        requests.append(json.loads(request.body))
        if exhausted or len(requests) <= 2:
            headers = HTTPHeaders()
            headers['x-amzn-errortype'] = 'ThrottlingException'
            return AWSResponse(request.url, 429, headers, _Body(b'{"message": "Busy"}'))
        body = json.dumps(memory.create_event(memoryId=MEMORY_ID, **requests[-1])).encode()
        return AWSResponse(request.url, 200, HTTPHeaders(), _Body(body))

    store.client.meta.events.register('before-send.bedrock-agentcore.CreateEvent', answer)
    feed = feed_turn(store, ('user-1', 'thread-1'), [HumanMessage(content='hello')])
    if exhausted:
        with pytest.raises(TurnFeedError, match='ThrottlingException'):
            asyncio.run(feed)
    else:
        asyncio.run(feed)

    assert len(requests) >= 3
    assert all(request == requests[0] for request in requests)
    assert memory.create_event_calls == (0 if exhausted else 1)
    assert requests[0]['clientToken']
    assert requests[0]['payload'] == [{'conversational': {'content': {'text': 'hello'}, 'role': 'USER'}}]


def test_opening_memory_recovers_from_a_dropped_idle_connection(microvm: FakeSts) -> None:
    _, store = agentcore.turn_memory(
        MEMORY_ID, turn_identity(), region_name='us-west-2', run_id='run-opening', turn=agentcore.next_turn(),
    )
    memory = FakeAgentCoreMemory()
    reconnect = False
    drops = 0

    def answer(request: Any, **_: Any) -> Any:
        nonlocal drops
        params = json.loads(request.body)
        if reconnect and params['namespace'].endswith('/facts/') and drops < 2:
            drops += 1
            raise ConnectionClosedError(endpoint_url=request.url)
        page = memory.list_memory_records(memoryId=MEMORY_ID, **params)
        return AWSResponse(request.url, 200, HTTPHeaders(), _Body(json.dumps(page).encode()))

    def empty_events(request: Any, **_: Any) -> Any:
        return AWSResponse(request.url, 200, HTTPHeaders(), _Body(b'{"events": []}'))

    store.client.meta.events.register('before-send.bedrock-agentcore.ListEvents', empty_events)
    store.client.meta.events.register('before-send.bedrock-agentcore.ListMemoryRecords', answer)
    assert agentcore.opening(store, 'user-1') == ''
    reconnect = True
    assert agentcore.opening(store, 'user-1') == ''
    assert drops == 2
