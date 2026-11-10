from pathlib import Path

import pytest

from botcube_harness_deepagents.serving import _workspace


def test_new_workspace_uses_the_configured_mount_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / 'session-storage' / 'files'
    monkeypatch.setenv('BOTCUBE_WORKSPACE', str(root))
    assert _workspace() == root
    assert root.is_dir()
