"""The keys every BotCube Config gives, which a test's own sections go over (botcube/tests/required-keys.json)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from botcube_credential_service.generated.resolved_config_types import ResolvedConfig
from botcube_credential_service.resolved_config import load_resolved_config

REQUIRED: dict[str, Any] = json.loads((Path(__file__).resolve().parents[2] / 'tests' / 'required-keys.json').read_text(encoding='utf8'))


def with_required(config: dict[str, Any]) -> dict[str, Any]:
    """These sections over the keys every BotCube Config gives; existing keeps their VPC."""
    return {**REQUIRED, **config, 'existing': {**REQUIRED['existing'], **config.get('existing', {})}}


def resolve_file(source: Path, destination: Path) -> Path:
    cli = Path(__file__).resolve().parents[2] / 'config/cli.ts'
    with destination.open('wb') as output:
        subprocess.run(['node', str(cli), 'resolve', str(source)], stdout=output, check=True)
    return destination


def resolve_sections(sections: dict[str, Any], directory: Path) -> Path:
    source = directory / 'botcube.yaml'
    source.write_text(json.dumps(with_required(sections)), encoding='utf8')
    return resolve_file(source, directory / 'resolved.json')


def resolved_sections(sections: dict[str, Any]) -> ResolvedConfig:
    with TemporaryDirectory() as directory:
        return load_resolved_config(resolve_sections(sections, Path(directory)))
