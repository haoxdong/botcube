from __future__ import annotations

import hashlib
import json
import re
import shlex
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from botcube_cartridge import HarnessDefinition, InvocationAuth

_PACKAGE_ROOT = Path(__file__).resolve().parent
_IDENTITY = json.loads((_PACKAGE_ROOT / 'identity.json').read_text(encoding='utf8'))
_SHELL_OPERATOR = re.compile(r'[;&|`$<>\r\n]')


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


def _validate_command(command: str) -> str | None:
    if _SHELL_OPERATOR.search(command):
        return 'Shell operators are not allowed'
    try:
        arguments = shlex.split(command)
    except ValueError:
        return 'Invalid shell command'
    if arguments and (arguments[0] == 'echo' or arguments == ['template-cli', 'data']):
        return None
    if arguments == ['agent-browser', 'get', 'url'] or (len(arguments) == 4 and arguments[:3] == ['agent-browser', 'get', 'text'] and not arguments[3].startswith('-')):
        return None
    if len(arguments) == 3 and arguments[:2] == ['agent-browser', 'open'] and arguments[2].startswith(('http://', 'https://')):
        return None
    return 'Only echo, template-cli data, or the documented agent-browser commands are allowed'


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
    no_persistent_memory_prompt='Persistent memory is unavailable for anonymous sessions.',
    execute_description='Runs echo, template-cli data, or documented agent-browser commands, with no shell operators. Returns its output and exit code.',
    prepare_invocation=_prepare_invocation,
    command_validator=_validate_command,
    prepare_root=_prepare_root,
    build_shell_env=lambda environment: dict(environment),
    shell_timeout=10,
    max_output_bytes=10000,
    session_id_env_var='BOTCUBE_TEMPLATE_SESSION_ID',
    environment_cache_key=_environment_cache_key,
)
