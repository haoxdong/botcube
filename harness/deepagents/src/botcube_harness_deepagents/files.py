from __future__ import annotations

import logging
import os
import re
import shutil
from collections.abc import Iterable
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote

from .files_mount import FilesMount

HARNESS_DIRECTORY = 'botcube-harness-deepagents'
SCRATCH_DIRECTORY = 'tmp'
# The Artifact version store: in Files, but only the Artifact tool and a User save write it (ADR 0087).
ARTIFACTS_DIRECTORY = 'artifacts'


class FilesBindingError(RuntimeError):
    code = 'INVALID_FILES'


def install_staged_files(source: Path, destination: Path, excluded: Iterable[str]) -> None:
    skip = tuple(excluded)
    for local in source.rglob('*'):
        name = local.relative_to(source).as_posix()
        if local.is_file() and is_files_path(name, skip):
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(local, target)


def is_files_path(name: str, excluded: tuple[str, ...]) -> bool:
    """Whether a workspace path is one of the agent's files: not hidden, not scratch, not the Harness's, not a skill."""
    parts = PurePosixPath(name).parts
    if not parts or any(part.startswith('.') for part in parts):
        return False
    return not any(parts[: len(PurePosixPath(prefix).parts)] == PurePosixPath(prefix).parts for prefix in excluded)


_LINKED_PATH = re.compile(r'\]\(\s*<?(/[^\s)>]+)')


def import_linked_files(root: Path, answer: str, excluded: Iterable[str], filesystem: Path = Path('/')) -> None:
    skip = tuple(excluded)
    workspace = root.resolve()
    for link in dict.fromkeys(_LINKED_PATH.findall(answer)):
        name = unquote(link).lstrip('/')
        if '..' in PurePosixPath(name).parts or not is_files_path(name, skip):
            continue
        local, real = root / name, filesystem / name
        source = real.resolve()
        allowed = (is_files_path(source.relative_to(workspace).as_posix(), skip)
                   if source.is_relative_to(workspace) else source.is_relative_to(filesystem.resolve() / 'mnt/data'))
        if not allowed:
            logging.getLogger(__name__).warning('Skipping linked file outside artifact directories')
            continue
        if os.path.lexists(local) or real.is_symlink() or not real.is_file():
            continue
        local.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(real, local)


def excluded_paths(skills: Iterable[str]) -> tuple[str, ...]:
    """The workspace paths that are not the agent's files: scratch space, the Harness's directory and the skill sources."""
    return (SCRATCH_DIRECTORY, HARNESS_DIRECTORY, *(skill.strip('/') for skill in skills))


def files_prompt(excluded: Iterable[str]) -> str:
    folders = ', '.join(f'`/{path}`' for path in excluded)
    return (
        f"The user's Files are your working directory (`/` to your file tools); hidden files and anything under {folders} aren't saved."
    )


def pop_files_mount(forwarded: dict[str, Any]) -> FilesMount | None:
    files = forwarded.pop('files', None)
    if files is None:
        return None
    if not isinstance(files, dict):
        raise FilesBindingError('Files must be an object')
    for field in ('fileSystemId', 'accessPointId', 'mountTargetIp', 'expiration', 'region', 'accessKeyId', 'secretAccessKey', 'sessionToken'):
        if not isinstance(files.get(field), str) or not files[field]:
            raise FilesBindingError(f'Files {field} must be a non-empty string')
    try:
        return FilesMount.from_binding(files)
    except (ValueError, TypeError) as error:
        raise FilesBindingError('Files EFS binding is invalid or expired') from error
