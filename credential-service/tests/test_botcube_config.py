"""The Credential Service reads the one BotCube Config BOTCUBE_CONFIG names, checked against its JSON Schema (ADR 0091)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from botcube_credential_service import botcube_config
from botcube_credential_service.botcube_config import (
    BotCubeConfigError,
    botcube_config_from_env,
    load_botcube_config,
    plan_usage_owner,
)
from botcube_credential_service.server import CredentialServiceSettings, create_app

BOTCUBE = Path(__file__).resolve().parents[2]
ENTERPRISE = BOTCUBE / 'examples' / 'enterprise' / 'botcube.yaml'
SECTION_DEFAULTS = BOTCUBE / 'tests' / 'fixtures' / 'config-section-defaults'
CANONICAL_SCHEMA = BOTCUBE / 'config' / 'botcube.schema.json'
VENDORED_SCHEMA = Path(botcube_config.__file__).with_name('botcube.schema.json')


def _file(tmp_path: Path, config: dict[str, Any]) -> Path:
    path = tmp_path / 'botcube.yaml'
    path.write_text(json.dumps(config))
    return path


def test_a_valid_file_gives_its_sections_and_the_defaults_of_those_it_leaves_out(tmp_path: Path) -> None:
    config = load_botcube_config(_file(tmp_path, {'integrations': {'modelGateway': {'kind': 'openai-compatible', 'url': 'https://models.example.com/v1',
                                                     'credential': {'kind': 'file', 'path': '/run/secrets/key'}, 'turnSummaryModel': 'summary'}}}))

    assert config['integrations']['modelGateway']['url'] == 'https://models.example.com/v1'
    assert config['network']['proxy'] == {'kind': 'none'}
    assert config['integrations']['telemetry'] == {'kind': 'xray'}


def test_the_plan_usage_owner_is_the_files_not_the_environments(tmp_path: Path) -> None:
    owned = _file(tmp_path, {'planUsage': {'ownerAccountId': 'acct_owner_1'}})
    legacy = {'BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID': 'acct_other'}

    assert plan_usage_owner(load_botcube_config(owned)) == 'acct_owner_1'
    assert plan_usage_owner(botcube_config_from_env(legacy)) == ''


def test_the_enterprise_example_loads() -> None:
    assert load_botcube_config(ENTERPRISE)['network']['proxy']['url'] == 'http://proxy.example.com:3128'


def test_an_unknown_key_stops_startup_naming_its_path(tmp_path: Path) -> None:
    path = _file(tmp_path, {'network': {'proxy': {'kind': 'forward', 'url': 'http://proxy.example.com:3128', 'user': 'x'}}})

    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: network.proxy.user: '):
        load_botcube_config(path)


def test_a_missing_value_stops_startup_naming_its_path(tmp_path: Path) -> None:
    path = _file(tmp_path, {'integrations': {'telemetry': {'kind': 'otlp'}}})

    with pytest.raises(BotCubeConfigError, match=f"^BotCube Config {path}: integrations.telemetry.url: 'url' is a required property"):
        load_botcube_config(path)


def test_a_missing_file_stops_startup(tmp_path: Path) -> None:
    path = tmp_path / 'absent.json'

    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: no file'):
        load_botcube_config(path)


def test_without_a_locator_every_section_is_its_default() -> None:
    config = botcube_config_from_env({})

    assert (config['integrations']['modelGateway'], config['network']['proxy'], config['integrations']['telemetry']) == ({'kind': 'bedrock'}, {'kind': 'none'}, {'kind': 'xray'})


def test_the_locator_names_the_file(tmp_path: Path) -> None:
    path = _file(tmp_path, {'network': {'proxy': {'kind': 'forward', 'url': 'http://proxy.example.com:3128'}}})

    assert botcube_config_from_env({'BOTCUBE_CONFIG': str(path)})['network']['proxy']['url'] == 'http://proxy.example.com:3128'


def test_the_credential_service_stops_before_it_serves_when_its_locator_names_no_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / 'absent.json'
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))

    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: no file'):
        create_app(CredentialServiceSettings('test', lambda: 'secret'), [])


def test_the_credential_service_stops_before_it_serves_on_a_file_the_schema_refuses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _file(tmp_path, {'network': {'proxy': {'kind': 'forward'}}})
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))

    with pytest.raises(BotCubeConfigError, match=f"^BotCube Config {path}: network.proxy.url: 'url' is a required property"):
        create_app(CredentialServiceSettings('test', lambda: 'secret'), [])


def test_the_vendored_schema_is_the_canonical_schema_byte_for_byte() -> None:
    assert VENDORED_SCHEMA.read_bytes() == CANONICAL_SCHEMA.read_bytes()


def test_sections_given_with_only_their_required_fields_load_as_the_typescript_loader_parses_them() -> None:
    expected = json.loads((SECTION_DEFAULTS / 'parsed.json').read_text(encoding='utf8'))

    assert load_botcube_config(SECTION_DEFAULTS / 'config.json') == expected


@pytest.mark.parametrize(('key', 'replacement'), [
    ('identity', 'integrations.signIn'), ('models', 'integrations.modelGateway'),
    ('turnCredentials', 'integrations.awsAccess'), ('harnessAuth', 'integrations.harnessAuth'),
    ('telemetry', 'integrations.telemetry'), ('imageRegistry', 'integrations.imageRegistry'),
    ('supplied', 'existing'), ('proxy', 'network.proxy'), ('corsOrigins', 'network.corsOrigins'),
    ('bot', '/bot/bot.yaml'), ('web', 'network.corsOrigins'),
])
def test_old_keys_name_the_replacement(tmp_path: Path, key: str, replacement: str) -> None:
    path = _file(tmp_path, {key: {}})
    with pytest.raises(BotCubeConfigError) as error:
        load_botcube_config(path)
    assert f'{key}: renamed to {replacement}' in str(error.value)


def test_yaml_12_scalars_and_comments(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text('productName: yes # YAML 1.2 keeps this a string\n')
    assert load_botcube_config(path)['productName'] == 'yes'


def test_old_filename_names_botcube_yaml(tmp_path: Path) -> None:
    path = tmp_path / 'deployment-config.json'
    path.write_text('{}')
    with pytest.raises(BotCubeConfigError, match='renamed to botcube.yaml'):
        load_botcube_config(path)


def test_duplicate_yaml_keys_fail(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text('productName: first\nproductName: second\n')
    with pytest.raises(BotCubeConfigError, match='not YAML 1.2'):
        load_botcube_config(path)


def test_date_like_scalars_remain_strings(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text('productName: 2026-11-21\n')
    assert load_botcube_config(path)['productName'] == '2026-11-21'


def test_yaml_11_directive_fails(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text('%YAML 1.1\n---\nproductName: yes\n')
    with pytest.raises(BotCubeConfigError, match='expected YAML 1.2'):
        load_botcube_config(path)
