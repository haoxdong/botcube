"""The BotCube Config (ADR 0091): the one file every BotCube process reads, located by BOTCUBE_CONFIG.

botcube/harness/deepagents holds a byte-identical copy of botcube/credential-service's, where its behaviour is tested.

It follows `botcube.schema.json`, emitted from BotCube's seam file `botcube/config/schema.ts`.
"""

from __future__ import annotations

import json
import os
import re
import ssl
from collections.abc import Iterable, Iterator, Mapping
from copy import deepcopy
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from jsonschema import ValidationError
    from jsonschema.protocols import Validator

CONFIG_ENV = 'BOTCUBE_CONFIG'
_SCHEMA = json.loads(Path(__file__).with_name('botcube.schema.json').read_text(encoding='utf8'))


def gateway_routes(models: Mapping[str, Any]) -> Mapping[str, Mapping[str, Any]]:
    if 'providers' in models:
        return models['providers']
    [gateway] = (option for option in _SCHEMA['properties']['integrations']['properties']['modelGateway']['oneOf'] if 'providers' in option['properties'])
    return {provider: {} for provider in gateway['properties']['providers']['properties']}


class BotCubeConfigError(RuntimeError):
    """A BotCube Config the process cannot run on; startup stops with the field at fault."""


def botcube_config_from_env(env: Mapping[str, str] = os.environ) -> dict[str, Any]:
    """The BotCube Config BOTCUBE_CONFIG names, or every section's default without one."""
    return _loaded(env.get(CONFIG_ENV) or None)


def load_ca_bundle(config: Mapping[str, Any]) -> None:
    """The caBundle SSL_CERT_FILE and REQUESTS_CA_BUNDLE point at, loaded now: a wrong one fails startup, not the first call."""
    if (path := config.get('caBundle')) is None:
        return
    try:
        ssl.create_default_context(cafile=path)
    except OSError as error:
        raise BotCubeConfigError(f'caBundle {path}: {error}') from None


def web_origins(config: Mapping[str, Any]) -> list[str]:
    """The origins CORS allows: domains.web and its aliases; without domains, none."""
    domains = config.get('domains')
    return [domains['web'], *domains.get('webAliases', [])] if domains else []


def credential_service_http_path(config: Mapping[str, Any]) -> str:
    """services.credentialService.http.path, the path the Credential Service serves its RPC under; none without it."""
    return _value_at(config, 'services.credentialService.http.path') or ''


@cache
def _loaded(path: str | None) -> dict[str, Any]:
    return load_botcube_config(Path(path)) if path else _with_defaults({})


def load_botcube_config(path: Path) -> dict[str, Any]:
    """The BotCube Config at this path, each section it leaves out its default, or an error naming each bad field."""
    source = f'BotCube Config {path}'
    if path.name == 'deployment-config.json':
        raise BotCubeConfigError(f'{source}: deployment-config.json: renamed to botcube.yaml')
    try:
        text = path.read_text(encoding='utf8')
    except FileNotFoundError:
        raise BotCubeConfigError(f'{source}: no file') from None
    from ruamel.yaml.error import YAMLError

    try:
        config = yaml_document(text)
    except (YAMLError, ValueError) as error:
        raise BotCubeConfigError(f'{source}: not YAML 1.2: {error}') from None
    replacements = _SCHEMA['x-renamed-keys']
    if isinstance(config, dict):
        for key, replacement in replacements.items():
            if held := _held_key(config, key):
                raise BotCubeConfigError(f'{source}: {held}: renamed to {replacement}')
    errors = sorted(_leaves(_validator().iter_errors(config)), key=lambda error: list(error.absolute_path))
    if errors:
        raise BotCubeConfigError('\n'.join(f'{source}: {_field(error)}: {error.message}' for error in errors))
    return _with_defaults(config)


def _held_key(value: Any, path: str) -> str | None:
    """Where value holds the key at the dotted path, whatever its value: **.key finds it at any depth, the first in document order."""
    if path.startswith('**.'):
        return _deep_key(value, path[3:], [])
    *parents, last = path.split('.')
    for key in parents:
        value = value.get(key) if isinstance(value, dict) else None
    return path if isinstance(value, dict) and last in value else None


def _deep_key(value: Any, key: str, at: list[str]) -> str | None:
    if isinstance(value, dict) and key in value:
        return '.'.join([*at, key])
    children = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else []
    for name, child in children:
        if found := _deep_key(child, key, [*at, str(name)]):
            return found
    return None


def _with_defaults(config: dict[str, Any]) -> dict[str, Any]:
    """The config, each field it leaves out that the schema defaults filled in, as the TypeScript loader's parse fills them."""
    list(_defaulting()(_SCHEMA).iter_errors(config))
    return config


@cache
def _jsonschema() -> Any:
    """jsonschema, imported on first use: the parking Transition's bundle builds deploy-root files with no jsonschema."""
    import jsonschema

    return jsonschema


@cache
def _validator() -> Validator:
    return _jsonschema().Draft202012Validator(_SCHEMA)


@cache
def _defaulting() -> Any:
    jsonschema = _jsonschema()
    return jsonschema.validators.extend(jsonschema.Draft202012Validator, {'properties': _filling_defaults, 'oneOf': _into_the_matching_branch, 'anyOf': _into_the_matching_branch})


def _filling_defaults(validator: Any, properties: Mapping[str, Any], instance: Any, schema: Mapping[str, Any]) -> Iterator[ValidationError]:
    if isinstance(instance, dict):
        for name, field in properties.items():
            if 'default' in field:
                instance.setdefault(name, deepcopy(field['default']))
    yield from _jsonschema().Draft202012Validator.VALIDATORS['properties'](validator, properties, instance, schema)


def _into_the_matching_branch(validator: Any, branches: list[Any], instance: Any, _schema: Mapping[str, Any]) -> Iterator[ValidationError]:
    branch = next((each for each in branches if _validator().evolve(schema=each).is_valid(instance)), None)
    if branch is not None:
        yield from validator.descend(instance, branch)


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
    from ruamel.yaml import YAML

    reader = YAML(typ='safe', pure=True)
    reader.version = (1, 2)
    resolvers = reader.resolver.versioned_resolver
    for first, rules in resolvers.items():
        resolvers[first] = [(tag, pattern) for tag, pattern in rules if tag not in ('tag:yaml.org,2002:timestamp', 'tag:yaml.org,2002:merge')]
    value = reader.load(text)
    if reader.version != (1, 2):
        raise ValueError('expected YAML 1.2')
    return value


def _value_at(value: Any, path: str) -> Any:
    for key in path.split('.'):
        if isinstance(value, list) and key.isdigit():
            value = value[int(key)] if int(key) < len(value) else None
        elif isinstance(value, dict):
            value = value.get(key)
        else:
            return None
    return value


def _replacement(source: Mapping[str, Any] | None) -> str:
    """Where a retired file's field went: the botcube.yaml key its Source names, or why none does."""
    if source is None:
        return 'no botcube.yaml key; delete it'
    if 'derived' in source:
        return 'derived from botcube.yaml name'
    if 'value' in source:
        return "BotCube's own value; delete it"
    return f"botcube.yaml {source['file'] if 'file' in source else source['path']}"


def _json_leaves(value: Any, path: tuple[str, ...] = ()) -> Iterator[str]:
    """Each leaf of a JSON value, as its dotted path; an empty object or list is a leaf."""
    entries: list[tuple[str, Any]] = []
    if isinstance(value, dict):
        entries = [(str(key), child) for key, child in value.items()]
    elif isinstance(value, list):
        entries = [(str(index), child) for index, child in enumerate(value)]
    if not entries:
        yield '.'.join(path)
    for key, child in entries:
        yield from _json_leaves(child, (*path, key))


def _retired_file_errors(deploy_root: Path, file: str, held: Any) -> list[str]:
    """The migration error lines of a retired file held in a deploy root, one per field, as botcube/config/read.cjs gives them."""
    fields: dict[str, Any] = _SCHEMA['x-retired-files'][file]

    def holds(prefix: str) -> bool:
        return any(each == prefix or each.startswith(f'{prefix}.') for each in fields)

    named: list[str] = []
    for leaf in _json_leaves(held):
        keys = leaf.split('.')
        covering = max((field for field in fields if leaf == field or leaf.startswith(f'{field}.')), key=len, default=None)
        unmapped = next((index for index in range(len(keys)) if not holds('.'.join(keys[: index + 1]))), None)
        field = covering or (leaf if unmapped is None else '.'.join(keys[: unmapped + 1]))
        if field not in named:
            named.append(field)
    return [
        f'Deploy root {deploy_root}: {file} is retired: botcube.yaml beside the deploy root replaces it; move each field to its key there, then delete the file',
        *(f'Deploy root {deploy_root}: {file}: {field}: {_replacement(fields.get(field))}' for field in named),
    ]


_CONFIGURATION = re.compile(r'(\.(json|ya?ml|toml|ini|cfg|conf|env)|^\.env(\..*)?)$')
_MANIFEST = re.compile(r'^(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(\.[\w-]+)?\.json|pyproject\.toml|uv\.lock|cdk\.json|cdk\.context\.json)$')
_BOT_DIRECTORY_FILES = frozenset({'botcube.yaml', 'bot.yaml', 'latency-budgets.json'})
_BUILT = frozenset({'node_modules', 'cdk.out', 'dist', '__pycache__'})


def _configuration(name: str) -> bool:
    return bool(_CONFIGURATION.search(name)) and not _MANIFEST.match(name)


def _configuration_files(directory: Path, prefix: str = '') -> list[str]:
    """The configuration files under a deploy root, as botcube/config/read.cjs finds them."""
    entries = sorted(directory.iterdir(), key=lambda entry: entry.name)
    if prefix and any(entry.is_file() and entry.name in ('Dockerfile', 'manifest.json') for entry in entries):
        return []
    found: list[str] = []
    for entry in entries:
        if entry.is_dir():
            if not entry.name.startswith('.') and entry.name not in _BUILT:
                found += _configuration_files(entry, f'{prefix}{entry.name}/')
        elif _configuration(entry.name):
            found.append(f'{prefix}{entry.name}')
    return found


def bot_directory_errors(bot_directory: Path, deploy_root: Path | None = None) -> list[str]:
    """Every error of a bot directory against one config, botcube.yaml plus the images it names, as botcube/config/read.cjs gives them."""
    deploy_root = bot_directory / 'deploy' if deploy_root is None else deploy_root
    retired = list(_SCHEMA['x-retired-files'])
    errors = [line for file in retired if (deploy_root / file).exists()
              for line in _retired_file_errors(deploy_root, file, json.loads((deploy_root / file).read_text(encoding='utf8')))]
    own = sorted(entry.name for entry in bot_directory.iterdir()
                 if entry.is_file() and _configuration(entry.name) and entry.name not in _BOT_DIRECTORY_FILES) if bot_directory.exists() else []
    beneath = [os.path.relpath(deploy_root / file, bot_directory) for file in _configuration_files(deploy_root) if file not in retired] if deploy_root.exists() else []
    return [*errors, *(
        f'Bot directory {bot_directory}: {file}: a configuration file; a deployment is botcube.yaml plus the images it names, '
        'so move its values into botcube.yaml, or into bot.yaml in the Bot Image, then delete the file'
        for file in [*own, *beneath]
    )]


def read_deployment(deploy_root: Path) -> dict[str, Any]:
    """The validated BotCube Config beside a deploy root, after migration checks."""
    bot_directory = deploy_root.parent
    errors = bot_directory_errors(bot_directory, deploy_root)
    if errors:
        raise BotCubeConfigError('\n'.join(errors))
    config_path = bot_directory / 'botcube.yaml'
    config = load_botcube_config(config_path)
    if 'name' not in config:
        raise BotCubeConfigError(f'BotCube Config {config_path} names no deployment')
    return config


_PHYSICAL_NAMES = {
    'runtimeAgentRuntimeName': '{snake}_runtime',
    'memoryName': '{snake}_memory',
    'agentComputerBrowserName': '{snake}_agent_computer_managed',
    'agentComputerBrowserProfileNamePrefix': '{snake}_',
    'linkBrowserName': '{snake}_link',
    'agentCoreTargetName': 'default',
    'sessionApiFunctionName': '{name}-session-api',
    'clusterName': '{name}',
    'deployRoleName': '{name}-ecs-github-deploy',
    'deployPolicyName': '{name}-ecs-deploy',
    'previewOriginStackName': '{name}-preview-origin',
    'privateEgressStackName': '{name}-private-egress',
    'natGatewayName': '{name}-private-egress',
    'apiHealthStackName': '{name}-api-health',
    'apiHealthAlarmName': '{name}-api-health',
    'webLatencyStackName': '{name}-web-latency',
    'webAppMonitorName': '{name}-web',
    'alertsTopicName': '{name}-alerts',
    'parkingFunctionName': '{name}-production-parking',
    'repositoryName': '{name}/runtime',
    'buildProjectName': '{name}-container-builder',
    'buildFunctionName': '{name}-container-build-handler',
    'buildLogGroupName': '/aws/lambda/{name}-container-build-handler',
    'deployUserName': '{name}-deploy',
    'runtimeRoleName': '{name}-runtime',
    'memoryRoleName': '{name}-memory',
    'userMemoryRoleName': '{name}-user-memory',
    'chatServiceTaskRoleName': None,
    'filesMountRoleName': None,
    'filesLinksRoleName': None,
    'agentComputerBrowserRoleName': None,
    'buildFunctionRoleName': '{name}-container-build-handler',
    'buildRoleName': '{name}-container-build',
    'sessionApiRoleName': '{name}-session-api',
    'invokePolicyNamePrefix': '{name}-agentcore-invoke',
    'runtimeAlarmNamePrefix': '{name}-runtime',
    'runtimeErrorsFilterName': '{name}-runtime-error-lines',
}


_FIXED_NAMES = {
    'parkStateParameterName': '/{name}/production/park-state',
    'originPullClientSecretName': '/{name}/cloudflare/origin-pull-client',
    'originTokenSecretName': '/{name}/cloudflare/origin-api-token',
    'turnIdentityKeysSecretName': '/{name}/chat-service/turn-identity-keys',
    'rollbackTaskFamilyPrefix': '{name}-preview-rollback-',
    'rollbackPolicyName': '{name}-preview-rollback',
}

def deployment_names(config: Mapping[str, Any]) -> dict[str, str]:
    """Physical resource names from name, with the deployment's explicit overrides."""
    name = config['name']
    defaults = {key: template.replace('{name}', name).replace('{snake}', name.replace('-', '_')).replace('{compact}', name.replace('-', ''))
                for key, template in _PHYSICAL_NAMES.items() if template is not None}
    return {**defaults, **config.get('names', {}),
            **{key: template.replace('{name}', name) for key, template in _FIXED_NAMES.items()}}
