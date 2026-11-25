import json
import os
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import boto3
import pytest
from botcube_config.resolved_config import load_resolved_config
from botocore.stub import Stubber

from botcube_harness_deepagents.deployment import deployed_config
from deployment_fixture import BOTCUBE, resolve


@pytest.mark.integration
@pytest.mark.parametrize(('example', 'origins'), [
    ('public', ['https://chat.example.invalid', 'https://www.chat.example.invalid']),
    ('enterprise', ['http://localhost:3001', 'http://127.0.0.1:3001']),
])
def test_reads_a_resolved_example(tmp_path: Path, example: str, origins: list[str]) -> None:
    source = BOTCUBE / 'examples' / example / 'botcube.yaml'
    config = load_resolved_config(resolve(source, tmp_path / 'resolved.json'))

    assert config['physicalNames']['runtimeAgentRuntimeName'] == 'bot_cube_runtime'
    assert config['webOrigins'] == origins
    assert config['credentialServiceHttpPath'] == ''
    routes = config['modelGateway']
    assert {provider for provider in ('anthropic', 'openai', 'deepseek', 'echo') if routes[provider]['route'] is not None} == (
        {'openai'} if example == 'enterprise' else set()
    )


def test_reads_packaged_section_defaults() -> None:
    default = load_resolved_config()
    assert default['config']['integrations']['modelGateway']['kind'] == 'bedrock'
    assert default['physicalNames'] == {}
    assert default['webOrigins'] == []


@pytest.mark.integration
def test_the_harness_exits_at_startup_naming_its_missing_config(tmp_path: Path) -> None:
    path = tmp_path / 'absent.json'
    started = subprocess.run(
        [sys.executable, '-m', 'botcube_harness_deepagents.serving'],
        env={**os.environ, 'BOTCUBE_CONFIG': str(path)},
        capture_output=True, text=True, timeout=60, check=False,
    )

    assert started.returncode != 0
    assert 'FileNotFoundError' in started.stderr
    assert str(path) in started.stderr


@pytest.mark.parametrize('version', ['2', 'true', '1.0', '"1"', 'null'])
def test_requires_its_exact_format_version(tmp_path: Path, version: str) -> None:
    path = tmp_path / 'resolved.json'
    path.write_text('{"formatVersion": ' + version + '}', encoding='utf8')

    with pytest.raises(ValueError, match='formatVersion'):
        load_resolved_config(path)


def test_reads_the_revision_object_and_names_it_on_access_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    client = boto3.client('s3', region_name='us-east-1', aws_access_key_id='local', aws_secret_access_key='local')
    monkeypatch.setattr(boto3, 'client', lambda service: client)
    target = {'Bucket': 'config-bucket', 'Key': 'resolved/previous.json'}
    locator = 's3://config-bucket/resolved/previous.json'
    previous = load_resolved_config()
    with Stubber(client) as stub:
        stub.add_response('get_object', {'Body': BytesIO(json.dumps(previous).encode())}, target)
        stub.add_client_error('get_object', service_error_code='AccessDenied', expected_params=target)
        monkeypatch.setenv('BOTCUBE_CONFIG', locator)
        assert deployed_config() == previous
        with pytest.raises(ValueError, match=r's3://config-bucket/resolved/previous.json: .*AccessDenied'):
            load_resolved_config(locator)
