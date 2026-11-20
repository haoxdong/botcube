"""The bot settings a bot's image carries: what the Harness serves in place of bot code (ADR 0091).

They follow `bot-settings.schema.json`, emitted from BotCube's seam file `botcube/deployment-config/schema.ts`.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any
from urllib.parse import quote

from jsonschema import Draft202012Validator, ValidationError

from .definition import (
    HarnessDefinition,
    InvocationAuth,
    environment_cache_key,
    openai_model_relay,
)
from .memory.agentcore import turn_actor

# The shell variable OpenTelemetry SDKs read resource attributes from, so a CLI's spans name the Turn's User and traffic.
_RESOURCE_ATTRIBUTES = 'OTEL_RESOURCE_ATTRIBUTES'
_SCHEMA = json.loads(Path(__file__).with_name('bot-settings.schema.json').read_text(encoding='utf8'))
# Where the agent finds the bot's skills, one directory each.
SKILLS = '/skills/'
USER_TOKEN_ENV = 'BOTCUBE_USER_TOKEN'


class BotSettingsError(RuntimeError):
    """Bot settings the Harness cannot serve; startup stops with the field at fault."""


@dataclass(frozen=True)
class BotSettings:
    agent_name: str
    # The models a User picks from; the first is the default.
    models: tuple[str, ...]
    # Each skill's directory, holding its SKILL.md.
    skills: tuple[Path, ...]
    user_token_in_shell: bool
    # The bot's instructions to every User, joined to the system prompt after BotCube's own; empty, none.
    instructions: str = ''


def load_bot_settings(path: Path) -> BotSettings:
    """The bot settings at this path, or a `BotSettingsError` naming the first bad field."""
    source = f'Bot settings {path}'
    try:
        settings = json.loads(path.read_text(encoding='utf8'))
    except (OSError, ValueError) as error:
        raise BotSettingsError(f'{source}: (root): {error}') from error
    errors = sorted(Draft202012Validator(_SCHEMA).iter_errors(settings), key=lambda error: list(error.absolute_path))
    if errors:
        raise BotSettingsError('\n'.join(f'{source}: {_field(error)}: {error.message}' for error in errors))
    skills = tuple((path.parent / skill).resolve() for skill in settings.get('skills', []))
    for index, skill in enumerate(skills):
        if not (skill / 'SKILL.md').is_file():
            raise BotSettingsError(f'{source}: skills.{index}: no SKILL.md in {skill}')
        if (first := [other.name for other in skills].index(skill.name)) != index:
            raise BotSettingsError(f'{source}: skills.{index}: skill "{skill.name}" is already skills.{first}')
    instructions = ''
    if 'instructions' in settings:
        try:
            instructions = (path.parent / settings['instructions']).read_text(encoding='utf8')
        except OSError as error:
            raise BotSettingsError(f'{source}: instructions: {error}') from error
    return BotSettings(
        agent_name=settings['agentIdentity']['name'],
        models=tuple(model['key'] for model in settings['models']),
        skills=skills,
        user_token_in_shell=settings.get('userTokenInShell', False),
        instructions=instructions,
    )


def bot_from_env() -> tuple[HarnessDefinition, str] | None:
    """The definition and default model of the bot `BOTCUBE_BOT_SETTINGS` names, if it names one.

    The Harness then serves the bot with BotCube's own definition and runs no bot code.
    """
    path = os.getenv('BOTCUBE_BOT_SETTINGS', '').strip()
    if not path:
        return None
    bot = load_bot_settings(Path(path))
    return bot_definition(bot), bot.models[0]


def bot_definition(bot: BotSettings) -> HarnessDefinition:
    """BotCube's own Harness definition for a bot that is only settings."""

    def prepare_root(root: Path) -> None:
        for skill in bot.skills:
            shutil.copytree(skill, root / SKILLS.strip('/') / skill.name, dirs_exist_ok=True)

    return HarnessDefinition(
        skills=(SKILLS,) if bot.skills else (),
        agent_name=bot.agent_name,
        prepare_invocation=partial(_prepare_invocation, user_token_in_shell=bot.user_token_in_shell),
        prepare_root=prepare_root,
        session_id_env_var='BOTCUBE_SESSION_ID',
        environment_cache_key=environment_cache_key(USER_TOKEN_ENV, _RESOURCE_ATTRIBUTES),
        system_prompt=bot.instructions,
    )


def _prepare_invocation(input_data: Any, *, user_token_in_shell: bool) -> InvocationAuth:
    """The Turn's User, with Memory, and the Credential Service's model relay when Chat bound one for the Session.

    The User is the Turn identity's actor; the Session's filing ID differs for a Session filed under an older ID.
    The shell names the User and Chat's traffic marker to the spans of any CLI the agent runs.
    """
    props = input_data.get('forwardedProps', {}) if isinstance(input_data, dict) else input_data.forwarded_props or {}
    session = input_data.get('threadId') if isinstance(input_data, dict) else input_data.thread_id
    url, token = props.get('credentialServiceUrl'), props.get('credentialServiceInvocationToken')
    if bool(url) != bool(token):
        raise ValueError('The Credential Service binding needs both its URL and its invocation token')
    relay = openai_model_relay(url, token, session) if url and token and isinstance(session, str) else None
    actor = turn_actor(props.get('turnIdentity')) or props.get('sessionUserId')
    environment = {
        **(_span_resource(actor, props.get('traffic')) or {}),
        **({USER_TOKEN_ENV: props.get('userToken') or ''} if user_token_in_shell else {}),
    }
    return InvocationAuth(actor_id=actor, persistent_memory=True, environment=environment or None, model_relay=relay)


def _span_resource(actor: Any, traffic: Any) -> dict[str, str] | None:
    """The OpenTelemetry resource attributes, values percent-encoded as the environment format requires."""
    attributes = {'enduser.id': actor, 'botcube.traffic': traffic}
    encoded = ','.join(f'{key}={quote(str(value), safe="")}' for key, value in attributes.items() if value is not None)
    return {_RESOURCE_ATTRIBUTES: encoded} if encoded else None


def _field(error: ValidationError) -> str:
    path: Sequence[Any] = list(error.absolute_path)
    if error.validator == 'additionalProperties':
        allowed = error.schema.get('properties', {}) if isinstance(error.schema, Mapping) else {}
        path = [*path, next(key for key in error.instance if key not in allowed)]
    return '.'.join(map(str, path)) or '(root)'
