"""An in-memory bedrock-agentcore client that rejects any request AgentCore would reject."""

from __future__ import annotations

import copy
import json
from collections import Counter, defaultdict
from types import SimpleNamespace
from typing import Any

import boto3
import botocore.session
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
        self.startup_snapshot_calls = 0
        # Each event's CreateEvent extractionMode, by Session ID: ListEvents does not return it.
        self.extraction_modes: dict[str, list[str | None]] = defaultdict(list)
        self.deleted_at: list[float] = []
        self.clock = 0.0

    def lag_listing(self) -> None:
        """ListMemoryRecords keeps listing the records as they are now, until it catches up."""
        self.listing = copy.deepcopy(self.records)

    def seed(self, actor_id: str, session_id: str) -> None:
        events = self.events[(actor_id, session_id)]
        events.append({'eventId': str(len(events)), 'payload': []})

    def create_event(self, **params: Any) -> dict[str, Any]:
        params = validated('CreateEvent', params)
        payload = [_as_listed(item) for item in params['payload']]
        if (len(payload) > 100 or len(json.dumps(params, default=str).encode('utf-8')) > 10_000_000
                or any(len(item.get('blob', '').encode('utf-8')) > 100_000 for item in payload)):
            raise EXCEPTIONS.ValidationException(
                {'Error': {'Code': 'ValidationException', 'Message': 'CreateEvent payload exceeds size or item quota'}}, 'CreateEvent')
        events = self.events[(params['actorId'], params['sessionId'])]
        event = {
            'eventId': f'created-{self.create_event_calls}',
            'eventTimestamp': params['eventTimestamp'],
            'payload': payload,
            **({'metadata': params['metadata']} if 'metadata' in params else {}),
        }
        self.create_event_calls += 1
        self.extraction_modes[params['sessionId']].append(params.get('extractionMode'))
        events.append(event)
        return {'event': event}

    def list_events(self, **params: Any) -> dict[str, Any]:
        params = validated('ListEvents', params)
        self.list_events_calls += 1
        self.listed[params['sessionId']] += 1
        if params['sessionId'] in self.missing_sessions:
            raise EXCEPTIONS.ResourceNotFoundException(
                {'Error': {'Code': 'ResourceNotFoundException', 'Message': 'Session not found'}}, 'ListEvents')
        newest_first = list(reversed(self.events[(params['actorId'], params['sessionId'])]))
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

    def startup_snapshot(self, *, memoryId: str, actorId: str, sessionIds: list[str]) -> dict[str, Any]:
        self.startup_snapshot_calls += 1
        assert memoryId == MEMORY_ID
        records = self.records if self.listing is None else self.listing
        summaries = [record for record in records if all(f'/actors/{actorId}/' in ns for ns in record['namespaces'])]
        events = {session: self._snapshot_events(memoryId, actorId, session) for session in sessionIds}
        return {'memoryRecordSummaries': summaries, 'eventsBySession': events}

    def _snapshot_events(self, memory_id: str, actor_id: str, session: str) -> list[Any]:
        assert session.startswith(('pending-memory-', 'memory-saves-'))
        events: list[Any] = []
        params: dict[str, Any] = {'memoryId': memory_id, 'actorId': actor_id, 'sessionId': session,
                                  'includePayloads': True, 'maxResults': 100}
        while True:
            try:
                page = self.list_events(**params)
            except self.exceptions.ResourceNotFoundException:
                if session.startswith('pending-memory-'):
                    break
                raise
            events.extend(page['events'])
            if 'nextToken' not in page:
                break
            params['nextToken'] = page['nextToken']
        return events

    def get_paginator(self, operation: str) -> Any:
        assert operation == 'list_memory_records', operation

        def paginate(*, PaginationConfig: dict[str, int], **params: Any) -> list[dict[str, Any]]:
            validated('ListMemoryRecords', {**params, 'maxResults': PaginationConfig['PageSize']})
            path = params['namespacePath']
            records = self.records if self.listing is None else self.listing
            listed = [record for record in records if any(ns.startswith(path) for ns in record['namespaces'])]
            return [{'memoryRecordSummaries': listed}]

        return SimpleNamespace(paginate=paginate)


def memory_capability_props(actor: str = 'user-1', filing: str = 'user-1') -> dict[str, str]:
    return {'url': 'https://chat.test/internal/turn-memory',
            'token': json.dumps({'actor': actor, 'filing': filing})}


def _broker_response(memory: FakeAgentCoreMemory, operation: str, params: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
    actor = identity['actor']
    if operation == 'actor_namespaces':
        assert params['actorId'] == actor
        strategies = {record['memoryStrategyId'] for record in memory.records}
        return {'namespaces': [f'/strategies/{strategy}/actors/{actor}/' for strategy in sorted(strategies)]}
    if operation == 'list_memory_records':
        assert f'/actors/{actor}/' in params['namespacePath']
        [response] = memory.get_paginator(operation).paginate(PaginationConfig={'PageSize': 100}, **params)
        return response
    if operation == 'startup_snapshot':
        assert params['actorId'] == actor
        return memory.startup_snapshot(**params)
    if 'actorId' in params:
        assert params['actorId'] in {actor, identity['filing']}
    return getattr(memory, operation)(**params)


def install_memory_broker_http(monkeypatch: Any, memory: FakeAgentCoreMemory) -> None:
    import httpx
    from botocore.exceptions import ClientError

    from botcube_harness_deepagents.memory_broker import _timestamps

    def post(wire_request: httpx.Request) -> httpx.Response:
        assert str(wire_request.url) == 'https://chat.test/internal/turn-memory'
        identity = json.loads(wire_request.headers['Authorization'].removeprefix('Bearer '))
        request = json.loads(wire_request.content)
        params = _timestamps(request['params'])
        operation = request['operation']
        try:
            response = _broker_response(memory, operation, params, identity)
        except ClientError as error:
            details = error.response.get('Error', {})
            return httpx.Response(400, json={'code': details.get('Code', 'MemoryBrokerError'),
                                           'detail': details.get('Message', 'Memory broker request failed')})
        return httpx.Response(200, content=json.dumps(response, default=lambda item: item.isoformat()))

    from botcube_harness_deepagents import memory_broker
    monkeypatch.setattr(memory_broker._http_client(), 'send', post)
