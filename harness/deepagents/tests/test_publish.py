from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents.files import excluded_paths
from botcube_harness_deepagents.files_mount import FilesMount
from botcube_harness_deepagents.lazy_files import turn_files
from botcube_harness_deepagents.publish import publish_tool
from mounted_files import MountedFiles, binding


@pytest.mark.parametrize(('filename', 'link'), [('chart.svg', '/artifacts/chart.svg'), ('monthly chart.svg', '/artifacts/monthly%20chart.svg')])
def test_publish_moves_scratch_into_files_and_returns_the_link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, filename: str, link: str) -> None:
    root, scratch = tmp_path / 'workspace', tmp_path / 'scratch' / filename
    root.mkdir()
    scratch.parent.mkdir()
    scratch.write_bytes(b'<svg>chart</svg>')
    mounted = MountedFiles(root)
    monkeypatch.setattr(FilesMount, 'pull', lambda mount, root, excluded=(): mounted.mount(mount, root, excluded))
    files = FilesMount.from_binding(binding())
    with turn_files(files, root, excluded_paths(())) as readiness:
        result = publish_tool(root).invoke({'name': 'publish', 'type': 'tool_call', 'id': 'chart', 'args': {'path': str(scratch)}})
        assert readiness.ready
    assert isinstance(result, ToolMessage)
    assert result.content == link
    assert result.artifact == {'path': f'/artifacts/{filename}'}
    assert not scratch.exists()
    assert mounted.read(f'artifacts/{filename}') == b'<svg>chart</svg>'


def test_publish_leaves_an_existing_file_in_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mounted = MountedFiles(tmp_path)
    mounted.write('reports/report.csv', b'date,close')
    monkeypatch.setattr(FilesMount, 'pull', lambda mount, root, excluded=(): mounted.mount(mount, root, excluded))
    files = FilesMount.from_binding(binding())
    with turn_files(files, tmp_path, excluded_paths(())):
        result = publish_tool(tmp_path).invoke({'name': 'publish', 'type': 'tool_call', 'id': 'report', 'args': {'path': '/reports/report.csv'}})
    assert isinstance(result, ToolMessage)
    assert result.content == '/reports/report.csv'
    assert result.artifact == {'path': '/reports/report.csv'}
    assert (tmp_path / 'reports' / 'report.csv').read_bytes() == b'date,close'
    assert not (tmp_path / 'artifacts').exists()


@pytest.mark.parametrize('kind', ['missing', 'directory'])
def test_publish_rejects_nonfiles(tmp_path: Path, kind: str) -> None:
    path = tmp_path / 'missing'
    if kind == 'directory':
        path.mkdir()
    expected = FileNotFoundError if kind == 'missing' else IsADirectoryError
    with pytest.raises(expected):
        publish_tool(tmp_path).invoke({'path': str(path)})


@pytest.mark.parametrize(('filename', 'skills'), [('.chart.svg', ()), ('chart.svg', ('artifacts',))])
def test_publish_keeps_the_source_when_the_destination_cannot_sync(tmp_path: Path, filename: str, skills: tuple[str, ...]) -> None:
    root = tmp_path / 'workspace'
    root.mkdir()
    source = tmp_path / filename
    source.write_bytes(b'<svg/>')

    with pytest.raises(ValueError, match='cannot be saved in Files'):
        publish_tool(root, skills).invoke({'path': str(source)})

    assert source.read_bytes() == b'<svg/>'
