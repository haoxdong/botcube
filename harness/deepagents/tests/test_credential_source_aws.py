from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any
from urllib.parse import unquote

import pytest
import requests
from moto import mock_aws

from botcube_harness_deepagents.credential_source import credential_source

START = 1_795_000_000.0
SOURCE = {'kind': 'aws', 'audience': 'collector.example.com'}


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'testing')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'testing')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    with mock_aws():
        yield


def _request(value: str) -> dict[str, Any]:
    return json.loads(unquote(value))


def _header(request: dict[str, Any], name: str) -> str | None:
    return next((header['value'] for header in request['headers'] if header['key'].lower() == name), None)


def test_gives_the_process_aws_identity_as_a_signed_get_caller_identity_request_for_fifteen_minutes(aws: None) -> None:
    credential = credential_source('telemetry.credential', SOURCE, now=lambda: START).get()

    request = _request(credential.value)
    assert request['method'] == 'POST'
    assert request['url'] == 'https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15'
    assert _header(request, 'x-botcube-audience') == 'collector.example.com'
    assert re.match(
        r'^AWS4-HMAC-SHA256 Credential=[A-Z0-9]+/\d{8}/us-east-1/sts/aws4_request, SignedHeaders=[^,]*x-botcube-audience',
        _header(request, 'authorization') or '',
    )
    headers = {header['key']: header['value'] for header in request['headers'] if header['key'].lower() != 'host'}
    assert '<Arn>arn:aws:sts::' in requests.post(request['url'], headers=headers, timeout=10).text
    assert credential.expires_at == START + 900


def test_signs_again_a_minute_before_the_signature_expires(aws: None) -> None:
    clock = [START]
    source = credential_source('telemetry.credential', SOURCE, now=lambda: clock[0])
    first = source.get()

    clock[0] = START + 420
    assert source.get() is first
    clock[0] = START + 841
    assert source.get().expires_at == START + 841 + 900
