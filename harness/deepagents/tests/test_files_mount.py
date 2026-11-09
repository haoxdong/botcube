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


def test_mount_command_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess
    from unittest.mock import Mock

    from botcube_harness_deepagents import files_mount

    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setattr(files_mount, '_LOCAL', tmp_path / 'state')
    monkeypatch.setattr(files_mount, '_WATCHDOG', None)
    monkeypatch.setattr(files_mount, 'workspace_mounted', lambda root: False)
    watchdog = Mock()
    watchdog.poll.return_value = None
    monkeypatch.setattr(files_mount.subprocess, 'Popen', lambda *args, **kwargs: watchdog)
    calls = []

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(command)
        assert 0 < float(str(kwargs.get('timeout', 0))) <= 30, 'mount commands need a deadline'
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(files_mount.subprocess, 'run', run)
    FilesMount.from_binding(binding()).pull(tmp_path / 'workspace')
    assert any(command[:3] == ['mount', '-t', 'efs'] for command in calls)


def test_same_account_recovers_a_lost_mount_and_watchdog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import json
    import subprocess
    from unittest.mock import Mock

    from botcube_harness_deepagents import files_mount

    monkeypatch.setenv('HOME', str(tmp_path))
    local = tmp_path / 'state'
    local.mkdir()
    mount = FilesMount.from_binding(binding())
    identity = {'fileSystemId': mount.file_system_id, 'accessPointId': mount.access_point_id}
    (local / 'mount.json').write_text(json.dumps(identity))
    dead = Mock()
    dead.poll.return_value = 1
    alive = Mock()
    alive.poll.return_value = None
    monkeypatch.setattr(files_mount, '_LOCAL', local)
    monkeypatch.setattr(files_mount, '_WATCHDOG', dead)
    monkeypatch.setattr(files_mount, 'workspace_mounted', lambda root: False)
    monkeypatch.setattr(files_mount.subprocess, 'Popen', lambda *args, **kwargs: alive)
    commands = []

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(files_mount.subprocess, 'run', run)
    mount.pull(tmp_path / 'workspace')
    assert any(command[:3] == ['mount', '-t', 'efs'] for command in commands)
    assert files_mount._WATCHDOG is alive
    assert json.loads((local / 'mount.json').read_text()) == identity
    different = {**binding(), 'accessPointId': 'fsap-00000000000000002'}
    with pytest.raises(RuntimeError, match='cannot change'):
        FilesMount.from_binding(different).pull(tmp_path / 'workspace')


def test_unreachable_efs_does_not_hold_a_plain_answer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    from threading import Event

    from botcube_harness_deepagents.lazy_files import TurnFiles

    entered, release = Event(), Event()

    def pull(self: FilesMount, root: Path, excluded: object = ()) -> None:
        entered.set()
        assert release.wait(2)

    monkeypatch.setattr(FilesMount, 'pull', pull)

    async def scenario() -> None:
        readiness = TurnFiles(FilesMount.from_binding(binding()), tmp_path, ())
        readiness.prefetch()
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            await asyncio.wait_for(readiness.settle_prefetch(), 0.1)
            assert not readiness.used
        finally:
            release.set()
            await readiness.settle_prefetch()

    asyncio.run(scenario())


def test_efs_workspace_tool_has_a_deadline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    from threading import Event

    from botcube_harness_deepagents import lazy_files

    entered, release = Event(), Event()

    def pull(self: FilesMount, root: Path, excluded: object = ()) -> None:
        entered.set()
        assert release.wait(2)

    monkeypatch.setattr(FilesMount, 'pull', pull)
    monkeypatch.setattr(lazy_files, 'EFS_READY_TIMEOUT', 0.02, raising=False)

    async def scenario() -> None:
        readiness = lazy_files.TurnFiles(FilesMount.from_binding(binding()), tmp_path, ())
        try:
            with pytest.raises(RuntimeError, match='deadline') as failure:
                await asyncio.wait_for(readiness.aensure(), 0.2)
            assert getattr(failure.value, 'code', None) == 'FILES_MOUNT'
        finally:
            release.set()

    asyncio.run(scenario())
