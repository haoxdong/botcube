"""The bot settings a bot's image carries: what the Harness serves in place of bot code (ADR 0091).

They follow `bot.schema.json`, emitted from BotCube's seam file `botcube/config/schema.ts`.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from jsonschema import Draft202012Validator, ValidationError
from ruamel.yaml.error import YAMLError

from .botcube_config import (
    CONFIG_ENV,
    botcube_config_from_env,
    gateway_routes,
    yaml_document,
)
from .definition import (
    BotModel,
    HarnessDefinition,
    InvocationAuth,
    environment_cache_key,
    openai_model_relay,
)
from .invocation import Invocation
from .llm import ECHO_PROVIDER, has_model_profile
from .memory.agentcore import turn_actor

# The shell variable OpenTelemetry SDKs read resource attributes from, so a CLI's spans name the Turn's User and traffic.
_RESOURCE_ATTRIBUTES = 'OTEL_RESOURCE_ATTRIBUTES'
_SCHEMA = json.loads(Path(__file__).with_name('bot.schema.json').read_text(encoding='utf8'))
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
    # The bot's instructions to every User, joined to the system prompt after BotCube's own; empty, none.
    instructions: str = ''
    calls: Mapping[str, BotModel] = field(default_factory=dict)
    environment: Mapping[str, str] = field(default_factory=dict)
    written_memory: bool = True
    extracted_memory: bool = True


def load_bot_settings(path: Path) -> BotSettings:
    """The bot settings at this path, or a `BotSettingsError` naming the first bad field."""
    source = f'Bot settings {path}'
    if path.name == 'bot.json':
        raise BotSettingsError(f'{source}: bot.json: renamed to /bot/bot.yaml')
    try:
        settings = yaml_document(path.read_text(encoding='utf8'))
    except (OSError, YAMLError, ValueError) as error:
        raise BotSettingsError(f'{source}: (root): {error}') from error
    for key, replacement in _SCHEMA['x-renamed-keys'].items():
        if isinstance(settings, dict) and key in settings:
            raise BotSettingsError(f'{source}: {key}: renamed to {replacement}')
    errors = sorted(Draft202012Validator(_SCHEMA).iter_errors(settings), key=lambda error: list(error.absolute_path))
    if errors:
        raise BotSettingsError('\n'.join(f'{source}: {_field(error)}: {error.message}' for error in errors))
    skills = _skills(path, settings, source)
    return BotSettings(
        agent_name=settings['agentIdentity']['name'],
        models=tuple(model['key'] for model in settings['models']),
        calls={model['key']: BotModel(model['provider'], model.get('maxTokens')) for model in settings['models']},
        skills=skills,
        instructions=_instructions(path, settings, source),
        environment=settings.get('environment', {}),
        written_memory=settings.get('writtenMemory', {}).get('enabled', True),
        extracted_memory=settings.get('extractedMemory', {}).get('enabled', True),
    )


def _skills(path: Path, settings: Mapping[str, Any], source: str) -> tuple[Path, ...]:
    """The bot's skill directories, each holding a SKILL.md under a name no other skill has."""
    skills = tuple((path.parent / skill).resolve() for skill in settings.get('skills', []))
    for index, skill in enumerate(skills):
        if not (skill / 'SKILL.md').is_file():
            raise BotSettingsError(f'{source}: skills.{index}: no SKILL.md in {skill}')
        if (first := [other.name for other in skills].index(skill.name)) != index:
            raise BotSettingsError(f'{source}: skills.{index}: skill "{skill.name}" is already skills.{first}')
    return skills


def _instructions(path: Path, settings: Mapping[str, Any], source: str) -> str:
    """The text of the bot's instructions file; empty when the settings name none."""
    if 'instructions' not in settings:
        return ''
    try:
        return (path.parent / settings['instructions']).read_text(encoding='utf8')
    except OSError as error:
        raise BotSettingsError(f'{source}: instructions: {error}') from error


def bot_from_env() -> tuple[HarnessDefinition, str]:
    """The Harness definition and default model from /bot/bot.yaml in the Bot Image, on a model gateway that reaches its providers."""
    gateway = botcube_config_from_env()['integrations']['modelGateway']
    path = Path('/bot/bot.yaml')
    bot = load_bot_settings(path)
    for index, (key, model) in enumerate(bot.calls.items()):
        if (unreached := unreached_provider(gateway, model.provider)) is not None:
            raise BotSettingsError(f"BotCube Config {os.environ[CONFIG_ENV]}: the bot settings' model {key} is on provider {model.provider}, but {unreached}")
        if gateway['kind'] != 'bedrock' and model.provider != ECHO_PROVIDER and model.max_tokens is None and not has_model_profile(key, model.provider):
            raise BotSettingsError(f'Bot settings {path}: models.{index}.maxTokens: LangChain has no model profile for {key} to take its output ceiling from: set maxTokens')
    return bot_definition(bot), bot.models[0]


def unreached_provider(gateway: Mapping[str, Any], provider: str) -> str | None:
    """Why the model gateway cannot call a model on `provider`, or None when it can, as botcube/config's `unreachedProvider`."""
    if gateway['kind'] == 'bedrock' or provider == ECHO_PROVIDER:
        return None
    served = gateway_routes(gateway)
    if provider not in served:
        return f"integrations.modelGateway reaches the providers {' and '.join(sorted(served))}"
    if provider == 'anthropic' and 'url' not in served['anthropic'] and urlsplit(gateway['url']).path.rstrip('/').endswith('/v1'):
        return "integrations.modelGateway.url ends in /v1, which Anthropic's API adds itself: set integrations.modelGateway.providers.anthropic.url without /v1"
    return None


def bot_definition(bot: BotSettings) -> HarnessDefinition:
    """BotCube's own Harness definition for a bot that is only settings."""

    def prepare_root(root: Path) -> None:
        for skill in bot.skills:
            shutil.copytree(skill, root / SKILLS.strip('/') / skill.name, dirs_exist_ok=True)

    return HarnessDefinition(
        skills=(SKILLS,) if bot.skills else (),
        agent_name=bot.agent_name,
        prepare_invocation=partial(_prepare_invocation, extracted_memory=bot.extracted_memory),
        prepare_root=prepare_root,
        session_id_env_var='BOTCUBE_SESSION_ID',
        environment_cache_key=environment_cache_key(_RESOURCE_ATTRIBUTES),
        system_prompt=bot.instructions,
        models=bot.calls,
        shell_environment=bot.environment,
    )


def _prepare_invocation(input_data: Invocation, token: str | None, *, extracted_memory: bool) -> InvocationAuth:
    """The Turn's User, with Extracted Memory unless the bot settings turn it off, and the Credential Service's model relay when Chat bound one for the Session.

    The User is the Turn identity's actor; the Session's filing ID differs for a Session filed under an older ID.
    The shell names the User and Chat's traffic marker to the spans of any CLI the agent runs.
    """
    options = input_data.options
    url = options.credential_service_url
    if bool(url) != bool(token):
        raise ValueError('The Credential Service binding needs both its URL and its invocation token')
    relay = openai_model_relay(url, token, input_data.thread_id) if url and token else None
    actor = turn_actor(input_data.turn_identity) or options.session_user_id
    return InvocationAuth(actor_id=actor, persistent_memory=extracted_memory, environment=_span_resource(actor, options.traffic), model_relay=relay)


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
