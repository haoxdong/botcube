from __future__ import annotations

import gzip
import json
import socket
import sys
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from botcube_credential_source import CredentialSourceError
from fastapi.testclient import TestClient

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.invocation import sign_credential_service_invocation
from botcube_credential_service.models import models_provider_from_config
from botcube_credential_service.resolved_config import (
    load_resolved_config,
    resolved_config_from_env,
)
from botcube_credential_service.server import CredentialServiceSettings, create_app
from required_keys import resolve_sections, resolved_sections

pytestmark = pytest.mark.integration

SECRET = 'credential-service-secret'
START = 1_790_965_829.0
STREAM = (
    b'data: {"id":"c1","object":"chat.completion.chunk","model":"echo","choices":[{"index":0,'
    b'"delta":{"role":"assistant","content":"Echo: Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
)
BODY = b'{"model":"echo","messages":[{"role":"user","content":"Hello"}],"stream":true}'


class FakeGateway:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.answer: Callable[[], httpx.Response] = lambda: httpx.Response(
            200, stream=httpx.ByteStream(STREAM), headers={'content-type': 'text/event-stream'},
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answer()


class Clock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> float:
        return self.now


class ListSink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, event: Mapping[str, Any]) -> None:
        self.events.append(dict(event))


@pytest.fixture
def key(tmp_path: Path) -> Path:
    path = tmp_path / 'models-api-key'
    path.write_text('sk-mounted\n')
    return path


@pytest.fixture
def gateway() -> FakeGateway:
    return FakeGateway()


def _deployed(endpoint: Mapping[str, Any]) -> dict[str, Any]:
    return {'integrations': {'modelGateway': {'kind': 'openai-compatible', **endpoint}}}


def _endpoint(credential: Mapping[str, Any]) -> dict[str, Any]:
    return _deployed({'url': 'https://models.example.com/v1', 'credential': credential, 'headers': {'x-tenant': 'botcube-example'}})


def _client(
    gateway: FakeGateway, config: dict[str, Any] | None, env: Mapping[str, str] | None = None, *, clock: Clock | None = None, sink: ListSink | None = None,
) -> TestClient:
    clock = clock or Clock()
    resolved = resolved_sections(config) if config is not None else resolved_config_from_env()
    provider = models_provider_from_config(
        CredentialAuditRecorder(sink=sink, clock=clock), resolved, env or {}, transport=httpx.MockTransport(gateway.handle), now=clock,
    )
    assert provider is not None
    settings = CredentialServiceSettings(name='test-credential-service', invocation_secret=lambda: SECRET)
    return TestClient(create_app(settings, [provider], config=resolved['config']))


def _turn(session_id: str = 'thread-1') -> dict[str, str]:
    token = sign_credential_service_invocation(SECRET, 'acct-1', session_id, model_provider='example', model_id='echo')
    return {'Authorization': f'Bearer {token}', 'X-BotCube-Session-Id': session_id, 'content-type': 'application/json'}


def _completion(client: TestClient, headers: Mapping[str, str] | None = None) -> httpx.Response:
    return client.post('/models/openai/chat/completions', content=BODY, headers=dict(headers or _turn()))


def test_a_turn_reaches_the_gateway_with_the_endpoint_bearer_and_headers_and_none_of_the_invocation(
    gateway: FakeGateway, key: Path,
) -> None:
    response = _completion(_client(gateway, _endpoint({'kind': 'file', 'path': str(key)})))

    assert response.status_code == 200
    assert response.headers['content-type'] == 'text/event-stream'
    assert response.content == STREAM
    [call] = gateway.requests
    assert (call.method, str(call.url)) == ('POST', 'https://models.example.com/v1/chat/completions')
    assert call.content == BODY
    assert call.headers['authorization'] == 'Bearer sk-mounted'
    assert call.headers['x-tenant'] == 'botcube-example'
    assert call.headers['content-type'] == 'application/json'
    assert 'x-botcube-session-id' not in call.headers


def test_each_relayed_call_is_in_the_audit_trail(gateway: FakeGateway, key: Path) -> None:
    sink = ListSink()

    _completion(_client(gateway, _endpoint({'kind': 'file', 'path': str(key)}), sink=sink), _turn('thread-2'))

    assert sink.events == [{
        'event': 'upstream_relay', 'accountId': 'acct-1', 'provider': 'models', 'sessionId': 'thread-2',
        'method': 'POST', 'path': 'openai/chat/completions', 'modelId': 'echo', 'timestamp': START,
    }]


@pytest.mark.parametrize('status', [429, 500, 503])
def test_a_gateway_failure_reaches_the_harness_as_the_gateway_answered_it(gateway: FakeGateway, key: Path, status: int) -> None:
    gateway.answer = lambda: httpx.Response(
        status, stream=httpx.ByteStream(b'{"error":{"message":"gateway"}}'), headers={'content-type': 'application/json', 'retry-after': '7'},
    )

    response = _completion(_client(gateway, _endpoint({'kind': 'file', 'path': str(key)})))

    assert (response.status_code, response.json()) == (status, {'error': {'message': 'gateway'}})
    assert response.headers['retry-after'] == '7'


def test_the_gateway_answer_reaches_the_harness_unchanged_but_for_its_hop_by_hop_headers(gateway: FakeGateway, key: Path) -> None:
    compressed = gzip.compress(STREAM)
    gateway.answer = lambda: httpx.Response(200, stream=httpx.ByteStream(compressed), headers={
        'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'x-request-id': 'req-1',
        'x-ratelimit-remaining-tokens': '99', 'keep-alive': 'timeout=5', 'connection': 'keep-alive',
    })

    response = _completion(_client(gateway, _endpoint({'kind': 'file', 'path': str(key)})))

    assert response.content == STREAM
    assert response.headers['content-encoding'] == 'gzip'
    assert (response.headers['x-request-id'], response.headers['x-ratelimit-remaining-tokens']) == ('req-1', '99')
    assert 'keep-alive' not in response.headers


def _failing(error: httpx.TransportError, cause: BaseException | None = None) -> Callable[[], httpx.Response]:
    def answer() -> httpx.Response:
        raise error from cause

    return answer


@pytest.mark.parametrize('answer', [
    _failing(httpx.ConnectError('All connection attempts failed'), ConnectionRefusedError(111, 'Connection refused')),
    _failing(httpx.ReadError(''), ConnectionResetError(104, 'Connection reset by peer')),
    _failing(httpx.ConnectTimeout('')),
], ids=['refused', 'reset', 'connect-timeout'])
def test_a_gateway_dropped_before_answering_is_a_bad_gateway_the_harness_retries(
    gateway: FakeGateway, key: Path, answer: Callable[[], httpx.Response],
) -> None:
    gateway.answer = answer

    response = _completion(_client(gateway, _endpoint({'kind': 'file', 'path': str(key)})))

    assert response.status_code == 502
    assert response.json()['error']['type'] == 'models_endpoint'


@pytest.mark.parametrize('answer', [
    _failing(httpx.ReadTimeout('')),
    _failing(httpx.RemoteProtocolError('Server disconnected without sending a response.')),
    _failing(httpx.ConnectError('[Errno -2] Name or service not known'), socket.gaierror(-2, 'Name or service not known')),
], ids=['read-timeout', 'closed', 'dns'])
def test_any_other_gateway_failure_is_an_error_the_harness_does_not_retry(
    gateway: FakeGateway, key: Path, answer: Callable[[], httpx.Response],
) -> None:
    gateway.answer = answer

    response = _completion(_client(gateway, _endpoint({'kind': 'file', 'path': str(key)})))

    assert response.status_code == 500
    assert response.json()['error']['type'] == 'models_endpoint'


def test_an_openai_model_reaches_the_gateways_responses_api_at_the_gateway_url(gateway: FakeGateway, key: Path) -> None:
    body = b'{"model":"gpt-5","input":[{"role":"user","content":"Hello"}],"stream":true}'
    client = _client(gateway, _endpoint({'kind': 'file', 'path': str(key)}))

    assert client.post('/models/openai/responses', content=body, headers=_turn()).status_code == 200

    [call] = gateway.requests
    assert (call.method, str(call.url), call.content) == ('POST', 'https://models.example.com/v1/responses', body)
    assert (call.headers['authorization'], call.headers['x-tenant']) == ('Bearer sk-mounted', 'botcube-example')


def test_a_provider_is_reached_at_its_own_url_with_its_own_credential_and_headers(gateway: FakeGateway, key: Path, tmp_path: Path) -> None:
    own_key = tmp_path / 'anthropic-key'
    own_key.write_text('sk-anthropic\n')
    anthropic = {'url': 'https://models.example.com/anthropic', 'credential': {'kind': 'file', 'path': str(own_key)}, 'headers': {'x-route': 'messages'}}
    config = _endpoint({'kind': 'file', 'path': str(key)})
    config['integrations']['modelGateway']['providers'] = {'anthropic': anthropic}
    client = _client(gateway, config)

    response = client.post('/models/anthropic/v1/messages', content=BODY, headers={**_turn(), 'x-api-key': 'invocation-token'})

    assert response.status_code == 200
    [call] = gateway.requests
    assert str(call.url) == 'https://models.example.com/anthropic/v1/messages'
    assert call.headers['authorization'] == 'Bearer sk-anthropic'
    assert call.headers['x-route'] == 'messages'
    assert 'x-tenant' not in call.headers
    assert 'x-api-key' not in call.headers


def test_a_provider_without_its_own_credential_takes_the_gateways(gateway: FakeGateway, key: Path) -> None:
    config = _endpoint({'kind': 'file', 'path': str(key)})
    config['integrations']['modelGateway']['providers'] = {'anthropic': {'url': 'https://models.example.com/anthropic'}}

    _client(gateway, config).post('/models/anthropic/v1/messages', content=BODY, headers=_turn())

    [call] = gateway.requests
    assert (str(call.url), call.headers['authorization'], call.headers['x-tenant']) == (
        'https://models.example.com/anthropic/v1/messages', 'Bearer sk-mounted', 'botcube-example',
    )


@pytest.mark.parametrize(('providers', 'status'), [({'openai': {}}, 200), ({}, 404)])
def test_the_gateway_routes_only_listed_providers(gateway: FakeGateway, key: Path, providers: dict[str, object], status: int) -> None:
    config = _endpoint({'kind': 'file', 'path': str(key)})
    config['integrations']['modelGateway']['providers'] = providers
    client = _client(gateway, config)

    assert client.post('/models/anthropic/v1/messages', content=BODY, headers=_turn()).status_code == 404
    assert client.post('/models/openai/responses', content=BODY, headers=_turn()).status_code == status
    assert [str(call.url) for call in gateway.requests] == (['https://models.example.com/v1/responses'] if status == 200 else [])


@pytest.mark.parametrize('path', ['/models/deepseek/chat/completions', '/models/chat/completions'])
def test_a_call_naming_no_provider_the_gateway_serves_never_reaches_it(gateway: FakeGateway, key: Path, path: str) -> None:
    response = _client(gateway, _endpoint({'kind': 'file', 'path': str(key)})).post(path, content=BODY, headers=_turn())

    assert response.status_code == 404
    assert gateway.requests == []


def test_cache_markers_reach_the_gateway_as_the_harness_wrote_them(gateway: FakeGateway, key: Path) -> None:
    marked = json.dumps({'model': 'claude-sonnet-5-5', 'stream': True, 'system': [{'type': 'text', 'text': 'You are BotCube.', 'cache_control': {'type': 'ephemeral'}}], 'messages': [
        {'role': 'user', 'content': [{'type': 'text', 'text': 'Hello', 'cache_control': {'type': 'ephemeral'}}]},
    ]}).encode()
    client = _client(gateway, _deployed({'url': 'https://models.example.com', 'credential': {'kind': 'file', 'path': str(key)}}))

    client.post('/models/anthropic/v1/messages', content=marked, headers=_turn())

    [call] = gateway.requests
    assert str(call.url) == 'https://models.example.com/v1/messages'
    assert call.content == marked


@pytest.mark.parametrize('headers', [
    {'content-type': 'application/json'},
    {'Authorization': 'Bearer sk-guessed', 'X-BotCube-Session-Id': 'thread-1'},
    {**_turn('thread-1'), 'X-BotCube-Session-Id': 'thread-2'},
])
def test_a_call_without_the_turns_invocation_never_reaches_the_gateway(
    gateway: FakeGateway, key: Path, headers: dict[str, str],
) -> None:
    response = _completion(_client(gateway, _endpoint({'kind': 'file', 'path': str(key)})), headers)

    assert response.status_code == 401
    assert gateway.requests == []


def test_a_rotated_file_reaches_the_gateway_once_its_value_is_due_a_reread(gateway: FakeGateway, key: Path) -> None:
    clock = Clock()
    client = _client(gateway, _endpoint({'kind': 'file', 'path': str(key)}), clock=clock)
    key.write_text('sk-rotated\n')

    _completion(client)
    clock.now = START + 241
    _completion(client)

    assert [call.headers['authorization'] for call in gateway.requests] == ['Bearer sk-mounted', 'Bearer sk-rotated']


def test_a_turn_fails_naming_the_models_seam_and_its_file_when_the_file_cannot_be_read_again(
    gateway: FakeGateway, key: Path,
) -> None:
    clock = Clock()
    client = _client(gateway, _endpoint({'kind': 'file', 'path': str(key)}), clock=clock)
    key.unlink()
    clock.now = START + 241

    response = _completion(client)

    assert response.status_code == 500
    assert response.json()['error']['type'] == 'models_credential'
    assert response.json()['error']['message'].startswith(f'models credential (file {key}): ')
    assert gateway.requests == []


def test_the_credential_command_runs_here_and_again_a_minute_before_its_token_expires(
    gateway: FakeGateway, tmp_path: Path,
) -> None:
    runs = tmp_path / 'runs'
    helper = tmp_path / 'helper.py'
    expiry = datetime.fromtimestamp(START + 600, UTC).isoformat()
    helper.write_text(
        'import json, pathlib\n'
        f'runs = pathlib.Path({str(runs)!r})\n'
        'count = int(runs.read_text()) + 1 if runs.exists() else 1\n'
        'runs.write_text(str(count))\n'
        f'print(json.dumps({{"kind": "ExecCredential", "status": {{"token": f"gw-token-{{count}}", "expirationTimestamp": {expiry!r}}}}}))\n'
    )
    command = {'kind': 'command', 'command': [sys.executable, str(helper)], 'timeoutSeconds': 30}
    clock = Clock()
    client = _client(gateway, {**_endpoint(command), 'allowCommandCredentials': True}, {'BOTCUBE_ALLOW_COMMAND_CREDENTIALS': '1'}, clock=clock)

    _completion(client)
    clock.now = START + 240
    _completion(client)
    clock.now = START + 541
    _completion(client)

    assert [call.headers['authorization'] for call in gateway.requests] == ['Bearer gw-token-1', 'Bearer gw-token-1', 'Bearer gw-token-2']


def test_startup_fails_naming_the_models_seam_and_its_file_when_the_credential_cannot_be_read(tmp_path: Path) -> None:
    absent = tmp_path / 'absent'
    with pytest.raises(CredentialSourceError, match=f'^models credential \\(file {absent}\\): '):
        models_provider_from_config(CredentialAuditRecorder(), resolved_sections(_endpoint({'kind': 'file', 'path': str(absent)})), {})


@pytest.mark.integration
@pytest.mark.parametrize('provider', ['anthropic', 'openai'])
def test_startup_names_the_provider_when_its_own_credential_cannot_be_read(
    key: Path, tmp_path: Path, provider: str,
) -> None:
    absent = tmp_path / 'absent'
    resolved = resolved_sections(_deployed({
        'url': 'https://models.example.com',
        'credential': {'kind': 'file', 'path': str(key)},
        'providers': {provider: {'credential': {'kind': 'file', 'path': str(absent)}}},
    }))
    with pytest.raises(CredentialSourceError, match=rf'^models {provider} credential \(file {absent}\): '):
        models_provider_from_config(CredentialAuditRecorder(), resolved, {})


def test_startup_refuses_a_command_credential_without_the_runtime_environment_opt_in() -> None:
    command = {'kind': 'command', 'command': ['gateway-token'], 'timeoutSeconds': 30}
    with pytest.raises(CredentialSourceError, match='^models credential \\(command gateway-token\\): a command credential runs only when'):
        models_provider_from_config(CredentialAuditRecorder(), resolved_sections({**_endpoint(command), 'allowCommandCredentials': True}), {})


def test_the_relay_reaches_the_endpoint_the_resolved_file_names(
    gateway: FakeGateway, key: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = resolve_sections(_endpoint({'kind': 'file', 'path': str(key)}), tmp_path)
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))

    response = _completion(_client(gateway, None))

    assert response.status_code == 200
    [call] = gateway.requests
    assert (str(call.url), call.headers['authorization']) == ('https://models.example.com/v1/chat/completions', 'Bearer sk-mounted')


def test_a_deployment_on_bedrock_has_no_models_relay() -> None:
    assert models_provider_from_config(CredentialAuditRecorder(), load_resolved_config(), {}) is None
