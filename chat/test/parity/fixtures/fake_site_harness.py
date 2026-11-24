"""The fake site's Harness definition: its skill, and the Credential Service binding its CLI reads.

The model scripts beside it configure the Harness with it through `serving.configure_harness_definition`.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from botcube_harness_deepagents.definition import (
    HarnessDefinition,
    InvocationAuth,
    environment_cache_key,
    openai_model_relay,
)

_SKILL = Path(__file__).resolve().parent / 'skills' / 'fake-site' / 'SKILL.md'
_SKILLS = '/skills/'


def prepare_invocation(input_data: Any, token: str | None) -> InvocationAuth:
    props = input_data.get('forwardedProps', {}) if isinstance(input_data, dict) else input_data.forwarded_props
    url = props.get('credentialServiceUrl')
    environment = {}
    if url and token:
        environment.update(FAKE_SITE_CREDENTIAL_SERVICE_URL=url, FAKE_SITE_CREDENTIAL_INVOCATION=token)
    session = input_data.get('threadId') if isinstance(input_data, dict) else input_data.thread_id
    relay = None
    if isinstance(session, str):
        environment['FAKE_SITE_CREDENTIAL_SESSION'] = session
        if url and token:
            relay = openai_model_relay(url, token, session)
        elif url or token:
            raise ValueError('The Credential Service binding needs both its URL and its invocation token')
    return InvocationAuth(actor_id=props.get('sessionUserId'), persistent_memory=True, environment=environment, model_relay=relay)


def _prepare_root(root: Path) -> None:
    target = root / _SKILLS.strip('/') / 'fake-site' / 'SKILL.md'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_SKILL, target)


FAKE_SITE_DEFINITION = HarnessDefinition(
    skills=(_SKILLS,),
    agent_name='BotCube',
    prepare_invocation=prepare_invocation,
    prepare_root=_prepare_root,
    session_id_env_var='BOTCUBE_FAKE_SITE_SESSION_ID',
    # The Chat Service re-signs the invocation each Turn.
    environment_cache_key=environment_cache_key('FAKE_SITE_CREDENTIAL_INVOCATION'),
)
