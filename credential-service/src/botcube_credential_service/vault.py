from __future__ import annotations

import base64
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from secrets import token_bytes
from typing import TYPE_CHECKING, Any, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import data_keys
from .audit import CredentialAuditRecorder

if TYPE_CHECKING:
    from types_boto3_dynamodb.service_resource import Table


class CredentialServiceError(RuntimeError):
    pass


class CredentialNotFound(CredentialServiceError):
    pass


class RefreshLeaseHeld(CredentialServiceError):

    def __init__(self, revision: str) -> None:
        super().__init__('Another task holds the refresh lease or rotated the credential')
        self.revision = revision


class RotationLost(CredentialServiceError):

    def __init__(self, message: str, *, current_revision: str | None = None) -> None:
        super().__init__(message)
        self.current_revision = current_revision


class RotationStoredButRefused(CredentialServiceError):

    def __init__(self, revision: str) -> None:
        super().__init__('The conditional write was refused after this rotated credential was stored')
        self.revision = revision


# AES-GCM associated data of every Vault item; `{provider}:{account id}` follows it.
ASSOCIATED_DATA_PREFIX = 'botcube-vault:v1:'
_PROVIDER_NAME = re.compile(r'[a-z0-9][a-z0-9_-]*')


def encryption_context(account_id: str, provider: str) -> dict[str, str]:
    return {'accountId': account_id, 'provider': provider}


class CredentialVault(Protocol):
    """The Vault: one Durable Credential per (account, provider) (ADR 0078 decision 3)."""

    def store_durable_credential(self, account_id: str, provider: str, durable_credential: str) -> str | None:
        ...

    def load_durable_credential(
        self,
        account_id: str,
        provider: str,
        *,
        audit: CredentialAuditRecorder | None = None,
        request_context: Mapping[str, Any] | None = None,
    ) -> str:
        """Raise CredentialNotFound when the account holds none for the provider."""
        ...

    def delete_durable_credential(self, account_id: str, provider: str) -> bool:
        """Delete one (account, provider) row; answer whether it existed."""
        ...

    def load_revised_credential(
        self,
        account_id: str,
        provider: str,
        *,
        audit: CredentialAuditRecorder | None = None,
        request_context: Mapping[str, Any] | None = None,
    ) -> RevisedCredential:
        """Read the credential and its revision from the same stored item."""
        ...

    def load_credential_revision(self, account_id: str, provider: str) -> str:
        """Read the current revision without decrypting; raise CredentialNotFound when absent."""
        ...


@dataclass(frozen=True)
class RevisedCredential:
    """A Durable Credential as read, with the revision a conditional replace names."""

    value: str
    # The stored item's ciphertext, new on every store: each seals under a fresh data key and nonce.
    revision: str


@dataclass(frozen=True)
class StoredSession:
    jar: str
    expires_at: float
    revision: str
    token: str


class RotatingCredentialVault(CredentialVault, Protocol):
    """A Vault for Durable Credentials that rotate on use, so each is spent once: under a refresh lease."""

    def take_refresh_lease(
        self, account_id: str, provider: str, *, revision: str, lease: str, now: float, expires_at: float,
    ) -> None:
        """Lease the credential read at `revision` for one refresh, unless another unexpired lease holds it.

        Raise RefreshLeaseHeld, naming the current revision, when another lease holds it or it changed,
        and CredentialNotFound when it is gone.
        """
        ...

    def renew_refresh_lease(
        self, account_id: str, provider: str, *, revision: str, lease: str, expires_at: float,
    ) -> None:
        """Extend only this owner and revision; raise RotationLost if custody changed."""
        ...

    def replace_durable_credential(
        self, account_id: str, provider: str, durable_credential: str, *, revision: str, lease: str,
    ) -> str:
        """Store the rotation, clear `lease`, and return its revision; raise RotationLost unless both still hold."""
        ...


class DynamoDbCredentialVault:
    def __init__(self, table: Table, kms: data_keys.DataKeyProvider) -> None:
        self.table = table
        self.kms = kms

    def sealed_item(self, account_id: str, provider: str, durable_credential: str) -> dict[str, str]:
        key = _item_key(account_id, provider)
        return {**key, **seal(self.kms, durable_credential, _encryption_context(key), _associated_data(key))}

    def store_durable_credential(self, account_id: str, provider: str, durable_credential: str) -> str:
        item = self.sealed_item(account_id, provider, durable_credential)
        self.table.put_item(Item=item)
        return _require_string(item, 'ciphertext')

    def load_durable_credential(
        self,
        account_id: str,
        provider: str,
        *,
        audit: CredentialAuditRecorder | None = None,
        request_context: Mapping[str, Any] | None = None,
    ) -> str:
        return self.load_revised_credential(account_id, provider, audit=audit, request_context=request_context).value

    def load_revised_credential(
        self,
        account_id: str,
        provider: str,
        *,
        audit: CredentialAuditRecorder | None = None,
        request_context: Mapping[str, Any] | None = None,
    ) -> RevisedCredential:
        key = _item_key(account_id, provider)
        record = self.table.get_item(Key=key, ConsistentRead=True).get('Item')
        if not isinstance(record, Mapping):
            raise CredentialNotFound(f'No durable credential for account {key["accountId"]} and provider {provider}')
        if audit is not None:
            audit.record_kms_decrypt(key['accountId'], request_context)
        value = unseal(self.kms, record, _encryption_context(key), _associated_data(key))
        return RevisedCredential(value, _require_string(record, 'ciphertext'))

    def take_refresh_lease(
        self, account_id: str, provider: str, *, revision: str, lease: str, now: float, expires_at: float,
    ) -> None:
        try:
            self.table.update_item(
                Key=_item_key(account_id, provider),
                UpdateExpression='SET refreshLease = :lease, refreshLeaseExpiresAt = :expires',
                ConditionExpression=(
                    'ciphertext = :revision AND (attribute_not_exists(refreshLeaseExpiresAt) OR refreshLeaseExpiresAt <= :now)'
                ),
                ExpressionAttributeValues={
                    ':lease': lease, ':expires': Decimal(str(expires_at)), ':revision': revision, ':now': Decimal(str(now)),
                },
                ReturnValuesOnConditionCheckFailure='ALL_OLD',
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException as failed:
            # The failed condition's item comes back in DynamoDB's attribute-value shape.
            current = failed.response.get('Item', {}).get('ciphertext', {}).get('S')
            if current is None:
                raise CredentialNotFound(f'No durable credential for account {account_id} and provider {provider}') from None
            raise RefreshLeaseHeld(current) from None

    def renew_refresh_lease(
        self, account_id: str, provider: str, *, revision: str, lease: str, expires_at: float,
    ) -> None:
        try:
            self.table.update_item(
                Key=_item_key(account_id, provider),
                UpdateExpression='SET refreshLeaseExpiresAt = :expires',
                ConditionExpression='ciphertext = :revision AND refreshLease = :lease',
                ExpressionAttributeValues={
                    ':expires': Decimal(str(expires_at)), ':revision': revision, ':lease': lease,
                },
                ReturnValuesOnConditionCheckFailure='ALL_OLD',
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException as failed:
            current = failed.response.get('Item', {}).get('ciphertext', {}).get('S')
            raise RotationLost('Refresh lease no longer belongs to this task', current_revision=current) from None

    def load_credential_revision(self, account_id: str, provider: str) -> str:
        revision = self.credential_revision(account_id, provider)
        if revision is None:
            raise CredentialNotFound(f'No durable credential for account {account_id} and provider {provider}')
        return revision

    def credential_revision(self, account_id: str, provider: str) -> str | None:
        key = _item_key(account_id, provider)
        record = self.table.get_item(Key=key, ConsistentRead=True, ProjectionExpression='ciphertext').get('Item')
        if record is None:
            return None
        return _require_string(record, 'ciphertext')

    def replace_durable_credential(
        self, account_id: str, provider: str, durable_credential: str, *, revision: str, lease: str,
    ) -> str:
        # The new item carries no lease, so this one write stores the rotation and clears the lease.
        item = self.sealed_item(account_id, provider, durable_credential)
        try:
            self.table.put_item(
                Item=item,
                ConditionExpression='ciphertext = :revision AND refreshLease = :lease',
                ExpressionAttributeValues={':revision': revision, ':lease': lease},
                ReturnValuesOnConditionCheckFailure='ALL_OLD',
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException as failed:
            current = failed.response.get('Item', {}).get('ciphertext', {}).get('S')
            # The SDK resends a write whose answer it lost; the resend finds this very item already stored.
            if current == item['ciphertext']:
                raise RotationStoredButRefused(current) from failed
            raise RotationLost(
                f'Another write replaced the {provider} credential of account {account_id}',
                current_revision=current,
            ) from failed
        return item['ciphertext']

    def copy_test_connector(
        self, source: str, target: str, provider: str,
        *, audit: CredentialAuditRecorder, request_context: Mapping[str, Any],
    ) -> None:
        source, target, provider = require_account_id(source), require_account_id(target), require_provider(provider)
        if source == target:
            raise CredentialServiceError('A Test User must differ from its credential owner')
        credential = self.load_revised_credential(source, provider, audit=audit, request_context=request_context)
        copied = {**self.sealed_item(target, provider, credential.value), 'copiedFrom': source}
        table = self.table
        table.meta.client.transact_write_items(TransactItems=[
            {'ConditionCheck': {'TableName': table.name, 'Key': {'accountId': source, 'provider': provider},
                                'ConditionExpression': 'ciphertext = :revision',
                                'ExpressionAttributeValues': {':revision': credential.revision}}},
            {'Put': {'TableName': table.name, 'Item': copied,
                     'ConditionExpression': 'attribute_not_exists(accountId) OR copiedFrom = :source',
                     'ExpressionAttributeValues': {':source': source}}},
            {'Put': {'TableName': table.name, 'Item': {
                'accountId': source, 'provider': f'test-copy#{provider}#{target}', 'testUserId': target,
            }}},
        ])


    def delete_durable_credential(self, account_id: str, provider: str) -> bool:
        account_id, provider = require_account_id(account_id), require_provider(provider)
        table = self.table
        key = {'accountId': account_id, 'provider': provider}
        record = table.get_item(Key=key, ConsistentRead=True).get('Item')
        source = record.get('copiedFrom') if record else None
        if isinstance(source, str):
            table.meta.client.transact_write_items(TransactItems=[
                {'Delete': {'TableName': table.name, 'Key': key,
                            'ConditionExpression': 'attribute_not_exists(accountId) OR copiedFrom = :source',
                            'ExpressionAttributeValues': {':source': source}}},
                {'Delete': {'TableName': table.name, 'Key': {
                    'accountId': source, 'provider': f'test-copy#{provider}#{account_id}',
                }}},
            ])
            existed = True
        else:
            existed = 'Attributes' in table.delete_item(Key=key, ReturnValues='ALL_OLD')
        page = table.query(KeyConditionExpression='accountId = :owner AND begins_with(provider, :prefix)',
                           ExpressionAttributeValues={':owner': account_id, ':prefix': f'test-copy#{provider}#'},
                           ConsistentRead=True)
        while True:
            for item in page.get('Items', []):
                target = item.get('testUserId')
                if not isinstance(target, str):
                    raise CredentialServiceError('Test Connector index has no Test User ID')
                self.delete_durable_credential(target, provider)
            last_key = page.get('LastEvaluatedKey')
            if last_key is None:
                return existed
            page = table.query(KeyConditionExpression='accountId = :owner AND begins_with(provider, :prefix)',
                               ExpressionAttributeValues={':owner': account_id, ':prefix': f'test-copy#{provider}#'},
                               ConsistentRead=True, ExclusiveStartKey=last_key)


    def store_session(
        self, account_id: str, provider: str, jar: str, *, revision: str, expires_at: float,
    ) -> str:
        key = _item_key(account_id, provider)
        sealed = seal(self.kms, jar, _encryption_context(key), _session_associated_data(key))
        try:
            self.table.update_item(
                Key=key,
                UpdateExpression=(
                    'SET sessionEncryptedDataKey = :key, sessionNonce = :nonce, sessionCiphertext = :ciphertext,'
                    ' sessionExpiresAt = :expires'
                ),
                ConditionExpression='ciphertext = :revision',
                ExpressionAttributeValues={
                    ':key': sealed['encryptedDataKey'], ':nonce': sealed['nonce'],
                    ':ciphertext': sealed['ciphertext'], ':expires': Decimal(str(expires_at)), ':revision': revision,
                },
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            raise CredentialServiceError('Credential changed during session re-mint; retry the request') from None
        return sealed['ciphertext']

    def load_session(
        self,
        account_id: str,
        provider: str,
        *,
        now: float,
        audit: CredentialAuditRecorder | None = None,
        request_context: Mapping[str, Any] | None = None,
    ) -> StoredSession | None:
        key = _item_key(account_id, provider)
        record = self.table.get_item(
            Key=key,
            ConsistentRead=True,
            ProjectionExpression='ciphertext, sessionEncryptedDataKey, sessionNonce, sessionCiphertext, sessionExpiresAt',
        ).get('Item')
        if not isinstance(record, Mapping) or 'sessionCiphertext' not in record:
            return None
        expires_at = record.get('sessionExpiresAt')
        if not isinstance(expires_at, Decimal):
            raise CredentialServiceError('Credential vault record missing sessionExpiresAt')
        if float(expires_at) <= now:
            return None
        if audit is not None:
            audit.record_kms_decrypt(key['accountId'], request_context)
        sealed = {
            'encryptedDataKey': record.get('sessionEncryptedDataKey'),
            'nonce': record.get('sessionNonce'),
            'ciphertext': record.get('sessionCiphertext'),
        }
        jar = unseal(self.kms, sealed, _encryption_context(key), _session_associated_data(key))
        return StoredSession(
            jar=jar, expires_at=float(expires_at), revision=_require_string(record, 'ciphertext'),
            token=_require_string(sealed, 'ciphertext'),
        )

    def discard_session(self, account_id: str, provider: str, *, token: str) -> bool:
        try:
            self.table.update_item(
                Key=_item_key(account_id, provider),
                UpdateExpression='REMOVE sessionEncryptedDataKey, sessionNonce, sessionCiphertext, sessionExpiresAt',
                ConditionExpression='sessionCiphertext = :token',
                ExpressionAttributeValues={':token': token},
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return False
        return True


def seal(
    kms: data_keys.DataKeyProvider, plaintext: str, encryption_context: dict[str, str], associated_data: bytes,
) -> dict[str, str]:
    """Envelope-encrypt one secret: AES-GCM under a per-item KMS data key, both bound to the item."""
    if not plaintext:
        raise ValueError('durable_credential must not be empty')
    plaintext_key, encrypted_key = kms.generate_data_key(encryption_context)
    nonce = token_bytes(12)
    ciphertext = AESGCM(plaintext_key).encrypt(nonce, plaintext.encode('utf-8'), associated_data)
    return {
        'encryptedDataKey': _b64encode(encrypted_key),
        'nonce': _b64encode(nonce),
        'ciphertext': _b64encode(ciphertext),
    }


def unseal(
    kms: data_keys.DataKeyProvider, record: Mapping[str, Any], encryption_context: dict[str, str], associated_data: bytes,
) -> str:
    encrypted_key = _b64decode(_require_string(record, 'encryptedDataKey'))
    nonce = _b64decode(_require_string(record, 'nonce'))
    ciphertext = _b64decode(_require_string(record, 'ciphertext'))
    plaintext_key = kms.decrypt_data_key(encrypted_key, encryption_context)
    return AESGCM(plaintext_key).decrypt(nonce, ciphertext, associated_data).decode('utf-8')


def require_account_id(value: str) -> str:
    account_id = str(value).strip()
    if not account_id:
        raise ValueError('account_id must not be empty')
    return account_id


def require_provider(value: str) -> str:
    if not _PROVIDER_NAME.fullmatch(value):
        raise ValueError(f'provider must be a lowercase name, not {value!r}')
    return value


def _item_key(account_id: str, provider: str) -> dict[str, str]:
    return {'accountId': require_account_id(account_id), 'provider': require_provider(provider)}


def _associated_data(key: Mapping[str, str]) -> bytes:
    return f'{ASSOCIATED_DATA_PREFIX}{key["provider"]}:{key["accountId"]}'.encode()


def _session_associated_data(key: Mapping[str, str]) -> bytes:
    """Distinct from the credential's, so a stored session can never be unsealed as the Durable Credential."""
    return f'{ASSOCIATED_DATA_PREFIX}session:{key["provider"]}:{key["accountId"]}'.encode()


def _encryption_context(key: Mapping[str, str]) -> dict[str, str]:
    return encryption_context(key['accountId'], key['provider'])


def _require_string(record: Mapping[str, Any], key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise CredentialServiceError(f'Credential vault record missing {key}')
    return value


def _b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode('ascii')


def _b64decode(value: str) -> bytes:
    return base64.b64decode(value.encode('ascii'), validate=True)
