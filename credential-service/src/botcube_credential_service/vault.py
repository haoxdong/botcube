from __future__ import annotations

import base64
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from secrets import token_bytes
from typing import TYPE_CHECKING, Any, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .audit import CredentialAuditRecorder

if TYPE_CHECKING:
    from types_boto3_dynamodb.service_resource import Table
    from types_boto3_kms import KMSClient


class CredentialServiceError(RuntimeError):
    """The Credential Service could not produce usable access from a Durable Credential."""


class CredentialNotFound(CredentialServiceError):
    """No Durable Credential is vaulted for this account and provider."""


class RefreshLeaseHeld(CredentialServiceError):
    """Another task holds an unexpired refresh lease on the credential, or rotated it since it was read."""

    def __init__(self, revision: str) -> None:
        super().__init__('Another task holds the refresh lease or rotated the credential')
        # The revision the Vault holds now.
        self.revision = revision


class RotationLost(CredentialServiceError):
    """A rotated credential's write-back lost: another write replaced the credential or took over its lease."""

    def __init__(self, message: str, *, current_revision: str | None = None) -> None:
        super().__init__(message)
        self.current_revision = current_revision


class RotationStoredButRefused(CredentialServiceError):
    """A conditional refusal proves this exact write landed, but the refusal must be reported."""

    def __init__(self, revision: str) -> None:
        super().__init__('The conditional write was refused after this rotated credential was stored')
        self.revision = revision


# AES-GCM associated data of every Vault item; `{provider}:{account id}` follows it.
ASSOCIATED_DATA_PREFIX = 'botcube-vault:v1:'
_PROVIDER_NAME = re.compile(r'[a-z0-9][a-z0-9_-]*')


def encryption_context(account_id: str, provider: str) -> dict[str, str]:
    """The KMS encryption context binding a Vault item's data key to its account and provider."""
    return {'accountId': account_id, 'provider': provider}


class DataKeyProvider(Protocol):
    def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
        """Return (plaintext DEK, encrypted DEK) bound to the encryption context."""
        ...

    def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
        """Return the plaintext DEK of an encrypted DEK bound to the encryption context."""
        ...


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
    """Envelope-encrypted Durable Credential store keyed by (accountId, provider)."""

    def __init__(self, table: Table, kms: DataKeyProvider) -> None:
        self.table = table
        self.kms = kms

    def sealed_item(self, account_id: str, provider: str, durable_credential: str) -> dict[str, str]:
        """The Vault item holding a Durable Credential, encrypted under a fresh data key."""
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

    def delete_durable_credential(self, account_id: str, provider: str) -> bool:
        response = self.table.delete_item(Key=_item_key(account_id, provider), ReturnValues='ALL_OLD')
        return 'Attributes' in response


class Boto3KmsDataKeyProvider:
    """AWS KMS data-key provider for the isolated Credential Service process."""

    def __init__(
        self,
        *,
        key_id: str,
        region_name: str | None = None,
        client: KMSClient | None = None,
    ) -> None:
        if not key_id:
            raise ValueError('key_id must not be empty')
        if client is None:
            import boto3

            client = boto3.client('kms', region_name=region_name)
        self.key_id = key_id
        self.client = client

    def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
        response = self.client.generate_data_key(
            KeyId=self.key_id,
            KeySpec='AES_256',
            EncryptionContext=encryption_context,
        )
        return bytes(response['Plaintext']), bytes(response['CiphertextBlob'])

    def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
        response = self.client.decrypt(CiphertextBlob=encrypted_data_key, EncryptionContext=encryption_context)
        return bytes(response['Plaintext'])


def seal(
    kms: DataKeyProvider, plaintext: str, encryption_context: dict[str, str], associated_data: bytes,
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
    kms: DataKeyProvider, record: Mapping[str, Any], encryption_context: dict[str, str], associated_data: bytes,
) -> str:
    """Decrypt what `seal` wrote, under the same encryption context and associated data."""
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
