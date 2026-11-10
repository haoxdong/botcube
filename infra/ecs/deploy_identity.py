"""The active Cartridge's deploy identity: its `identity.json` over BotCube's `identity-defaults.json`."""

import json
import os
from pathlib import Path
from typing import Any, TypeVar

SERVICES = ('chat-service-preview', 'credential-service')

T = TypeVar('T')
_DEFAULTS = Path(__file__).resolve().parents[1] / 'identity-defaults.json'


def _over(defaults: Any, cartridge: Any) -> Any:
    """`cartridge` over `defaults`: objects merge key by key; any other value the Cartridge sets replaces the default."""
    if not isinstance(defaults, dict) or not isinstance(cartridge, dict):
        return cartridge
    return {**defaults, **{key: _over(defaults.get(key), value) for key, value in cartridge.items()}}


def load_identity() -> dict[str, Any]:
    deploy_root = Path(os.environ['CARTRIDGE_DEPLOY_ROOT'])
    return _over(json.loads(_DEFAULTS.read_text()), json.loads((deploy_root / 'identity.json').read_text()))


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value
