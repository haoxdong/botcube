from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents.artifact import artifact_tool, publishing_tools
from botcube_harness_deepagents.files import excluded_paths
from botcube_harness_deepagents.files_mount import FilesMount
from botcube_harness_deepagents.lazy_files import turn_files
from mounted_files import MountedFiles, binding

PAGE = b'<!doctype html><html><head><title>Q3 revenue</title></head><body><h1>Q3</h1></body></html>'


def call(root: Path, **args: str) -> ToolMessage:
    result = artifact_tool(root).invoke({'name': 'Artifact', 'type': 'tool_call', 'id': 'publish', 'args': args})
    assert isinstance(result, ToolMessage)
    return result


def test_publishing_an_html_file_saves_it_in_files_as_artifact_version_1(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mounted = MountedFiles(tmp_path)
    mounted.write('reports/q3.html', PAGE)
    monkeypatch.setattr(FilesMount, 'pull', lambda mount, root, excluded=(): mounted.mount(mount, root, excluded))
    with turn_files(FilesMount.from_binding(binding()), tmp_path, excluded_paths(())) as readiness:
        result = call(tmp_path, action='publish', file_path='/reports/q3.html', title='Q3 revenue by month',
                      description='Monthly revenue against plan')
        assert readiness.ready

    published = {
        'id': '/reports/q3.html', 'type': None, 'title': 'Q3 revenue by month',
        'description': 'Monthly revenue against plan', 'version': 1,
        'path': '/artifacts/reports/q3.html.versions/1.html',
    }
    assert json.loads(str(result.content)) == published
    assert result.artifact == published
    assert mounted.read('artifacts/reports/q3.html.versions/1.html') == PAGE


def test_publishing_the_same_file_again_makes_the_next_version_of_the_same_artifact(tmp_path: Path) -> None:
    source = tmp_path / 'q3.html'
    source.write_bytes(PAGE)
    call(tmp_path, file_path='/q3.html', title='Q3 revenue')
    source.write_bytes(PAGE.replace(b'Q3</h1>', b'Q3, revised</h1>'))

    second = json.loads(str(call(tmp_path, file_path=str(source)).content))

    assert (second['id'], second['version'], second['path']) == ('/q3.html', 2, '/artifacts/q3.html.versions/2.html')
    assert (tmp_path / 'artifacts/q3.html.versions/1.html').read_bytes() == PAGE
    assert b'Q3, revised' in (tmp_path / 'artifacts/q3.html.versions/2.html').read_bytes()


def test_an_untitled_publish_takes_the_pages_title(tmp_path: Path) -> None:
    (tmp_path / 'q3.html').write_bytes(PAGE)
    assert json.loads(str(call(tmp_path, file_path='/q3.html').content))['title'] == 'Q3 revenue'


def test_publishing_a_missing_file_fails_with_a_clear_message(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match=r'No file at /reports/q3\.html\. Write the page there, then publish it\.'):
        call(tmp_path, file_path='/reports/q3.html', title='Q3')
    assert not (tmp_path / 'artifacts').exists()


@pytest.mark.parametrize(('name', 'message'), [
    ('notes.md', r'An Artifact is an \.html file for now: notes\.md'),
    ('tmp/q3.html', r'Save the page in Files to publish it: /tmp/q3\.html'),
])
def test_publishing_what_cannot_be_an_artifact_fails_and_saves_nothing(tmp_path: Path, name: str, message: str) -> None:
    (tmp_path / name).parent.mkdir(exist_ok=True)
    (tmp_path / name).write_bytes(PAGE)
    with pytest.raises(ValueError, match=message):
        call(tmp_path, file_path=f'/{name}')
    assert not (tmp_path / 'artifacts').exists()


def test_an_absolute_path_is_a_files_path_even_where_the_host_has_that_file(tmp_path: Path) -> None:
    root = tmp_path / 'files'
    (root / 'reports').mkdir(parents=True)
    (root / 'reports/q3.html').write_bytes(PAGE)
    outside = tmp_path / 'host.html'
    outside.write_bytes(PAGE)

    with pytest.raises(FileNotFoundError, match=re.escape(f'No file at {outside}.')):
        call(root, file_path=str(outside))
    assert not (root / 'artifacts').exists()
    assert json.loads(str(call(root, file_path='reports/q3.html').content))['id'] == '/reports/q3.html'


def test_publishing_with_a_url_fails_and_says_to_publish_the_same_file_again(tmp_path: Path) -> None:
    (tmp_path / 'q3.html').write_bytes(PAGE)
    with pytest.raises(ValueError, match=r'Publishing takes no url; .* publish the same file_path again\.'):
        call(tmp_path, file_path='/q3.html', url='https://claude.ai/artifact/q3')
    assert not (tmp_path / 'artifacts').exists()


def test_only_publish_is_available_yet(tmp_path: Path) -> None:
    (tmp_path / 'q3.html').write_bytes(PAGE)
    with pytest.raises(ValueError, match=r"Only action 'publish' is available"):
        call(tmp_path, action='read', file_path='/q3.html')


def test_the_artifacts_flag_swaps_publish_for_artifact_and_is_off_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BOTCUBE_ARTIFACTS', raising=False)
    assert [tool.name for tool in publishing_tools(tmp_path, ())] == ['publish']
    monkeypatch.setenv('BOTCUBE_ARTIFACTS', '1')
    assert [tool.name for tool in publishing_tools(tmp_path, ())] == ['Artifact']
