"""A User's save in the panel and the agent's next publish: the agent works from what the User saved (ADR 0087)."""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Callable
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents import artifact
from botcube_harness_deepagents.artifact import artifact_tool
from botcube_harness_deepagents.artifact_types import PAGE, SLIDES
from chat_save import UserSave, chat_service_save
from test_artifact_sheet import BUDGET, write_sheet
from test_artifact_slides import AGENDA, COVER, DECK, write_deck

pytestmark = pytest.mark.integration

USERS_COVER = COVER.replace('Where we landed, and what Q4 needs', 'Where we landed (checked by finance)')


@pytest.fixture(scope='module')
def user_saves(tmp_path_factory: pytest.TempPathFactory) -> UserSave:
    return chat_service_save(tmp_path_factory.mktemp('chat'))


def call(root: Path, **args: str) -> ToolMessage:
    result = artifact_tool(root).invoke({'name': 'Artifact', 'type': 'tool_call', 'id': 'call', 'args': args})
    assert isinstance(result, ToolMessage)
    return result


def published_deck(root: Path) -> None:
    write_deck(root, DECK, {'cover': COVER, 'agenda': AGENDA})
    call(root, file_path='/decks/q3/project/deck.json')


def test_a_publish_over_a_version_the_user_saved_is_refused_until_read_and_then_keeps_both_edits(
    tmp_path: Path, user_saves: UserSave,
) -> None:
    published_deck(tmp_path)
    saved = user_saves(tmp_path, '/decks/q3', 1, {'project/slides/cover.html': USERS_COVER})
    assert (saved['version'], saved['author'], saved['path']) == (2, 'user', '/artifacts/decks/q3.versions/2')
    write_deck(tmp_path, DECK, {'agenda': AGENDA.replace('Numbers', 'Numbers and risks')})

    with pytest.raises(ValueError) as refused:
        call(tmp_path, file_path='/decks/q3/project/deck.json')

    assert str(refused.value) == (
        'Refused: the User saved Artifact Version 2 after your last read (Artifact Version 1). '
        "Read it first (action: 'read'), redo your change on what the User saved, then publish. "
        'Changed: /decks/q3/project/slides/cover.html'
    )
    assert not (tmp_path / 'artifacts/decks/q3.versions/3').exists()

    read = json.loads(str(call(tmp_path, action='read', url='/decks/q3').content))
    assert (read['version'], read['author'], read['read']) == (2, 'user', 2)
    assert read['files']['project/slides/cover.html'] == USERS_COVER

    published = json.loads(str(call(tmp_path, file_path='/decks/q3/project/deck.json').content))
    assert (published['version'], published['type']) == (3, 'slides')
    stored = tmp_path / 'artifacts/decks/q3.versions/3/project/slides'
    assert 'checked by finance' in (stored / 'cover.html').read_text()
    assert 'Numbers and risks' in (stored / 'agenda.html').read_text()


def test_a_stale_write_over_the_users_save_is_refused_and_read_returns_what_the_user_saved(
    tmp_path: Path, user_saves: UserSave,
) -> None:
    published_deck(tmp_path)
    user_saves(tmp_path, '/decks/q3', 1, {'project/slides/cover.html': USERS_COVER})
    write_deck(tmp_path, DECK, {'cover': COVER.replace('Q3 Operating Review</h1>', 'Q3 Review</h1>')})

    with pytest.raises(ValueError, match=r'Changed: /decks/q3/project/slides/cover\.html$'):
        call(tmp_path, file_path='/decks/q3')

    read = json.loads(str(call(tmp_path, action='read', file_path='/decks/q3').content))
    assert read['files']['project/slides/cover.html'] == USERS_COVER


def test_a_users_save_the_agent_never_read_refuses_its_publish_naming_every_file(
    tmp_path: Path, user_saves: UserSave,
) -> None:
    published_deck(tmp_path)
    (tmp_path / 'artifacts/decks/q3.versions/read.json').unlink()
    user_saves(tmp_path, '/decks/q3', 1, {'project/slides/cover.html': USERS_COVER})

    with pytest.raises(ValueError) as refused:
        call(tmp_path, file_path='/decks/q3')

    assert 'after your last read (none)' in str(refused.value)
    assert str(refused.value).endswith(
        'Changed: /decks/q3/project/deck.json, /decks/q3/project/slides/agenda.html, /decks/q3/project/slides/cover.html',
    )
    listed = json.loads(str(call(tmp_path, action='list').content))['artifacts']
    assert [(artifact['version'], artifact['read']) for artifact in listed] == [(2, 0)]


def while_checked(monkeypatch: pytest.MonkeyPatch, meanwhile: Callable[[], object]) -> None:
    """Runs `meanwhile` once, while the next publish checks its staged copy of the deck."""
    pending = [meanwhile]

    def check(folder: Path, name: str) -> None:
        if pending:
            pending.pop()()
        SLIDES.check(folder, name)

    monkeypatch.setattr(artifact, 'TYPES', (dataclasses.replace(SLIDES, check=check), PAGE))


def test_a_user_save_landing_while_the_publish_is_checked_refuses_the_publish(
    tmp_path: Path, user_saves: UserSave, monkeypatch: pytest.MonkeyPatch,
) -> None:
    published_deck(tmp_path)
    write_deck(tmp_path, DECK, {'agenda': AGENDA.replace('Numbers', 'Numbers and risks')})
    while_checked(monkeypatch, lambda: user_saves(tmp_path, '/decks/q3', 1, {'project/slides/cover.html': USERS_COVER}))

    with pytest.raises(ValueError) as refused:
        call(tmp_path, file_path='/decks/q3/project/deck.json')

    assert str(refused.value) == (
        'Refused: the User saved Artifact Version 2 after your last read (Artifact Version 1). '
        "Read it first (action: 'read'), redo your change on what the User saved, then publish. "
        'Changed: /decks/q3/project/slides/cover.html'
    )
    versions = tmp_path / 'artifacts/decks/q3.versions'
    assert sorted(path.name for path in versions.iterdir()) == ['1', '1.json', '2', '2.json', 'read.json']
    assert json.loads((versions / 'read.json').read_text()) == {'version': 1}
    assert (versions / '2/project/slides/cover.html').read_text() == USERS_COVER


def test_a_publish_skips_past_another_agent_publish_but_never_past_a_user_save(
    tmp_path: Path, user_saves: UserSave, monkeypatch: pytest.MonkeyPatch,
) -> None:
    published_deck(tmp_path)

    def another_chat_publishes_then_the_user_saves() -> None:
        call(tmp_path, file_path='/decks/q3')
        user_saves(tmp_path, '/decks/q3', 2, {'project/slides/cover.html': USERS_COVER})

    while_checked(monkeypatch, another_chat_publishes_then_the_user_saves)

    with pytest.raises(ValueError, match=r'^Refused: the User saved Artifact Version 3 after your last read \(Artifact Version 2\)\.'):
        call(tmp_path, file_path='/decks/q3')

    versions = tmp_path / 'artifacts/decks/q3.versions'
    assert [json.loads((versions / f'{number}.json').read_text())['author'] for number in (1, 2, 3)] == ['agent', 'agent', 'user']
    assert not (versions / '4.json').exists()


def test_a_users_sheet_save_refuses_the_agents_publish_until_read_and_the_next_publish_keeps_the_users_edit(
    tmp_path: Path, user_saves: UserSave,
) -> None:
    write_sheet(tmp_path, BUDGET)
    call(tmp_path, file_path='/sheets/budget.sheet.json')
    # The panel's Save: the version's edits, then the User's typing as `writeCells`, keyed by the Source's file name.
    users = {'edits': [*BUDGET['edits'], {'kind': 'writeCells', 'sheet': 'Budget', 'topLeft': 'B2', 'rows': [[1500]]}]}
    saved = user_saves(tmp_path, '/sheets/budget.sheet.json', 1, {'budget.sheet.json': json.dumps(users)})
    assert (saved['version'], saved['type'], saved['path']) == (
        2, 'sheet', '/artifacts/sheets/budget.sheet.json.versions/2.sheet.json',
    )
    # A stale write over the Source, from before the agent read the User's save.
    write_sheet(tmp_path, BUDGET)

    with pytest.raises(ValueError, match=r'Refused: the User saved Artifact Version 2 .* Changed: /sheets/budget\.sheet\.json$'):
        call(tmp_path, file_path='/sheets/budget.sheet.json')
    assert not (tmp_path / 'artifacts/sheets/budget.sheet.json.versions/3.sheet.json').exists()

    read = json.loads(str(call(tmp_path, action='read', url='/sheets/budget.sheet.json').content))
    assert (read['version'], read['author']) == (2, 'user')
    assert json.loads(read['sheet']) == users
    write_sheet(tmp_path, {'edits': [*users['edits'], {'kind': 'fitColumns', 'sheet': 'Budget', 'columns': 'A:B'}]})
    assert json.loads(str(call(tmp_path, file_path='/sheets/budget.sheet.json').content))['version'] == 3


def test_a_users_sheet_save_the_checker_refuses_names_the_edit_and_stores_nothing(
    tmp_path: Path, user_saves: UserSave,
) -> None:
    write_sheet(tmp_path, BUDGET)
    call(tmp_path, file_path='/sheets/budget.sheet.json')
    checkbox = {'kind': 'formatCells', 'sheet': 'Budget', 'ranges': ['C2'], 'format': {'cellControl': {'kind': 'checkbox'}}}
    edits = {'edits': [*BUDGET['edits'], checkbox]}

    with pytest.raises(RuntimeError, match=r'budget\.sheet\.json edit 2 \(formatCells\) — format\.cellControl\.kind is "checkbox"'):
        user_saves(tmp_path, '/sheets/budget.sheet.json', 1, {'budget.sheet.json': json.dumps(edits)})

    assert sorted(path.name for path in (tmp_path / 'artifacts/sheets/budget.sheet.json.versions').iterdir()) == [
        '1.json', '1.sheet.json', 'read.json',
    ]
