import json
import subprocess
from io import BytesIO
from pathlib import Path

import boto3
import pytest
from botocore.stub import Stubber

from botcube_harness_deepagents import botcube_config
from botcube_harness_deepagents.resolved_config import load_resolved_config

BOTCUBE = Path(__file__).resolve().parents[3]


@pytest.mark.integration
@pytest.mark.parametrize('example', ['public', 'enterprise'])
def test_reads_a_resolved_example(tmp_path: Path, example: str) -> None:
    source = BOTCUBE / 'examples' / example / 'botcube.yaml'
    resolved = tmp_path / 'resolved'
    with resolved.open('w', encoding='utf8') as output:
        subprocess.run(['node', str(BOTCUBE / 'config/cli.ts'), 'resolve', str(source)], stdout=output, check=True)

    current = botcube_config.load_botcube_config(source)
    config = load_resolved_config(resolved)
    assert botcube_config.botcube_config_from_env({'BOTCUBE_CONFIG': str(resolved)}) == config['config']
    assert config['physicalNames'] == botcube_config.deployment_names(current)
    routes = config['modelGateway']
    assert {provider for provider in ('anthropic', 'openai', 'deepseek', 'echo') if routes[provider]['route'] is not None} == (
        {'anthropic', 'openai'} if example == 'enterprise' else set()
    )


def test_reads_packaged_section_defaults() -> None:
    default = load_resolved_config()
    assert default['config'] == botcube_config.botcube_config_from_env({})
    assert default['physicalNames'] == {}
    assert default['webOrigins'] == []


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
        assert load_resolved_config(locator) == previous
        with pytest.raises(ValueError, match=r's3://config-bucket/resolved/previous.json: .*AccessDenied'):
            load_resolved_config(locator)
