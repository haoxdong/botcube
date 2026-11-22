from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from botcube_harness_deepagents.credential_source import (
    Credential,
    CredentialSourceError,
    credential_source,
)

START = 1_795_000_000.0


@pytest.fixture
def secrets(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'testing')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'testing')
    with mock_aws():
        yield boto3.client('secretsmanager', region_name='us-east-1')


def _secret(client: Any, value: str) -> str:
    return client.create_secret(Name=f'models-api-key-{uuid.uuid4()}', SecretString=value)['ARN']


def test_gives_the_secrets_string_until_five_minutes_on(secrets: Any) -> None:
    arn = _secret(secrets, 'sk-from-secret')

    source = credential_source('models', {'kind': 'secret', 'secretId': arn}, now=lambda: START)

    assert source.get() == Credential(value='sk-from-secret', expires_at=START + 300)


def test_reads_a_secret_named_without_its_arn_in_its_own_region(secrets: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    name = f'models-api-key-{uuid.uuid4()}'
    secrets.create_secret(Name=name, SecretString='sk-by-name')

    source = credential_source('models', {'kind': 'secret', 'secretId': name}, now=lambda: START)

    assert source.get() == Credential(value='sk-by-name', expires_at=START + 300)


def test_reads_the_secret_again_a_minute_before_its_value_expires(secrets: Any) -> None:
    arn = _secret(secrets, 'sk-first')
    clock = [START]
    source = credential_source('models', {'kind': 'secret', 'secretId': arn}, now=lambda: clock[0])
    source.get()
    secrets.put_secret_value(SecretId=arn, SecretString='sk-rotated')

    clock[0] = START + 120
    assert source.get().value == 'sk-first'
    clock[0] = START + 241
    assert source.get().value == 'sk-rotated'


def test_fails_naming_its_seam_and_its_secret(secrets: Any) -> None:
    arn = f'arn:aws:secretsmanager:us-east-1:123456789012:secret:absent-{uuid.uuid4()}'
    source = credential_source('models', {'kind': 'secret', 'secretId': arn})

    for _ in range(2):
        with pytest.raises(CredentialSourceError, match=f'^models credential \\(secret {arn}\\): .*ResourceNotFoundException'):
            source.get()
