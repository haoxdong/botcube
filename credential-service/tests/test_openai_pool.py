import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from typing import NoReturn

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.server import CredentialServiceSettings, create_app


class Stream(httpx.AsyncByteStream):
    def __init__(self, failure: bool) -> None:
        self.closed = False
        self.failure = failure

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b'model catalog'
        if self.failure:
            raise httpx.ReadError('provider disconnected')

    async def aclose(self) -> None:
        self.closed = True


def unused_vault() -> NoReturn:
    raise AssertionError('relay does not access the Vault')


def request() -> Request:
    return Request({'type': 'http', 'method': 'GET', 'path': '/openai/v1/models',
                    'query_string': b'', 'headers': [], 'scheme': 'http', 'server': ('service', 80)},
                   receive=lambda: asyncio.sleep(0, result={'type': 'http.request', 'body': b''}))


async def consume_response(response: Response, outcome: str) -> None:
    if outcome == 'error':
        return
    assert isinstance(response, StreamingResponse)
    body = response.body_iterator
    assert isinstance(body, AsyncGenerator)
    assert await anext(body) == b'model catalog'
    if outcome == 'cancelled':
        await body.aclose()
    elif outcome == 'read_failure':
        with pytest.raises(httpx.ReadError, match='provider disconnected'):
            await anext(body)
    else:
        with pytest.raises(StopAsyncIteration):
            await anext(body)


@pytest.mark.parametrize('outcome', ['success', 'error', 'cancelled', 'read_failure'])
def test_responses_close_without_closing_shared_client(outcome: str) -> None:
    async def run() -> None:
        streams: list[Stream] = []
        requests: list[httpx.Request] = []

        async def upstream(call: httpx.Request) -> httpx.Response:
            requests.append(call)
            stream = Stream(outcome == 'read_failure')
            streams.append(stream)
            return httpx.Response(503 if outcome == 'error' else 200, stream=stream,
                                  headers={'set-cookie': 'account=first; Path=/'})

        owner = OpenAIProvider(unused_vault, audit=CredentialAuditRecorder(), transport=httpx.MockTransport(upstream))
        shared = owner._client
        for account, access in [('first', 'token-first'), ('second', 'token-second')]:
            response = await owner.relay(request(), 'v1/models', access, account_id=account, request_context={})
            await consume_response(response, outcome)
            assert streams[-1].closed
            assert not shared.is_closed
            assert owner._client is shared
        assert [call.headers['authorization'] for call in requests] == ['Bearer token-first', 'Bearer token-second']
        assert all('cookie' not in call.headers for call in requests)
        assert list(shared.cookies.jar) == []
        await owner.aclose()
        assert shared.is_closed

    asyncio.run(run())


def test_application_shutdown_closes_provider_pool() -> None:
    class Transport(httpx.MockTransport):
        closed = False

        async def aclose(self) -> None:
            self.closed = True

    transport = Transport(lambda _: httpx.Response(200))
    owner = OpenAIProvider(unused_vault, audit=CredentialAuditRecorder(), transport=transport)
    settings = CredentialServiceSettings(name='pool-test', invocation_secret=lambda: 'secret')
    shared = owner._client
    with TestClient(create_app(settings, [owner])) as client:
        assert client.get('/missing').status_code == 404
        assert not shared.is_closed
    assert shared.is_closed
    assert transport.closed
