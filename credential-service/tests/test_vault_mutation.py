from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any
from unittest.mock import Mock

import boto3
import pytest
from botocore.stub import Stubber
from moto import mock_aws

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.vault import (
    Boto3KmsDataKeyProvider,
    CredentialNotFound,
    CredentialServiceError,
    DynamoDbCredentialVault,
    RefreshLeaseHeld,
    RotationLost,
    RotationStoredButRefused,
    require_account_id,
)
from test_vault import _kms, _vault_table


@pytest.fixture
def vault() -> Iterator[DynamoDbCredentialVault]:
    with mock_aws():
        yield DynamoDbCredentialVault(_vault_table(), _kms())


class AuditEvents:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, event: Mapping[str, Any]) -> None:
        self.events.append(dict(event))


def test_loading_a_credential_preserves_the_session_audit_context(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'openai', 'refresh-token')
    sink = AuditEvents()
    audit = CredentialAuditRecorder(sink=sink, clock=lambda: 42)

    assert vault.load_durable_credential(
        'acct-1', 'openai', audit=audit,
        request_context={'sessionId': 'run-1', 'method': 'POST', 'path': 'responses'},
    ) == 'refresh-token'
    assert sink.events == [{
        'event': 'kms_decrypt', 'accountId': 'acct-1', 'sessionId': 'run-1',
        'method': 'POST', 'path': 'responses', 'timestamp': 42,
    }]


def test_refresh_reads_use_strong_consistency_and_revision_reads_project_only_ciphertext(
    vault: DynamoDbCredentialVault,
) -> None:
    item = vault.sealed_item('acct-1', 'openai', 'refresh-token')
    # DynamoDB's low-level response shape; the resource deserializes this before the Vault reads it.
    response = {'Item': {key: {'S': value} for key, value in item.items()}}
    with Stubber(vault.table.meta.client) as stub:
        stub.add_response('get_item', response, {
            'TableName': 'vault', 'Key': {'accountId': 'acct-1', 'provider': 'openai'}, 'ConsistentRead': True,
        })
        loaded = vault.load_revised_credential('acct-1', 'openai')
        assert loaded.value == 'refresh-token'
        stub.add_response('get_item', {'Item': {'ciphertext': {'S': 'current-revision'}}}, {
            'TableName': 'vault', 'Key': {'accountId': 'acct-1', 'provider': 'openai'},
            'ConsistentRead': True, 'ProjectionExpression': 'ciphertext',
        })
        assert vault.load_credential_revision('acct-1', 'openai') == 'current-revision'
        stub.assert_no_pending_responses()


def test_a_refresh_contender_is_told_which_revision_now_holds_the_lease(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'openai', 'refresh-token')
    revision = vault.load_credential_revision('acct-1', 'openai')
    vault.take_refresh_lease('acct-1', 'openai', revision=revision, lease='holder', now=0, expires_at=30)

    with pytest.raises(RefreshLeaseHeld, match='Another task holds the refresh lease or rotated the credential') as refused:
        vault.take_refresh_lease('acct-1', 'openai', revision=revision, lease='contender', now=1, expires_at=31)
    assert refused.value.revision == revision


@pytest.mark.parametrize('operation', ['renew', 'replace'])
@pytest.mark.parametrize('failure_item', [None, {}])
def test_a_deleted_refresh_item_is_a_classified_custody_loss(
    vault: DynamoDbCredentialVault, operation: str, failure_item: dict[str, Any] | None,
) -> None:
    method = 'update_item' if operation == 'renew' else 'put_item'
    fields = {} if failure_item is None else {'Item': failure_item}
    with Stubber(vault.table.meta.client) as stub:
        stub.add_client_error(method, service_error_code='ConditionalCheckFailedException', modeled_fields=fields)
        with pytest.raises(RotationLost) as refused:
            if operation == 'renew':
                vault.renew_refresh_lease('acct-1', 'openai', revision='old', lease='holder', expires_at=30)
            else:
                vault.replace_durable_credential('acct-1', 'openai', 'rotated', revision='old', lease='holder')
        assert refused.value.current_revision is None
        assert str(refused.value) == (
            'Refresh lease no longer belongs to this task' if operation == 'renew'
            else 'Another write replaced the openai credential of account acct-1'
        )
        stub.assert_no_pending_responses()


def test_a_competing_rotation_reports_the_winning_revision(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'openai', 'refresh-token')
    revision = vault.load_credential_revision('acct-1', 'openai')
    vault.take_refresh_lease('acct-1', 'openai', revision=revision, lease='holder', now=0, expires_at=30)
    vault.store_durable_credential('acct-1', 'openai', 'another-write')
    winner = vault.load_credential_revision('acct-1', 'openai')

    with pytest.raises(RotationLost, match='Another write replaced the openai credential of account acct-1') as refused:
        vault.replace_durable_credential('acct-1', 'openai', 'rotated', revision=revision, lease='holder')
    assert refused.value.current_revision == winner
    assert vault.load_durable_credential('acct-1', 'openai') == 'another-write'


def test_a_refused_sdk_retry_reports_that_this_exact_rotation_was_stored(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = vault.sealed_item('acct-1', 'openai', 'rotated')

    def sealed_item(account: str, provider: str, credential: str) -> dict[str, str]:
        return item

    monkeypatch.setattr(vault, 'sealed_item', sealed_item)
    with Stubber(vault.table.meta.client) as stub:
        stub.add_client_error('put_item', service_error_code='ConditionalCheckFailedException', modeled_fields={
            'Item': {'ciphertext': {'S': item['ciphertext']}},
        }, expected_params={
            'TableName': 'vault', 'Item': item,
            'ConditionExpression': 'ciphertext = :revision AND refreshLease = :lease',
            'ExpressionAttributeValues': {':revision': 'old', ':lease': 'holder'},
            'ReturnValuesOnConditionCheckFailure': 'ALL_OLD',
        })
        with pytest.raises(RotationStoredButRefused) as refused:
            vault.replace_durable_credential('acct-1', 'openai', 'rotated', revision='old', lease='holder')
        assert refused.value.revision == item['ciphertext']
        assert str(refused.value) == 'The conditional write was refused after this rotated credential was stored'
        assert refused.value.__cause__ is not None


def test_an_absent_revision_read_names_the_missing_account_and_provider(vault: DynamoDbCredentialVault) -> None:
    with pytest.raises(CredentialNotFound, match='No durable credential for account acct-1 and provider openai'):
        vault.load_credential_revision('acct-1', 'openai')


def test_default_kms_client_uses_the_named_region(monkeypatch: pytest.MonkeyPatch) -> None:
    client = Mock()
    factory = Mock(return_value=client)
    monkeypatch.setattr(boto3, 'client', factory)

    kms = Boto3KmsDataKeyProvider(key_id='key-1', region_name='eu-west-1')
    assert kms.client is client
    factory.assert_called_once_with('kms', region_name='eu-west-1')


def test_configuration_errors_explain_which_identity_is_missing() -> None:
    with pytest.raises(ValueError, match='key_id must not be empty'):
        Boto3KmsDataKeyProvider(key_id='')
    with pytest.raises(ValueError, match='account_id must not be empty'):
        require_account_id(' ')


@pytest.mark.parametrize('value', ['', 7, None])
def test_malformed_vault_fields_are_classified_before_decryption(
    vault: DynamoDbCredentialVault, value: Any,
) -> None:
    item: dict[str, Any] = vault.sealed_item('acct-1', 'openai', 'refresh-token')
    item['encryptedDataKey'] = value
    vault.table.put_item(Item=item)

    with pytest.raises(CredentialServiceError, match='Credential vault record missing encryptedDataKey'):
        vault.load_durable_credential('acct-1', 'openai')


def test_non_base64_bytes_in_an_encrypted_field_are_not_silently_ignored(vault: DynamoDbCredentialVault) -> None:
    import binascii

    item = vault.sealed_item('acct-1', 'openai', 'refresh-token')
    item['ciphertext'] += '!'
    vault.table.put_item(Item=item)

    with pytest.raises(binascii.Error):
        vault.load_durable_credential('acct-1', 'openai')


def test_loading_an_absent_credential_names_the_missing_account_and_provider(vault: DynamoDbCredentialVault) -> None:
    with pytest.raises(CredentialNotFound, match='No durable credential for account acct-1 and provider openai'):
        vault.load_durable_credential('acct-1', 'openai')


def test_deletion_between_read_and_lease_is_reported_as_a_missing_credential(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('acct-1', 'openai', 'refresh-token')
    revision = vault.load_credential_revision('acct-1', 'openai')
    assert vault.delete_durable_credential('acct-1', 'openai') is True

    with pytest.raises(CredentialNotFound, match='No durable credential for account acct-1 and provider openai'):
        vault.take_refresh_lease('acct-1', 'openai', revision=revision, lease='holder', now=0, expires_at=30)


def test_an_empty_durable_credential_reports_its_failure_without_changing_existing_custody(
    vault: DynamoDbCredentialVault,
) -> None:
    vault.store_durable_credential('acct-1', 'openai', 'current-credential')
    vault.store_durable_credential('acct-1', 'other-provider', 'other-credential')
    vault.store_durable_credential('acct-2', 'openai', 'other-account')
    before = vault.table.get_item(Key={'accountId': 'acct-1', 'provider': 'openai'})
    assert 'Item' in before

    with pytest.raises(ValueError, match='durable_credential must not be empty'):
        vault.store_durable_credential('acct-1', 'openai', '')

    after = vault.table.get_item(Key={'accountId': 'acct-1', 'provider': 'openai'})
    assert 'Item' in after
    assert after['Item'] == before['Item']
    assert vault.load_durable_credential('acct-1', 'openai') == 'current-credential'
    assert vault.load_durable_credential('acct-1', 'other-provider') == 'other-credential'
    assert vault.load_durable_credential('acct-2', 'openai') == 'other-account'
