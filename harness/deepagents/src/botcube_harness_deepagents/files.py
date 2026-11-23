from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path, PurePosixPath
from typing import Any

from ag_ui.core import Message

from .files_mount import FilesMount

HARNESS_DIRECTORY = 'botcube-harness-deepagents'
SCRATCH_DIRECTORY = 'tmp'
# The Artifact version store: in Files, but only the Artifact tool and a User save write it (ADR 0087).
ARTIFACTS_DIRECTORY = 'artifacts'


class FilesBindingError(RuntimeError):
    code = 'INVALID_FILES'


def is_files_path(name: str, excluded: tuple[str, ...]) -> bool:
    """Whether a workspace path is one of the agent's files: not hidden, not scratch, not the Harness's, not a skill."""
    parts = PurePosixPath(name).parts
    if not parts or any(part.startswith('.') for part in parts):
        return False
    return not any(parts[: len(PurePosixPath(prefix).parts)] == PurePosixPath(prefix).parts for prefix in excluded)


def excluded_paths(skills: Iterable[str]) -> tuple[str, ...]:
    """The workspace paths that are not the agent's files: scratch space, the Harness's directory and the skill sources."""
    return (SCRATCH_DIRECTORY, HARNESS_DIRECTORY, *(skill.strip('/') for skill in skills))


def files_prompt(root: Path, excluded: Iterable[str]) -> str:
    folders = ', '.join(f'`{root / path}`' for path in excluded)
    return (
        f"The user's Files are at `{root}`, your working directory. Use full paths there in file tools, "
        f"shell commands, and Markdown file links. Hidden files and anything under {folders} aren't saved."
    )


def absolute_attachment_paths(messages: Iterable[Message], workspace: Callable[[], Path]) -> None:
    for message in messages:
        if message.role != 'user' or not isinstance(message.content, str):
            continue
        text, heading, files = message.content.rpartition('\n\nAttached files:\n')
        lines = files.splitlines()
        if heading and lines and all(line.startswith('- /') for line in lines):
            root = workspace()
            paths = (root / line[2:].lstrip('/') if not Path(line[2:]).is_relative_to(root) else Path(line[2:]) for line in lines)
            message.content = text + heading + '\n'.join(f'- {path}' for path in paths)


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
