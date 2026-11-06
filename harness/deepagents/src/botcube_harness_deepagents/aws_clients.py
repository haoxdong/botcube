"""The process's Bedrock clients, loading their data through one Loader.

Each botocore Session builds its own Loader, which lists every service's data directory again, and resolves the
runtime's credentials again. A restored V2 microVM pays ~38 ms for each file access the snapshot never made, and its
first credential fetch and connections are slow. So every client here loads its data through `LOADER`,
which the snapshot build primes, and a region's Bedrock clients are built once per process.
"""
from __future__ import annotations

import functools
import json
from typing import Any

import boto3
import botocore.loaders
import botocore.session
from botocore.awsrequest import AWSResponse
from botocore.compat import HTTPHeaders

from . import turn_timing

LOADER = botocore.loaders.create_loader()


def session() -> boto3.Session:
    core = botocore.session.Session()
    core.register_component('data_loader', LOADER)
    return boto3.Session(botocore_session=core)


@functools.cache
def bedrock(region_name: str | None) -> tuple[Any, Any]:
    """The runtime and control-plane clients every Bedrock model in this process shares; boto clients are thread-safe."""
    shared = session()
    with turn_timing.phase('aws_credentials'):
        shared.get_credentials()
    return shared.client('bedrock-runtime', region_name=region_name), shared.client('bedrock', region_name=region_name)


class _AnsweredBody:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def stream(self, **_: Any) -> Any:
        yield self._body


def prime(region_name: str) -> None:
    """Loads these clients' data files, and Converse's request and response handling, through `LOADER`, with no
    credentials fetched and no request leaving the process, so a V2 snapshot holds them."""
    fake = session()
    runtime: Any = fake.client(
        'bedrock-runtime', region_name=region_name, aws_access_key_id='snapshot', aws_secret_access_key='snapshot')
    fake.client('bedrock', region_name=region_name, aws_access_key_id='snapshot', aws_secret_access_key='snapshot')
    answered = json.dumps({
        'output': {'message': {'role': 'assistant', 'content': [{'text': 'ok'}]}}, 'stopReason': 'end_turn',
        'usage': {'inputTokens': 1, 'outputTokens': 1, 'totalTokens': 2}, 'metrics': {'latencyMs': 1},
    }).encode()

    def answer(request: Any, **_: Any) -> AWSResponse:
        return AWSResponse(request.url, 200, HTTPHeaders(), _AnsweredBody(answered))

    runtime.meta.events.register_first('before-send.bedrock-runtime.Converse', answer)
    runtime.converse(modelId='snapshot', messages=[{'role': 'user', 'content': [{'text': 'snapshot'}]}])
