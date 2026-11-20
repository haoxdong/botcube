"""A bot is a settings file the Harness reads, with no bot code (ADR 0091)."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agentcore_fake import turn_identity
from botcube_harness_deepagents import serving, session_api
from botcube_harness_deepagents.bot_settings import BotSettingsError, load_bot_settings
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
    path = root / 'bot.json'
    path.write_text(json.dumps({
        'agentIdentity': {'name': 'Cubey', 'character': 'A test bot'},
        'accountKey': 'cubey',
        'models': [{'key': 'sonnet-4.6', 'label': 'Sonnet', 'provider': 'anthropic'}, {'key': 'opus-4.6', 'label': 'Opus', 'provider': 'anthropic'}],
        'skills': ['skills/greeting'],
        **settings,
    }))
    return path


@pytest.fixture
def bot_service(request: pytest.FixtureRequest, start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[_Service]:
    home = tmp_path / 'home'
    home.mkdir()
    bot = _bot(tmp_path / 'bot', **getattr(request, 'param', {}))
    for name, value in {'HOME': str(home), 'BOTCUBE_CHECKPOINT_PATH': str(tmp_path / 'checkpoints.sqlite3'), 'LANGSMITH_TRACING': 'false',
                        'BOTCUBE_WORKSPACE': str(tmp_path / 'workspace'), 'BOTCUBE_BOT_SETTINGS': str(bot)}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv('BOTCUBE_CARTRIDGE_MODULE')
    for name, value in {'AGENTCORE_MEMORY_ID': '', '_AGENTS': {}, '_BACKENDS': {}, '_BACKEND_BY_AGENT': {}, '_CHECKPOINTER': None,
                        '_STORE': None, '_SESSION_TURNS': serving._SessionTurns()}.items():
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


def _signed(subject: str) -> str:
    return f'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ7{subject}In0.{hashlib.sha256(subject.encode()).hexdigest()}'


def _shell_reading(token: str) -> str:
    return f'{hashlib.sha256(token.encode()).hexdigest()}  -'


_PRINT_ENVIRONMENT = 'run: env; printf %s "$BOTCUBE_USER_TOKEN" | sha256sum'


@pytest.mark.parametrize('bot_service', [{'userTokenInShell': True}], indirect=True)
def test_an_opted_in_bot_s_shell_holds_the_turn_s_user_token_which_the_model_and_transcript_never_see(
    bot_service: _Service, caplog: pytest.LogCaptureFixture,
) -> None:
    token = _signed('user-1')

    events = bot_service.turn(_PRINT_ENVIRONMENT, userToken=token)

    output = _tool_output(events)
    assert _shell_reading(token) in output
    assert 'BOTCUBE_USER_TOKEN=[redacted]' in output
    seen = json.dumps([events, bot_service.recorder.prompts, bot_service.recorder.heard])
    assert token not in seen
    assert 'harness_shell_output' in caplog.text
    assert token not in caplog.text


@pytest.mark.parametrize('bot_service', [{'userTokenInShell': True}], indirect=True)
def test_each_turn_s_shell_holds_that_turn_s_user_token(bot_service: _Service) -> None:
    bot_service.turn(_PRINT_ENVIRONMENT, userToken=_signed('first'))

    events = bot_service.turn(_PRINT_ENVIRONMENT, userToken=_signed('second'))

    assert _shell_reading(_signed('second')) in _tool_output(events)


@pytest.mark.parametrize('bot_service', [{'userTokenInShell': True}], indirect=True)
def test_a_turn_without_a_user_token_leaves_none_from_an_earlier_turn_in_the_shell(bot_service: _Service) -> None:
    bot_service.turn(_PRINT_ENVIRONMENT, userToken=_signed('first'))

    events = bot_service.turn('run: printf "[%s]" "$BOTCUBE_USER_TOKEN"')

    assert _tool_output(events).startswith('[]')


@pytest.mark.parametrize('bot_service', [{}, {'userTokenInShell': False}], indirect=True)
def test_a_bot_keeps_the_user_token_out_of_its_shell_unless_it_opts_in(bot_service: _Service) -> None:
    events = bot_service.turn('run: printenv BOTCUBE_USER_TOKEN || echo absent', userToken=_signed('user-1'))

    assert _tool_output(events).startswith('absent\n')
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


@pytest.mark.parametrize(
    ('settings', 'field'),
    [
        ({'agentIdentity': {'name': 'Cubey', 'character': 'A test bot', 'colour': 'blue'}}, 'agentIdentity.colour'),
        ({'models': []}, 'models'),
        ({'skills': ['skills/missing']}, 'skills.0'),
        ({'skills': ['skills/greeting', 'other/greeting']}, 'skills.1'),
        ({'userTokenInShell': 'yes'}, 'userTokenInShell'),
        ({'instructions': 'MISSING.md'}, 'instructions'),
    ],
)
def test_bad_bot_settings_stop_startup_naming_the_field(start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                        settings: dict[str, Any], field: str) -> None:
    path = _bot(tmp_path, **settings)
    (tmp_path / 'other' / 'greeting').mkdir(parents=True)
    (tmp_path / 'other' / 'greeting' / 'SKILL.md').write_text(SKILL)
    monkeypatch.setenv('BOTCUBE_BOT_SETTINGS', str(path))
    monkeypatch.delenv('BOTCUBE_CARTRIDGE_MODULE')

    with pytest.raises(BotSettingsError, match=rf'^Bot settings {path}: {re.escape(field)}: '):
        start()


def test_a_bot_is_settings_or_a_cartridge_never_both(start: Start, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_BOT_SETTINGS', str(_bot(tmp_path)))

    with pytest.raises(BotSettingsError, match=r'^BOTCUBE_BOT_SETTINGS and BOTCUBE_CARTRIDGE_MODULE are both set'):
        start()


def test_the_example_bot_is_servable() -> None:
    example = Path(__file__).resolve().parents[3] / 'examples' / 'bot'

    bot = load_bot_settings(example / 'bot.json')

    assert (bot.agent_name, bot.models[0], bot.skills) == ('BotCube', 'echo', (example / 'skills' / 'computer',))
