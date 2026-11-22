"""The active bot's deploy identity, built from its BotCube Config, over BotCube's `identity-defaults.json`."""

import json
import os
from pathlib import Path
from typing import Any, TypeVar

from botcube_credential_service.botcube_config import deploy_root_file, deployment_file

SERVICES = ('chat-service-preview', 'credential-service')

T = TypeVar('T')
_DEFAULTS = Path(__file__).resolve().parents[1] / 'identity-defaults.json'


def _over(defaults: Any, bot: Any) -> Any:
    """`bot` over `defaults`: objects merge key by key; any other value the bot sets replaces the default."""
    if not isinstance(defaults, dict) or not isinstance(bot, dict):
        return bot
    return {**defaults, **{key: _over(defaults.get(key), value) for key, value in bot.items()}}


def deploy_root() -> Path:
    """The active deploy directory, `BOTCUBE_DEPLOY_ROOT`."""
    root = os.environ.get('BOTCUBE_DEPLOY_ROOT')
    if not root:
        raise RuntimeError('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory')
    return Path(root)


def load_identity() -> dict[str, Any]:
    """The identity over the defaults: from the BotCube Config `BOTCUBE_CONFIG` names, as a deployed process is told
    of it, else from the deploy root's files."""
    config = os.environ.get('BOTCUBE_CONFIG')
    identity = _bundled_identity(Path(config)) if config else deploy_root_file(deploy_root(), 'identity.json', _DEFAULTS.parents[1])
    return _over(json.loads(_DEFAULTS.read_text()), identity)


def _bundled_identity(config: Path) -> Any:
    """The identity a deployed process's bundle gives: its BotCube Config as JSON, validated when it was synthesized.
    The bundle holds no YAML or JSON Schema library, so this needs neither."""
    return deployment_file(json.loads(config.read_text()), 'identity.json', config, config.parent)


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value
