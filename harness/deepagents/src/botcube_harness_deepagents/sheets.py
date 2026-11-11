"""Sheet, the Artifact Type whose Source is one `<name>.sheet.json` file: `{"edits": [...]}` of sheet edits.

Its entry in `artifact_types`: `store` copies the file, and only a regular file, into the version being built in the
version store; `refuse` runs the checker (the `artifact-check` Node package beside this harness) over that copy, which
the `artifact` tool renames into place as the next version only when it passes. Each error names the file, the edit's
index and kind, the field and the nearest allowed form. A version is at `/artifacts/<Source path>.versions/<n>.sheet.json`.

Files keep no versions, so `keep` copies each File an `importFile` edit names into the version store (`kept_files`), and
the version's record lists the copy for each edit: every replay of the version reads that copy, never the File.
"""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import artifact_check, kept_files

SUFFIX = '.sheet.json'


def sheet_file(source: Path) -> Path | None:
    """The Sheet a publish names: its `.sheet.json` file. None when `source` names no Sheet."""
    return source if source.name.endswith(SUFFIX) else None


def refuse(file: Path, name: str) -> None:
    """Refuses the Sheet at `file` (read as `name`) when it breaks the sheet format, naming every error as the agent
    reads it."""
    if errors := artifact_check.errors('sheet', file, name):
        raise ValueError(
            'The Sheet breaks the sheet format, so nothing was published. Fix every error, then publish again:\n'
            + '\n'.join(f'- {error}' for error in errors),
        )


def store(file: Path, version: Path) -> None:
    """Copies the Sheet at `file` to `version`, which does not exist yet, reading it without following a link."""
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(f'{file.name} is not a regular file, so nothing was published. Write the Sheet itself.')
        with version.open('xb') as copy:
            copy.write(source.read())


def keep(version: Path, versions: Path, root: Path, find: Callable[[str], Path | None]) -> dict[str, Any]:
    """Keeps a copy of each File the Sheet at `version` imports (`kept_files`), refusing the publish when one is not in
    Files. Returns the record's `imports`."""
    edits = json.loads(version.read_text(encoding='utf-8'))['edits']
    steps = [(index, edit['asset']) for index, edit in enumerate(edits) if edit['kind'] == 'importFile']
    imports, missing = kept_files.keep(steps, versions, root, find)
    if missing:
        name = versions.name.removesuffix('.versions')
        raise ValueError(
            'The Sheet imports a File that is not in Files, so nothing was published. Save it there, then publish again:\n'
            + '\n'.join(f"- {name} edit {index} (importFile) — asset: no File at /{asset.lstrip('/')}" for index, asset in missing),
        )
    return {'imports': imports} if imports else {}


def read(version: Path) -> dict[str, Any]:
    """A Sheet version's `sheet`, the file's text, and the copies of the Files it imports."""
    return {'sheet': version.read_text(encoding='utf-8'), **kept_files.recorded(version, SUFFIX)}
