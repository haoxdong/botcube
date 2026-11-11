"""The Artifact Types the `Artifact` tool publishes, one entry each (ADR 0087).

A type's version is stored beside its `<n>.json` record as `<n><suffix>`: a folder when the suffix is empty, one file
otherwise. A publish names a type's Source when its `source` finds one at the published path; the first type that
does is the Artifact's type. A publish `store`s the Source as a hidden, not yet numbered version, then `check`s that
copy, given the Source's file name for its errors (raising ValueError naming every error), so what is stored is
exactly what was checked. What else the version `keep`s (copies of the Files a Sheet imports or an Email attaches,
found in Files by `find`, see `kept_files`) is recorded in its `<n>.json`.
"""

from __future__ import annotations

import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import docs, email, sheets, slides


@dataclass(frozen=True)
class ArtifactType:
    name: str | None
    # What a publish names to make one, as the `Artifact` tool's refusal of any other file lists it.
    named: str
    # How to publish one, as the `Artifact` tool's description tells the agent.
    publishes: str
    suffix: str
    source: Callable[[Path], Path | None]
    check: Callable[[Path, str], None]
    store: Callable[[Path, Path], None]
    title: Callable[[Path], str | None]
    read: Callable[[Path], dict[str, Any]]
    keep: Callable[[Path, Path, Path, Callable[[str], Path | None]], dict[str, Any]] = lambda version, versions, root, find: {}


_TITLE = re.compile(r'<title[^>]*>([^<]*)</title>', re.IGNORECASE)


def _page_title(page: Path) -> str | None:
    found = _TITLE.search(page.read_bytes().decode('utf-8', errors='replace'))
    return found.group(1).strip() if found else None


def _store_page(page: Path, version: Path) -> None:
    shutil.copyfile(page, version)


PAGE = ArtifactType(
    name=None,
    named='an .html page',
    publishes=(
        'An `.html` page publishes as a page, titled by its <title>: it runs its scripts in a sandbox and loads '
        'libraries only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com at a pinned version.'
    ),
    suffix='.html',
    source=lambda path: path if path.suffix.lower() in ('.html', '.htm') else None,
    check=lambda page, name: None,
    store=_store_page,
    title=_page_title,
    read=lambda version: {'html': version.read_text(encoding='utf-8', errors='replace')},
)

SLIDES = ArtifactType(
    name='slides', named="a deck's project/deck.json",
    publishes="A deck's `project/deck.json` publishes the deck as Slides, once it passes the slide format's check.",
    suffix='', source=slides.deck_folder, check=slides.refuse, store=slides.store, title=slides.title,
    read=slides.read,
)

DOC = ArtifactType(
    name='doc', named='a .md Doc',
    publishes="A `.md` file publishes as a Doc, titled by its first `# ` heading, once it passes the Doc's check.",
    suffix='.md', source=docs.source, check=docs.refuse, store=docs.store, title=docs.title, read=docs.read,
)

SHEET = ArtifactType(
    name='sheet', named='a .sheet.json Sheet',
    publishes=(
        "A `<name>.sheet.json` file of sheet edits publishes as a Sheet, once it passes the sheet format's check; the "
        'version keeps a copy of each File its `importFile` edits name.'
    ),
    suffix=sheets.SUFFIX, source=sheets.sheet_file, check=sheets.refuse, store=sheets.store,
    title=lambda file: None, read=sheets.read, keep=sheets.keep,
)

EMAIL = ArtifactType(
    name='email', named='an .email.json Email draft',
    publishes=(
        "A `<name>.email.json` draft in Gmail's draft fields publishes as an Email, once it passes the email format's "
        'check; the version keeps a copy of each File it attaches.'
    ),
    suffix=email.SUFFIX, source=email.draft, check=email.refuse, store=email.store, title=email.title,
    read=email.read, keep=email.keep,
)

TYPES = (SLIDES, DOC, SHEET, EMAIL, PAGE)


def listed(items: list[str]) -> str:
    return ', '.join(items[:-1]) + f' or {items[-1]}' if len(items) > 1 else ''.join(items)


# What the `Artifact` tool's refusal of a file no type publishes names.
NAMED = listed([kind.named for kind in TYPES])
# How the `Artifact` tool's description tells the agent to publish each type.
PUBLISHES = ' '.join(kind.publishes for kind in TYPES)
