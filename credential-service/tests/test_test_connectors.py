from __future__ import annotations

import pytest
from botocore.exceptions import ClientError

import test_vault
from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.vault import CredentialNotFound, DynamoDbCredentialVault

vault = test_vault.vault


def test_each_run_reseals_an_independent_connector_and_owner_unlink_revokes_all(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('owner', 'site', 'first-credential')
    vault.store_durable_credential('unrelated', 'site', 'unrelated-credential')
    def copy(target: str) -> None:
        vault.copy_test_connector('owner', target, 'site',
                            audit=CredentialAuditRecorder(), request_context={'scope': 'test_user_copy'})
    copy('test-one')
    first = vault.load_credential_revision('test-one', 'site')
    vault.store_durable_credential('owner', 'site', 'fresh-credential')
    copy('test-one')
    copy('test-two')
    assert vault.load_durable_credential('test-one', 'site') == 'fresh-credential'
    assert vault.load_credential_revision('test-one', 'site') != first
    assert vault.load_credential_revision('test-one', 'site') != vault.load_credential_revision('owner', 'site')

    vault.delete_durable_credential('owner', 'site')

    for user in ['owner', 'test-one', 'test-two']:
        with pytest.raises(CredentialNotFound):
            vault.load_durable_credential(user, 'site')
    assert vault.load_durable_credential('unrelated', 'site') == 'unrelated-credential'
    assert vault.table.query(KeyConditionExpression='accountId = :id', ExpressionAttributeValues={':id': 'owner'}).get('Items') == []


def test_deleting_a_test_user_preserves_the_owner_and_other_copies(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('owner', 'site', 'credential')
    for user in ['test-one', 'test-two']:
        vault.copy_test_connector('owner', user, 'site', audit=CredentialAuditRecorder(), request_context={})
    vault.delete_durable_credential('test-one', 'site')
    with pytest.raises(CredentialNotFound):
        vault.load_durable_credential('test-one', 'site')
    assert vault.load_durable_credential('test-two', 'site') == 'credential'
    assert vault.load_durable_credential('owner', 'site') == 'credential'


def test_operator_cannot_replace_a_normal_users_connector_with_a_test_copy(vault: DynamoDbCredentialVault) -> None:
    vault.store_durable_credential('owner', 'site', 'owner-credential')
    vault.store_durable_credential('normal-user', 'site', 'normal-credential')
    with pytest.raises(ClientError):
        vault.copy_test_connector('owner', 'normal-user', 'site', audit=CredentialAuditRecorder(), request_context={})
    assert vault.load_durable_credential('normal-user', 'site') == 'normal-credential'


def test_copy_endpoint_requires_operator_scope_and_never_returns_the_credential(vault: DynamoDbCredentialVault) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from botcube_credential_service.invocation import sign_credential_service_invocation
    from botcube_credential_service.server import InvocationGuard
    from botcube_credential_service.test_connectors import test_connector_routes

    vault.store_durable_credential('owner', 'site', 'private-credential')
    app = FastAPI()
    app.include_router(test_connector_routes(InvocationGuard(lambda: 'operator-secret'), lambda: vault,
                                             'site', lambda: 'owner', CredentialAuditRecorder()))
    client = TestClient(app)
    assert client.post('/auth/test-user-copy').status_code == 401
    regular = sign_credential_service_invocation('operator-secret', 'test-one', 'run')
    assert client.post('/auth/test-user-copy', headers={'authorization': 'Bearer ' + regular}).status_code == 401
    operator = sign_credential_service_invocation('operator-secret', 'test-one', 'run', scope='test_user_copy')
    response = client.post('/auth/test-user-copy', headers={'authorization': 'Bearer ' + operator})
    assert response.status_code == 200
    assert response.json() == {'status': 'stored'}
    assert vault.load_durable_credential('test-one', 'site') == 'private-credential'
