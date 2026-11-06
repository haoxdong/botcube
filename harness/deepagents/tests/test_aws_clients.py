"""A restored V2 microVM pays for each SDK data file the snapshot never read, and for every credential fetch."""
import builtins
import socket
from collections.abc import Iterator
from typing import Any

import pytest

from botcube_harness_deepagents import aws_clients
from botcube_harness_deepagents.llm import build_model


@pytest.fixture(autouse=True)
def fresh(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    aws_clients.bedrock.cache_clear()
    yield
    aws_clients.bedrock.cache_clear()


def test_prime_reads_the_clients_data_files_without_the_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_: Any, **__: Any) -> None:
        raise AssertionError('the snapshot build must not use the network')
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket, 'getaddrinfo', forbidden)
    aws_clients.prime('us-east-1')

    opened: list[str] = []
    real_open = builtins.open
    def tracking(file: Any, *args: Any, **kwargs: Any) -> Any:
        opened.append(str(file))
        return real_open(file, *args, **kwargs)
    monkeypatch.setattr(builtins, 'open', tracking)

    aws_clients.bedrock('us-east-1')

    assert [path for path in opened if '/botocore/data/' in path] == []


def test_every_bedrock_model_shares_one_pair_of_clients_per_process() -> None:
    first = build_model(model='opus-4.6', max_tokens=16000)
    second = build_model(model='opus-4.6', max_tokens=16000, effort='high')

    assert first.client is second.client
    assert first.bedrock_client is second.bedrock_client
    assert first.client.meta.service_model.service_name == 'bedrock-runtime'
    assert first.bedrock_client.meta.service_model.service_name == 'bedrock'
