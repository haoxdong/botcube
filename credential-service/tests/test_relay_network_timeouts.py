"""Relay catalogs survive slow packets and fail stalled connections/streams with bounded custody."""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Mapping
from typing import Any, Protocol, cast

import anyio
import httpx
import pytest
from anyio.streams.tls import TLSStream
from starlette.requests import Request
from starlette.responses import StreamingResponse

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.vault import DynamoDbCredentialVault
from test_openai import RECORDED
from test_openai import vault as vault


class LoopInternals(Protocol):
    """The CPython scheduler boundary used only by this in-memory network replay."""

    _scheduled: list[asyncio.TimerHandle]
    _ready: deque[asyncio.Handle]

    def _run_once(self) -> None:
        ...


class PacketClockLoop(asyncio.SelectorEventLoop):
    """Advance only when no task is ready; no source timeout or elapsed time is rescaled."""

    def __init__(self) -> None:
        self.now = 0.0
        super().__init__()

    def time(self) -> float:
        return self.now

    def _run_once(self) -> None:
        # A fully in-memory packet replay has no real I/O to await. The actual asyncio and
        # AnyIO deadline callbacks race actual sleep callbacks on one virtual clock.
        loop = cast(LoopInternals, self)
        deadlines = [handle.when() for handle in loop._scheduled if not handle.cancelled()]
        if not loop._ready and deadlines:
            self.now = max(self.now, min(deadlines))
        cast(LoopInternals, super())._run_once()


class ReplaySocket(anyio.abc.ByteStream):
    def __init__(self, packets: list[tuple[float, bytes]]) -> None:
        self.packets = packets
        self.closed = False
        self.request = bytearray()

    @property
    def extra_attributes(self) -> Mapping[Any, Any]:
        return {}

    async def receive(self, max_bytes: int = 65536) -> bytes:
        if not self.packets:
            raise anyio.EndOfStream
        delay, packet = self.packets[0]
        await anyio.sleep(delay)
        self.packets.pop(0)
        return packet

    async def send(self, item: bytes) -> None:
        self.request.extend(item)

    async def send_eof(self) -> None:
        return None

    async def aclose(self) -> None:
        self.closed = True


def replay_network(
    monkeypatch: pytest.MonkeyPatch, *, connect_delay: float, body_delay: float,
) -> ReplaySocket:
    body = (RECORDED / 'models.json').read_bytes()
    headers = (
        b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n'
        + f'Content-Length: {len(body)}\r\n\r\n'.encode()
    )
    socket = ReplaySocket([(0, headers), (body_delay, body)])

    async def connect_tcp(**kwargs: Any) -> ReplaySocket:
        await anyio.sleep(connect_delay)
        return socket

    async def tls_wrap(stream: ReplaySocket, **kwargs: Any) -> ReplaySocket:
        return stream

    # Only the external network and TLS peer are replaced. HTTPX, HTTPCore, their
    # exception translation, AnyIO timeout scopes, and HTTP/1 framing execute unchanged.
    # https://www.python-httpx.org/advanced/timeouts/
    # https://www.encode.io/httpcore/network-backends/
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(anyio, 'connect_tcp', connect_tcp)
    monkeypatch.setattr(TLSStream, 'wrap', staticmethod(tls_wrap))
    return socket


async def consume_catalog(vault: DynamoDbCredentialVault) -> bytes:
    async def receive() -> dict[str, Any]:
        return {'type': 'http.request', 'body': b'', 'more_body': False}

    request = Request(
        {'type': 'http', 'method': 'GET', 'path': '/openai/v1/models', 'query_string': b'', 'headers': []},
        receive,
    )
    provider = OpenAIProvider(lambda: vault, audit=CredentialAuditRecorder())
    response = await provider.relay(request, 'v1/models', 'test-access', account_id='acct-1', request_context={})
    assert isinstance(response, StreamingResponse)
    assert response.status_code == 200
    chunks: list[bytes] = []
    async for chunk in response.body_iterator:
        assert isinstance(chunk, bytes)
        chunks.append(chunk)
    return b''.join(chunks)


def test_slow_but_live_upstream_still_delivers_the_catalog(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = replay_network(monkeypatch, connect_delay=20, body_delay=45)
    with asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        assert runner.run(consume_catalog(vault)) == (RECORDED / 'models.json').read_bytes()
    assert socket.closed
    assert b'GET /v1/models HTTP/1.1' in socket.request


def test_a_connection_that_remains_unavailable_fails_before_delivering_a_catalog(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = replay_network(monkeypatch, connect_delay=30.5, body_delay=0)
    with asyncio.Runner(loop_factory=PacketClockLoop) as runner, pytest.raises(httpx.ConnectTimeout):
        runner.run(consume_catalog(vault))
    assert not socket.request


def test_a_stalled_catalog_stream_fails_and_releases_the_network_stream(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = replay_network(monkeypatch, connect_delay=0, body_delay=300.5)
    with asyncio.Runner(loop_factory=PacketClockLoop) as runner, pytest.raises(httpx.ReadTimeout):
        runner.run(consume_catalog(vault))
    assert socket.closed
