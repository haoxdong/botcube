from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx
import pytest

from botcube_credential_service.vault import DynamoDbCredentialVault
from test_openai import FakeOpenAI, _bound_turn, _client, _stored
from test_openai import vault as vault


class ChunkedFrames(httpx.AsyncByteStream):
    def __init__(self, content: bytes, width: int) -> None:
        self.content = content
        self.width = width

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for start in range(0, len(self.content), self.width):
            yield self.content[start:start + self.width]


@pytest.mark.parametrize('ending', [b'\n', b'\r\n'], ids=['lf', 'crlf'])
@pytest.mark.parametrize('width', [1, 7, 1024], ids=['each-byte', 'seven-bytes', 'whole'])
@pytest.mark.parametrize('complete', [True, False])
def test_response_frames_fail_through_the_sse_protocol(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, complete: bool, ending: bytes, width: int,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    first = b'data: {"type":"response.output_text.delta","delta":"answer"}' + ending * 2
    last = b'data: {"type":"response.completed"}'
    content = first + last + (ending * 2 if complete else ending)
    monkeypatch.setattr(upstream, 'responses', lambda: httpx.Response(
        200, stream=ChunkedFrames(content, width), headers={'content-type': 'text/event-stream'},
    ))
    response = _client(vault, upstream).post(
        '/openai/v1/responses', json={'model': 'gpt-6-astra', 'stream': True},
        headers=_bound_turn('openai', 'gpt-6-astra'),
    )
    assert response.status_code == 200
    if complete:
        assert response.content == content
    else:
        assert response.content.startswith(first)
        error_frame = response.content.removeprefix(first)
        assert error_frame.startswith(b'event: error\ndata: ')
        error = json.loads(error_frame.removeprefix(b'event: error\ndata: '))
        assert error['type'] == 'error'
        assert error['error']['type'] == 'plan_usage'
        assert error['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
        assert 'incomplete response stream frame' in error['error']['message']


@pytest.mark.parametrize('padding', [b'\n', b'\r\n', b'\n\n', b'\r\n\r\n'])
def test_completed_response_allows_trailing_blank_lines(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch, padding: bytes,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    content = b'data: {"type":"response.completed"}\n\n' + padding
    monkeypatch.setattr(upstream, 'responses', lambda: httpx.Response(
        200, stream=ChunkedFrames(content, 1), headers={'content-type': 'text/event-stream'},
    ))
    response = _client(vault, upstream).post(
        '/openai/v1/responses', json={'model': 'gpt-6-astra', 'stream': True},
        headers=_bound_turn('openai', 'gpt-6-astra'),
    )
    assert response.status_code == 200
    assert response.content == content
