"""The bot settings a bot's image carries: what the Harness serves in place of bot code (ADR 0091).

They follow `bot-settings.schema.json`, emitted from BotCube's seam file `botcube/deployment-config/schema.ts`.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from botcube_cartridge import (
    HarnessDefinition,
    InvocationAuth,
    environment_cache_key,
    openai_model_relay,
)
from jsonschema import Draft202012Validator, ValidationError

_SCHEMA = json.loads(Path(__file__).with_name('bot-settings.schema.json').read_text(encoding='utf8'))
# Where the agent finds the bot's skills, one directory each.
SKILLS = '/skills/'


class BotSettingsError(RuntimeError):
    """Bot settings the Harness cannot serve; startup stops with the field at fault."""


@dataclass(frozen=True)
class BotSettings:
    agent_name: str
    # The models a User picks from; the first is the default.
    models: tuple[str, ...]
    # Each skill's directory, holding its SKILL.md.
    skills: tuple[Path, ...]


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
    return BotSettings(
        agent_name=settings['agentIdentity']['name'],
        models=tuple(model['key'] for model in settings['models']),
        skills=skills,
    )


def bot_from_env(cartridge_module: str) -> tuple[HarnessDefinition, str] | None:
    """The definition and default model of the bot `BOTCUBE_BOT_SETTINGS` names, if it names one.

    The Harness then serves the bot with BotCube's own definition and runs no bot code.
    """
    path = os.getenv('BOTCUBE_BOT_SETTINGS', '').strip()
    if not path:
        return None
    if cartridge_module:
        raise BotSettingsError('BOTCUBE_BOT_SETTINGS and BOTCUBE_CARTRIDGE_MODULE are both set: a bot is its settings or a Cartridge, not both')
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
        prepare_invocation=_prepare_invocation,
        prepare_root=prepare_root,
        session_id_env_var='BOTCUBE_SESSION_ID',
        environment_cache_key=environment_cache_key(),
    )


def _prepare_invocation(input_data: Any) -> InvocationAuth:
    """The Turn's User, with Memory, and the Credential Service's model relay when Chat bound one for the Session."""
    props = input_data.get('forwardedProps', {}) if isinstance(input_data, dict) else input_data.forwarded_props or {}
    session = input_data.get('threadId') if isinstance(input_data, dict) else input_data.thread_id
    url, token = props.get('credentialServiceUrl'), props.get('credentialServiceInvocationToken')
    if bool(url) != bool(token):
        raise ValueError('The Credential Service binding needs both its URL and its invocation token')
    relay = openai_model_relay(url, token, session) if url and token and isinstance(session, str) else None
    return InvocationAuth(actor_id=props.get('sessionUserId'), persistent_memory=True, environment=None, model_relay=relay)


def _field(error: ValidationError) -> str:
    path: Sequence[Any] = list(error.absolute_path)
    if error.validator == 'additionalProperties':
        allowed = error.schema.get('properties', {}) if isinstance(error.schema, Mapping) else {}
        path = [*path, next(key for key in error.instance if key not in allowed)]
    return '.'.join(map(str, path)) or '(root)'
