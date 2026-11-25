"""A BotCube Config written for a test, which BOTCUBE_CONFIG names as the deploy does."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

ENDPOINT_MODELS = {'kind': 'openai-compatible', 'url': 'https://models.example.com/v1',
                   'credential': {'kind': 'file', 'path': '/run/secrets/botcube/models-api-key'}}


BOTCUBE = Path(__file__).resolve().parents[3]
REQUIRED: dict[str, Any] = json.loads((BOTCUBE / 'tests' / 'required-keys.json').read_text(encoding='utf8'))


def deploy(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **sections: Any) -> Path:
    """A BotCube Config of these sections over the keys every one gives; existing keeps their VPC."""
    source = tmp_path / 'source.json'
    source.write_text(json.dumps({**REQUIRED, **sections, 'existing': {**REQUIRED['existing'], **sections.get('existing', {})}}))
    path = resolve(source, tmp_path / 'resolved.json')
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))
    return path


def resolve(source: Path, output: Path) -> Path:
    result = subprocess.run(['node', str(BOTCUBE / 'config/cli.ts'), 'resolve', str(source)], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    output.write_text(result.stdout, encoding='utf8')
    return output
