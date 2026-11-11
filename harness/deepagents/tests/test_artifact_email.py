"""Publishing an Email with the `Artifact` tool: a draft in Gmail's draft fields, checked against its JSON schema."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents.artifact import SKILLS, artifact_tool
from chat_save import UserSave, chat_service_save

pytestmark = pytest.mark.integration

SKILL_PAGE = SKILLS / 'artifacts/SKILL.md'

DRAFT = {
    'to': ['dana@example.com'],
    'cc': ['finance@example.com'],
    'subject': 'Q3 numbers for review',
    'htmlBody': '<p>Hi Dana,</p><p>The Q3 deck is attached. Revenue came in <b>4% over plan</b>.</p>',
    'body': 'Hi Dana,\n\nThe Q3 deck is attached. Revenue came in 4% over plan.',
    'attachments': [{'file': '/reports/q3.pdf', 'filename': 'Q3 review.pdf', 'mimeType': 'application/pdf'}],
}
VERSIONS = 'artifacts/drafts/q3.email.json.versions'


@pytest.fixture(scope='module')
def user_saves(tmp_path_factory: pytest.TempPathFactory) -> UserSave:
    return chat_service_save(tmp_path_factory.mktemp('chat'))


def call(root: Path, skills: tuple[str, ...] = (), **args: str) -> ToolMessage:
    result = artifact_tool(root, skills).invoke({'name': 'Artifact', 'type': 'tool_call', 'id': 'publish', 'args': args})
    assert isinstance(result, ToolMessage)
    return result


def write(root: Path, draft: Mapping[str, object], name: str = 'drafts/q3.email.json') -> None:
    (root / name).parent.mkdir(parents=True, exist_ok=True)
    (root / name).write_text(json.dumps(draft), encoding='utf-8')


def with_report(root: Path) -> None:
    (root / 'reports').mkdir(parents=True, exist_ok=True)
    (root / 'reports/q3.pdf').write_bytes(b'%PDF-1.7')


def refused(root: Path, said: str = 'The draft breaks the email format', skills: tuple[str, ...] = ()) -> list[str]:
    """The errors of a refused publish of the draft, which leaves nothing in the version store."""
    with pytest.raises(ValueError) as refusal:
        call(root, skills, file_path='/drafts/q3.email.json')
    message = str(refusal.value)
    assert message.startswith(f'{said}, so nothing was published.')
    assert not (root / VERSIONS).exists() or list((root / VERSIONS).iterdir()) == []
    return [line[2:] for line in message.splitlines() if line.startswith('- ')]


NOT_IN_FILES = 'The draft attaches a File that is not in Files'


def assert_errors(errors: list[str], expected: list[tuple[str, str]]) -> None:
    for where, said in expected:
        assert any(line.startswith(where) and said in line for line in errors), (where, errors)
    assert len(errors) == len(expected), errors


def test_a_draft_publishes_as_an_email_and_read_returns_its_fields(tmp_path: Path) -> None:
    with_report(tmp_path)
    write(tmp_path, DRAFT)

    published = json.loads(str(call(tmp_path, file_path='/drafts/q3.email.json', description='Q3 to Dana').content))
    read = json.loads(str(call(tmp_path, action='read', url='/drafts/q3.email.json').content))

    assert published == {
        'id': '/drafts/q3.email.json', 'type': 'email', 'title': 'Q3 numbers for review', 'description': 'Q3 to Dana',
        'version': 1, 'path': f'/{VERSIONS}/1.email.json',
    }
    assert (read['type'], read['version'], read['author'], read['email']) == ('email', 1, 'agent', DRAFT)
    assert [kept['from'] for kept in read['imports']] == ['/reports/q3.pdf']
    assert sorted(path.name for path in (tmp_path / VERSIONS).iterdir()) == ['1.email.json', '1.json', 'imports', 'read.json']


def test_a_draft_with_bad_fields_returns_every_error_and_saves_nothing(tmp_path: Path) -> None:
    write(tmp_path, {
        'to': 'dana@example.com',
        'cc': ['Finance <finance@example.com>'],
        'subject': 'Q3 numbers',
        'htmlBody': '<p>Attached.</p>',
        'attachments': [{'file': '/reports/../../etc/passwd'}, {'content': 'JVBERi0xLjc=', 'filename': 'q3.pdf'}],
        'includeSignature': True,
    })

    assert_errors(refused(tmp_path), [
        ('q3.email.json to ', 'Nearest: a list of plain addresses'),
        ('q3.email.json cc[0] ', 'Nearest: a plain address'),
        ('q3.email.json attachments[0].file ', "Nearest: file: the attachment's path in Files"),
        ('q3.email.json attachments[1].content ', 'Nearest: file'),
        ('q3.email.json attachments[1] ', 'Nearest: file'),
        ('q3.email.json includeSignature ', 'Nearest: leave it out'),
    ])


def test_an_attachment_must_be_one_of_the_agents_files(tmp_path: Path) -> None:
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.txt').write_text('not yours', encoding='utf-8')
    root = tmp_path / 'files'
    with_report(root)
    (root / 'reports/linked.pdf').symlink_to(outside / 'secret.txt')
    (root / 'linked').symlink_to(outside)
    (root / 'botcube-harness-deepagents').mkdir()
    (root / 'botcube-harness-deepagents/state.json').write_text('{}', encoding='utf-8')
    (root / 'skills/finance').mkdir(parents=True)
    (root / 'skills/finance/template.pdf').write_bytes(b'%PDF-1.7')
    write(root, {**DRAFT, 'attachments': [
        {'file': '/reports/q3.pdf'}, {'file': '/reports/missing.pdf'}, {'file': '/reports/linked.pdf'},
        {'file': '/linked/secret.txt'}, {'file': '/reports'}, {'file': '/botcube-harness-deepagents/state.json'},
        {'file': '/skills/finance/template.pdf'},
    ]})

    assert_errors(refused(root, NOT_IN_FILES, skills=('/skills/',)), [
        (f'q3.email.json attachments[{index}].file ', f'No file in Files: {path}')
        for index, path in [
            (1, '/reports/missing.pdf'), (2, '/reports/linked.pdf'), (3, '/linked/secret.txt'), (4, '/reports'),
            (5, '/botcube-harness-deepagents/state.json'), (6, '/skills/finance/template.pdf'),
        ]
    ])


def test_a_bad_field_is_refused_before_a_missing_attachment_is_looked_for(tmp_path: Path) -> None:
    write(tmp_path, {**DRAFT, 'cc': ['Finance <finance@example.com>']})
    assert_errors(refused(tmp_path), [('q3.email.json cc[0] ', 'Nearest: a plain address')])

    write(tmp_path, DRAFT)
    assert_errors(refused(tmp_path, NOT_IN_FILES), [
        ('q3.email.json attachments[0].file ', 'No file in Files: /reports/q3.pdf'),
    ])


def test_a_version_keeps_a_copy_of_each_attachment_as_it_was_at_the_publish(tmp_path: Path) -> None:
    with_report(tmp_path)
    write(tmp_path, DRAFT)
    call(tmp_path, file_path='/drafts/q3.email.json')
    (tmp_path / 'reports/q3.pdf').write_bytes(b'%PDF-1.7 changed')
    call(tmp_path, file_path='/drafts/q3.email.json')
    (tmp_path / 'reports/q3.pdf').unlink()

    first = json.loads((tmp_path / VERSIONS / '1.json').read_text())['imports']
    read = json.loads(str(call(tmp_path, action='read', url='/drafts/q3.email.json').content))
    copy = f'/{VERSIONS}/imports/{hashlib.sha256(b"%PDF-1.7").hexdigest()}.pdf'
    assert first == [{'edit': 0, 'from': '/reports/q3.pdf', 'path': copy}]
    assert (tmp_path / copy.lstrip('/')).read_bytes() == b'%PDF-1.7'
    assert read['version'] == 2
    assert read['imports'] == [{
        'edit': 0, 'from': '/reports/q3.pdf', 'path': f'/{VERSIONS}/imports/{hashlib.sha256(b"%PDF-1.7 changed").hexdigest()}.pdf',
    }]


def test_a_user_save_keeps_the_copies_of_the_edited_version(tmp_path: Path, user_saves: UserSave) -> None:
    with_report(tmp_path)
    write(tmp_path, DRAFT)
    call(tmp_path, file_path='/drafts/q3.email.json')
    kept = json.loads((tmp_path / VERSIONS / '1.json').read_text())['imports']

    user_saves(tmp_path, '/drafts/q3.email.json', 1, {'q3.email.json': json.dumps({**DRAFT, 'subject': 'Q3, final'})})

    assert json.loads((tmp_path / VERSIONS / '2.json').read_text())['imports'] == kept
    with pytest.raises(RuntimeError, match='keeps the attachments of version 2: attachment 0 is /reports/q3.pdf'):
        user_saves(tmp_path, '/drafts/q3.email.json', 2, {'q3.email.json': json.dumps({**DRAFT, 'attachments': []})})


def test_a_body_the_email_editor_cannot_hold_is_refused_naming_the_element_and_the_nearest_form(tmp_path: Path) -> None:
    write(tmp_path, {**DRAFT, 'attachments': [], 'htmlBody': (
        '<div><p style="color:red">Hi <span>Dana</span>,</p></div>'
        '<table><tr><td>4%</td></tr></table><img src="https://example.com/chart.png">'
        '<p><a href="javascript:alert(1)">open</a> <strong><p>nested</p></strong></p><ul>loose<li>ok</li></ul>'
        '<h4>Risks</h4>'
    )})

    assert_errors(refused(tmp_path), [
        ('q3.email.json htmlBody <div> ', 'Nearest: a <p>'),
        ('q3.email.json htmlBody <table> ', 'Nearest: a <ul> of <li><p> rows'),
        ('q3.email.json htmlBody <img> ', 'Nearest: attach the image as a File'),
        ('q3.email.json htmlBody <a href> ', 'Nearest: href="https://…"'),
        ('q3.email.json htmlBody <p> ', 'is inside a <strong>'),
        ('q3.email.json htmlBody <ul> ', 'holds something other than <li>'),
        ('q3.email.json htmlBody <h4> ', 'Nearest: an <h3>'),
    ])


def test_a_line_break_or_control_character_in_a_header_field_is_refused(tmp_path: Path) -> None:
    with_report(tmp_path)
    write(tmp_path, {
        **DRAFT,
        'to': ['dana@example.com\r\nBcc: everyone@example.com'],
        'bcc': ['lee\u0000@example.com'],
        'subject': 'Q3\r\nX-Injected: 1',
        'attachments': [{'file': '/reports/q3.pdf', 'filename': 'q3.pdf"\r\nContent-Type: text/html'}],
    })

    assert_errors(refused(tmp_path), [
        ('q3.email.json to[0] ', 'Nearest: a plain address'),
        ('q3.email.json bcc[0] ', 'Nearest: a plain address'),
        ('q3.email.json subject ', 'Nearest: one line of text'),
        ('q3.email.json attachments[0].filename ', 'Nearest: a file name on one line'),
    ])


def test_a_draft_that_is_not_json_is_refused_naming_where_it_breaks(tmp_path: Path) -> None:
    (tmp_path / 'drafts').mkdir()
    (tmp_path / 'drafts/q3.email.json').write_text('{"to": ["dana@example.com"],}', encoding='utf-8')

    assert_errors(refused(tmp_path), [('q3.email.json draft — is not JSON', 'Nearest: a draft object')])


def test_a_draft_reached_through_a_link_publishes_nothing(tmp_path: Path) -> None:
    write(tmp_path, {**DRAFT, 'attachments': []}, 'drafts/real.email.json')
    (tmp_path / 'drafts/q3.email.json').symlink_to(tmp_path / 'drafts/real.email.json')
    outside = tmp_path.parent / f'{tmp_path.name}-outside.email.json'
    outside.write_text(json.dumps({**DRAFT, 'attachments': []}), encoding='utf-8')
    (tmp_path / 'drafts/out.email.json').symlink_to(outside)

    # A link inside Files publishes the file it names, under that file's own id; one leading out publishes nothing.
    assert json.loads(str(call(tmp_path, file_path='/drafts/q3.email.json').content))['id'] == '/drafts/real.email.json'
    with pytest.raises(ValueError, match='Save the page in Files'):
        call(tmp_path, file_path='/drafts/out.email.json')
    assert not (tmp_path / 'artifacts/drafts/out.email.json.versions').exists()


def test_a_publish_over_a_draft_the_user_saved_is_refused_until_read(tmp_path: Path, user_saves: UserSave) -> None:
    write(tmp_path, {**DRAFT, 'attachments': []})
    call(tmp_path, file_path='/drafts/q3.email.json')
    users = {**DRAFT, 'attachments': [], 'to': ['dana@example.com', 'lee@example.com']}
    saved = user_saves(tmp_path, '/drafts/q3.email.json', 1, {'q3.email.json': json.dumps(users)})
    assert (saved['type'], saved['version'], saved['path']) == ('email', 2, f'/{VERSIONS}/2.email.json')

    with pytest.raises(ValueError, match=r'Version 2 after your last read.*Changed: /drafts/q3\.email\.json$'):
        call(tmp_path, file_path='/drafts/q3.email.json')
    assert json.loads(str(call(tmp_path, action='read', file_path='/drafts/q3.email.json').content))['email'] == users
    assert json.loads(str(call(tmp_path, file_path='/drafts/q3.email.json').content))['version'] == 3


def test_the_chat_service_refuses_a_save_that_is_not_json_or_breaks_the_format(tmp_path: Path, user_saves: UserSave) -> None:
    write(tmp_path, {**DRAFT, 'attachments': []})
    call(tmp_path, file_path='/drafts/q3.email.json')

    for text, said in [
        ('{"to": ["dana@example.com"],', 'q3.email.json draft — is not JSON'),
        (json.dumps({**DRAFT, 'attachments': [], 'htmlBody': '<table></table>'}), 'q3.email.json htmlBody <table>'),
    ]:
        with pytest.raises(RuntimeError, match=re.escape(said)):
            user_saves(tmp_path, '/drafts/q3.email.json', 1, {'q3.email.json': text})
    assert sorted(path.name for path in (tmp_path / VERSIONS).iterdir()) == ['1.email.json', '1.json', 'read.json']


def test_every_email_example_in_the_skill_page_passes_the_checker(tmp_path: Path) -> None:
    page = SKILL_PAGE.read_text(encoding='utf-8')
    start = page.index('\n## Email\n')
    section = page[start:page.index('\n## ', start + 1)]
    examples = re.findall(r'```json\n(.*?)\n```', section, re.DOTALL)
    assert examples
    for example in examples:
        for attachment in json.loads(example).get('attachments', []):
            (tmp_path / attachment['file'].lstrip('/')).parent.mkdir(parents=True, exist_ok=True)
            (tmp_path / attachment['file'].lstrip('/')).write_bytes(b'example')
        (tmp_path / 'draft.email.json').write_text(example, encoding='utf-8')
        assert json.loads(str(call(tmp_path, file_path='/draft.email.json').content))['type'] == 'email'
