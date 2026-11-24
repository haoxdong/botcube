from __future__ import annotations

import json
from pathlib import Path

from .generated.resolved_config_types import FORMAT_VERSION, ResolvedConfig


def load_resolved_config(path: Path | None = None) -> ResolvedConfig:
    """Read the deploy's resolved config, or the packaged section defaults."""
    source = path if path is not None else Path(__file__).with_name('resolved-empty.json')
    config = json.loads(source.read_text(encoding='utf8'))
    version = config.get('formatVersion') if isinstance(config, dict) else None
    if type(version) is not int or version != FORMAT_VERSION:
        raise ValueError(f'Resolved BotCube Config {source}: expected formatVersion {FORMAT_VERSION}, got {version!r}')
    return config
