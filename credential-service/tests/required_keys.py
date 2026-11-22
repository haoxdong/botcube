"""The keys every BotCube Config gives, which a test's own sections go over (botcube/tests/required-keys.json)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REQUIRED: dict[str, Any] = json.loads((Path(__file__).resolve().parents[2] / 'tests' / 'required-keys.json').read_text(encoding='utf8'))


def with_required(config: dict[str, Any]) -> dict[str, Any]:
    """These sections over the keys every BotCube Config gives; existing keeps their VPC."""
    return {**REQUIRED, **config, 'existing': {**REQUIRED['existing'], **config.get('existing', {})}}
