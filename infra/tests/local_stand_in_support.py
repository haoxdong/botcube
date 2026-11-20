"""Shared fixtures for the local stack's stand-in tests (local/stand-ins/)."""

import json
import threading
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import boto3
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fake_site import FakeSiteServer
from moto import mock_aws

from botcube_credential_service.invocation import sign_credential_service_invocation

ACCOUNT = 'local-user'


class LocalKeys:
    def __init__(self) -> None:
        self.key = AESGCM.generate_key(bit_length=256)

    def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
        key = AESGCM.generate_key(bit_length=256)
        return key, AESGCM(self.key).encrypt(bytes(12), key, json.dumps(encryption_context).encode())

    def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
        return AESGCM(self.key).decrypt(bytes(12), encrypted_data_key, json.dumps(encryption_context).encode())


def authorization(scope: str | None = None) -> dict[str, str]:
    return {
        'Authorization': 'Bearer ' + sign_credential_service_invocation('local-secret', ACCOUNT, 'session', scope=scope),
        'X-BotCube-Session-Id': 'session',
    }


@contextmanager
def vault_table() -> Generator[Any]:
    with mock_aws():
        dynamodb: Any = boto3.resource('dynamodb', region_name='us-east-1')
        yield dynamodb.create_table(
            TableName='vault',
            KeySchema=[
                {'AttributeName': 'accountId', 'KeyType': 'HASH'},
                {'AttributeName': 'provider', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'accountId', 'AttributeType': 'S'},
                {'AttributeName': 'provider', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )


@contextmanager
def running_fake_site() -> Generator[FakeSiteServer]:
    site = FakeSiteServer(('127.0.0.1', 0))
    thread = threading.Thread(target=site.serve_forever, daemon=True)
    thread.start()
    try:
        yield site
    finally:
        site.shutdown()
        site.server_close()
        thread.join(timeout=5)
