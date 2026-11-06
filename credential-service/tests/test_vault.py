from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from cryptography.exceptions import InvalidTag
from moto import mock_aws
from types_boto3_dynamodb.service_resource import Table

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.data_keys import (
    Boto3KmsDataKeyProvider,
)
from botcube_credential_service.vault import (
    CredentialNotFound,
    CredentialServiceError,
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


class _ListSink:
    def __init__(self) -> None:
        self.events: list[Mapping[str, Any]] = []

    def record(self, event: Mapping[str, Any]) -> None:
        self.events.append(event)


class _OneKeyKms:
    """A data key that decrypts under any context, leaving AES-GCM's associated data as the only binding."""

    def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
        return b'k' * 32, b'encrypted-dek'

    def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
        return b'k' * 32


def test_a_stored_session_is_sealed_and_cannot_be_unsealed_as_the_durable_credential(
    vault: DynamoDbCredentialVault,
) -> None:
    one_key = DynamoDbCredentialVault(vault.table, _OneKeyKms())
    revision = one_key.store_durable_credential('acct-1', 'site', 'site-secret')
    one_key.store_session('acct-1', 'site', '{"cookies": ["session-secret"]}', revision=revision, expires_at=2e9)
    item = _stored(vault.table, {'accountId': 'acct-1', 'provider': 'site'})

    assert 'session-secret' not in repr(item)
    vault.table.put_item(Item={
        **item, 'encryptedDataKey': item['sessionEncryptedDataKey'], 'nonce': item['sessionNonce'],
        'ciphertext': item['sessionCiphertext'],
    })
    with pytest.raises(InvalidTag):
        one_key.load_durable_credential('acct-1', 'site')


def test_a_session_minted_from_a_replaced_credential_is_not_stored(vault: DynamoDbCredentialVault) -> None:
    revision = vault.store_durable_credential('acct-1', 'site', 'old')
    vault.store_durable_credential('acct-1', 'site', 'new')

    with pytest.raises(CredentialServiceError, match='Credential changed during session re-mint'):
        vault.store_session('acct-1', 'site', '{"cookies": []}', revision=revision, expires_at=2e9)
    assert vault.load_session('acct-1', 'site', now=0) is None


def test_an_expired_stored_session_is_never_decrypted(vault: DynamoDbCredentialVault) -> None:
    revision = vault.store_durable_credential('acct-1', 'site', 'secret')
    vault.store_session('acct-1', 'site', '{"cookies": []}', revision=revision, expires_at=100)
    events = _ListSink()
    audit = CredentialAuditRecorder(sink=events)

    assert vault.load_session('acct-1', 'site', now=100, audit=audit) is None
    stored = vault.load_session('acct-1', 'site', now=99, audit=audit)

    assert stored is not None and stored.jar == '{"cookies": []}'
    assert [event['event'] for event in events.events] == ['kms_decrypt']


@pytest.mark.parametrize('replacement', ['newer', 'deleted'])
def test_discard_of_a_replaced_or_absent_session_preserves_the_current_vault(
    vault: DynamoDbCredentialVault, replacement: str,
) -> None:
    revision = vault.store_durable_credential('acct-1', 'site', 'secret')
    rejected = vault.store_session('acct-1', 'site', 'rejected', revision=revision, expires_at=100)
    if replacement == 'newer':
        vault.store_session('acct-1', 'site', 'current', revision=revision, expires_at=100)
    else:
        vault.delete_durable_credential('acct-1', 'site')
    before = vault.table.get_item(Key={'accountId': 'acct-1', 'provider': 'site'}).get('Item')

    assert vault.discard_session('acct-1', 'site', token=rejected) is False
    assert vault.table.get_item(Key={'accountId': 'acct-1', 'provider': 'site'}).get('Item') == before


def test_discard_removes_the_named_session_but_preserves_the_durable_credential(
    vault: DynamoDbCredentialVault,
) -> None:
    revision = vault.store_durable_credential('acct-1', 'site', 'secret')
    token = vault.store_session('acct-1', 'site', 'rejected', revision=revision, expires_at=100)

    assert vault.discard_session('acct-1', 'site', token=token) is True
    assert vault.load_session('acct-1', 'site', now=0) is None
    assert vault.load_durable_credential('acct-1', 'site') == 'secret'


@pytest.mark.parametrize('code,status', [('AccessDeniedException', 403), ('InternalServerError', 500)])
def test_session_discard_propagates_dynamodb_failures(
    vault: DynamoDbCredentialVault, code: str, status: int,
) -> None:
    with Stubber(vault.table.meta.client) as stub:
        stub.add_client_error('update_item', service_error_code=code, http_status_code=status)
        with pytest.raises(ClientError, match=code):
            vault.discard_session('acct-1', 'site', token='rejected')
