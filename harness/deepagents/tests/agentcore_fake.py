"""An in-memory bedrock-agentcore client that rejects any request AgentCore would reject,
and the STS exchange whose tagged credentials scope it as IAM does (ADR 0067 §8)."""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast

import boto3
import botocore.session
from botocore.exceptions import ClientError
from botocore.validate import validate_parameters

PAGE_SIZE = 100
MEMORY_ID = 'memory_1-0123456789'

_SERVICE_MODEL = botocore.session.get_session().get_service_model('bedrock-agentcore')
# The client's modeled errors, as `client.exceptions` exposes them.
EXCEPTIONS = boto3.client(
    'bedrock-agentcore', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test',
).exceptions


def validated(operation: str, params: dict[str, Any]) -> dict[str, Any]:
    """Reject a request AgentCore would reject: the service model's shape and bounds, and the memory."""
    input_shape: Any = _SERVICE_MODEL.operation_model(operation).input_shape
    validate_parameters(params, input_shape)
    for name, value in params.items():
        maximum = input_shape.members[name].metadata.get('max')
        assert maximum is None or not isinstance(value, int) or value <= maximum, (name, value)
    assert params['memoryId'] == MEMORY_ID, params['memoryId']
    return params


def _as_listed(item: dict[str, Any]) -> dict[str, Any]:
    """A payload item as ListEvents returns it: AgentCore renders a dict blob as a Java-style string."""
    blob = item.get('blob')
    if isinstance(blob, dict):
        return {'blob': '{' + ', '.join(f'{key}={value}' for key, value in blob.items()) + '}'}
    return item


class FakeAgentCoreMemory:
    """In-memory stand-in for the bedrock-agentcore client's event and memory record APIs."""

    exceptions = EXCEPTIONS

    def __init__(self) -> None:
        # Sessions AgentCore reports as missing: listing their events raises ResourceNotFoundException.
        self.missing_sessions: set[str] = set()
        self.events: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        self.records: list[dict[str, Any]] = []
        # What ListMemoryRecords serves while it lags writes, as AgentCore's does for about a minute.
        self.listing: list[dict[str, Any]] | None = None
        self.list_events_calls = 0
        # ListEvents calls by Session ID.
        self.listed: Counter[str] = Counter()
        self.create_event_calls = 0
        # Each event's CreateEvent extractionMode, by Session ID: ListEvents does not return it.
        self.extraction_modes: dict[str, list[str | None]] = defaultdict(list)
        self.deleted_at: list[float] = []
        self.clock = 0.0
        # Each CreateEvent clientToken's event: AgentCore creates a retried event once.
        self.created_by_token: dict[str, dict[str, Any]] = {}
        # Sessions ever written, by actor: ListSessions keeps listing them once emptied.
        self.sessions: dict[str, list[str]] = defaultdict(list)
        # Seconds each call under Turn credentials takes, as a round trip to AgentCore does.
        self.latency = 0.0
        # Memory clients the Harness built under Turn credentials.
        self.clients = 0
        # Each such call's operation and (start, end) on the perf_counter clock, STS's exchange among them.
        self.round_trips: list[tuple[str, float, float]] = []

    def round_trip(self, operation: str) -> None:
        if latency := self.latency:
            start = time.perf_counter()
            time.sleep(latency)
            self.round_trips.append((operation, start, time.perf_counter()))

    def lag_listing(self) -> None:
        """ListMemoryRecords keeps listing the records as they are now, until it catches up."""
        self.listing = copy.deepcopy(self.records)

    def seed(self, actor_id: str, session_id: str) -> None:
        events = self.events[(actor_id, session_id)]
        events.append({'eventId': str(len(events)), 'payload': []})
        if session_id not in self.sessions[actor_id]:
            self.sessions[actor_id].append(session_id)

    def create_event(self, **params: Any) -> dict[str, Any]:
        params = validated('CreateEvent', params)
        payload = [_as_listed(item) for item in params['payload']]
        if (len(payload) > 100 or len(json.dumps(params, default=str).encode('utf-8')) > 10_000_000
                or any(len(item.get('blob', '').encode('utf-8')) > 100_000 for item in payload)):
            raise EXCEPTIONS.ValidationException(
                {'Error': {'Code': 'ValidationException', 'Message': 'CreateEvent payload exceeds size or item quota'}}, 'CreateEvent')
        token = params.get('clientToken')
        if token in self.created_by_token:
            return {'event': self.created_by_token[token]}
        events = self.events[(params['actorId'], params['sessionId'])]
        event = {
            'eventId': f'created-{self.create_event_calls}',
            'eventTimestamp': params['eventTimestamp'],
            'payload': payload,
            **({'metadata': params['metadata']} if 'metadata' in params else {}),
        }
        self.create_event_calls += 1
        self.extraction_modes[params['sessionId']].append(params.get('extractionMode'))
        if params['sessionId'] not in self.sessions[params['actorId']]:
            self.sessions[params['actorId']].append(params['sessionId'])
        if token is not None:
            self.created_by_token[token] = event
        events.append(event)
        return {'event': event}

    def get_event(self, **params: Any) -> dict[str, Any]:
        params = validated('GetEvent', params)
        for event in self.events.get((params['actorId'], params['sessionId']), []):
            if event['eventId'] == params['eventId']:
                return {'event': event}
        raise EXCEPTIONS.ResourceNotFoundException(
            {'Error': {'Code': 'ResourceNotFoundException', 'Message': 'Event not found'}}, 'GetEvent')

    def list_sessions(self, **params: Any) -> dict[str, Any]:
        params = validated('ListSessions', params)
        sessions = self.sessions.get(params['actorId'], [])
        start = int(params.get('nextToken', 0))
        end = start + params.get('maxResults', PAGE_SIZE)
        response: dict[str, Any] = {'sessionSummaries': [
            {'sessionId': session, 'actorId': params['actorId'], 'createdAt': datetime.fromtimestamp(self.clock, UTC)} for session in sessions[start:end]
        ]}
        if end < len(sessions):
            response['nextToken'] = str(end)
        return response

    def list_events(self, **params: Any) -> dict[str, Any]:
        params = validated('ListEvents', params)
        self.list_events_calls += 1
        self.listed[params['sessionId']] += 1
        if params['sessionId'] in self.missing_sessions:
            raise EXCEPTIONS.ResourceNotFoundException(
                {'Error': {'Code': 'ResourceNotFoundException', 'Message': 'Session not found'}}, 'ListEvents')
        newest_first = list(reversed(self.events[(params['actorId'], params['sessionId'])]))
        conditions = params.get('filter', {}).get('eventMetadata', [])
        assert all(condition['operator'] == 'EQUALS_TO' for condition in conditions), conditions
        newest_first = [
            event for event in newest_first
            if all(event.get('metadata', {}).get(condition['left']['metadataKey']) == condition['right']['metadataValue']
                   for condition in conditions)
        ]
        if not params.get('includePayloads', True):
            newest_first = [{**event, 'payload': []} for event in newest_first]
        start = int(params.get('nextToken', 0))
        end = start + params.get('maxResults', PAGE_SIZE)
        response: dict[str, Any] = {'events': newest_first[start:end]}
        if end < len(newest_first):
            response['nextToken'] = str(end)
        return response

    def delete_event(self, **params: Any) -> dict[str, Any]:
        params = validated('DeleteEvent', params)
        events = self.events[(params['actorId'], params['sessionId'])]
        events[:] = [event for event in events if event['eventId'] != params['eventId']]
        self.deleted_at.append(self.clock)
        return {}

    def _record(self, record_id: str, operation: str) -> dict[str, Any]:
        for record in self.records:
            if record['memoryRecordId'] == record_id:
                return record
        raise EXCEPTIONS.ResourceNotFoundException(
            {'Error': {'Code': 'ResourceNotFoundException', 'Message': 'Memory record not found'}}, operation)

    def batch_update_memory_records(self, **params: Any) -> dict[str, Any]:
        params = validated('BatchUpdateMemoryRecords', params)
        for update in params['records']:
            self._record(update['memoryRecordId'], 'BatchUpdateMemoryRecords')['content'] = update['content']
        successful = [{'memoryRecordId': update['memoryRecordId'], 'status': 'SUCCEEDED'} for update in params['records']]
        return {'successfulRecords': successful, 'failedRecords': []}

    def delete_memory_record(self, **params: Any) -> dict[str, Any]:
        params = validated('DeleteMemoryRecord', params)
        self.records.remove(self._record(params['memoryRecordId'], 'DeleteMemoryRecord'))
        return {'memoryRecordId': params['memoryRecordId']}

    def get_paginator(self, operation: str) -> Any:
        assert operation == 'list_memory_records', operation

        def paginate(*, PaginationConfig: dict[str, int], **params: Any) -> list[dict[str, Any]]:
            validated('ListMemoryRecords', {**params, 'maxResults': PaginationConfig['PageSize']})
            return [{'memoryRecordSummaries': self._under(params['namespace'])}]

        return SimpleNamespace(paginate=paginate)

    def _under(self, prefix: str) -> list[dict[str, Any]]:
        """The listed records with a namespace starting with this prefix, as the `namespace` parameter matches."""
        records = self.records if self.listing is None else self.listing
        return [record for record in records if any(ns.startswith(prefix) for ns in record['namespaces'])]

    def list_memory_records(self, **params: Any) -> dict[str, Any]:
        params = validated('ListMemoryRecords', params)
        listed = self._under(params['namespace'])
        start = int(params.get('nextToken', 0))
        end = start + params.get('maxResults', PAGE_SIZE)
        response: dict[str, Any] = {'memoryRecordSummaries': listed[start:end]}
        if end < len(listed):
            response['nextToken'] = str(end)
        return response

    def retrieve_memory_records(self, **params: Any) -> dict[str, Any]:
        """Records under the namespace prefix whose text holds the query, standing in for semantic search."""
        params = validated('RetrieveMemoryRecords', params)
        query = params['searchCriteria']['searchQuery'].lower()
        found = [record for record in self._under(params['namespace']) if query in record['content']['text'].lower()]
        return {'memoryRecordSummaries': found[:params.get('maxResults', PAGE_SIZE)]}

    def get_memory_record(self, **params: Any) -> dict[str, Any]:
        params = validated('GetMemoryRecord', params)
        return {'memoryRecord': copy.deepcopy(self._record(params['memoryRecordId'], 'GetMemoryRecord'))}


USER_MEMORY_ROLE_ARN = 'arn:aws:iam::123456789012:role/user-memory'
_TAGS_CLAIM = 'https://aws.amazon.com/tags'
# HS256 stands in for the Chat Service's ES256: the fake STS checks the signature as STS checks it against the JWKS.
_SIGNING_KEY = b'turn-identity-test-key'
_STS_MODEL = botocore.session.get_session().get_service_model('sts')


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def turn_identity(actor: str = 'user-1', filing: str | None = None, session: str = 'thread-1', *,
                  expires_in: int = 3600, key: bytes = _SIGNING_KEY) -> str:
    """A Turn's JWT as the Chat Service signs it: tagged with the actor, the filing actor, the Session and its writes prefix."""
    tags = {'actorId': [actor], 'filingActorId': [filing or actor], 'sessionId': [session],
            'writesPrefix': ['lgw-' + hashlib.sha256(session.encode()).hexdigest()[:32]]}
    header = _b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    claims = _b64(json.dumps({'sub': actor, 'aud': 'sts.amazonaws.com', 'exp': int(time.time()) + expires_in,
                              _TAGS_CLAIM: {'principal_tags': tags}}).encode())
    signature = _b64(hmac.digest(key, f'{header}.{claims}'.encode(), 'sha256'))
    return f'{header}.{claims}.{signature}'


def _sts_error(code: str, message: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'AssumeRoleWithWebIdentity')


class FakeSts:
    """STS AssumeRoleWithWebIdentity: checks the JWT and issues credentials carrying its session tags."""

    def __init__(self, memory: FakeAgentCoreMemory | None = None) -> None:
        # Whose latency each exchange takes, as a round trip to STS does.
        self.memory = memory
        self.calls: list[dict[str, Any]] = []
        self.regions: list[str | None] = []
        # Each issued access key's session tags.
        self.issued: dict[str, dict[str, str]] = {}
        # The Memory calls made with issued credentials.
        self.memory_calls: list[tuple[str, dict[str, Any]]] = []

    def assume_role_with_web_identity(self, **params: Any) -> dict[str, Any]:
        shape = _STS_MODEL.operation_model('AssumeRoleWithWebIdentity').input_shape
        assert shape is not None
        validate_parameters(params, shape)
        self.calls.append(params)
        if self.memory is not None:
            self.memory.round_trip('assume_role_with_web_identity')
        assert params['RoleArn'] == USER_MEMORY_ROLE_ARN, params['RoleArn']
        header, claims, signature = [*params['WebIdentityToken'].split('.'), '', '', ''][:3]
        expected = _b64(hmac.digest(_SIGNING_KEY, f'{header}.{claims}'.encode(), 'sha256'))
        if not hmac.compare_digest(signature, expected):
            raise _sts_error('InvalidIdentityToken', 'Incorrect token audience or signature')
        decoded = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))
        if decoded['exp'] <= time.time():
            raise _sts_error('ExpiredTokenException', 'Token expired')
        key = f'ASIA{len(self.issued):012d}'
        self.issued[key] = {name: value for name, [value] in decoded[_TAGS_CLAIM]['principal_tags'].items()}
        return {'Credentials': {'AccessKeyId': key, 'SecretAccessKey': 'secret', 'SessionToken': 'session-token',
                                'Expiration': datetime.fromtimestamp(decoded['exp'], UTC)}}


def _denied(operation: str, params: dict[str, Any]) -> ClientError:
    scope = {key: params[key] for key in ('actorId', 'sessionId', 'namespace') if key in params}
    return EXCEPTIONS.AccessDeniedException(
        {'Error': {'Code': 'AccessDeniedException', 'Message': f'Not authorized to perform {operation} on {scope}'}},
        # botocore names the operation as its service model does.
        ''.join(part.title() for part in operation.split('_')))


_EVENT_OPERATIONS = ('create_event', 'get_event', 'list_events', 'delete_event')
_RECORD_LISTINGS = ('list_memory_records', 'retrieve_memory_records')
# Neither takes a namespace condition key, so the role allows them unconditioned (ADR 0031).
_RECORDS_BY_ID = ('get_memory_record', 'delete_memory_record')


class TaggedMemoryClient:
    """bedrock-agentcore under credentials whose tags the Memory role's policy evaluates, as IAM does (ADR 0067 §8).

    Each call is evaluated under the credentials it is signed with now, and each allowed call is
    recorded in `calls`, as (operation, params).
    """

    exceptions = EXCEPTIONS

    def __init__(self, memory: FakeAgentCoreMemory, tags: Callable[[], dict[str, str]],
                 calls: list[tuple[str, dict[str, Any]]]) -> None:
        self.memory = memory
        self._tags = tags
        self.calls = calls

    @property
    def tags(self) -> dict[str, str]:
        return self._tags()

    def _allowed(self, operation: str, params: dict[str, Any]) -> bool:
        tags = self.tags
        if operation in _EVENT_OPERATIONS:
            session = params.get('sessionId', '')
            own_session = session == tags['sessionId'] or session.startswith(f"{tags['writesPrefix']}-")
            return params.get('actorId') == tags['actorId'] or (params.get('actorId') == tags['filingActorId'] and own_session)
        if operation in _RECORD_LISTINGS:
            return str(params.get('namespace', '')).startswith(f"/actors/{tags['actorId']}/")
        return operation in _RECORDS_BY_ID

    def __getattr__(self, operation: str) -> Any:
        call = getattr(self.memory, operation)

        def scoped(**params: Any) -> Any:
            if not self._allowed(operation, params):
                raise _denied(operation, params)
            self.calls.append((operation, params))
            self.memory.round_trip(operation)
            return call(**params)

        return scoped

    def get_paginator(self, operation: str) -> Any:
        paginator = self.memory.get_paginator(operation)

        def paginate(**params: Any) -> Any:
            if not self._allowed(operation, params):
                raise _denied(operation, params)
            self.calls.append((operation, params))
            self.memory.round_trip(operation)
            return paginator.paginate(**params)

        return SimpleNamespace(paginate=paginate)


def install_tagged_memory(monkeypatch: Any, memory: FakeAgentCoreMemory) -> FakeSts:
    """Serve STS and AgentCore Memory from `boto3.client`.

    The Harness's Memory client takes the scope of the Turn credentials it signs each call with and
    records its calls in `sts.memory_calls`; `boto3.client` serves the session API under its own role.
    """
    from botcube_harness_deepagents.memory import agentcore

    sts = FakeSts(memory)
    real_client = boto3.client

    def client(service_name: str, **options: Any) -> Any:
        if service_name == 'sts':
            sts.regions.append(options.get('region_name'))
            return sts
        if service_name == 'bedrock-agentcore':
            return memory
        return cast(Any, real_client)(service_name, **options)

    def signed(credentials: Any, like: Any) -> TaggedMemoryClient:
        memory.clients += 1
        return TaggedMemoryClient(memory, lambda: sts.issued[credentials.get_frozen_credentials().access_key], sts.memory_calls)

    monkeypatch.setattr(boto3, 'client', client)
    # A new process: its Memory client is built on its first Turn.
    monkeypatch.setattr(agentcore, '_MEMORY', None)
    monkeypatch.setattr(agentcore, '_memory_client', signed)
    monkeypatch.setattr(agentcore, 'USER_MEMORY_ROLE_ARN', USER_MEMORY_ROLE_ARN)
    return sts


def another_microvm() -> None:
    """Another Session sandbox's microVM: AgentCore runs each in its own, whose first Turn builds its Memory client."""
    from botcube_harness_deepagents.memory import agentcore

    agentcore._MEMORY = None


def fresh_warm_sessions(monkeypatch: Any) -> None:
    """A new process's warm Sessions: none held."""
    from botcube_harness_deepagents.memory.agentcore import warm_session

    monkeypatch.setattr(warm_session, '_SESSIONS', warm_session._WarmSessions(warm_session.WARM_SESSIONS))
