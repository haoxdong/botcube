"""The active Cartridge's deploy identity: its `identity.json` over BotCube's `identity-defaults.json`."""

import json
import os
from pathlib import Path
from typing import Any

_DEFAULTS = Path(__file__).resolve().parents[1] / 'identity-defaults.json'


def _over(defaults: Any, cartridge: Any) -> Any:
    """`cartridge` over `defaults`: objects merge key by key; any other value the Cartridge sets replaces the default."""
    if not isinstance(defaults, dict) or not isinstance(cartridge, dict):
        return cartridge
    return {**defaults, **{key: _over(defaults.get(key), value) for key, value in cartridge.items()}}


def load_identity() -> dict[str, Any]:
    deploy_root = Path(os.environ['CARTRIDGE_DEPLOY_ROOT'])
    return _over(json.loads(_DEFAULTS.read_text()), json.loads((deploy_root / 'identity.json').read_text()))
