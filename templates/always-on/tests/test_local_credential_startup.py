from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Thread
from typing import Any, cast

import boto3
import httpx
import pytest
from moto.server import ThreadedMotoServer

from botcube_always_on.fake_site import FakeSiteServer
from test_site_provider import authorization

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


@contextmanager
def credential_process(environment: dict[str, str], log: Path) -> Iterator[str]:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with log.open('w') as output:
        process = subprocess.Popen(
            [sys.executable, '-m', 'botcube_always_on.credential_service'],
            env={**environment, 'PORT': str(port)}, stdout=output, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 10
            while True:
                assert process.poll() is None, log.read_text()
                try:
                    response = httpx.get(f'{url}/health', timeout=0.5)
                    assert response.status_code == 200, response.text
                    break
                except httpx.ConnectError:
                    assert time.monotonic() < deadline, log.read_text()
                    time.sleep(0.05)
            yield url
        finally:
            process.terminate()
            process.wait(timeout=5)


def test_compose_local_credentials_boot_link_persist_and_revoke(tmp_path: Path) -> None:
    dynamodb = ThreadedMotoServer(ip_address='127.0.0.1', port=0, verbose=False)
    dynamodb.start()
    site = FakeSiteServer(('127.0.0.1', 0))
    thread = Thread(target=site.serve_forever, daemon=True)
    thread.start()
    host, port = dynamodb.get_host_and_port()
    endpoint = f'http://{host}:{port}'
    key = tmp_path / 'vault' / 'key'
    environment = {
        **os.environ, 'AWS_ACCESS_KEY_ID': 'local', 'AWS_SECRET_ACCESS_KEY': 'local',
        'AWS_SESSION_TOKEN': '', 'AWS_DEFAULT_REGION': 'us-east-1', 'AGENTCORE_REGION': 'us-east-1',
        'AWS_ENDPOINT_URL_DYNAMODB': endpoint, 'BOTCUBE_VAULT_TABLE': 'credential-vault',
        'BOTCUBE_VAULT_KMS_KEY_ID': '', 'BOTCUBE_LOCAL_VAULT_KEY_FILE': str(key),
        'BOTCUBE_CREDENTIAL_INVOCATION_SECRET': 'local-secret',
        'TEMPLATE_SITE_URL': f'http://127.0.0.1:{site.server_port}',
    }
    try:
        dynamodb_resource = cast("Any", boto3.resource(
            'dynamodb', endpoint_url=endpoint, region_name='us-east-1',
            aws_access_key_id='local', aws_secret_access_key='local',
        ))
        table = dynamodb_resource.create_table(
            TableName='credential-vault', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'accountId', 'KeyType': 'HASH'}, {'AttributeName': 'provider', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'accountId', 'AttributeType': 'S'}, {'AttributeName': 'provider', 'AttributeType': 'S'}],
        )
        credential = httpx.post(f'{environment["TEMPLATE_SITE_URL"]}/login').json()['credential']
        with credential_process(environment, tmp_path / 'initial.log') as url:
            assert httpx.get(f'{url}/fake-site/data').status_code == 401
            linked = httpx.post(f'{url}/fake-site/auth/link/ingest', headers=authorization('credential_capture'),
                                json={'credential': credential})
            assert linked.json() == {'status': 'linked'}
            assert httpx.get(f'{url}/fake-site/data', headers=authorization()).json() == {
                'items': [{'name': 'Sample item', 'value': 42}],
            }
        item_key = {'accountId': 'template-user', 'provider': 'fake-site'}
        assert credential not in repr(table.get_item(Key=item_key)['Item'])
        assert key.stat().st_mode & 0o777 == 0o600
        with credential_process(environment, tmp_path / 'restarted.log') as url:
            assert httpx.get(f'{url}/fake-site/data', headers=authorization()).status_code == 200
            revoked = httpx.post(f'{url}/fake-site/auth/link/revoke', headers=authorization('credential_revocation'))
            assert revoked.json() == {'status': 'revoked'}
            assert httpx.get(f'{url}/fake-site/data', headers=authorization()).json()['code'] == 'SIGN_IN_NEEDED'
        assert 'Item' not in table.get_item(Key=item_key)
    finally:
        site.shutdown()
        site.server_close()
        thread.join(timeout=5)
        dynamodb.stop()
