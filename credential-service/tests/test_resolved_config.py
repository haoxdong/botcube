import subprocess
from pathlib import Path

import pytest

from botcube_credential_service import botcube_config
from botcube_credential_service.resolved_config import load_resolved_config

BOTCUBE = Path(__file__).resolve().parents[2]


@pytest.mark.integration
@pytest.mark.parametrize('example', ['public', 'enterprise'])
def test_reads_a_resolved_example(tmp_path: Path, example: str) -> None:
    source = BOTCUBE / 'examples' / example / 'botcube.yaml'
    resolved = tmp_path / 'resolved.json'
    with resolved.open('w', encoding='utf8') as output:
        subprocess.run(['node', str(BOTCUBE / 'config/cli.ts'), 'resolve', str(source)], stdout=output, check=True)

    current = botcube_config.load_botcube_config(source)
    config = load_resolved_config(resolved)
    assert config['physicalNames'] == botcube_config.deployment_names(current)
    assert config['webOrigins'] == botcube_config.web_origins(current)
    assert config['credentialServiceHttpPath'] == botcube_config.credential_service_http_path(current)
    routes = config['modelGateway']
    assert {provider for provider in ('anthropic', 'openai', 'deepseek', 'echo') if routes[provider]['route'] is not None} == (
        set(botcube_config.gateway_providers()) if example == 'enterprise' else set()
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
