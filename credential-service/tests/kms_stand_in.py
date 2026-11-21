"""An offline KMS for the Sign-in Sheet's key: keys by ARN, aliases that move between them, real RSA-OAEP-256, and refusals on demand."""

from __future__ import annotations

import uuid
from typing import Any

from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

REGION_ACCOUNT = 'arn:aws:kms:us-east-1:000000000000'
_OAEP = padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


class KmsStandIn:
    def __init__(self) -> None:
        self._keys: dict[str, tuple[str, str, rsa.RSAPrivateKey | None]] = {}
        self._aliases: dict[str, str] = {}
        self._refusals: dict[str, str] = {}

    def create_key(self, key_spec: str = 'RSA_2048', key_usage: str = 'ENCRYPT_DECRYPT') -> str:
        arn = f'{REGION_ACCOUNT}:key/{uuid.uuid4()}'
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048) if key_spec.startswith('RSA_') else None
        self._keys[arn] = (key_spec, key_usage, private)
        return arn

    def point_alias(self, alias_arn: str, key_arn: str) -> None:
        self._aliases[alias_arn] = key_arn

    def refuse(self, operation: str, code: str) -> None:
        self._refusals[operation] = code

    def describe_key(self, *, KeyId: str) -> dict[str, Any]:
        arn = self._resolve(KeyId, 'describe_key')
        key_spec, key_usage, _ = self._keys[arn]
        return {'KeyMetadata': {'KeyId': arn.rsplit('/', 1)[1], 'Arn': arn, 'KeySpec': key_spec, 'KeyUsage': key_usage}}

    def get_public_key(self, *, KeyId: str) -> dict[str, Any]:
        arn = self._resolve(KeyId, 'get_public_key')
        der = self._private(arn).public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        return {'KeyId': arn, 'PublicKey': der}

    def decrypt(self, *, KeyId: str, CiphertextBlob: bytes, EncryptionAlgorithm: str) -> dict[str, Any]:
        arn = self._resolve(KeyId, 'decrypt')
        try:
            return {'KeyId': arn, 'Plaintext': self._private(arn).decrypt(CiphertextBlob, _OAEP)}
        except ValueError:
            raise _error('InvalidCiphertextException') from None

    def _resolve(self, key_id: str, operation: str) -> str:
        if operation in self._refusals:
            raise _error(self._refusals[operation])
        arn = self._aliases.get(key_id, key_id)
        if arn not in self._keys:
            raise _error('NotFoundException')
        return arn

    def _private(self, arn: str) -> rsa.RSAPrivateKey:
        private = self._keys[arn][2]
        if private is None:
            raise _error('UnsupportedOperationException')
        return private


def _error(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': code}}, 'KMS')
