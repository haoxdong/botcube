from __future__ import annotations

import json
import os
from pathlib import Path
from secrets import token_bytes

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class LocalDataKeyProvider:
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
