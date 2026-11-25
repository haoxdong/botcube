import json
from io import BytesIO
from pathlib import Path

import boto3
import certifi
import httpx
import pytest
from botcube_credential_source import credential_source
from botocore.stub import Stubber
from fastapi.testclient import TestClient

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.invocation import sign_credential_service_invocation
from botcube_credential_service.models import models_provider_from_config
from botcube_credential_service.resolved_config import (
    load_resolved_config,
    resolved_config_from_env,
)
from botcube_credential_service.server import (
    CredentialServiceSettings,
    create_app,
    plan_usage_owner,
)
from botcube_credential_service.stock import stock_credential_service
from required_keys import resolve_file, resolve_sections

BOTCUBE = Path(__file__).resolve().parents[2]
SETTINGS = CredentialServiceSettings('test', lambda: 'secret')


def _start_stock_service() -> None:
    stock_credential_service(lambda: pytest.fail('startup accessed the vault'), SETTINGS.invocation_secret)


@pytest.mark.integration
@pytest.mark.parametrize('source', sorted((BOTCUBE / 'examples').glob('*/botcube.yaml')), ids=lambda path: path.parent.name)
def test_the_service_serves_exactly_the_resolved_model_routes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: Path,
) -> None:
    path = resolve_file(source, tmp_path / 'resolved.json')
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))
    resolved = resolved_config_from_env()
    key = tmp_path / 'models-key'
    key.write_text('stand-in', encoding='utf8')
    monkeypatch.setattr(
        'botcube_credential_service.models.credential_source',
        lambda seam, _source, **options: credential_source(seam, {'kind': 'file', 'path': str(key)}, **options),
    )
    monkeypatch.setattr('botcube_credential_service.models.proxy_url_from_config', lambda *_args: None)
    calls: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, stream=httpx.ByteStream(b'upstream'))

    models = models_provider_from_config(CredentialAuditRecorder(), resolved, transport=httpx.MockTransport(upstream))
    token = sign_credential_service_invocation('secret', 'account', 'session', model_provider='example', model_id='echo')
    headers = {'Authorization': f'Bearer {token}', 'X-BotCube-Session-Id': 'session'}
    with TestClient(create_app(SETTINGS, [models] if models else [], config=resolved['config'])) as client:
        for provider, reach in resolved['modelGateway'].items():
            route = reach['route']
            response = client.post(f'/models/{provider}/probe', headers=headers)
            if route is None:
                assert response.status_code == 404
                assert calls == []
            else:
                assert (response.status_code, response.text) == (200, 'upstream')
                [request] = calls
                calls.clear()
                assert str(request.url) == f"{route['url']}/probe"
                assert request.headers['authorization'] == 'Bearer stand-in'
                assert {name: request.headers[name] for name in route['headers']} == route['headers']


def test_reads_packaged_section_defaults() -> None:
    default = load_resolved_config()
    assert default['config']['integrations']['modelGateway'] == {'kind': 'bedrock'}
    assert default['physicalNames'] == {}
    assert default['webOrigins'] == []
    assert default['credentialServiceHttpPath'] == ''


@pytest.mark.integration
def test_plan_usage_reads_the_resolved_owner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = resolve_sections({'planUsage': {'ownerAccountId': 'acct_owner_1'}}, tmp_path)
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))
    monkeypatch.setenv('BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID', 'acct_other')
    assert plan_usage_owner(resolved_config_from_env()['config']) == 'acct_owner_1'


def test_startup_fails_when_the_resolved_file_is_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / 'missing.json'
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))
    with pytest.raises(FileNotFoundError, match=str(path)):
        _start_stock_service()


@pytest.mark.parametrize('version', ['2', 'true', '1.0', '"1"', 'null'])
def test_startup_requires_the_exact_format_version(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: str) -> None:
    path = tmp_path / 'resolved.json'
    path.write_text('{"formatVersion": ' + version + '}', encoding='utf8')
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))

    with pytest.raises(ValueError, match=f'Resolved BotCube Config {path}: expected formatVersion'):
        _start_stock_service()


@pytest.mark.parametrize(('bundle', 'reason'), [
    ('absent.pem', 'No such file or directory'),
    ('not-a-certificate.pem', 'no certificate or crl found'),
])
@pytest.mark.integration
def test_startup_fails_when_the_resolved_ca_bundle_is_unusable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bundle: str, reason: str,
) -> None:
    (tmp_path / 'not-a-certificate.pem').write_text('not a certificate')
    path = tmp_path / bundle
    monkeypatch.setenv('BOTCUBE_CONFIG', str(resolve_sections({'caBundle': str(path)}, tmp_path)))
    with pytest.raises(RuntimeError, match=f'^caBundle {path}: .*{reason}'):
        _start_stock_service()


@pytest.mark.integration
def test_startup_loads_the_resolved_ca_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_CONFIG', str(resolve_sections({'caBundle': certifi.where()}, tmp_path)))
    _start_stock_service()


def test_reads_the_revision_object_and_names_it_on_access_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    client = boto3.client('s3', region_name='us-east-1', aws_access_key_id='local', aws_secret_access_key='local')
    monkeypatch.setattr(boto3, 'client', lambda service: client)
    target = {'Bucket': 'config-bucket', 'Key': 'resolved/previous.json'}
    locator = 's3://config-bucket/resolved/previous.json'
    monkeypatch.setenv('BOTCUBE_CONFIG', locator)
    previous = load_resolved_config()
    with Stubber(client) as stub:
        stub.add_response('get_object', {'Body': BytesIO(json.dumps(previous).encode())}, target)
        stub.add_client_error('get_object', service_error_code='AccessDenied', expected_params=target)
        _start_stock_service()
        with pytest.raises(ValueError, match=r's3://config-bucket/resolved/previous.json: .*AccessDenied'):
            _start_stock_service()
