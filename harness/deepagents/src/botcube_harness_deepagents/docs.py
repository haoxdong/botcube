"""A Doc, the Artifact Type whose Source is one Markdown file (`.md`), stored as `<n>.md`.

Its entry in `artifact_types`: `store` copies the file into the version being built, `refuse` runs the checker (the
`artifact-check` Node package beside this harness) over that copy, and `title` is the Doc's first `# ` heading.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from . import artifact_check

_HEADING = re.compile(r'^# +(.+?)[ #]*$', re.MULTILINE)


def source(path: Path) -> Path | None:
    return path if path.suffix.lower() == '.md' else None


def store(doc: Path, version: Path) -> None:
    """Copies the Doc to `version`, which must not exist yet."""
    with version.open('xb') as stored:
        stored.write(doc.read_bytes())


def refuse(doc: Path, name: str) -> None:
    """Refuses a Doc the viewer can't show as written, naming each error as the User's save does."""
    if errors := artifact_check.errors('doc', doc, name):
        raise ValueError(
            'The Doc has Markdown its viewer does not show, so nothing was published. Fix every error, then publish '
            'again:\n' + '\n'.join(f'- {error}' for error in errors),
        )


def title(doc: Path) -> str | None:
    found = _HEADING.search(doc.read_text(encoding='utf-8', errors='replace'))
    return found.group(1).strip() if found else None


def read(version: Path) -> dict[str, Any]:
    return {'markdown': version.read_text(encoding='utf-8', errors='replace')}
