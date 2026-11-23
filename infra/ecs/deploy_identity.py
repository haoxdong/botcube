"""Native deployment config and the NAT a parking operation owns."""

import json
import os
from pathlib import Path
from typing import Any, TypeVar

from botcube_credential_service.botcube_config import deployment_names, read_deployment

SERVICES = ('chat-service-preview', 'credential-service')

T = TypeVar('T')


def deploy_root() -> Path:
    """The active deploy directory, `BOTCUBE_DEPLOY_ROOT`."""
    root = os.environ.get('BOTCUBE_DEPLOY_ROOT')
    if not root:
        raise RuntimeError('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory')
    return Path(root)


def load_deployment() -> dict[str, Any]:
    """The native deployment config, validated by synthesis for a deployed bundle."""
    config = os.environ.get('BOTCUBE_CONFIG')
    return json.loads(Path(config).read_text()) if config else read_deployment(deploy_root())


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value


def owned_egress(config: dict[str, Any]) -> dict[str, Any] | None:
    """The NAT this deployment owns, absent when the existing VPC supplies egress."""
    if not config.get('network', {}).get('natGateways'):
        return None
    names = deployment_names(config)
    return {
        'stackName': names['privateEgressStackName'],
        'routeTableId': config['existing']['vpc']['privateSubnets'][0]['routeTableId'],
        'publicIp': config['network'].get('publicIp'),
        'natGateway': {'name': names['natGatewayName']},
    }
