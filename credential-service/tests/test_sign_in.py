import asyncio
import base64
import json
from collections.abc import Mapping

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from botcube_credential_service.sign_in import (
    InputField,
    NotEncryptedToCredentialService,
    SheetKey,
    SignInPageChanged,
    type_credentials,
)


class Page:
    def __init__(self, origin: str) -> None:
        self.origin = origin
        self.calls: list[tuple[str, Mapping[str, object]]] = []

    async def send(self, method: str, params: Mapping[str, object]) -> Mapping[str, object]:
        self.calls.append((method, params))
        if method == 'Runtime.evaluate':
            return {'result': {'value': {'origin': self.origin, 'path': '/login', 'name': 'username', 'type': 'text'}}}
        return {}


def test_sealed_input_is_opened_only_by_its_process_key() -> None:
    key = SheetKey()
    public = serialization.load_der_public_key(base64.b64decode(key.public_key()))
    assert isinstance(public, rsa.RSAPublicKey)
    sealed = base64.b64encode(public.encrypt(
        json.dumps({'username': 'person@example.test', 'password': 'test-password'}).encode(),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )).decode()
    assert key.open(sealed) == ('person@example.test', 'test-password')
    with pytest.raises(NotEncryptedToCredentialService):
        SheetKey().open(sealed)


@pytest.mark.parametrize('origin', ['https://login.example.test', 'https://other.example.test'])
def test_only_trusted_origins_receive_input(origin: str) -> None:
    page = Page(origin)
    field = InputField('username', 'input[name="username"]', lambda active: active.get('name') == 'username')
    operation = type_credentials(page, ((field, 'person@example.test'),),
                                 origins=frozenset({'https://login.example.test'}), origin_error='Untrusted sign-in origin')
    if origin == 'https://login.example.test':
        asyncio.run(operation)
        assert [method for method, _ in page.calls] == [
            'Runtime.evaluate', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
        ]
    else:
        with pytest.raises(SignInPageChanged, match='Untrusted'):
            asyncio.run(operation)
        assert [method for method, _ in page.calls] == ['Runtime.evaluate']
