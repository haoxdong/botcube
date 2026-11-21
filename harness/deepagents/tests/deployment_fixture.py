"""A BotCube Config written for a test, which BOTCUBE_CONFIG names as the deploy does."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

ENDPOINT_MODELS = {'kind': 'openai-compatible', 'url': 'https://models.example.com/v1',
                   'credential': {'kind': 'file', 'path': '/run/secrets/botcube/models-api-key'}, 'turnSummaryModel': 'example-summary'}


def deploy(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **sections: Any) -> Path:
    path = tmp_path / 'botcube.yaml'
    path.write_text(json.dumps({**sections}))
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))
    return path
