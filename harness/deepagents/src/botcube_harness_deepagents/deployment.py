from __future__ import annotations

import os
import ssl
from functools import cache

from .generated.resolved_config_types import Config, ResolvedConfig
from .resolved_config import load_resolved_config

CONFIG_ENV = 'BOTCUBE_CONFIG'


def deployed_config() -> ResolvedConfig:
    return _read_deployment(os.environ.get(CONFIG_ENV) or None)


@cache
def _read_deployment(locator: str | None) -> ResolvedConfig:
    return load_resolved_config(locator)


def load_ca_bundle(config: Config) -> None:
    """Load the CA bundle at startup so a bad file fails before the first call."""
    if (path := config.get('caBundle')) is None:
        return
    try:
        ssl.create_default_context(cafile=path)
    except OSError as error:
        raise RuntimeError(f'caBundle {path}: {error}') from error
