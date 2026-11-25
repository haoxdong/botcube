"""A bot is a settings file the Harness reads, with no bot code (ADR 0091)."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agentcore_fake import turn_identity
from botcube_harness_deepagents import serving, session_api, turn_lifecycle
from botcube_harness_deepagents.bot_settings import BotSettingsError, load_bot_settings
from deployment_fixture import BOTCUBE, ENDPOINT_MODELS, deploy, resolve
from test_serving import _Recorder, _ScriptedModel, _Service, _tool_output
from test_serving import start as start

Start = Callable[[], list[tuple[Any, dict[str, Any]]]]

SKILL = '---\nname: greeting\ndescription: Greet the user by name.\n---\n\nSay hello first.\n'
INSTRUCTIONS = 'Answer every User in French.\n'


def _bot(root: Path, **settings: Any) -> Path:
    skill = root / 'skills' / 'greeting'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text(SKILL)
    (root / 'INSTRUCTIONS.md').write_text(INSTRUCTIONS)
    path = root / 'bot.yaml'
    path.write_text(json.dumps({
        'agentIdentity': {'name': 'Cubey', 'character': 'A test bot'},
        'accountKey': 'cubey',
        'models': [{'key': 'sonnet-4.6', 'label': 'Sonnet', 'provider': 'anthropic'}, {'key': 'opus-4.6', 'label': 'Opus', 'provider': 'anthropic'}],
        'skills': ['skills/greeting'],
        **settings,
    }))
    return path


def _deployed(monkeypatch: pytest.MonkeyPatch, root: Path, bot: Path, **sections: Any) -> Path:
    """A BotCube Config in its own directory, naming the bot settings relative to itself as the examples' do."""
    directory = root / 'deployment'
    directory.mkdir()
    original = load_bot_settings

    def image_settings(path: Path) -> Any:
        assert path == Path('/bot/bot.yaml')
        return original(bot)

    monkeypatch.setattr('botcube_harness_deepagents.bot_settings.load_bot_settings', image_settings)
    return deploy(monkeypatch, directory, **sections)


@pytest.fixture
def bot_service(request: pytest.FixtureRequest, start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[_Service]:
    home = tmp_path / 'home'
    home.mkdir()
    bot = _bot(tmp_path / 'bot', **getattr(request, 'param', {}))
    for name, value in {'HOME': str(home), 'BOTCUBE_CHECKPOINT_PATH': str(tmp_path / 'checkpoints.sqlite3'), 'LANGSMITH_TRACING': 'false',
                        'BOTCUBE_WORKSPACE': str(tmp_path / 'workspace')}.items():
        monkeypatch.setenv(name, value)
    _deployed(monkeypatch, tmp_path, bot)
    for name, value in {'AGENTCORE_MEMORY_ID': '', '_AGENTS': {}, '_BACKENDS': {}, '_BACKEND_BY_AGENT': {}, '_CHECKPOINTER': None,
                        '_STORE': None, '_SESSION_TURNS': turn_lifecycle.SessionTurns()}.items():
        monkeypatch.setattr(serving, name, value)
    recorder = _Recorder()

    def build_model(**kwargs: Any) -> Any:
        recorder.builds.append(kwargs)
        return _ScriptedModel(recorder=recorder)

    monkeypatch.setattr(serving, 'build_model', build_model)
    monkeypatch.setattr(session_api, 'AGENTCORE_MEMORY_ID', '')
    monkeypatch.setattr(session_api, '_GRAPH', None)
    start()
    with TestClient(serving.app) as client:
        yield _Service(client, recorder, home, [])


def test_the_harness_serves_the_bot_its_settings_describe(bot_service: _Service) -> None:
    events = bot_service.turn('read: /skills/greeting/SKILL.md', actor=None)

    assert serving._require_bot().agent_name == 'Cubey'
    # A Turn that names no model runs on the bot's first.
    assert bot_service.recorder.builds[-1]['model'] == 'sonnet-4.6'
    assert '- greeting:' in bot_service.recorder.prompts[0]
    assert 'Say hello first.' in _tool_output(events)


@pytest.mark.parametrize('bot_service', [{'instructions': 'INSTRUCTIONS.md'}], indirect=True)
def test_the_bots_instructions_follow_botcubes_in_the_system_prompt(bot_service: _Service) -> None:
    bot_service.turn('hello')

    system = bot_service.recorder.prompts[0]
    assert system.startswith(serving.AGENT_SYSTEM_PROMPT + '\n\n' + INSTRUCTIONS)


def test_a_bot_without_instructions_keeps_botcubes_system_prompt(bot_service: _Service) -> None:
    bot_service.turn('hello')

    system = bot_service.recorder.prompts[0]
    assert system.startswith(serving.AGENT_SYSTEM_PROMPT)
    assert INSTRUCTIONS.strip() not in system


def test_a_turn_runs_on_the_model_it_names(bot_service: _Service) -> None:
    bot_service.turn('hello', model='opus-4.6')

    assert bot_service.recorder.builds[-1]['model'] == 'opus-4.6'


@pytest.mark.parametrize('bot_service', [{'models': [
    {'key': 'claude-sonnet-5-5', 'label': 'Sonnet', 'provider': 'anthropic'},
    {'key': 'gpt-5', 'label': 'GPT', 'provider': 'openai', 'maxTokens': 32000},
]}], indirect=True)
def test_a_turns_model_is_built_on_its_provider_under_its_output_ceiling(bot_service: _Service) -> None:
    bot_service.turn('hello')
    bot_service.turn('hello', model='gpt-5', thread='thread-gpt')

    assert [(build['model'], build['provider'], build['max_tokens']) for build in bot_service.recorder.builds] == [
        ('claude-sonnet-5-5', 'anthropic', None), ('gpt-5', 'openai', 32000),
    ]


def test_a_turn_acts_as_the_actor_its_identity_names(bot_service: _Service) -> None:
    # A Session filed under an older ID: the acting User is the Turn identity's actor, not the Session's filing ID.
    bot_service.turn('hello', user='older-filing', turnIdentity=turn_identity('current-actor', 'older-filing'))

    assert [(key.actor_id, key.session_user_id) for key in serving._AGENTS] == [('current-actor', 'older-filing')]


def test_a_turn_with_no_identity_acts_as_the_session_user(bot_service: _Service) -> None:
    bot_service.turn('hello', user='user-1')

    assert [key.actor_id for key in serving._AGENTS] == ['user-1']


_RESOURCE = 'run: printenv OTEL_RESOURCE_ATTRIBUTES'


def test_shell_commands_carry_the_acting_user_and_the_traffic_marker(bot_service: _Service) -> None:
    # The OpenTelemetry resource-attribute format percent-encodes values, so a separator in the ID stays inside it.
    events = bot_service.turn(_RESOURCE, turnIdentity=turn_identity('user one,2', 'user-1'), traffic='test')

    assert _tool_output(events) == 'enduser.id=user%20one%2C2,botcube.traffic=test\n\n[Command succeeded with exit code 0]'


def test_a_turn_with_no_traffic_marker_carries_only_the_user(bot_service: _Service) -> None:
    events = bot_service.turn(_RESOURCE, user='user-1')

    assert _tool_output(events) == 'enduser.id=user-1\n\n[Command succeeded with exit code 0]'


def test_a_traffic_change_reaches_the_cached_agent_without_a_rebuild(bot_service: _Service) -> None:
    bot_service.turn(_RESOURCE, traffic='test')
    events = bot_service.turn(_RESOURCE, traffic='real')

    assert _tool_output(events) == 'enduser.id=user-1,botcube.traffic=real\n\n[Command succeeded with exit code 0]'
    assert len(serving._AGENTS) == 1


def test_a_member_of_a_bot_that_keeps_extracted_memory_gets_the_memory_tool(bot_service: _Service) -> None:
    bot_service.turn('hello')

    assert 'memory' in bot_service.recorder.tools[-1]


@pytest.mark.parametrize('bot_service', [{'extractedMemory': {'enabled': False}}], indirect=True)
def test_a_bot_whose_settings_turn_extracted_memory_off_gives_a_member_no_memory(bot_service: _Service) -> None:
    bot_service.turn('hello')

    assert 'memory' not in bot_service.recorder.tools[-1]
    assert all(agent.graph.store is None for agent in serving._AGENTS.values())


@pytest.mark.parametrize(('settings', 'written', 'extracted'), [
    ({}, True, True),
    ({'writtenMemory': {'enabled': False}}, False, True),
    ({'extractedMemory': {'enabled': False}}, True, False),
    ({'writtenMemory': {}, 'extractedMemory': {}}, True, True),
])
def test_each_kind_of_memory_is_on_unless_its_settings_turn_it_off(tmp_path: Path, settings: dict[str, Any], written: bool, extracted: bool) -> None:
    bot = load_bot_settings(_bot(tmp_path, **settings))

    assert (bot.written_memory, bot.extracted_memory) == (written, extracted)


def test_memory_stops_startup_naming_both_kinds_of_memory(start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _bot(tmp_path, memory=True)
    _deployed(monkeypatch, tmp_path, path)

    with pytest.raises(BotSettingsError, match=rf'^Bot settings {re.escape(str(path.resolve()))}: memory: renamed to writtenMemory.enabled and extractedMemory.enabled'):
        start()


@pytest.mark.parametrize(
    ('settings', 'field'),
    [
        ({'agentIdentity': {'name': 'Cubey', 'character': 'A test bot', 'colour': 'blue'}}, 'agentIdentity.colour'),
        ({'models': []}, 'models'),
        ({'skills': ['skills/missing']}, 'skills.0'),
        ({'skills': ['skills/greeting', 'other/greeting']}, 'skills.1'),
        ({'environment': {'HOME_DIR': '${HOME}'}}, 'environment.HOME_DIR'),
        ({'instructions': 'MISSING.md'}, 'instructions'),
    ],
)
def test_bad_bot_settings_stop_startup_naming_the_field(start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                        settings: dict[str, Any], field: str) -> None:
    path = _bot(tmp_path, **settings)
    (tmp_path / 'other' / 'greeting').mkdir(parents=True)
    (tmp_path / 'other' / 'greeting' / 'SKILL.md').write_text(SKILL)
    _deployed(monkeypatch, tmp_path, path)

    with pytest.raises(BotSettingsError, match=rf'^Bot settings {re.escape(str(path.resolve()))}: {re.escape(field)}: '):
        start()


GATEWAY = {'modelGateway': {**ENDPOINT_MODELS, 'url': 'https://models.example.com'}}
UNPROFILED = {'key': 'sonnet-4.6', 'label': 'Sonnet', 'provider': 'anthropic'}


def test_a_gateway_model_with_no_ceiling_and_no_langchain_profile_stops_startup(start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _bot(tmp_path, models=[{'key': 'claude-sonnet-5-5', 'label': 'Sonnet', 'provider': 'anthropic'}, UNPROFILED])
    _deployed(monkeypatch, tmp_path, path, integrations=GATEWAY)

    with pytest.raises(BotSettingsError, match=re.escape(
        'Bot settings /bot/bot.yaml: models.1.maxTokens: LangChain has no model profile for sonnet-4.6 to take its output ceiling from: set maxTokens'
    )):
        start()


def test_a_gateway_model_without_a_langchain_profile_runs_under_the_ceiling_it_sets(start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _bot(tmp_path, models=[{**UNPROFILED, 'maxTokens': 16000}])
    _deployed(monkeypatch, tmp_path, path, integrations=GATEWAY)

    start()

    assert serving._require_bot().models['sonnet-4.6'].max_tokens == 16000


def test_user_token_in_shell_stops_startup_naming_environment(start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _bot(tmp_path, userTokenInShell=True)
    _deployed(monkeypatch, tmp_path, path)

    with pytest.raises(BotSettingsError, match=rf'^Bot settings {re.escape(str(path.resolve()))}: userTokenInShell: renamed to environment, '):
        start()


def test_the_harness_reads_the_bot_image_without_a_config_locator(monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import bot_settings

    monkeypatch.delenv('BOTCUBE_CONFIG', raising=False)
    seen: list[Path] = []

    def missing_image(path: Path) -> Any:
        seen.append(path)
        raise BotSettingsError('missing image')

    monkeypatch.setattr(bot_settings, 'load_bot_settings', missing_image)
    with pytest.raises(BotSettingsError, match='missing image'):
        bot_settings.bot_from_env()
    assert seen == [Path('/bot/bot.yaml')]


def test_the_example_bot_is_servable() -> None:
    example = Path(__file__).resolve().parents[3] / 'examples' / 'bot'

    bot = load_bot_settings(example / 'bot.yaml')

    assert (bot.agent_name, bot.default_model, bot.skills) == ('BotCube', 'echo', (example / 'skills' / 'computer',))


@pytest.mark.parametrize('case', json.loads((Path(__file__).resolve().parents[3] / 'tests/fixtures/model-provider-reachability.json').read_text()))
def test_gateway_reachability(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, case: dict[str, Any]) -> None:
    from botcube_harness_deepagents import bot_settings

    provider = case['provider']
    bot = _bot(tmp_path / 'bot', models=[{'key': 'test-model', 'label': 'Test', 'provider': provider, 'maxTokens': 1024}])
    monkeypatch.setattr(bot_settings, 'load_bot_settings', lambda path: load_bot_settings(bot))
    gateway = {**ENDPOINT_MODELS, 'url': 'https://models.example.com', **case['gateway']}
    path = deploy(monkeypatch, tmp_path, integrations={'modelGateway': gateway})

    if case['error'] is None:
        assert bot_settings.bot_from_env()[1] == 'test-model'
    else:
        with pytest.raises(BotSettingsError) as raised:
            bot_settings.bot_from_env()
        assert str(raised.value) == f"BotCube Config {path}: the bot settings' model test-model is on provider {provider}, but {case['error']}"


@pytest.mark.integration
@pytest.mark.parametrize('source', [
    BOTCUBE / 'examples/public/botcube.yaml',
    BOTCUBE / 'examples/enterprise/botcube.yaml',
], ids=['public', 'enterprise'])
@pytest.mark.parametrize(('provider', 'enterprise_error'), [
    ('anthropic', "the bot settings' model test-model is on provider anthropic, but "
     "integrations.modelGateway.url ends in /v1, which Anthropic's API adds itself: "
     "set integrations.modelGateway.providers.anthropic.url without /v1"),
    ('openai', None),
    ('deepseek', "the bot settings' model test-model is on provider deepseek, but "
     'integrations.modelGateway reaches the providers anthropic and openai'),
    ('echo', None),
], ids=['anthropic', 'openai', 'deepseek', 'echo'])
def test_startup_uses_the_resolver_reachability_message(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, source: Path, provider: str, enterprise_error: str | None,
) -> None:
    from botcube_harness_deepagents import bot_settings

    path = resolve(source, tmp_path / 'resolved.json')
    monkeypatch.setenv('BOTCUBE_CONFIG', str(path))
    bot = _bot(tmp_path / 'bot', models=[{'key': 'test-model', 'label': 'Test', 'provider': provider, 'maxTokens': 1024}])
    monkeypatch.setattr(bot_settings, 'load_bot_settings', lambda path: load_bot_settings(bot))
    reason = json.loads(path.read_text())['modelGateway'][provider]['unreachableReason']

    expected = enterprise_error if source.parent.name == 'enterprise' else None
    if expected is None:
        assert reason is None
        assert bot_settings.bot_from_env()[1] == 'test-model'
    else:
        assert expected.endswith(f', but {reason}')
        with pytest.raises(BotSettingsError) as error:
            bot_settings.bot_from_env()
        assert str(error.value) == f'BotCube Config {path}: {expected}'
