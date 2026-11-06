from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from botcube_cartridge import (
    HarnessDefinition,
    InvocationAuth,
    environment_cache_key,
    install_skill,
    openai_model_relay,
)

_PACKAGE_ROOT = Path(__file__).resolve().parent
_IDENTITY = json.loads((_PACKAGE_ROOT / 'identity.json').read_text(encoding='utf8'))


def _prepare_invocation(input_data: Any) -> InvocationAuth:
    props = input_data.get('forwardedProps', {}) if isinstance(input_data, dict) else input_data.forwarded_props
    environment = {}
    for prop, key in (
        ('credentialServiceUrl', 'TEMPLATE_CREDENTIAL_SERVICE_URL'),
        ('credentialServiceInvocationToken', 'TEMPLATE_CREDENTIAL_INVOCATION'),
    ):
        value = props.get(prop)
        if isinstance(value, str) and value:
            environment[key] = value
    session = input_data.get('threadId') if isinstance(input_data, dict) else input_data.thread_id
    relay = None
    if isinstance(session, str):
        environment['TEMPLATE_CREDENTIAL_SESSION'] = session
        url, token = environment.get('TEMPLATE_CREDENTIAL_SERVICE_URL'), environment.get('TEMPLATE_CREDENTIAL_INVOCATION')
        if url and token:
            relay = openai_model_relay(url, token, session)
        elif url or token:
            raise ValueError('The Credential Service binding needs both its URL and its invocation token')
    return InvocationAuth(actor_id=props.get('sessionUserId'), persistent_memory=True, environment=environment, model_relay=relay)


_SKILLS = '/skills/'


def _prepare_root(root: Path) -> None:
    install_skill(root, _SKILLS, 'template', _PACKAGE_ROOT / 'skills' / 'SKILL.md')


CARTRIDGE = HarnessDefinition(
    skills=(_SKILLS,),
    agent_name=_IDENTITY['name'],
    prepare_invocation=_prepare_invocation,
    prepare_root=_prepare_root,
    session_id_env_var='BOTCUBE_TEMPLATE_SESSION_ID',
    # The Chat Service re-signs the invocation each Turn.
    environment_cache_key=environment_cache_key('TEMPLATE_CREDENTIAL_INVOCATION'),
)
