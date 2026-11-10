from __future__ import annotations

import configparser
import ipaddress
import json
import logging
import os
import re
import shutil
import subprocess
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from time import perf_counter

_MOUNT_LOCK = Lock()
_LOCAL = Path('/run/botcube-files')
_WATCHDOG: subprocess.Popen[bytes] | None = None
MOUNT_TIMEOUT = 30.0


class FilesMountError(RuntimeError):
    code = 'FILES_MOUNT'


@dataclass(frozen=True)
class FilesMount:
    file_system_id: str
    access_point_id: str
    mount_target_ip: str
    region: str
    credentials: Mapping[str, str]

    @classmethod
    def from_binding(cls, files: Mapping[str, str]) -> FilesMount:
        ipaddress.ip_address(files['mountTargetIp'])
        expiry = datetime.fromisoformat(files['expiration'].replace('Z', '+00:00'))
        if expiry <= datetime.now(UTC):
            raise ValueError('expired credentials')
        if not re.fullmatch(r'fs-[0-9a-f]+', files['fileSystemId']) or not re.fullmatch(r'fsap-[0-9a-f]+', files['accessPointId']):
            raise ValueError('invalid file system or access point')
        return cls(files['fileSystemId'], files['accessPointId'], files['mountTargetIp'], files['region'],
                   {field: files[field] for field in ('accessKeyId', 'secretAccessKey', 'sessionToken')})

    def pull(self, root: Path, excluded: Iterable[str] = ()) -> None:
        if not _MOUNT_LOCK.acquire(timeout=MOUNT_TIMEOUT):
            raise FilesMountError('Files mount deadline exceeded waiting for preparation')
        try:
            self._prepare(root, tuple(excluded))
        except subprocess.TimeoutExpired as error:
            raise FilesMountError('Files mount deadline exceeded') from error
        finally:
            _MOUNT_LOCK.release()

    def _prepare(self, root: Path, excluded: tuple[str, ...]) -> None:
        _LOCAL.mkdir(mode=0o700, parents=True, exist_ok=True)
        state = _LOCAL / 'mount.json'
        identity = {'fileSystemId': self.file_system_id, 'accessPointId': self.access_point_id}
        if state.exists() and json.loads(state.read_text()) != identity:
            raise RuntimeError('A Runtime session cannot change its Files access point')
        self._refresh_credentials()
        if state.exists():
            if workspace_mounted(root) and _WATCHDOG is not None and _WATCHDOG.poll() is None:
                return
            detach_workspace(root)
        if workspace_mounted(root):
            raise RuntimeError('Files workspace has an unrecognized mount')
        root.mkdir(parents=True, exist_ok=True)
        local = _LOCAL / 'workspace'
        local.mkdir(exist_ok=True)
        kept = preserve_local_directories(root, local, excluded)
        self._mount(root, local, kept)
        state.write_text(json.dumps(identity))

    def _mount(self, root: Path, local: Path, kept: list[str]) -> None:
        global _WATCHDOG
        started = perf_counter()
        try:
            _WATCHDOG = subprocess.Popen(['amazon-efs-mount-watchdog'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run([
                'mount', '-t', 'efs', f'{self.file_system_id}:/', str(root), '-o',
                f'tls,iam,accesspoint={self.access_point_id},mounttargetip={self.mount_target_ip},region={self.region},awsprofile=botcube-files',
            ], check=True, capture_output=True, timeout=MOUNT_TIMEOUT)
            for name in kept:
                target = root / name
                target.mkdir(parents=True, exist_ok=True)
                subprocess.run(['mount', '--bind', str(local / name), str(target)], check=True, capture_output=True, timeout=MOUNT_TIMEOUT)
            if _WATCHDOG.poll() is not None:
                raise FilesMountError('Files mount watchdog stopped during initialization')
        except BaseException:
            detach_workspace(root)
            for name in kept:
                shutil.move(str(local / name), root / name)
            raise
        logging.getLogger(__name__).info('Harness Files EFS mount_ms=%.3f', (perf_counter() - started) * 1000)

    def _refresh_credentials(self) -> None:
        directory = Path.home() / '.aws'
        directory.mkdir(mode=0o700, exist_ok=True)
        path = directory / 'credentials'
        config = configparser.RawConfigParser()
        config.read(path)
        config['botcube-files'] = {
            'aws_access_key_id': self.credentials['accessKeyId'],
            'aws_secret_access_key': self.credentials['secretAccessKey'],
            'aws_session_token': self.credentials['sessionToken'],
        }
        with NamedTemporaryFile(mode='w', dir=directory, delete=False) as file:
            config.write(file)
            temporary = Path(file.name)
        os.replace(temporary, path)



def detach_workspace(root: Path) -> None:
    global _WATCHDOG
    mounts = [Path(line.split()[4]) for line in Path('/proc/self/mountinfo').read_text().splitlines()]
    for mount in sorted((path for path in mounts if path.is_relative_to(root)), key=lambda path: len(path.parts), reverse=True):
        subprocess.run(['umount', '-l', str(mount)], check=True, capture_output=True, timeout=MOUNT_TIMEOUT)
    if _WATCHDOG is not None and _WATCHDOG.poll() is None:
        _WATCHDOG.terminate()
        try:
            _WATCHDOG.wait(timeout=2)
        except subprocess.TimeoutExpired:
            logging.getLogger(__name__).warning('Files watchdog did not terminate within its deadline; killing it')
            _WATCHDOG.kill()
            _WATCHDOG.wait(timeout=2)
    _WATCHDOG = None


def workspace_mounted(root: Path) -> bool:
    return any(line.split()[4] == str(root) for line in Path('/proc/self/mountinfo').read_text().splitlines())


def preserve_local_directories(root: Path, local: Path, excluded: tuple[str, ...]) -> list[str]:
    paths = sorted(set(excluded), key=lambda value: len(Path(value).parts))
    kept: list[str] = []
    for name in paths:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Local Files directory must stay inside the workspace')
        if any(relative.is_relative_to(parent) for parent in kept):
            continue
        source = local / name
        source.parent.mkdir(parents=True, exist_ok=True)
        if (root / name).exists():
            shutil.move(str(root / name), source)
        source.mkdir(parents=True, exist_ok=True)
        kept.append(name)
    return kept
