"""The fake site's Harness definition: its skill, and the Credential Service binding its CLI reads.

The model scripts beside it configure the Harness with it through `serving.configure_harness_definition`.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from botcube_harness_deepagents.definition import (
    HarnessDefinition,
    InvocationAuth,
    environment_cache_key,
    openai_model_relay,
)
from botcube_harness_deepagents.invocation import Invocation

_SKILL = Path(__file__).resolve().parent / 'skills' / 'fake-site' / 'SKILL.md'
_SKILLS = '/skills/'


def prepare_invocation(input_data: Invocation, token: str | None) -> InvocationAuth:
    options = input_data.options
    url = options.credential_service_url
    session = input_data.thread_id
    environment = {'FAKE_SITE_CREDENTIAL_SESSION': session}
    if bool(url) != bool(token):
        raise ValueError('The Credential Service binding needs both its URL and its invocation token')
    relay = None
    if url and token:
        environment.update(FAKE_SITE_CREDENTIAL_SERVICE_URL=url, FAKE_SITE_CREDENTIAL_INVOCATION=token)
        relay = openai_model_relay(url, token, session)
    return InvocationAuth(actor_id=options.session_user_id, persistent_memory=True, environment=environment, model_relay=relay)


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
