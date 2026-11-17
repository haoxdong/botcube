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

    assert serving._require_cartridge().agent_name == 'Cubey'
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


def test_a_turn_acts_as_the_actor_its_identity_names(bot_service: _Service) -> None:
    # A Session filed under an older ID: the acting User is the Turn identity's actor, not the Session's filing ID.
    bot_service.turn('hello', user='older-filing', turnIdentity=turn_identity('current-actor', 'older-filing'))

    assert [(key.actor_id, key.session_user_id) for key in serving._AGENTS] == [('current-actor', 'older-filing')]


def test_a_turn_with_no_identity_acts_as_the_session_user(bot_service: _Service) -> None:
    bot_service.turn('hello', user='user-1')

    assert [key.actor_id for key in serving._AGENTS] == ['user-1']


@pytest.mark.parametrize(
    ('settings', 'field'),
    [
        ({'agentIdentity': {'name': 'Cubey', 'character': 'A test bot', 'colour': 'blue'}}, 'agentIdentity.colour'),
        ({'models': []}, 'models'),
        ({'skills': ['skills/missing']}, 'skills.0'),
        ({'skills': ['skills/greeting', 'other/greeting']}, 'skills.1'),
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
