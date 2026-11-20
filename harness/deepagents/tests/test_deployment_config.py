"""The Harness reads the one Deployment Config BOTCUBE_DEPLOYMENT_CONFIG names, checked against its JSON Schema (ADR 0091)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from botcube_harness_deepagents import deployment_config
from botcube_harness_deepagents.deployment_config import (
    DeploymentConfigError,
    deployment_config_from_env,
    load_deployment_config,
)

BOTCUBE = Path(__file__).resolve().parents[3]
ENTERPRISE = BOTCUBE / 'examples' / 'enterprise' / 'deployment-config.json'
SECTION_DEFAULTS = BOTCUBE / 'tests' / 'fixtures' / 'deployment-config-section-defaults'
CANONICAL_SCHEMA = BOTCUBE / 'deployment-config' / 'deployment-config.schema.json'
VENDORED_SCHEMA = Path(deployment_config.__file__).with_name('deployment-config.schema.json')


def _file(tmp_path: Path, config: dict[str, Any]) -> Path:
    path = tmp_path / 'deployment-config.json'
    path.write_text(json.dumps(config))
    return path


def test_a_valid_file_gives_its_sections_and_the_defaults_of_those_it_leaves_out(tmp_path: Path) -> None:
    config = load_deployment_config(_file(tmp_path, {'bot': './bot.json', 'models': {'kind': 'openai-compatible', 'url': 'https://models.example.com/v1',
                                                     'credential': {'kind': 'file', 'path': '/run/secrets/key'}, 'turnSummaryModel': 'summary'}}))

    assert config['models']['url'] == 'https://models.example.com/v1'
    assert config['proxy'] == {'kind': 'none'}
    assert config['telemetry'] == {'kind': 'xray'}


def test_the_enterprise_example_loads() -> None:
    assert load_deployment_config(ENTERPRISE)['proxy']['url'] == 'http://proxy.example.com:3128'


def test_an_unknown_key_stops_startup_naming_its_path(tmp_path: Path) -> None:
    path = _file(tmp_path, {'bot': './bot.json', 'proxy': {'kind': 'forward', 'url': 'http://proxy.example.com:3128', 'user': 'x'}})

    with pytest.raises(DeploymentConfigError, match=f'^Deployment Config {path}: proxy.user: '):
        load_deployment_config(path)


def test_a_missing_value_stops_startup_naming_its_path(tmp_path: Path) -> None:
    path = _file(tmp_path, {'bot': './bot.json', 'telemetry': {'kind': 'otlp'}})

    with pytest.raises(DeploymentConfigError, match=f"^Deployment Config {path}: telemetry.url: 'url' is a required property"):
        load_deployment_config(path)


def test_a_missing_file_stops_startup(tmp_path: Path) -> None:
    path = tmp_path / 'absent.json'

    with pytest.raises(DeploymentConfigError, match=f'^Deployment Config {path}: no file'):
        load_deployment_config(path)


def test_without_a_locator_every_section_is_its_default() -> None:
    config = deployment_config_from_env({})

    assert (config['models'], config['proxy'], config['telemetry']) == ({'kind': 'bedrock'}, {'kind': 'none'}, {'kind': 'xray'})


def test_the_locator_names_the_file(tmp_path: Path) -> None:
    path = _file(tmp_path, {'bot': './bot.json', 'proxy': {'kind': 'forward', 'url': 'http://proxy.example.com:3128'}})

    assert deployment_config_from_env({'BOTCUBE_DEPLOYMENT_CONFIG': str(path)})['proxy']['url'] == 'http://proxy.example.com:3128'


def test_the_harness_exits_at_startup_naming_the_file_its_locator_names_but_cannot_find(tmp_path: Path) -> None:
    path = tmp_path / 'absent.json'

    started = subprocess.run([sys.executable, '-m', 'botcube_harness_deepagents.serving'], env={**os.environ, 'BOTCUBE_DEPLOYMENT_CONFIG': str(path)},
                             capture_output=True, text=True, timeout=60, check=False)

    assert started.returncode != 0
    assert f'Deployment Config {path}: no file' in started.stderr


def test_the_vendored_schema_is_the_canonical_schema_byte_for_byte() -> None:
    assert VENDORED_SCHEMA.read_bytes() == CANONICAL_SCHEMA.read_bytes()


def test_sections_given_with_only_their_required_fields_load_as_the_typescript_loader_parses_them() -> None:
    expected = json.loads((SECTION_DEFAULTS / 'parsed.json').read_text(encoding='utf8'))

    assert load_deployment_config(SECTION_DEFAULTS / 'config.json') == expected
