"""The Credential Service reads the one BotCube Config BOTCUBE_CONFIG names, checked against its JSON Schema (ADR 0091)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from botcube_credential_service import botcube_config
from botcube_credential_service.botcube_config import (
    BotCubeConfigError,
    botcube_config_from_env,
    credential_service_http_path,
    deploy_root_file,
    load_botcube_config,
)
from botcube_credential_service.server import (
    CredentialServiceSettings,
    create_app,
    plan_usage_owner,
)
from required_keys import REQUIRED, with_required

BOTCUBE = Path(__file__).resolve().parents[2]
ENTERPRISE = BOTCUBE / 'examples' / 'enterprise' / 'botcube.yaml'
SECTION_DEFAULTS = BOTCUBE / 'tests' / 'fixtures' / 'config-section-defaults'
CANONICAL_SCHEMA = BOTCUBE / 'config' / 'botcube.schema.json'
VENDORED_SCHEMA = Path(botcube_config.__file__).with_name('botcube.schema.json')
REQUIRED_YAML = ''.join(f'{key}: {json.dumps(value)}\n' for key, value in REQUIRED.items())


def _file(tmp_path: Path, config: dict[str, Any]) -> Path:
    path = tmp_path / 'botcube.yaml'
    path.write_text(json.dumps(with_required(config)))
    return path


def _bare_file(tmp_path: Path, config: dict[str, Any]) -> Path:
    path = tmp_path / 'botcube.yaml'
    path.write_text(json.dumps(config))
    return path


@pytest.mark.parametrize('key', ['name', 'env', 'domains', 'domains.web', 'domains.chatService', 'existing', 'existing.vpc'])
def test_a_file_without_a_required_key_stops_startup_naming_it_as_the_typescript_loader_does(tmp_path: Path, key: str) -> None:
    config = json.loads(json.dumps(REQUIRED))
    *parents, last = key.split('.')
    parent = config
    for part in parents:
        parent = parent[part]
    del parent[last]
    path = _bare_file(tmp_path, config)

    with pytest.raises(BotCubeConfigError) as error:
        load_botcube_config(path)
    assert str(error.value) == f"BotCube Config {path}: {key}: '{last}' is a required property"


def test_an_empty_file_stops_startup_naming_each_key_a_deployment_gives(tmp_path: Path) -> None:
    path = _bare_file(tmp_path, {})

    with pytest.raises(BotCubeConfigError) as error:
        load_botcube_config(path)
    assert str(error.value).split('\n') == [f"BotCube Config {path}: {key}: '{key}' is a required property" for key in ['name', 'env', 'domains', 'existing']]


def test_a_valid_file_gives_its_sections_and_the_defaults_of_those_it_leaves_out(tmp_path: Path) -> None:
    config = load_botcube_config(_file(tmp_path, {'integrations': {'modelGateway': {'kind': 'openai-compatible', 'url': 'https://models.example.com/v1',
                                                     'credential': {'kind': 'file', 'path': '/run/secrets/key'}, 'turnSummaryModel': 'summary'}}}))

    assert config['integrations']['modelGateway']['url'] == 'https://models.example.com/v1'
    assert config['integrations']['proxy'] == {'kind': 'none'}
    assert config['integrations']['telemetry'] == {'kind': 'xray'}


def test_the_plan_usage_owner_is_the_files_not_the_environments(tmp_path: Path) -> None:
    owned = _file(tmp_path, {'planUsage': {'ownerAccountId': 'acct_owner_1'}})
    legacy = {'BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID': 'acct_other'}

    assert plan_usage_owner(load_botcube_config(owned)) == 'acct_owner_1'
    assert plan_usage_owner(botcube_config_from_env(legacy)) == ''


def test_the_enterprise_example_loads() -> None:
    assert load_botcube_config(ENTERPRISE)['integrations']['proxy']['url'] == 'http://proxy.example.com:3128'


def test_an_unknown_key_stops_startup_naming_its_path(tmp_path: Path) -> None:
    path = _file(tmp_path, {'integrations': {'proxy': {'kind': 'forward', 'url': 'http://proxy.example.com:3128', 'user': 'x'}}})

    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: integrations.proxy.user: '):
        load_botcube_config(path)


def test_a_missing_value_stops_startup_naming_its_path(tmp_path: Path) -> None:
    path = _file(tmp_path, {'integrations': {'telemetry': {'kind': 'otlp'}}})

    with pytest.raises(BotCubeConfigError, match=f"^BotCube Config {path}: integrations.telemetry.url: 'url' is a required property"):
        load_botcube_config(path)


def test_a_missing_file_stops_startup(tmp_path: Path) -> None:
    path = tmp_path / 'absent.json'

    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: no file'):
        load_botcube_config(path)


def test_without_a_locator_every_section_is_its_default() -> None:
    config = botcube_config_from_env({})

    assert (config['integrations']['modelGateway'], config['integrations']['proxy'], config['integrations']['telemetry']) == ({'kind': 'bedrock'}, {'kind': 'none'}, {'kind': 'xray'})


def test_the_locator_names_the_file(tmp_path: Path) -> None:
    path = _file(tmp_path, {'integrations': {'proxy': {'kind': 'forward', 'url': 'http://proxy.example.com:3128'}}})

    assert botcube_config_from_env({'BOTCUBE_CONFIG': str(path)})['integrations']['proxy']['url'] == 'http://proxy.example.com:3128'


def test_the_credential_service_stops_before_it_serves_when_its_locator_names_no_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / 'absent.json'
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))

    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: no file'):
        create_app(CredentialServiceSettings('test', lambda: 'secret'), [])


def test_the_credential_service_stops_before_it_serves_on_a_file_the_schema_refuses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _file(tmp_path, {'integrations': {'proxy': {'kind': 'forward'}}})
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))

    with pytest.raises(BotCubeConfigError, match=f"^BotCube Config {path}: integrations.proxy.url: 'url' is a required property"):
        create_app(CredentialServiceSettings('test', lambda: 'secret'), [])


def test_the_vendored_schema_is_the_canonical_schema_byte_for_byte() -> None:
    assert VENDORED_SCHEMA.read_bytes() == CANONICAL_SCHEMA.read_bytes()


def test_sections_given_with_only_their_required_fields_load_as_the_typescript_loader_parses_them(tmp_path: Path) -> None:
    expected = json.loads((SECTION_DEFAULTS / 'parsed.json').read_text(encoding='utf8'))
    config = tmp_path / 'botcube.yaml'
    config.write_text(json.dumps({**REQUIRED, **json.loads((SECTION_DEFAULTS / 'config.json').read_text(encoding='utf8'))}))

    assert load_botcube_config(config) == {**REQUIRED, **expected}


@pytest.mark.parametrize(('key', 'replacement'), [
    ('identity', 'integrations.signIn'), ('models', 'integrations.modelGateway'),
    ('turnCredentials', 'integrations.awsAccess'), ('harnessAuth', 'integrations.harnessAuth'),
    ('telemetry', 'integrations.telemetry'), ('imageRegistry', 'integrations.imageRegistry'),
    ('supplied', 'existing'), ('proxy', 'integrations.proxy'), ('corsOrigins', 'domains.web and domains.webAliases'),
    ('bot', '/bot/bot.yaml'), ('web', 'domains.web and domains.webAliases'),
    ('productName', "productName in /bot/bot.yaml, the Bot Image's bot settings"),
    ('productService', "productService in /bot/bot.yaml, the Bot Image's bot settings"),
])
def test_old_keys_name_the_replacement(tmp_path: Path, key: str, replacement: str) -> None:
    path = _file(tmp_path, {key: {}})
    with pytest.raises(BotCubeConfigError) as error:
        load_botcube_config(path)
    assert f'{key}: renamed to {replacement}' in str(error.value)


@pytest.mark.parametrize(('key', 'config', 'replacement'), [
    ('network.proxy', {'network': {'proxy': {'kind': 'none'}}}, 'integrations.proxy'),
    ('network.corsOrigins', {'network': {'corsOrigins': ['https://chat.example.com']}}, 'domains.web and domains.webAliases'),
    ('existing.network', {'existing': {'network': {}}}, 'existing.vpc, with network.natGateways 0'),
])
def test_old_nested_keys_name_the_replacement(tmp_path: Path, key: str, config: dict[str, Any], replacement: str) -> None:
    with pytest.raises(BotCubeConfigError, match=f'{key}: renamed to {replacement}'):
        load_botcube_config(_file(tmp_path, config))


SECRET = {'kind': 'secret', 'secretArn': 'arn:aws:secretsmanager:us-east-1:000000000000:secret:key'}
TELEMETRY = {'kind': 'otlp', 'url': 'https://collector.example.com/v1/traces'}


@pytest.mark.parametrize(('key', 'config'), [
    ('integrations.telemetry.credential.secretArn', {'integrations': {'telemetry': {**TELEMETRY, 'credential': SECRET}}}),
    ('integrations.signIn.clients.0.clientSecret.secretArn', {'integrations': {'signIn': {'kind': 'oidc', 'clients': [{'clientSecret': SECRET}]}}}),
])
def test_a_credential_sources_secret_arn_names_secret_id(tmp_path: Path, key: str, config: dict[str, Any]) -> None:
    with pytest.raises(BotCubeConfigError) as error:
        load_botcube_config(_file(tmp_path, config))
    assert f"{key}: renamed to secretId, the secret's name or ARN" in str(error.value)


@pytest.mark.parametrize('secret_id', ['arn:aws:secretsmanager:us-east-1:000000000000:secret:key', 'botcube/oidc-client-secret'])
def test_a_secret_credential_source_is_read_by_its_secret_id(tmp_path: Path, secret_id: str) -> None:
    config = load_botcube_config(_file(tmp_path, {'integrations': {'telemetry': {**TELEMETRY, 'credential': {'kind': 'secret', 'secretId': secret_id}}}}))

    assert config['integrations']['telemetry']['credential'] == {'kind': 'secret', 'secretId': secret_id}


def test_yaml_12_scalars_and_comments(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text(f'{REQUIRED_YAML}tags:\n  team: yes # YAML 1.2 keeps this a string\n')
    assert load_botcube_config(path)['tags']['team'] == 'yes'


def test_old_filename_names_botcube_yaml(tmp_path: Path) -> None:
    path = tmp_path / 'deployment-config.json'
    path.write_text('{}')
    with pytest.raises(BotCubeConfigError, match='renamed to botcube.yaml'):
        load_botcube_config(path)


def test_duplicate_yaml_keys_fail(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text('tags:\n  team: first\n  team: second\n')
    with pytest.raises(BotCubeConfigError, match='not YAML 1.2'):
        load_botcube_config(path)


def test_date_like_scalars_remain_strings(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text(f'{REQUIRED_YAML}tags:\n  team: 2026-11-21\n')
    assert load_botcube_config(path)['tags']['team'] == '2026-11-21'


def test_yaml_11_directive_fails(tmp_path: Path) -> None:
    path = tmp_path / 'botcube.yaml'
    path.write_text('%YAML 1.1\n---\ntags:\n  team: yes\n')
    with pytest.raises(BotCubeConfigError, match='expected YAML 1.2'):
        load_botcube_config(path)


@pytest.mark.parametrize(('config', 'field'), [
    ({'name': 'acme', 'names': {'runtimeRole': 'acme-runtime'}}, 'names.runtimeRole'),
    ({'name': 'acme', 'existing': {'vpc': {'vpcId': 'vpc-acme', 'publicSubnets': [], 'privateSubnets': [], 'natEgress': {}}}}, 'existing.vpc.natEgress'),
    ({'name': 'acme', 'tags': {'aws:createdBy': 'acme'}}, 'tags'),
])
def test_an_unknown_deployment_key_or_a_tag_aws_reserves_stops_startup(tmp_path: Path, config: dict[str, Any], field: str) -> None:
    path = _file(tmp_path, config)

    with pytest.raises(BotCubeConfigError, match=f'^BotCube Config {path}: {field}'):
        load_botcube_config(path)


DEPLOYMENT = {
    'name': 'acme-bot',
    'env': {'account': '123456789012', 'region': 'eu-west-1'},
    'domains': {'web': 'https://acme.example.com', 'chatService': 'https://api.acme.example.com'},
    'existing': REQUIRED['existing'],
}
RETIRED = BOTCUBE / 'tests/fixtures/public-example-deploy-root'


def _deploy_root(tmp_path: Path, files: dict[str, Any] | None = None) -> Path:
    """A deploy root beside a BotCube Config, holding the files given, as botcube/config/deployment.test.ts builds it."""
    root = tmp_path / 'deploy'
    (root / 'agentcore').mkdir(parents=True)
    (tmp_path / 'botcube.yaml').write_text(json.dumps(DEPLOYMENT))
    for name, value in (files or {}).items():
        (root / name).write_text(json.dumps(value))
    return root


def test_a_retired_file_fails_naming_each_fields_botcube_yaml_key_as_the_typescript_reader_does(tmp_path: Path) -> None:
    root = _deploy_root(tmp_path, {'identity.json': {
        'aws': {'account': '000000000000', 'ecs': {'publicSubnets': [{'id': 'subnet-puba'}], 'parking': {'originSlotKey': 'slot'}, 'cluster': 'acme'}},
        'ssm': {'parkState': '/acme/park'},
        'github': {'environment': 'production'},
    }})

    with pytest.raises(BotCubeConfigError) as error:
        deploy_root_file(root, 'agentcore/aws-targets.json', BOTCUBE)
    assert str(error.value).split('\n') == [
        f'Deploy root {root}: identity.json is retired: botcube.yaml beside the deploy root replaces it; move each field to its key there, then delete the file',
        f'Deploy root {root}: identity.json: aws.account: botcube.yaml env.account',
        f'Deploy root {root}: identity.json: aws.ecs.publicSubnets: botcube.yaml existing.vpc.publicSubnets',
        f"Deploy root {root}: identity.json: aws.ecs.parking.originSlotKey: BotCube's own value; delete it",
        f'Deploy root {root}: identity.json: aws.ecs.cluster: botcube.yaml names.clusterName',
        f'Deploy root {root}: identity.json: ssm.parkState: derived from botcube.yaml name',
        f'Deploy root {root}: identity.json: github: no botcube.yaml key; delete it',
    ]


@pytest.mark.parametrize('retired', ['identity.json', 'agentcore/agentcore.json', 'agentcore/aws-targets.json'])
def test_each_retired_file_the_public_example_held_fails_and_passes_once_gone(tmp_path: Path, retired: str) -> None:
    root = _deploy_root(tmp_path)
    (root / retired).write_text((RETIRED / retired).read_text())

    with pytest.raises(BotCubeConfigError, match=f'Deploy root {root}: {retired} is retired'):
        deploy_root_file(root, 'identity.json', BOTCUBE)
    (root / retired).unlink()
    assert deploy_root_file(root, 'identity.json', BOTCUBE)['aws']['account'] == '123456789012'


def test_the_public_examples_agentcore_project_fields_are_named_as_the_typescript_reader_names_them(tmp_path: Path) -> None:
    root = _deploy_root(tmp_path)
    (root / 'agentcore/agentcore.json').write_text((RETIRED / 'agentcore/agentcore.json').read_text())

    assert botcube_config.bot_directory_errors(tmp_path, root) == [
        f'Deploy root {root}: agentcore/agentcore.json is retired: botcube.yaml beside the deploy root replaces it; move each field to its key there, then delete the file',
        f'Deploy root {root}: agentcore/agentcore.json: name: derived from botcube.yaml name',
        f'Deploy root {root}: agentcore/agentcore.json: tags.agentcore:project-name: botcube.yaml name',
        f'Deploy root {root}: agentcore/agentcore.json: runtimes.0.name: derived from botcube.yaml name',
        f"Deploy root {root}: agentcore/agentcore.json: runtimes.0.dockerfile: BotCube's own value; delete it",
        f'Deploy root {root}: agentcore/agentcore.json: memories.0.name: derived from botcube.yaml name',
    ]


def _bot_directory(tmp_path: Path, files: list[str]) -> Path:
    for file in ['botcube.yaml', *files]:
        (tmp_path / file).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / file).write_text('{}')
    return tmp_path


@pytest.mark.parametrize('file', ['settings.json', 'release.json', '.env', 'deploy/ecs/config.yaml', 'deploy/overrides.toml'])
def test_a_bot_directory_fails_while_it_holds_another_configuration_file_and_passes_once_it_is_gone(tmp_path: Path, file: str) -> None:
    root = _bot_directory(tmp_path, [file])

    assert botcube_config.bot_directory_errors(root) == [
        f'Bot directory {root}: {file}: a configuration file; a deployment is botcube.yaml plus the images it names, '
        'so move its values into botcube.yaml, or into bot.yaml in the Bot Image, then delete the file'
    ]
    (root / file).unlink()
    assert botcube_config.bot_directory_errors(root) == []


def test_a_bot_directory_holds_its_bot_settings_latency_budgets_build_manifests_and_build_contexts(tmp_path: Path) -> None:
    root = _bot_directory(tmp_path, [
        'bot.yaml', 'latency-budgets.json', 'pyproject.toml', 'uv.lock',
        'deploy/stage-tools.sh', 'deploy/ecs/cdk/package.json', 'deploy/ecs/cdk/tsconfig.build.json', 'deploy/ecs/cdk/cdk.json',
        'deploy/credential-service/Dockerfile', 'deploy/credential-service/remint/settings.json',
        'deploy/link-extension/manifest.json', 'deploy/link-extension/rules.json',
        'deploy/ecs/cdk/node_modules/some-package/config.json', 'deploy/agentcore/.cli/state.json',
        'ui/web/tsconfig.json', 'tests/fixtures/profile.json',
    ])

    assert botcube_config.bot_directory_errors(root) == []


def test_the_credential_service_http_path_is_the_files_or_none() -> None:
    assert credential_service_http_path({'services': {'credentialService': {'http': {'path': '/rpc'}}}}) == '/rpc'
    assert credential_service_http_path({'services': {'credentialService': {}}}) == ''
    assert credential_service_http_path({}) == ''
