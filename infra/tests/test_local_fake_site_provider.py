"""The local Credential Service's fake-site provider (local/stand-ins/fake_site_provider.py)."""

from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fake_site_provider import FakeSiteProvider
from fastapi.testclient import TestClient

from botcube_credential_service.resolved_config import load_resolved_config
from botcube_credential_service.server import CredentialServiceSettings, create_app
from botcube_credential_service.vault import DynamoDbCredentialVault
from local_stand_in_support import (
    ACCOUNT,
    LocalKeys,
    authorization,
    running_fake_site,
    vault_table,
)


@pytest.fixture
def table() -> Iterator[Any]:
    with vault_table() as created:
        yield created


@pytest.mark.integration
def test_link_relay_and_unlink_keep_durable_credential_in_encrypted_vault(table: Any) -> None:
    with running_fake_site() as site:
        url = f'http://127.0.0.1:{site.server_port}'
        vault = DynamoDbCredentialVault(table, LocalKeys())
        app = create_app(
            CredentialServiceSettings('local', lambda: 'local-secret'),
            [FakeSiteProvider(lambda: vault, url)],
            config=load_resolved_config()['config'],
        )
        with TestClient(app) as client:
            assert client.get('/fake-site/data', headers=authorization()).json()['code'] == 'SIGN_IN_NEEDED'
            credential = httpx.post(f'{url}/login').json()['credential']
            linked = client.post('/fake-site/auth/link/ingest', headers=authorization('credential_capture'), json={'credential': credential})
            assert linked.json() == {'status': 'linked'}
            assert credential not in repr(table.get_item(Key={'accountId': ACCOUNT, 'provider': 'fake-site'})['Item'])
            assert client.get('/fake-site/data', headers=authorization()).json() == {'items': [{'name': 'Sample item', 'value': 42}]}
            stored = repr(table.get_item(Key={'accountId': ACCOUNT, 'provider': 'fake-site'})['Item'])
            assert site.access and all(access not in stored for access in site.access)
            assert client.get('/fake-site/auth/status', headers=authorization()).json() == {'status': 'linked'}
            assert client.get('/fake-site/login', headers=authorization()).status_code == 403
            assert client.get('/fake-site/data?destination=evil', headers=authorization()).status_code == 403
            assert client.post('/fake-site/auth/link/revoke', headers=authorization('credential_revocation')).json() == {'status': 'revoked'}
            assert client.get('/fake-site/data', headers=authorization()).status_code == 401
            assert client.get('/fake-site/auth/status', headers=authorization()).json() == {'status': 'not_linked'}


@pytest.mark.integration
def test_relay_reuses_the_sites_access_until_the_site_ends_it_then_re_mints_once(table: Any) -> None:
    with running_fake_site() as site:
        url = f'http://127.0.0.1:{site.server_port}'
        vault = DynamoDbCredentialVault(table, LocalKeys())

        def app() -> Any:
            return create_app(CredentialServiceSettings('local', lambda: 'local-secret'), [FakeSiteProvider(lambda: vault, url)], config=load_resolved_config()['config'])

        with TestClient(app()) as client:
            credential = httpx.post(f'{url}/login').json()['credential']
            client.post('/fake-site/auth/link/ingest', headers=authorization('credential_capture'), json={'credential': credential})

            assert client.get('/fake-site/data', headers=authorization()).status_code == 200
            assert client.get('/fake-site/data', headers=authorization()).status_code == 200
            assert len(site.access) == 1
        with TestClient(app()) as cold:
            assert cold.get('/fake-site/data', headers=authorization()).json() == {'items': [{'name': 'Sample item', 'value': 42}]}
            assert len(site.access) == 1
            site.access.clear()
            assert cold.get('/fake-site/data', headers=authorization()).status_code == 200
            assert len(site.access) == 1
        with TestClient(app()) as later:
            assert later.get('/fake-site/data', headers=authorization()).status_code == 200
            assert len(site.access) == 1


def test_status_does_not_hide_vault_failure() -> None:

    def failed_vault() -> DynamoDbCredentialVault:
        raise RuntimeError('vault unavailable')

    provider = FakeSiteProvider(failed_vault, 'http://127.0.0.1:1')
    app = create_app(
        CredentialServiceSettings('local', lambda: 'local-secret'),
        [provider],
        config=load_resolved_config()['config'],
    )
    with TestClient(app) as client, pytest.raises(RuntimeError, match='vault unavailable'):
        client.get('/fake-site/auth/status', headers=authorization())
