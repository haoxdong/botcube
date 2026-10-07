from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from cryptography.exceptions import InvalidTag
from moto import mock_aws
from types_boto3_dynamodb.service_resource import Table

from botcube_credential_service.vault import (
    Boto3KmsDataKeyProvider,
    CredentialNotFound,
    DynamoDbCredentialVault,
)


@pytest.fixture
def vault() -> Iterator[DynamoDbCredentialVault]:
    with mock_aws():
        yield DynamoDbCredentialVault(_vault_table(), _kms())


def _vault_table() -> Table:
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
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


def _stored(table: Table, key: dict[str, str]) -> dict[str, Any]:
    item = table.get_item(Key=key).get('Item')
    assert item is not None
    return dict(item)


def _kms() -> Boto3KmsDataKeyProvider:
    client = boto3.client('kms', region_name='us-east-1')
    return Boto3KmsDataKeyProvider(key_id=client.create_key()['KeyMetadata']['KeyId'], client=client)


def test_an_account_holds_one_durable_credential_per_provider(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'site', 'site-secret')
    vault.store_durable_credential('acct-1', 'plan', 'plan-secret')
    vault.store_durable_credential('acct-1', 'plan', 'rotated-plan-secret')
    vault.store_durable_credential('acct-2', 'site', 'other-site-secret')

    assert vault.load_durable_credential('acct-1', 'site') == 'site-secret'
    assert vault.load_durable_credential('acct-1', 'plan') == 'rotated-plan-secret'
    assert vault.load_durable_credential('acct-2', 'site') == 'other-site-secret'


def test_revoking_one_provider_leaves_the_account_other_providers(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'site', 'site-secret')
    vault.store_durable_credential('acct-1', 'plan', 'plan-secret')

    assert vault.delete_durable_credential('acct-1', 'site') is True
    assert vault.delete_durable_credential('acct-1', 'site') is False

    with pytest.raises(CredentialNotFound):
        vault.load_durable_credential('acct-1', 'site')
    assert vault.load_durable_credential('acct-1', 'plan') == 'plan-secret'


def test_a_durable_credential_moved_to_another_provider_does_not_decrypt(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'site', 'site-secret')
    item = _stored(vault.table, {'accountId': 'acct-1', 'provider': 'site'})
    vault.table.put_item(Item={**item, 'provider': 'plan'})

    with pytest.raises(Exception, match='InvalidCiphertextException'):
        vault.load_durable_credential('acct-1', 'plan')


def test_a_durable_credential_moved_to_another_account_does_not_decrypt(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'site', 'site-secret')
    item = _stored(vault.table, {'accountId': 'acct-1', 'provider': 'site'})
    vault.table.put_item(Item={**item, 'accountId': 'acct-2'})

    with pytest.raises(Exception, match='InvalidCiphertextException'):
        vault.load_durable_credential('acct-2', 'site')


def test_a_ciphertext_swapped_between_providers_fails_authentication(vault: DynamoDbCredentialVault) -> None:
    """Even under a data key that decrypts, AES-GCM binds the ciphertext to its account and provider."""

    class OneKeyKms:
        def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
            return b'k' * 32, b'encrypted-dek'

        def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
            return b'k' * 32

    one_key = DynamoDbCredentialVault(vault.table, OneKeyKms())
    one_key.store_durable_credential('acct-1', 'site', 'site-secret')
    item = _stored(vault.table, {'accountId': 'acct-1', 'provider': 'site'})
    vault.table.put_item(Item={**item, 'provider': 'plan'})

    with pytest.raises(InvalidTag):
        one_key.load_durable_credential('acct-1', 'plan')


@pytest.mark.parametrize('provider', ['', 'a:b', 'Site', ' site'])
def test_a_provider_must_be_a_plain_lowercase_name(vault: DynamoDbCredentialVault, provider: str) -> None:
    with pytest.raises(ValueError, match='provider'):
        vault.store_durable_credential('acct-1', provider, 'secret')


@pytest.mark.parametrize('operation', ['store', 'load', 'delete'])
def test_a_missing_table_is_a_storage_failure_not_an_absent_credential(vault: DynamoDbCredentialVault, operation: str) -> None:
    from botocore.exceptions import ClientError

    vault.table.delete()
    with pytest.raises(ClientError, match='ResourceNotFoundException'):
        if operation == 'store':
            vault.store_durable_credential('acct-1', 'site', 'secret')
        elif operation == 'load':
            vault.load_durable_credential('acct-1', 'site')
        else:
            vault.delete_durable_credential('acct-1', 'site')
