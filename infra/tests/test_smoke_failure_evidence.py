import io
import json
import runpy
import urllib.error
from contextlib import nullcontext
from email.message import Message
from types import SimpleNamespace
from uuid import UUID

import pytest

from deploy_script_support import DEPLOY_ECS

verifier = runpy.run_path(str(DEPLOY_ECS / 'verify-service.py'))
RUN = '00000000-0000-0000-0000-000000000001'
ANSWER = 'preview acceptance 00000000000000000000000000000001'


class Response(io.BytesIO):
    status = 200

    def __init__(self, events):
        super().__init__(''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode())
        self.headers = Message()
        for name, value in {'Content-Type': 'text/event-stream', 'CF-Ray': 'synthetic-edge',
                            'Server': 'synthetic-proxy', 'Set-Cookie': 'private-cookie'}.items():
            self.headers[name] = value


class Conversation:
    def __init__(self, ending):
        self.ending = ending
        self.exists = False
        self.sends = 0
        self.kinds = []

    def open(self, request, timeout):
        payload = json.loads(request.data)
        if not payload:
            raise urllib.error.HTTPError(request.full_url, 422, 'invalid', Message(), None)
        self.sends += 1
        events = [{'type': 'RUN_STARTED', 'threadId': 'owned-thread', 'runId': RUN},
                  {'type': 'STATE_SNAPSHOT', 'snapshot': {'private-state': True}},
                  {'type': 'TEXT_MESSAGE_START', 'messageId': 'reply', 'role': 'assistant'},
                  {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'reply', 'delta': ANSWER}]
        if self.ending == 'success':
            events += [{'type': 'TEXT_MESSAGE_END', 'messageId': 'reply'},
                       {'type': 'RUN_FINISHED', 'threadId': 'owned-thread', 'runId': RUN}]
        elif self.ending == 'error':
            events[-1] = {'type': 'RUN_ERROR', 'message': 'private-error'}
        self.kinds = [event['type'] for event in events]
        return Response(events)

    def request(self, client, path, *, method='GET', **kwargs):
        if method == 'POST' and path == '/threads':
            self.exists = True
            return 201, {'id': 'owned-thread'}
        if method == 'DELETE':
            if client is self:
                self.exists = False
            return 204, None
        visible = self.exists and client is self
        if path == '/threads':
            return 200, {'threads': [{'id': 'owned-thread'}] if visible else []}
        return (200, {'messages': [{'role': 'assistant', 'content': ANSWER}]}) if visible else (404, None)


@pytest.mark.parametrize('ending', ['truncated', 'error', 'success'])
def test_smoke_keeps_joinable_content_free_evidence_and_cleanup(monkeypatch, ending):
    call = verifier['verify_conversation']
    client = Conversation(ending)
    monkeypatch.setitem(call.__globals__, 'request', client.request)
    monkeypatch.setitem(call.__globals__, 'test_user', lambda *_: nullcontext((object(), 'foreign-owner')))
    monkeypatch.setitem(call.__globals__, 'uuid', SimpleNamespace(uuid4=lambda: UUID(RUN)))
    monkeypatch.setitem(call.__globals__, 'IDENTITY', {**verifier['IDENTITY'], 'domains': {'chatServicePreview': 'https://probe.example.invalid'}})
    monkeypatch.setitem(verifier['ACCEPTANCE'], 'conversation_owner_client', lambda: (client, 'owner'))
    timing = {}
    if ending == 'success':
        assert call(table=None, timing=timing)['completeAnswer'] is True
    else:
        message = 'lacks one complete successful run' if ending == 'truncated' else 'reported RUN_ERROR'
        with pytest.raises(RuntimeError, match=message):
            call(table=None, timing=timing)
    assert client.sends == 1
    assert timing['conversationDeleted'] is True and client.exists is False
    assert timing['threadId'] == 'owned-thread'
    assert timing['runId'] == RUN
    assert timing['requestHost'] == 'probe.example.invalid'
    assert timing['eventTypes'] == client.kinds
    assert len(timing['eventTypes']) == len(timing['eventOffsetsSeconds'])
    assert timing['responseHeaders'] == {'content-type': 'text/event-stream', 'server': 'synthetic-proxy', 'cf-ray': 'synthetic-edge'}
    encoded = json.dumps(timing)
    assert ANSWER not in encoded
    assert all(secret not in encoded for secret in ['private-cookie', 'private-state', 'private-error'])
