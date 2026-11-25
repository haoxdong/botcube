"""Resolved deployment identity and the NAT a parking operation owns."""

import json
import os
from pathlib import Path
from typing import Any, TypeVar

SERVICES = ('chat-service-preview', 'credential-service')

T = TypeVar('T')


def deploy_root() -> Path:
    """The active deploy directory, `BOTCUBE_DEPLOY_ROOT`."""
    root = os.environ.get('BOTCUBE_DEPLOY_ROOT')
    if not root:
        raise RuntimeError('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory')
    return Path(root)


def load_deployment() -> dict[str, Any]:
    """The resolved BotCube Config emitted by the TypeScript loader."""
    locator = os.environ.get('BOTCUBE_CONFIG')
    if not locator:
        raise RuntimeError('BOTCUBE_CONFIG must point to the resolved BotCube Config')
    try:
        resolved = json.loads(Path(locator).read_text(encoding='utf8'))
    except (OSError, ValueError) as error:
        raise RuntimeError(f'Resolved BotCube Config {locator}: {error}') from error
    version = resolved.get('formatVersion') if isinstance(resolved, dict) else None
    if type(version) is not int or version != 1:
        raise RuntimeError(f'Resolved BotCube Config {locator}: expected formatVersion 1, got {version!r}')
    return resolved


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value


def owned_egress(resolved: dict[str, Any]) -> dict[str, Any] | None:
    """The NAT this deployment owns, absent when the existing VPC supplies egress."""
    config = resolved['config']
    if not config.get('network', {}).get('natGateways'):
        return None
    names = resolved['physicalNames']
    return {
        'stackName': names['privateEgressStackName'],
        'routeTableId': config['existing']['vpc']['privateSubnets'][0]['routeTableId'],
        'publicIp': config['network'].get('publicIp'),
        'natGateway': {'name': names['natGatewayName']},
    }
