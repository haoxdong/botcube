"""The BotCube Config (ADR 0091): the one file every BotCube process reads, located by BOTCUBE_CONFIG.

The twin of the Harness's `botcube_config`, as `credential_source` is.

It follows `botcube.schema.json`, emitted from BotCube's seam file `botcube/config/schema.ts`.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Iterator, Mapping
from copy import deepcopy
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError, validators
from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

CONFIG_ENV = 'BOTCUBE_CONFIG'
_SCHEMA = json.loads(Path(__file__).with_name('botcube.schema.json').read_text(encoding='utf8'))
_VALIDATOR = Draft202012Validator(_SCHEMA)


class BotCubeConfigError(RuntimeError):
    """A BotCube Config the process cannot run on; startup stops with the field at fault."""


def botcube_config_from_env(env: Mapping[str, str] = os.environ) -> dict[str, Any]:
    """The BotCube Config BOTCUBE_CONFIG names, or every section's default without one."""
    return _loaded(env.get(CONFIG_ENV) or None)


@cache
def _loaded(path: str | None) -> dict[str, Any]:
    return load_botcube_config(Path(path)) if path else _with_defaults({})


def plan_usage_owner(config: Mapping[str, Any]) -> str:
    """The Account whose linked plans Plan Usage runs on: the config's `planUsage.ownerAccountId`, empty without one."""
    return str(config.get('planUsage', {}).get('ownerAccountId', ''))


def load_botcube_config(path: Path) -> dict[str, Any]:
    """The BotCube Config at this path, each section it leaves out its default, or an error naming each bad field."""
    source = f'BotCube Config {path}'
    if path.name == 'deployment-config.json':
        raise BotCubeConfigError(f'{source}: deployment-config.json: renamed to botcube.yaml')
    try:
        text = path.read_text(encoding='utf8')
    except FileNotFoundError:
        raise BotCubeConfigError(f'{source}: no file') from None
    try:
        config = yaml_document(text)
    except (YAMLError, ValueError) as error:
        raise BotCubeConfigError(f'{source}: not YAML 1.2: {error}') from None
    replacements = _SCHEMA['x-renamed-keys']
    if isinstance(config, dict):
        for key, replacement in replacements.items():
            if key in config:
                raise BotCubeConfigError(f'{source}: {key}: renamed to {replacement}')
    errors = sorted(_leaves(_VALIDATOR.iter_errors(config)), key=lambda error: list(error.absolute_path))
    if errors:
        raise BotCubeConfigError('\n'.join(f'{source}: {_field(error)}: {error.message}' for error in errors))
    return _with_defaults(config)


def _with_defaults(config: dict[str, Any]) -> dict[str, Any]:
    """The config, each field it leaves out that the schema defaults filled in, as the TypeScript loader's parse fills them."""
    list(_Defaulting(_SCHEMA).iter_errors(config))
    return config


def _filling_defaults(validator: Any, properties: Mapping[str, Any], instance: Any, schema: Mapping[str, Any]) -> Iterator[ValidationError]:
    if isinstance(instance, dict):
        for name, field in properties.items():
            if 'default' in field:
                instance.setdefault(name, deepcopy(field['default']))
    yield from Draft202012Validator.VALIDATORS['properties'](validator, properties, instance, schema)


def _into_the_matching_branch(validator: Any, branches: list[Any], instance: Any, _schema: Mapping[str, Any]) -> Iterator[ValidationError]:
    branch = next((each for each in branches if _VALIDATOR.evolve(schema=each).is_valid(instance)), None)
    if branch is not None:
        yield from validator.descend(instance, branch)


_Defaulting = validators.extend(Draft202012Validator, {'properties': _filling_defaults, 'oneOf': _into_the_matching_branch, 'anyOf': _into_the_matching_branch})


def _leaves(errors: Iterable[ValidationError]) -> Iterator[ValidationError]:
    """Each error, a section's adapter error replaced by the errors of the adapter its `kind` names."""
    for error in errors:
        chosen = _chosen_adapter(error)
        if chosen is None:
            yield error
        else:
            yield from _leaves(iter(chosen))


def _chosen_adapter(error: ValidationError) -> list[ValidationError] | None:
    if error.validator != 'oneOf' or not isinstance(error.instance, dict) or not isinstance(error.validator_value, list):
        return None
    kind = error.instance.get('kind')
    branch = next((index for index, adapter in enumerate(error.validator_value)
                   if adapter.get('properties', {}).get('kind', {}).get('const') == kind), None)
    if branch is None:
        return None
    return [each for each in error.context or [] if each.relative_schema_path and each.relative_schema_path[0] == branch]


def _field(error: ValidationError) -> str:
    path: list[Any] = list(error.absolute_path)
    if error.validator == 'additionalProperties' and isinstance(error.instance, dict) and isinstance(error.schema, Mapping):
        allowed = error.schema.get('properties', {})
        path = [*path, next(key for key in error.instance if key not in allowed)]
    if error.validator == 'required' and isinstance(error.validator_value, list):
        path = [*path, next(key for key in error.validator_value if error.message.startswith(repr(key)))]
    return '.'.join(map(str, path)) or '(root)'


def yaml_document(text: str) -> Any:
    reader = YAML(typ='safe', pure=True)
    reader.version = (1, 2)
    resolvers = reader.resolver.versioned_resolver
    for first, rules in resolvers.items():
        resolvers[first] = [(tag, pattern) for tag, pattern in rules if tag not in ('tag:yaml.org,2002:timestamp', 'tag:yaml.org,2002:merge')]
    value = reader.load(text)
    if reader.version != (1, 2):
        raise ValueError('expected YAML 1.2')
    return value
