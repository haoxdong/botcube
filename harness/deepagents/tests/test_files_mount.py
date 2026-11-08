from __future__ import annotations

from pathlib import Path

import pytest

from botcube_harness_deepagents.files_mount import FilesMount
from botcube_harness_deepagents.files_sync import FilesSyncError, pop_files_sync


def binding() -> dict[str, str]:
    return {
        'fileSystemId': 'fs-00000000000000001', 'accessPointId': 'fsap-00000000000000001',
        'mountTargetIp': '192.0.2.12', 'region': 'us-east-1', 'accessKeyId': 'key',
        'secretAccessKey': 'secret', 'sessionToken': 'token', 'expiration': '2099-01-01T00:00:00Z',
    }


def test_efs_binding_is_consumed_without_requiring_an_s3_bucket() -> None:
    props = {'files': binding()}
    files = pop_files_sync(props)
    assert isinstance(files, FilesMount)
    assert files.file_system_id == 'fs-00000000000000001'
    assert files.mount_target_ip == '192.0.2.12'
    assert props == {}


@pytest.mark.parametrize('field,value', [('mountTargetIp', 'host.invalid'), ('accessPointId', '../other'), ('expiration', '2000-01-01T00:00:00Z')])
def test_invalid_mount_binding_is_rejected(field: str, value: str) -> None:
    files = binding()
    files[field] = value
    with pytest.raises(FilesSyncError):
        pop_files_sync({'files': files})


def test_staged_publication_mounts_before_installing_an_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from collections.abc import Iterable

    from botcube_harness_deepagents.lazy_files import TurnFiles

    root = tmp_path / 'workspace'
    root.mkdir()
    staging = tmp_path / 'staging'
    staging.mkdir()
    (staging / 'history.md').write_text('archived history')
    files = pop_files_sync({'files': binding()})
    assert isinstance(files, FilesMount)

    def mount(self: FilesMount, destination: Path, excluded: Iterable[str]) -> None:
        assert not (destination / 'history.md').exists()
        (destination / 'mounted').touch()

    monkeypatch.setattr(FilesMount, 'pull', mount)
    readiness = TurnFiles(files, root, ())
    readiness.publish_staged(staging)
    assert readiness.ready
    assert (root / 'mounted').exists()
    assert (root / 'history.md').read_text() == 'archived history'
