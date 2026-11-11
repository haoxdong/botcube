"""A Doc: an Artifact whose Source is one Markdown file (ADR 0087)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents.artifact import artifact_tool

PLAN = '# Q4 plan\n\nWhat we ship, and when.\n\n## Milestones\n\n- [x] Beta\n- [ ] Launch\n\n| Month | Goal |\n| --- | --- |\n| Oct | Beta |\n'


def call(root: Path, **args: str) -> ToolMessage:
    result = artifact_tool(root).invoke({'name': 'Artifact', 'type': 'tool_call', 'id': 'call', 'args': args})
    assert isinstance(result, ToolMessage)
    return result


def test_publishing_a_markdown_file_makes_a_doc_titled_by_its_first_heading(tmp_path: Path) -> None:
    (tmp_path / 'plans').mkdir()
    (tmp_path / 'plans/q4.md').write_text(PLAN, encoding='utf-8')

    published = json.loads(str(call(tmp_path, file_path='/plans/q4.md', description='The Q4 plan').content))
    read = json.loads(str(call(tmp_path, action='read', url='/plans/q4.md').content))

    assert published == {
        'id': '/plans/q4.md', 'type': 'doc', 'title': 'Q4 plan', 'description': 'The Q4 plan', 'version': 1,
        'path': '/artifacts/plans/q4.md.versions/1.md',
    }
    assert (tmp_path / 'artifacts/plans/q4.md.versions/1.md').read_text(encoding='utf-8') == PLAN
    assert (read['type'], read['markdown'], read['versions']) == (
        'doc', PLAN, [{'version': 1, 'author': 'agent', 'path': '/artifacts/plans/q4.md.versions/1.md'}],
    )


def test_a_doc_the_user_saved_refuses_the_agents_publish_until_read(tmp_path: Path) -> None:
    source = tmp_path / 'q4.md'
    source.write_text(PLAN, encoding='utf-8')
    call(tmp_path, file_path='/q4.md')
    users = PLAN.replace('What we ship', 'What we ship (checked by finance)')
    # The panel's Save, as the Chat Service stores it: the Source, then the next version, the User's.
    source.write_text(users, encoding='utf-8')
    versions = tmp_path / 'artifacts/q4.md.versions'
    (versions / '2.md').write_text(users, encoding='utf-8')
    (versions / '2.json').write_text(json.dumps({'author': 'user', 'title': 'Q4 plan', 'description': ''}))

    with pytest.raises(ValueError, match=r'Version 2 after your last read \(Artifact Version 1\).*Changed: /q4\.md$'):
        call(tmp_path, file_path='/q4.md')
    read = json.loads(str(call(tmp_path, action='read', file_path='/q4.md').content))
    assert (read['author'], read['markdown']) == ('user', users)
    assert json.loads(str(call(tmp_path, file_path='/q4.md').content))['version'] == 3


def test_publishing_refuses_raw_html_naming_the_line_and_the_nearest_markdown_and_saves_nothing(tmp_path: Path) -> None:
    (tmp_path / 'q4.md').write_text(
        f'{PLAN}\nPay is <span style="color:#c00">due Friday</span>.\n\n<p align="center">Signed off</p>\n',
        encoding='utf-8',
    )

    with pytest.raises(ValueError) as refused:
        call(tmp_path, file_path='/q4.md')

    lines = str(refused.value).split('\n')
    assert lines[0].startswith('The Doc has Markdown its viewer does not show, so nothing was published.')
    assert lines[1].startswith('- q4.md:14:8 <span> — is HTML, which the Doc does not keep')
    assert lines[1].endswith('Nearest: the text alone, with emphasis as **bold** or _italic_.')
    assert lines[2].startswith('- q4.md:16:1 <p> — is HTML')
    assert len(lines) == 3
    assert list((tmp_path / 'artifacts/q4.md.versions').iterdir()) == []


def test_an_image_is_held_in_the_doc_as_a_data_uri_and_one_from_elsewhere_is_refused(tmp_path: Path) -> None:
    held = '![Chart](data:image/png;base64,iVBORw0KGgo=)'
    (tmp_path / 'q4.md').write_text(f'# Q4\n\n{held}\n\n![Logo](https://example.com/logo.png)\n', encoding='utf-8')

    with pytest.raises(ValueError, match=r'- q4\.md:5:1 !\[Logo\]\(https://example\.com/logo\.png\) — is an image the Doc '
                       r'would load from elsewhere.*Nearest: the image itself as a data: URI'):
        call(tmp_path, file_path='/q4.md')
    (tmp_path / 'q4.md').write_text(f'# Q4\n\n{held}\n', encoding='utf-8')
    assert json.loads(str(call(tmp_path, file_path='/q4.md').content))['version'] == 1


def test_a_doc_version_is_built_aside_and_takes_the_number_after_one_already_claimed(tmp_path: Path) -> None:
    (tmp_path / 'q4.md').write_text(PLAN, encoding='utf-8')
    versions = tmp_path / 'artifacts/q4.md.versions'
    versions.mkdir(parents=True)
    # A number claimed by another publish, still building: this publish takes the next one.
    (versions / '1.json').write_text(json.dumps({'author': 'agent', 'title': 'other', 'description': ''}))

    published = json.loads(str(call(tmp_path, file_path='/q4.md').content))

    assert published['version'] == 2
    assert sorted(path.name for path in versions.iterdir()) == ['1.json', '2.json', '2.md', 'read.json']


SKILL_PAGE = Path(__file__).resolve().parents[1] / 'artifact-check/skills/artifacts/SKILL.md'


def skill_page_docs() -> list[str]:
    """The Doc section's Markdown examples: up to the next section's heading, outside a fence."""
    lines = SKILL_PAGE.read_text(encoding='utf-8').split('\n')
    start = lines.index('## Doc')
    fenced = False
    for end in range(start + 1, len(lines)):
        fenced ^= lines[end].startswith('```')
        if not fenced and lines[end].startswith('## '):
            break
    else:
        end = len(lines)
    return re.findall(r'```markdown\n(.*?)\n```', '\n'.join(lines[start:end]), re.DOTALL)


def test_every_doc_example_in_the_skill_page_publishes_as_a_doc(tmp_path: Path) -> None:
    examples = skill_page_docs()
    assert len(examples) >= 3
    for index, example in enumerate(examples):
        (tmp_path / f'example-{index}.md').write_text(example, encoding='utf-8')
        published = json.loads(str(call(tmp_path, file_path=f'/example-{index}.md').content))
        assert published['type'] == 'doc'
