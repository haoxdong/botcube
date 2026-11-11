from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, ToolMessage

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.artifact import artifact_tool, publishing_tools
from botcube_harness_deepagents.files import excluded_paths
from botcube_harness_deepagents.files_mount import FilesMount
from botcube_harness_deepagents.lazy_files import turn_files
from conftest import ToolBindableFakeMessagesModel
from mounted_files import AccountFiles, MountedFiles, binding

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


def test_publishing_the_same_file_again_makes_the_next_version_and_read_finds_every_version(tmp_path: Path) -> None:
    source = tmp_path / 'q3.html'
    source.write_bytes(PAGE)
    call(tmp_path, file_path='/q3.html', title='Q3 revenue')
    revised = PAGE.replace(b'Q3</h1>', b'Q3, revised</h1>')
    source.write_bytes(revised)

    second = json.loads(str(call(tmp_path, file_path=str(source)).content))
    read = json.loads(str(call(tmp_path, action='read', file_path='/q3.html').content))

    assert (second['id'], second['version'], second['path']) == ('/q3.html', 2, '/artifacts/q3.html.versions/2.html')
    assert read == {
        'id': '/q3.html', 'type': None, 'title': 'Q3 revenue', 'description': '', 'version': 2, 'author': 'agent',
        'path': '/artifacts/q3.html.versions/2.html', 'read': 2, 'html': revised.decode(),
        'versions': [
            {'version': 1, 'author': 'agent', 'path': '/artifacts/q3.html.versions/1.html'},
            {'version': 2, 'author': 'agent', 'path': '/artifacts/q3.html.versions/2.html'},
        ],
    }
    assert (tmp_path / 'artifacts/q3.html.versions/1.html').read_bytes() == PAGE


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


def test_list_and_read_find_an_artifact_published_in_another_chat_of_the_account(tmp_path: Path) -> None:
    files = AccountFiles.at(tmp_path / 'efs')
    yesterday, today = tmp_path / 'chat-yesterday', tmp_path / 'chat-today'
    with turn_files(files, yesterday, excluded_paths(())) as readiness:
        readiness.ensure()
        (yesterday / 'dashboard.html').write_bytes(PAGE)
        call(yesterday, file_path='/dashboard.html', title='Sales dashboard', description='Weekly sales by region')

    with turn_files(files, today, excluded_paths(())):
        listed = json.loads(str(call(today, action='list').content))
        read = json.loads(str(call(today, action='read', url=listed['artifacts'][0]['id']).content))

    assert listed == {'artifacts': [{
        'id': '/dashboard.html', 'type': None, 'title': 'Sales dashboard', 'description': 'Weekly sales by region',
        'version': 1, 'author': 'agent', 'path': '/artifacts/dashboard.html.versions/1.html', 'read': 1,
    }]}
    assert (read['id'], read['version'], read['html']) == ('/dashboard.html', 1, PAGE.decode())


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
    assert json.loads(str(call(root, action='read', file_path=str(root / 'reports/q3.html')).content))['version'] == 1


def test_publishing_with_a_url_fails_and_says_to_publish_the_same_file_again(tmp_path: Path) -> None:
    (tmp_path / 'q3.html').write_bytes(PAGE)
    with pytest.raises(ValueError, match=r'Publishing takes no url; .* publish the same file_path again\.'):
        call(tmp_path, file_path='/q3.html', url='https://claude.ai/artifact/q3')
    assert not (tmp_path / 'artifacts').exists()


def test_read_moves_the_agents_read_mark_past_a_version_the_user_saved(tmp_path: Path) -> None:
    (tmp_path / 'q3.html').write_bytes(PAGE)
    call(tmp_path, file_path='/q3.html', title='Q3 revenue')
    versions = tmp_path / 'artifacts/q3.html.versions'
    # A User's save, as the panel's edit in place stores it.
    (versions / '2.html').write_bytes(PAGE.replace(b'Q3</h1>', b'Q3 (checked)</h1>'))
    (versions / '2.json').write_text(json.dumps({'author': 'user', 'title': 'Q3 revenue', 'description': ''}))

    before = json.loads(str(call(tmp_path, action='list').content))['artifacts'][0]
    read = json.loads(str(call(tmp_path, action='read', file_path='/q3.html').content))
    after = json.loads(str(call(tmp_path, action='list').content))['artifacts'][0]

    assert (before['version'], before['author'], before['read']) == (2, 'user', 1)
    assert [(version['version'], version['author']) for version in read['versions']] == [(1, 'agent'), (2, 'user')]
    assert 'Q3 (checked)' in read['html']
    assert after['read'] == 2


def test_reading_an_artifact_that_does_not_exist_names_the_way_to_find_one(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match=r"No Artifact /q3\.html\. List them with action 'list'\."):
        call(tmp_path, action='read', file_path='/q3.html')


def test_the_artifacts_flag_swaps_publish_for_artifact_and_is_off_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BOTCUBE_ARTIFACTS', raising=False)
    assert [tool.name for tool in publishing_tools(tmp_path, ())] == ['publish']
    monkeypatch.setenv('BOTCUBE_ARTIFACTS', '1')
    assert [tool.name for tool in publishing_tools(tmp_path, ())] == ['Artifact']


@pytest.mark.parametrize('identity', ['../../outside/q3.html', '/../../outside/q3.html', 'tmp/q3.html'])
def test_reading_outside_files_fails_and_moves_no_read_mark(tmp_path: Path, identity: str) -> None:
    root = tmp_path / 'files'
    # A version store where the name would land if read followed it: past the root, or in scratch space.
    for versions in (tmp_path / 'outside/q3.html.versions', root / 'artifacts/tmp/q3.html.versions'):
        versions.mkdir(parents=True)
        (versions / '1.html').write_bytes(PAGE)
        (versions / '1.json').write_text(json.dumps({'author': 'agent', 'title': 'Q3', 'description': ''}))
        (versions / 'read.json').write_text(json.dumps({'version': 0}))

    with pytest.raises(ValueError, match=re.escape('Name an Artifact in Files')):
        call(root, action='read', file_path=identity)
    assert json.loads((tmp_path / 'outside/q3.html.versions/read.json').read_text()) == {'version': 0}
    assert json.loads((root / 'artifacts/tmp/q3.html.versions/read.json').read_text()) == {'version': 0}


def test_concurrent_publishes_each_keep_their_own_version(tmp_path: Path) -> None:
    pages = [PAGE.replace(b'Q3</h1>', f'Q3 draft {draft}</h1>'.encode()) for draft in range(16)]
    start = threading.Barrier(len(pages))

    def publish(page: bytes) -> int:
        draft = tmp_path / f'draft-{pages.index(page)}'
        (draft / 'reports').mkdir(parents=True)
        (draft / 'reports/q3.html').write_bytes(page)
        # Each chat writes its own draft; all of them name the one Artifact in the shared version store.
        (draft / 'artifacts').symlink_to(tmp_path / 'artifacts', target_is_directory=True)
        start.wait()
        return int(json.loads(str(call(draft, file_path='/reports/q3.html').content))['version'])

    (tmp_path / 'artifacts').mkdir()
    with ThreadPoolExecutor(len(pages)) as pool:
        versions = list(pool.map(publish, pages))

    stored = tmp_path / 'artifacts/reports/q3.html.versions'
    assert sorted(versions) == list(range(1, len(pages) + 1))
    assert sorted((stored / f'{version}.html').read_bytes() for version in versions) == sorted(pages)


def test_the_agents_file_tools_cannot_change_the_version_store_but_the_artifact_tool_can(tmp_path: Path) -> None:
    (tmp_path / 'q3.html').write_bytes(PAGE)
    call(tmp_path, file_path='/q3.html', title='Q3 revenue')
    forged = {'author': 'user', 'title': 'Q3 revenue', 'description': ''}

    def turn(number: int, name: str, **args: str) -> AIMessage:
        return AIMessage(content='', tool_calls=[{'id': f'call-{number}', 'name': name, 'args': args}])

    model = ToolBindableFakeMessagesModel(responses=[
        turn(1, 'write_file', file_path='/artifacts/q3.html.versions/2.html', content='forged'),
        turn(2, 'write_file', file_path='/artifacts/./q3.html.versions/2.json', content=json.dumps(forged)),
        turn(3, 'edit_file', file_path='/artifacts/q3.html.versions/1.html', old_string='Q3', new_string='Q4'),
        turn(4, 'Artifact', file_path='/q3.html'),
        AIMessage(content='Published version 2.'),
    ])
    agent = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], tools=[artifact_tool(tmp_path)],
    )

    state = agent.invoke({'messages': 'Update the Q3 page.'})

    results = [message for message in state['messages'] if isinstance(message, ToolMessage)]
    refused, published = results[:3], results[3]
    assert [result.status for result in refused] == ['error'] * 3
    assert all('Only the Artifact tool writes /artifacts' in str(result.content) for result in refused)
    assert json.loads(str(published.content))['version'] == 2
    versions = tmp_path / 'artifacts/q3.html.versions'
    assert (versions / '1.html').read_bytes() == PAGE
    assert json.loads((versions / '2.json').read_text())['author'] == 'agent'
