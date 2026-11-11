"""Publishing Slides with the `Artifact` tool: the deck is checked against the slide format first."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents import slides
from botcube_harness_deepagents.artifact import artifact_tool
from botcube_harness_deepagents.slides import CHECKER, check

SKILL_PAGE = CHECKER.parent.parent / 'skills' / 'artifacts' / 'SKILL.md'

DECK: dict[str, object] = {
    'v': 4, 'createdOnFiles': {'v': 1, 'at': '2026-11-11T09:00:00Z'}, 'lists': 'css', 'title': 'Q3 Operating Review',
    'order': ['cover', 'agenda'], 'sections': {'s1': {'description': 'Where Q3 landed', 'start': 'cover'}},
    'cover': 'cover', 'faces': {}, 'designSystems': [],
}
COVER = """<section id="cover" style="background:#0f2a3d;color:#f4f1ea;font-family:Inter, sans-serif;padding:128px;display:flex;flex-direction:column;justify-content:center;gap:32px">
<h1 style="font-size:120px;font-weight:600">Q3 Operating Review</h1>
<p style="font-size:32px">Where we landed, and what Q4 needs</p>
<aside>Open with the headline number.</aside>
</section>"""
AGENDA = """<section id="agenda" style="background:#fbfbf8;color:#1a1a1a;padding:128px;display:flex;flex-direction:column;gap:48px">
<h2 style="font-size:72px">Agenda</h2>
<div style="display:flex;gap:32px">
<div style="flex:1;background:#ffffff;padding:40px;border:1px solid #e3e6e4;border-radius:16px">
<h3 style="font-size:44px">Numbers</h3>
</div>
</div>
</section>"""
# The same agenda with five things the slide format has no place for.
BROKEN_AGENDA = """<section id="agenda" style="background:#fbfbf8;color:#1a1a1a;padding:128px;display:flex;flex-direction:column;gap:48px">
<h4 style="font-size:72px">Agenda</h4>
<div style="display:flex;gap:32px;margin-top:24px">
<div style="flex:1;background:#ffffff;padding:40px;z-index:2" onclick="track()">
<h3 style="font-size:2em">Numbers</h3>
</div>
</div>
<script>track()</script>
</section>"""


def call(root: Path, **args: str) -> ToolMessage:
    result = artifact_tool(root).invoke({'name': 'Artifact', 'type': 'tool_call', 'id': 'publish', 'args': args})
    assert isinstance(result, ToolMessage)
    return result


def write_deck(root: Path, deck: dict[str, object], slides: dict[str, str]) -> None:
    project = root / 'decks/q3/project'
    (project / 'slides').mkdir(parents=True, exist_ok=True)
    (project / 'deck.json').write_text(json.dumps(deck), encoding='utf-8')
    for name, html in slides.items():
        (project / 'slides' / f'{name}.html').write_text(html, encoding='utf-8')


def test_a_deck_breaking_the_slide_format_returns_every_error_and_saves_nothing(tmp_path: Path) -> None:
    write_deck(tmp_path, {**DECK, 'order': ['cover', 'agenda', 'numbers']}, {'cover': COVER, 'agenda': BROKEN_AGENDA})

    with pytest.raises(ValueError) as refused:
        call(tmp_path, file_path='/decks/q3/project/deck.json')

    message = str(refused.value)
    assert message.startswith('The deck breaks the slide format, so nothing was published. Fix every error')
    errors = [line for line in message.splitlines() if line.startswith('- ')]
    expected = [
        ('project/deck.json', 'order[2]', 'project/slides/numbers.html'),
        ('project/slides/agenda.html:2:', '<h4>', 'Nearest: <h3>'),
        ('project/slides/agenda.html:3:', '<div> margin-top: 24px', 'Nearest: gap on the parent'),
        ('project/slides/agenda.html:4:', '<div> z-index: 2', 'Nearest: source order'),
        ('project/slides/agenda.html:4:', '<div onclick>', 'Nearest: a pinned <x-embed>'),
        ('project/slides/agenda.html:5:', '<h3> font-size: 2em', 'Nearest: font-size: a px length'),
        ('project/slides/agenda.html:8:', '<script>', 'Nearest: a pinned <x-embed>'),
    ]
    for where, element, nearest in expected:
        assert any(where in line and element in line and nearest in line for line in errors), (where, element, errors)
    assert len(errors) == len(expected), errors
    assert list((tmp_path / 'artifacts/decks/q3.versions').iterdir()) == []


def test_the_fixed_deck_publishes_as_slides_version_1(tmp_path: Path) -> None:
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA})

    result = call(tmp_path, file_path='/decks/q3/project/deck.json', description='Q3 against plan')

    published = {
        'id': '/decks/q3', 'type': 'slides', 'title': 'Q3 Operating Review', 'description': 'Q3 against plan',
        'version': 1, 'path': '/artifacts/decks/q3.versions/1',
    }
    assert json.loads(str(result.content)) == published
    version = tmp_path / 'artifacts/decks/q3.versions/1/project'
    assert json.loads((version / 'deck.json').read_text()) == DECK
    assert (version / 'slides/agenda.html').read_text() == AGENDA


def test_publishing_the_deck_again_makes_version_2_and_keeps_version_1(tmp_path: Path) -> None:
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA})
    call(tmp_path, file_path='/decks/q3/project/deck.json')
    write_deck(tmp_path, DECK, {'agenda': AGENDA.replace('Agenda', 'Today')})

    second = json.loads(str(call(tmp_path, file_path='/decks/q3').content))

    assert (second['id'], second['version'], second['path']) == ('/decks/q3', 2, '/artifacts/decks/q3.versions/2')
    assert 'Agenda' in (tmp_path / 'artifacts/decks/q3.versions/1/project/slides/agenda.html').read_text()
    assert 'Today' in (tmp_path / 'artifacts/decks/q3.versions/2/project/slides/agenda.html').read_text()


def test_a_pinned_x_embed_may_hold_a_live_page_with_its_script(tmp_path: Path) -> None:
    embed = ('<x-embed style="position:absolute;left:128px;top:300px;width:800px;height:400px"><!doctype html><html><body>'
             '<div id="n"></div><script>document.getElementById("n").textContent = 1 < 2 ? "live" : "";</script>'
             '</body></html></x-embed>\n</section>')
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA.replace('</section>', embed)})
    assert json.loads(str(call(tmp_path, file_path='/decks/q3/project/deck.json').content))['type'] == 'slides'

    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA.replace('</section>', embed.replace('position:absolute;', ''))})
    with pytest.raises(ValueError, match=r'agenda\.html:8:\d+ <x-embed> — is not pinned with a width and a height'):
        call(tmp_path, file_path='/decks/q3/project/deck.json')


VERSIONS = 'artifacts/decks/q3.versions'


def stored(root: Path) -> list[str]:
    """Every file in the deck's version store, staging folders included."""
    versions = root / VERSIONS
    return sorted(path.relative_to(versions).as_posix() for path in versions.rglob('*') if not path.is_dir())


def test_a_deck_lists_and_reads_as_slides_with_each_versions_author(tmp_path: Path) -> None:
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA})
    call(tmp_path, file_path='/decks/q3/project/deck.json', description='Q3 against plan')
    versions = tmp_path / VERSIONS
    (versions / '2/project/slides').mkdir(parents=True)
    (versions / '2/project/deck.json').write_text(json.dumps(DECK), encoding='utf-8')
    (versions / '2/project/slides/agenda.html').write_text(AGENDA.replace('Agenda', 'Today'), encoding='utf-8')
    (versions / '2.json').write_text(json.dumps({'author': 'user', 'title': 'Q3 review', 'description': ''}))

    listed = json.loads(str(call(tmp_path, action='list').content))
    read = json.loads(str(call(tmp_path, action='read', file_path='/decks/q3/project/deck.json').content))

    latest = {
        'id': '/decks/q3', 'type': 'slides', 'title': 'Q3 review', 'description': '', 'version': 2, 'author': 'user',
        'path': '/artifacts/decks/q3.versions/2',
    }
    assert listed == {'artifacts': [{**latest, 'read': 1}]}
    assert read == {
        **latest, 'read': 2,
        'files': {'project/deck.json': json.dumps(DECK), 'project/slides/agenda.html': AGENDA.replace('Agenda', 'Today')},
        'versions': [
            {'version': 1, 'author': 'agent', 'path': '/artifacts/decks/q3.versions/1'},
            {'version': 2, 'author': 'user', 'path': '/artifacts/decks/q3.versions/2'},
        ],
    }
    assert json.loads((versions / 'read.json').read_text()) == {'version': 2}


def test_a_symlinked_slide_is_refused_by_name_and_nothing_is_saved(tmp_path: Path) -> None:
    write_deck(tmp_path, DECK, {'agenda': AGENDA})
    (tmp_path / 'secret.html').write_text(COVER.replace('Q3 Operating Review', 'a secret'), encoding='utf-8')
    (tmp_path / 'decks/q3/project/slides/cover.html').symlink_to(tmp_path / 'secret.html')

    with pytest.raises(ValueError, match=r'symbolic link.*: project/slides/cover\.html$'):
        call(tmp_path, file_path='/decks/q3/project/deck.json')
    assert stored(tmp_path) == []


def test_a_symlinked_slides_folder_is_refused_by_name(tmp_path: Path) -> None:
    write_deck(tmp_path, DECK, {})
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    for name, html in {'cover': COVER, 'agenda': AGENDA}.items():
        (elsewhere / f'{name}.html').write_text(html, encoding='utf-8')
    slides_folder = tmp_path / 'decks/q3/project/slides'
    slides_folder.rmdir()
    slides_folder.symlink_to(elsewhere, target_is_directory=True)

    with pytest.raises(ValueError, match=r'symbolic link.*: project/slides$'):
        call(tmp_path, file_path='/decks/q3')
    assert stored(tmp_path) == []


def test_a_version_holds_only_the_deck_json_and_the_slides(tmp_path: Path) -> None:
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA})
    project = tmp_path / 'decks/q3/project'
    (project / 'notes.txt').write_text('draft', encoding='utf-8')
    (project / 'slides/agenda.md').write_text('draft', encoding='utf-8')
    (project / 'ds').mkdir()
    (project / 'ds/logo.png').write_bytes(b'png')

    call(tmp_path, file_path='/decks/q3/project/deck.json')

    assert stored(tmp_path) == [
        '1.json', '1/project/deck.json', '1/project/slides/agenda.html', '1/project/slides/cover.html', 'read.json',
    ]


def test_a_publish_that_lands_while_this_one_is_checked_keeps_its_number(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA})
    other = tmp_path / VERSIONS / '1/project'

    def check_while_another_publishes(folder: Path) -> list[str]:
        other.mkdir(parents=True)
        (other / 'deck.json').write_text('{"title": "the other publish"}', encoding='utf-8')
        return check(folder)

    monkeypatch.setattr(slides, 'check', check_while_another_publishes)
    published = json.loads(str(call(tmp_path, file_path='/decks/q3').content))

    assert (published['version'], published['path']) == (2, '/artifacts/decks/q3.versions/2')
    assert (other / 'deck.json').read_text() == '{"title": "the other publish"}'
    assert stored(tmp_path) == [
        '1/project/deck.json', '2.json', '2/project/deck.json', '2/project/slides/agenda.html',
        '2/project/slides/cover.html', 'read.json',
    ]


def test_a_copy_that_fails_midway_leaves_no_version(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA})
    copy = slides._copy
    copied: list[str] = []

    def copy_then_fail(folder_fd: int, entry: str, to: Path, shown: str) -> None:
        if copied:
            raise OSError(28, 'No space left on device')
        copied.append(entry)
        copy(folder_fd, entry, to, shown)

    monkeypatch.setattr(slides, '_copy', copy_then_fail)
    with pytest.raises(OSError, match='No space left on device'):
        call(tmp_path, file_path='/decks/q3')
    assert copied == ['deck.json']
    assert list((tmp_path / VERSIONS).iterdir()) == []


def test_a_checker_that_crashes_fails_loud_with_its_stderr(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match=r'(?s)The slide checker failed \(exit 1\): .*ENOENT'):
        check(tmp_path / 'no-such-deck')


def test_an_image_is_held_in_the_slide_as_a_data_uri_since_a_slide_loads_nothing(tmp_path: Path) -> None:
    for source in ('/_blob/photo', 'project/ds/brand/logo.png', 'https://images.example/q3.png'):
        image = f'<img src="{source}" alt="HQ" style="width:480px;height:360px">\n</section>'
        write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA.replace('</section>', image)})
        with pytest.raises(ValueError, match=r'<img src=.*is not an image held in the slide\. Nearest: the image itself as a data: URI'):
            call(tmp_path, file_path='/decks/q3')

    photo = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="HQ" style="width:480px;height:360px">\n</section>'
    write_deck(tmp_path, DECK, {'cover': COVER, 'agenda': AGENDA.replace('</section>', photo)})
    assert json.loads(str(call(tmp_path, file_path='/decks/q3').content))['version'] == 1


def skill_page_slides() -> list[str]:
    page = SKILL_PAGE.read_text(encoding='utf-8')
    section = page[page.index('\n## Slides\n'):]
    section = section[:section.find('\n## ', 1)] if '\n## ' in section[1:] else section
    return re.findall(r'```html\n(<section.*?</section>)\n```', section, re.DOTALL)


def test_every_slides_example_in_the_skill_page_passes_the_checker(tmp_path: Path) -> None:
    examples = skill_page_slides()
    assert len(examples) >= 2
    for example in examples:
        slide = re.search(r'<section id="([^"]+)"', example)
        assert slide is not None
        write_deck(tmp_path, {**DECK, 'order': [slide.group(1)], 'cover': slide.group(1),
                              'sections': {'s1': {'description': 'One', 'start': slide.group(1)}}},
                   {slide.group(1): example})
        published = json.loads(str(call(tmp_path, file_path='/decks/q3/project/deck.json').content))
        assert published['type'] == 'slides'


def test_the_skill_pages_rules_table_is_the_one_the_checker_generates() -> None:
    generated = subprocess.run(['node', str(CHECKER), 'rules'], check=True, capture_output=True, text=True).stdout
    page = SKILL_PAGE.read_text(encoding='utf-8')
    table = page[page.index('<!-- generated:slides-rules -->\n') + len('<!-- generated:slides-rules -->\n'):
                 page.index('<!-- /generated:slides-rules -->')]
    assert table == generated
