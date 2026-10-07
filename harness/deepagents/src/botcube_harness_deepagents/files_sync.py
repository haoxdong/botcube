"""The account's Files, synced with the agent's workspace around each Turn (ADR 0077 decision 2).

The Chat Service forwards the account's prefix of the Files bucket with credentials scoped to
that prefix, because the Runtime's own role reaches no Files. Before the Turn the workspace
refreshes each file unless its local edit is newer; before the Turn finishes, Files take each file the agent
wrote or changed. Hidden files, the agent's scratch space `/tmp`, the Harness's own files, and the
Cartridge's skills stay out.

Each sync records the files it left in Files with their stamped second, so a delete in Files sticks.
A recorded file gone from Files leaves the workspace, and is not put back, unless the agent
edited it since. A rename arrives as its old name deleted and its new name pulled.
Unchanged downloaded content is never uploaded, even when local timestamps change.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any

import boto3

FILES_PROP = 'files'
# The Harness's own directory in the workspace: the rendered long-term memory.
HARNESS_DIRECTORY = 'botcube-harness-deepagents'
# The agent's scratch space: what it writes to `/tmp` is temporary, not the user's.
SCRATCH_DIRECTORY = 'tmp'
# Each file the sync last saw in Files, with the second Files stamped it, kept in the Harness's own directory.
RECORD_PATH = f'{HARNESS_DIRECTORY}/files-sync.json'
_CREDENTIAL_FIELDS = ('accessKeyId', 'secretAccessKey', 'sessionToken')


class FilesSyncError(RuntimeError):
    """The invocation's Files binding is malformed."""

    code = 'INVALID_FILES'


class FilesSyncRecordError(RuntimeError):
    """The workspace's record of its last Files sync can't be read."""

    code = 'FILES_SYNC_RECORD'


@dataclass(frozen=True)
class SyncedFile:
    stamp: int
    digest: str | None


@dataclass(frozen=True)
class FilesSync:
    bucket: str
    prefix: str
    region: str
    credentials: Mapping[str, str]

    def _client(self) -> Any:
        return boto3.client(
            's3',
            region_name=self.region,  # pragma: no mutate: moto, the suite's S3, serves any region
            aws_access_key_id=self.credentials['accessKeyId'],
            aws_secret_access_key=self.credentials['secretAccessKey'],
            aws_session_token=self.credentials['sessionToken'],  # pragma: no mutate: moto, the suite's S3, checks no session token
        )

    def _remote(self, s3: Any, skip: tuple[str, ...]) -> dict[str, int]:
        """Each of the agent's files in Files, by its path in the workspace, with its last-modified second."""
        remote: dict[str, int] = {}
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=self.bucket, Prefix=self.prefix):
            for item in page.get('Contents', []):
                name = item['Key'][len(self.prefix):]
                # A directory S3 Files syncs shows as a key ending in `/`; the workspace makes its own.
                if name.endswith('/') or not _synced(name, skip):
                    continue
                if any(len(part.encode('utf-8')) > 255 for part in PurePosixPath(name).parts):
                    raise FilesSyncError(f'Cannot sync file {name!r} from Files: each file name must be at most 255 UTF-8 bytes')
                remote[name] = int(item['LastModified'].timestamp())
        return remote

    def pull(self, root: Path, excluded: Iterable[str]) -> None:
        """Refresh Files unless the workspace has a newer edit, stamping the time in Files, and drop what Files deleted."""
        s3 = self._client()
        skip = tuple(excluded)
        record = _read_record(root)
        remote = self._remote(s3, skip)
        workspace = root.resolve()
        synced = dict(record)
        for name, baseline in record.items():
            local = root / name
            # Deleted in Files and unedited here since the sync that recorded it; a newer edit stays and is put back.
            # A path excluded since, such as a new skill, is out of the listing though still in Files,
            # and a path through a link out of the workspace is not the agent's file.
            if (
                name not in remote
                and _synced(name, skip)
                and local.resolve().is_relative_to(workspace)
            ):
                if not local.exists():
                    synced.pop(name)
                elif local.is_file() and _unchanged(local, baseline):
                    local.unlink()
                    synced.pop(name)
        for name, modified in remote.items():
            local = root / name
            baseline = _pull_file(s3, self.bucket, self.prefix + name, local, modified, record.get(name))
            if baseline is not None:
                synced[name] = baseline
        _write_record(root, synced)

    def push(self, root: Path, excluded: Iterable[str]) -> None:
        """Put each file the agent wrote or changed into Files, never one deleted there since its sync."""
        s3 = self._client()
        skip = tuple(excluded)
        record = _read_record(root)
        remote = self._remote(s3, skip)
        synced = {name: record.get(name, SyncedFile(stamp, None)) for name, stamp in remote.items()}
        for local in sorted(root.rglob('*')):
            name = local.relative_to(root).as_posix()
            if not local.is_file() or local.is_symlink() or not _synced(name, skip):
                continue
            baseline = record.get(name)
            digest = _digest(local)
            unchanged = _synced_baseline(local, baseline, remote.get(name), digest)
            if unchanged is not None:
                synced[name] = unchanged
                continue
            key = self.prefix + name
            s3.upload_file(str(local), self.bucket, key)
            # Stamp the upload's time in Files, so an unchanged copy is not pushed again.
            modified = int(s3.head_object(Bucket=self.bucket, Key=key)['LastModified'].timestamp())
            os.utime(local, (modified, modified))  # pragma: no mutate: stamping the local clock's now differs only on a clock apart from S3's, which one test machine cannot run
            synced[name] = SyncedFile(modified, digest)
        _write_record(root, synced)


def _pull_file(
    s3: Any, bucket: str, key: str, local: Path, modified: int, baseline: SyncedFile | None,
) -> SyncedFile | None:
    # Distinct S3 replacements can share a second; only a newer local edit wins.
    newer = local.is_file() and local.stat().st_mtime > modified and (baseline is None or not _unchanged(local, baseline))
    if newer and (baseline is None or baseline.digest is not None):
        return None
    local.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=local.parent, prefix='.files-sync-') as directory:
        downloaded = Path(directory) / 'file'
        s3.download_file(bucket, key, str(downloaded))
        synced = SyncedFile(modified, _digest(downloaded))
        if not newer:
            downloaded.replace(local)
            os.utime(local, (modified, modified))
    return synced


def _synced_baseline(
    local: Path, baseline: SyncedFile | None, remote_stamp: int | None, digest: str,
) -> SyncedFile | None:
    if baseline is not None and baseline.digest is not None:
        if digest == baseline.digest:
            os.utime(local, (baseline.stamp, baseline.stamp))
            return baseline
        return None
    stamp = remote_stamp if remote_stamp is not None else baseline.stamp if baseline is not None else None
    if stamp is not None and local.stat().st_mtime <= stamp:
        return baseline or SyncedFile(stamp, None)
    return None


def _unchanged(path: Path, baseline: SyncedFile) -> bool:
    if baseline.digest is not None:
        return _digest(path) == baseline.digest
    return path.stat().st_mtime <= baseline.stamp


def _digest(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def _read_record(root: Path) -> dict[str, SyncedFile]:
    """The files the last sync saw in Files; none before the workspace's first sync."""
    path = root / RECORD_PATH
    if not path.exists():
        return {}
    try:
        record = json.loads(path.read_text())
    except ValueError as error:
        raise FilesSyncRecordError(f'The Files sync record /{RECORD_PATH} is unreadable: {error}') from error
    # A bool is an int to Python, never a second to the sync.
    if not isinstance(record, dict):
        raise FilesSyncRecordError(f'The Files sync record /{RECORD_PATH} is unreadable: not an object of file names to seconds')
    # The agent can write the record: an absolute name would have a pull remove a file outside the workspace.
    for name in record:
        if PurePosixPath(name).is_absolute():
            raise FilesSyncRecordError(f'The Files sync record /{RECORD_PATH} is unreadable: {name!r} is not a path in the workspace')
    return {name: _parse_synced_file(value) for name, value in record.items()}


def _parse_synced_file(value: Any) -> SyncedFile:
    if type(value) is int:
        return SyncedFile(value, None)
    if not isinstance(value, dict):
        raise FilesSyncRecordError(f'The Files sync record /{RECORD_PATH} is unreadable: not an object of file names to seconds')
    if (
        set(value) != {'stamp', 'digest'}
        or type(value['stamp']) is not int
        or not isinstance(value['digest'], str)
        or re.fullmatch(r'[0-9a-f]{64}', value['digest']) is None
    ):
        raise FilesSyncRecordError(f'The Files sync record /{RECORD_PATH} is unreadable: invalid file stamp or SHA256 digest')
    return SyncedFile(value['stamp'], value['digest'])


def _write_record(root: Path, record: Mapping[str, SyncedFile]) -> None:
    """Replace the record whole: a half-written one would fail every later Turn."""
    path = root / RECORD_PATH
    path.parent.mkdir(exist_ok=True)
    partial = path.with_name(f'{path.name}.partial')  # pragma: no mutate: any name beside the record works; only a crash mid-write, which no test runs, reads it
    values = {name: entry.stamp if entry.digest is None else {'stamp': entry.stamp, 'digest': entry.digest}
              for name, entry in record.items()}
    partial.write_text(json.dumps(values))
    partial.replace(path)


def _synced(name: str, excluded: tuple[str, ...]) -> bool:
    """Whether a workspace path is one of the agent's files: not hidden, not scratch, not the Harness's, not a skill."""
    parts = PurePosixPath(name).parts
    if not parts or any(part.startswith('.') for part in parts):
        return False
    return not any(parts[: len(PurePosixPath(prefix).parts)] == PurePosixPath(prefix).parts for prefix in excluded)


def excluded_paths(skills: Iterable[str]) -> tuple[str, ...]:
    """The workspace paths that are not the agent's files: scratch space, the Harness's directory and the skill sources."""
    return (SCRATCH_DIRECTORY, HARNESS_DIRECTORY, *(skill.strip('/') for skill in skills))


def files_prompt(excluded: Iterable[str]) -> str:
    """The agent's view of the sync: told nothing, it looked for Files elsewhere and called them empty."""
    folders = ', '.join(f'`/{path}`' for path in excluded)
    return (
        "The user's Files are the files in your workspace: `/` to your file tools, the shell's working directory. "
        f'What you write there is saved to their Files, except hidden files and anything under {folders}.'
    )


def pop_files_sync(forwarded: dict[str, Any]) -> FilesSync | None:
    """Take the account's Files binding out of the forwarded props; None when the Turn carries none."""
    files = forwarded.pop(FILES_PROP, None)
    if files is None:
        return None
    if not isinstance(files, dict):
        raise FilesSyncError('Files must be an object')
    fields = ('bucket', 'prefix', 'region', *_CREDENTIAL_FIELDS)
    for field in fields:
        value = files.get(field)
        if not isinstance(value, str) or not value:
            raise FilesSyncError(f'Files {field} must be a non-empty string')
    if not files['prefix'].endswith('/'):
        raise FilesSyncError('Files prefix must end with /')
    return FilesSync(
        bucket=files['bucket'],
        prefix=files['prefix'],
        region=files['region'],  # pragma: no mutate: moto, the suite's S3, serves any region
        credentials={field: files[field] for field in _CREDENTIAL_FIELDS},
    )
