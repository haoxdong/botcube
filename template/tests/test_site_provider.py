import json
import threading
from typing import Any

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

from botcube_credential_service.invocation import sign_credential_service_invocation
from botcube_credential_service.server import CredentialServiceSettings, create_app
from botcube_credential_service.vault import DynamoDbCredentialVault
from botcube_template.fake_site import FakeSiteServer
from botcube_template.site_provider import FakeSiteProvider


class LocalTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, str]] = {}

    def put_item(self, *, Item: dict[str, str]) -> None:
        self.items[(Item['accountId'], Item['provider'])] = Item

    def get_item(self, *, Key: dict[str, str], **_kwargs: Any) -> dict[str, object]:
        item = self.items.get((Key['accountId'], Key['provider']))
        return {'Item': item} if item else {}

    def delete_item(self, *, Key: dict[str, str], **_kwargs: Any) -> dict[str, object]:
        item = self.items.pop((Key['accountId'], Key['provider']), None)
        return {'Attributes': item} if item else {}


class LocalKeys:
    def __init__(self) -> None:
        self.key = AESGCM.generate_key(bit_length=256)

    def generate_data_key(self, encryption_context: dict[str, str]) -> tuple[bytes, bytes]:
        key = AESGCM.generate_key(bit_length=256)
        return key, AESGCM(self.key).encrypt(bytes(12), key, json.dumps(encryption_context).encode())

    def decrypt_data_key(self, encrypted_data_key: bytes, encryption_context: dict[str, str]) -> bytes:
        return AESGCM(self.key).decrypt(bytes(12), encrypted_data_key, json.dumps(encryption_context).encode())


def authorization(scope: str | None = None) -> dict[str, str]:
    return {
        'Authorization': 'Bearer ' + sign_credential_service_invocation('local-secret', 'template-user', 'session', scope=scope),
        'X-Template-Session': 'session',
    }


def test_link_relay_and_unlink_keep_durable_credential_in_encrypted_vault() -> None:
    site = FakeSiteServer(('127.0.0.1', 0))
    thread = threading.Thread(target=site.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{site.server_port}'
    table = LocalTable()
    vault = DynamoDbCredentialVault(table, LocalKeys())
    app = create_app(
        CredentialServiceSettings('template', lambda: 'local-secret', 'X-Template-Account', 'X-Template-Session'),
        [FakeSiteProvider(lambda: vault, url)],
    )
    try:
        with TestClient(app) as client:
            assert client.get('/fake-site/data', headers=authorization()).json()['code'] == 'SIGN_IN_NEEDED'
            credential = httpx.post(f'{url}/login').json()['credential']
            linked = client.post('/fake-site/auth/link/ingest', headers=authorization('credential_capture'), json={'credential': credential})
            assert linked.json() == {'status': 'linked'}
            assert credential not in json.dumps(table.items['template-user', 'fake-site'])
            assert client.get('/fake-site/data', headers=authorization()).json() == {'items': [{'name': 'Sample item', 'value': 42}]}
            assert client.get('/fake-site/auth/status', headers=authorization()).json() == {'status': 'linked'}
            assert client.get('/fake-site/login', headers=authorization()).status_code == 403
            assert client.get('/fake-site/data?destination=evil', headers=authorization()).status_code == 403
            assert client.post('/fake-site/auth/link/revoke', headers=authorization('credential_revocation')).json() == {'status': 'revoked'}
            assert client.get('/fake-site/data', headers=authorization()).status_code == 401
            assert client.get('/fake-site/auth/status', headers=authorization()).json() == {'status': 'not_linked'}
    finally:
        site.shutdown()
        site.server_close()
        thread.join()


def test_status_does_not_hide_vault_failure() -> None:
    import pytest

    def failed_vault() -> DynamoDbCredentialVault:
        raise RuntimeError('vault unavailable')

    provider = FakeSiteProvider(failed_vault, 'http://127.0.0.1:1')
    app = create_app(
        CredentialServiceSettings('template', lambda: 'local-secret', 'X-Template-Account', 'X-Template-Session'),
        [provider],
    )
    with TestClient(app) as client, pytest.raises(RuntimeError, match='vault unavailable'):
        client.get('/fake-site/auth/status', headers=authorization())
