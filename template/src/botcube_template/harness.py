from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from botcube_cartridge import HarnessDefinition, InvocationAuth

_PACKAGE_ROOT = Path(__file__).resolve().parent
_IDENTITY = json.loads((_PACKAGE_ROOT / 'identity.json').read_text(encoding='utf8'))


def _prepare_invocation(input_data: Any) -> InvocationAuth:
    props = input_data.get('forwardedProps', {}) if isinstance(input_data, dict) else input_data.forwarded_props
    environment = {}
    for prop, key in (
        ('credentialServiceUrl', 'TEMPLATE_CREDENTIAL_SERVICE_URL'),
        ('credentialServiceInvocation', 'TEMPLATE_CREDENTIAL_INVOCATION'),
        ('agentComputerCdpUrl', 'AGENT_BROWSER_CDP'),
    ):
        value = props.get(prop)
        if isinstance(value, str) and value:
            environment[key] = value
    if cdp_url := environment.get('AGENT_BROWSER_CDP'):
        environment['AGENT_BROWSER_SESSION'] = hashlib.sha256(cdp_url.encode()).hexdigest()[:32]
        environment['AGENT_BROWSER_SOCKET_DIR'] = '/tmp/template-browser'
        environment['AGENT_BROWSER_IDLE_TIMEOUT_MS'] = '10000'
    session = input_data.get('threadId') if isinstance(input_data, dict) else input_data.thread_id
    if isinstance(session, str):
        environment['TEMPLATE_CREDENTIAL_SESSION'] = session
    return InvocationAuth(actor_id=props.get('sessionUserId'), persistent_memory=True, environment=environment)


def _prepare_root(root: Path) -> None:
    destination = root / 'skills' / 'template'
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(_PACKAGE_ROOT / 'skills' / 'SKILL.md', destination / 'SKILL.md')


def _environment_cache_key(
    environment: Mapping[str, str] | None,
) -> tuple[tuple[str, str], ...]:
    return tuple(sorted(
        (str(key), str(value)) for key, value in (environment or {}).items()
        if key not in {'AGENT_BROWSER_CDP', 'AGENT_BROWSER_SESSION'}
    ))


CARTRIDGE = HarnessDefinition(
    skills=('/skills/',),
    agent_name=_IDENTITY['name'],
    system_prompt='',
    prepare_invocation=_prepare_invocation,
    prepare_root=_prepare_root,
    build_shell_env=lambda environment: dict(environment),
    session_id_env_var='BOTCUBE_TEMPLATE_SESSION_ID',
    environment_cache_key=_environment_cache_key,
)
