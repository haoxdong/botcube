from __future__ import annotations

import json
import socket
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from botocore.exceptions import ClientError

from botcube_harness_deepagents.memory_broker import (
    MemoryBrokerClient,
    MemoryCapability,
    turn_memory,
)


@dataclass
class Broker:
    url: str = ''
    calls: list[dict[str, Any]] = field(default_factory=list)
    connections: list[socket.socket] = field(default_factory=list)
    rendezvous: threading.Barrier | None = None


@pytest.fixture
def broker() -> Iterator[Broker]:
    state = Broker()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            authorization = self.headers['Authorization']
            state.calls.append({'authorization': authorization, 'cookie': self.headers.get('Cookie'),
                                'acceptEncoding': self.headers.get('Accept-Encoding', ''), 'body': body})
            if state.rendezvous is not None:
                state.rendezvous.wait(timeout=5)
            denied = authorization == 'Bearer revoked'
            reply = {'code': 'AccessDeniedException', 'detail': 'Turn revoked'} if denied else {
                'events': [{'actorId': body['params']['actorId'], 'sessionId': body['params']['sessionId']}],
            }
            payload = json.dumps(reply).encode()
            self.send_response(403 if denied else 200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Set-Cookie', f'private={body["params"]["actorId"]}; Path=/')
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()

        def log_message(self, format: str, *args: Any) -> None:
            pass

    class Server(ThreadingHTTPServer):
        def get_request(self) -> tuple[socket.socket, Any]:
            connection, address = super().get_request()
            state.connections.append(connection)
            return connection, address

    with Server(('127.0.0.1', 0), Handler) as server:
        state.url = f'http://127.0.0.1:{server.server_address[1]}/internal/turn-memory'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield state
        finally:
            server.shutdown()
            for connection in state.connections:
                connection.close()
            thread.join(timeout=2)


def read(client: MemoryBrokerClient, broker: Broker, actor: str, token: str) -> dict[str, Any]:
    with turn_memory(MemoryCapability(broker.url, token, actor)):
        return client.list_events(memoryId='memory', actorId=actor, sessionId=f'{actor}-session')


def test_broker_reuses_one_connection_with_fresh_authorization_and_no_response_cookies(broker: Broker) -> None:
    client = MemoryBrokerClient()
    assert read(client, broker, 'alice', 'alice-first') == {'events': [{'actorId': 'alice', 'sessionId': 'alice-session'}]}
    assert read(client, broker, 'alice', 'alice-next') == {'events': [{'actorId': 'alice', 'sessionId': 'alice-session'}]}
    assert read(MemoryBrokerClient(), broker, 'bob', 'bob-turn') == {'events': [{'actorId': 'bob', 'sessionId': 'bob-session'}]}
    assert [(call['authorization'], call['cookie']) for call in broker.calls] == [
        ('Bearer alice-first', None), ('Bearer alice-next', None), ('Bearer bob-turn', None),
    ]
    assert len(broker.connections) == 1
    assert all('gzip' in call['acceptEncoding'] for call in broker.calls)
    with pytest.raises(RuntimeError, match='active Turn capability'):
        client.list_events(memoryId='memory', actorId='alice', sessionId='alice-session')


def test_overlapping_broker_requests_keep_accounts_separate(broker: Broker) -> None:
    broker.rendezvous = threading.Barrier(2)
    client = MemoryBrokerClient()
    with ThreadPoolExecutor(2) as workers:
        alice = workers.submit(read, client, broker, 'alice', 'alice-turn')
        bob = workers.submit(read, client, broker, 'bob', 'bob-turn')
        assert alice.result(timeout=6) == {'events': [{'actorId': 'alice', 'sessionId': 'alice-session'}]}
        assert bob.result(timeout=6) == {'events': [{'actorId': 'bob', 'sessionId': 'bob-session'}]}
    broker.rendezvous = None
    assert read(client, broker, 'carol', 'carol-turn') == {'events': [{'actorId': 'carol', 'sessionId': 'carol-session'}]}
    assert {call['authorization']: call['body']['params']['actorId'] for call in broker.calls} == {
        'Bearer alice-turn': 'alice', 'Bearer bob-turn': 'bob', 'Bearer carol-turn': 'carol',
    }
    assert [call['cookie'] for call in broker.calls] == [None, None, None]
    assert len(broker.connections) == 2


def test_broker_reuses_its_connection_after_a_pause_between_turns(broker: Broker) -> None:
    client = MemoryBrokerClient()
    assert read(client, broker, 'alice', 'first') == {'events': [{'actorId': 'alice', 'sessionId': 'alice-session'}]}
    time.sleep(6)
    assert read(client, broker, 'alice', 'next') == {'events': [{'actorId': 'alice', 'sessionId': 'alice-session'}]}
    assert [call['authorization'] for call in broker.calls] == ['Bearer first', 'Bearer next']
    assert len(broker.connections) == 1


def test_revoked_turn_fails_without_breaking_the_next_authorized_request(broker: Broker) -> None:
    client = MemoryBrokerClient()
    with pytest.raises(ClientError, match='Turn revoked') as failure:
        read(client, broker, 'alice', 'revoked')
    assert failure.value.response.get('Error') == {'Code': 'AccessDeniedException', 'Message': 'Turn revoked'}
    assert read(client, broker, 'alice', 'current') == {'events': [{'actorId': 'alice', 'sessionId': 'alice-session'}]}
    assert [(call['authorization'], call['cookie']) for call in broker.calls] == [('Bearer revoked', None), ('Bearer current', None)]
    assert len(broker.connections) == 1
