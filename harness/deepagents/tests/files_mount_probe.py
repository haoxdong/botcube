from __future__ import annotations

import os
import subprocess
from pathlib import Path

import botcube_harness_deepagents.files_mount as mounts
from botcube_harness_deepagents.serving import _workspace


def main() -> None:
    subprocess.run(['/bin/mount', '-t', 'tmpfs', 'tmpfs', '/mnt'], check=True)
    storage = Path('/mnt/workspace')
    storage.mkdir()
    subprocess.run(['/bin/mount', '-t', 'tmpfs', 'session-storage', str(storage)], check=True)
    os.environ['BOTCUBE_WORKSPACE'] = str(storage / 'files')
    root = _workspace()
    (storage / 'session.txt').write_text('session cache')
    os.environ['HOME'] = '/mnt/home'
    Path('/mnt/home').mkdir()
    mounts._LOCAL = Path('/mnt/local')
    durable = Path('/mnt/durable')
    durable.mkdir()
    (durable / 'report.txt').write_text('durable bytes')
    commands = Path('/mnt/bin')
    commands.mkdir()
    watchdog = commands / 'amazon-efs-mount-watchdog'
    watchdog.write_text('#!/bin/sh\nexec sleep 600\n')
    watchdog.chmod(0o755)
    mount = commands / 'mount'
    mount.write_text('#!/bin/sh\nif [ "$1" = "-t" ]; then\n'
                     '  if [ "$FILES_TEST_FAIL" = "1" ]; then exit 32; fi\n'
                     '  exec /bin/mount --bind /mnt/durable "$4"\nfi\nexec /bin/mount "$@"\n')
    mount.chmod(0o755)
    os.environ['PATH'] = str(commands) + os.pathsep + os.environ['PATH']
    files = mounts.FilesMount('fs-0123', 'fsap-0123', '192.0.2.12', 'us-east-1',
                             {'accessKeyId': 'key', 'secretAccessKey': 'secret', 'sessionToken': 'token'})
    excluded = ('tmp', 'skills', 'botcube-harness-deepagents')
    for name in excluded:
        (root / name).mkdir()
        (root / name / 'local.txt').write_text(name)
    os.environ['FILES_TEST_FAIL'] = '1'
    try:
        files.pull(root, excluded)
    except subprocess.CalledProcessError:
        assert all((root / name / 'local.txt').read_text() == name for name in excluded)
    else:
        raise AssertionError('mount failure was hidden')
    del os.environ['FILES_TEST_FAIL']
    try:
        files.pull(storage)
    except RuntimeError as error:
        assert 'unrecognized mount' in str(error)
    else:
        raise AssertionError('Session Storage mount was accepted as an EFS target')
    files.pull(root, excluded)
    assert (root / 'report.txt').read_text() == 'durable bytes'
    assert (storage / 'session.txt').read_text() == 'session cache'
    for name in excluded:
        assert (root / name / 'local.txt').read_text() == name
        assert list((durable / name).iterdir()) == []
    (root / 'published.txt').write_text('published')
    assert (durable / 'published.txt').read_text() == 'published'
    files.pull(root, excluded)
    other = mounts.FilesMount('fs-0123', 'fsap-0999', '192.0.2.12', 'us-east-1', files.credentials)
    try:
        other.pull(root)
    except RuntimeError as error:
        assert 'cannot change' in str(error)
    else:
        raise AssertionError('changed account binding accepted')
    print('PASS nested workspace mount, local exclusions, denied mount rollback and account isolation')


if __name__ == '__main__':
    try:
        main()
    finally:
        if mounts._WATCHDOG is not None:
            mounts._WATCHDOG.terminate()
            mounts._WATCHDOG.wait()
