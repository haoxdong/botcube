"""Email, the Artifact Type whose Source is one draft in Gmail's draft fields: a `<name>.email.json` file in Files.

Its entry in `artifact_types`: `store` copies the draft, a regular file and never a link, to the version being built;
`refuse` runs the checker over that copy; `keep` copies each attached File into the version store (`kept_files`),
refusing the publish when one is not in Files, so the version's `.eml` attaches the Files as they were at the publish.
A version is at `/artifacts/<draft path>.versions/<n>.email.json`.
"""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import artifact_check, kept_files

SUFFIX = '.email.json'


def draft(source: Path) -> Path | None:
    """The draft a publish names: a `<name>.email.json` file; None for any other path."""
    return source if source.name.endswith(SUFFIX) and len(source.name) > len(SUFFIX) else None


def store(source: Path, version: Path) -> None:
    """Copies the draft at `source` to `version`, which does not exist yet, reading through a descriptor that follows
    no link: a link swapped in after the publish named the draft fails the publish instead of being read.
    """
    try:
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        if source.is_symlink():
            raise ValueError(f'{source.name} is a symbolic link, so nothing was published. Write the draft itself.') from error
        raise
    with os.fdopen(fd, 'rb') as read:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(f'{source.name} is not a regular file, so nothing was published. Write the draft itself.')
        with version.open('xb') as written:
            written.write(read.read())


def refuse(version: Path, name: str) -> None:
    """Refuses the draft built at `version` (the checker reads it as `name`) when it breaks the email format."""
    if errors := artifact_check.errors('email', version, name):
        raise ValueError(
            'The draft breaks the email format, so nothing was published. Fix every error, then publish again:\n'
            + '\n'.join(f'- {error}' for error in errors),
        )


def keep(version: Path, versions: Path, root: Path, find: Callable[[str], Path | None]) -> dict[str, Any]:
    """Keeps a copy of each File the draft at `version` attaches (`kept_files`), refusing the publish when one is not
    in Files, so the `.eml` attaches the Files as they were at the publish. Returns the record's `imports`."""
    attachments = json.loads(version.read_text(encoding='utf-8')).get('attachments', [])
    imports, missing = kept_files.keep(
        [(index, attachment['file']) for index, attachment in enumerate(attachments)], versions, root, find,
    )
    if missing:
        name = versions.name.removesuffix('.versions')
        raise ValueError(
            'The draft attaches a File that is not in Files, so nothing was published. Save it there, then publish again:\n'
            + '\n'.join(
                f'- {name} attachments[{index}].file — No file in Files: {path}. '
                'Nearest: write the file in Files first, or name one that is there.'
                for index, path in missing
            ),
        )
    return {'imports': imports} if imports else {}


def title(version: Path) -> str | None:
    return json.loads(version.read_text(encoding='utf-8')).get('subject') or None


def read(version: Path) -> dict[str, Any]:
    """A draft version's `email`, its fields, and the copies of the Files it attaches."""
    return {'email': json.loads(version.read_text(encoding='utf-8')), **kept_files.recorded(version, SUFFIX)}
