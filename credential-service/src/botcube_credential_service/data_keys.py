from __future__ import annotations

import json
import os
from pathlib import Path
from secrets import token_bytes
from typing import TYPE_CHECKING, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

if TYPE_CHECKING:
    from types_boto3_kms import KMSClient


class DataKeyProvider(Protocol):
    def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
        """Return (plaintext DEK, encrypted DEK) bound to the encryption context."""
        ...

    def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
        """Return the plaintext DEK of an encrypted DEK bound to the encryption context."""
        ...



class Boto3KmsDataKeyProvider:
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



class LocalDataKeyProvider:
    """A local stack's stand-in for KMS: data keys wrapped by a key kept in a file, made on first use."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            with path.open('xb') as output:
                os.chmod(path, 0o600)
                output.write(AESGCM.generate_key(bit_length=256))
        self._key = AESGCM(path.read_bytes())

    def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
        key = AESGCM.generate_key(bit_length=256)
        nonce = token_bytes(12)
        encrypted = self._key.encrypt(nonce, key, json.dumps(encryption_context, sort_keys=True).encode())
        return key, nonce + encrypted

    def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
        return self._key.decrypt(encrypted_data_key[:12], encrypted_data_key[12:], json.dumps(encryption_context, sort_keys=True).encode())

