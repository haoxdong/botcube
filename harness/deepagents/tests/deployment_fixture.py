"""A BotCube Config written for a test, which BOTCUBE_CONFIG names as the deploy does."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

ENDPOINT_MODELS = {'kind': 'openai-compatible', 'url': 'https://models.example.com/v1',
                   'credential': {'kind': 'file', 'path': '/run/secrets/botcube/models-api-key'}}


REQUIRED: dict[str, Any] = json.loads((Path(__file__).resolve().parents[3] / 'tests' / 'required-keys.json').read_text(encoding='utf8'))


def deploy(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **sections: Any) -> Path:
    """A BotCube Config of these sections over the keys every one gives; existing keeps their VPC."""
    path = tmp_path / 'botcube.yaml'
    path.write_text(json.dumps({**REQUIRED, **sections, 'existing': {**REQUIRED['existing'], **sections.get('existing', {})}}))
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))
    return path
