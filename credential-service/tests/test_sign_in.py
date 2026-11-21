import asyncio
import base64
import json
from collections.abc import Mapping

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from botcube_credential_service.sign_in import (
    InputField,
    KmsSheetKey,
    NotEncryptedToCredentialService,
    SheetKey,
    SheetKeyMisconfigured,
    SignInPageChanged,
    type_credentials,
)
from kms_stand_in import REGION_ACCOUNT, KmsStandIn

ALIAS = f'{REGION_ACCOUNT}:alias/sign-in-sheet'


class Page:
    def __init__(self, origin: str) -> None:
        self.origin = origin
        self.calls: list[tuple[str, Mapping[str, object]]] = []

    async def send(self, method: str, params: Mapping[str, object]) -> Mapping[str, object]:
        self.calls.append((method, params))
        if method == 'Runtime.evaluate':
            return {'result': {'value': {'origin': self.origin, 'path': '/login', 'name': 'username', 'type': 'text'}}}
        return {}


def _seal(public_key: str, credentials: object) -> str:
    public = serialization.load_der_public_key(base64.b64decode(public_key))
    assert isinstance(public, rsa.RSAPublicKey)
    return base64.b64encode(public.encrypt(
        json.dumps(credentials).encode(),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )).decode()


def test_sealed_input_is_opened_only_by_its_process_key() -> None:
    key = SheetKey()
    published = key.public_key()
    sealed = _seal(published.public_key, {'username': 'person@example.test', 'password': 'test-password'})
    assert key.open(sealed, published.key_id) == ('person@example.test', 'test-password')
    other = SheetKey()
    with pytest.raises(NotEncryptedToCredentialService):
        other.open(sealed, other.public_key().key_id)


@pytest.mark.parametrize(('key_spec', 'key_usage'), [('SYMMETRIC_DEFAULT', 'ENCRYPT_DECRYPT'), ('RSA_2048', 'SIGN_VERIFY'), ('ECC_NIST_P256', 'SIGN_VERIFY')])
def test_an_alias_naming_a_key_that_is_not_rsa_for_encryption_stops_startup_naming_the_field(key_spec: str, key_usage: str) -> None:
    kms = KmsStandIn()
    key = kms.create_key(key_spec, key_usage)
    kms.point_alias(ALIAS, key)

    with pytest.raises(SheetKeyMisconfigured) as refused:
        KmsSheetKey(ALIAS, kms)

    assert str(refused.value) == (
        f'supplied.kmsKeys.sheet: {ALIAS} names {key}, a {key_spec} key for {key_usage}; '
        'the Sign-in Sheet needs an RSA key for ENCRYPT_DECRYPT'
    )


def test_an_alias_that_names_no_key_stops_startup_naming_the_field() -> None:
    with pytest.raises(SheetKeyMisconfigured, match=f'^supplied.kmsKeys.sheet: {ALIAS} could not be described: NotFoundException'):
        KmsSheetKey(ALIAS, KmsStandIn())


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
