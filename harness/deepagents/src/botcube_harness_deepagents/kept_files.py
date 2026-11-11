"""The Files a version names, kept in the version store: Files keep no versions, so a publish copies each File a Source
names (a Sheet's `importFile` step, an Email's attachment) beside the versions, at `imports/<sha256>.<ext>`, and the
version's `<n>.json` lists each copy under `imports`. Every later read of the version reads that copy, never the File.

A record's `imports` entry is `{edit, from, path}`: `edit` is the index of what names the File in the Source (a Sheet's
edit, an Email's attachment), `from` the File it named and `path` the copy, both as Files paths. The Chat Service and
the web read the same shape from `botcube-artifact-check/record`.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any


def keep(
    named: list[tuple[int, str]], versions: Path, root: Path, find: Callable[[str], Path | None],
) -> tuple[list[dict[str, Any]], list[tuple[int, str]]]:
    """Copies each File `named` (by its index in the Source and its Files path) into `versions`. Returns the record's
    `imports`, and every `(index, path)` that names no File in Files; nothing is copied when one is missing."""
    found = [(index, path, find(path)) for index, path in named]
    if missing := [(index, path) for index, path, file in found if file is None]:
        return [], missing
    return [
        {'edit': index, 'from': _named(root, file), 'path': _named(root, _copy(file, versions))}
        for index, _, file in found if file is not None
    ], []


def recorded(version: Path, suffix: str) -> dict[str, Any]:
    """The `imports` of the one-file version at `version` (`<n><suffix>`), as its record lists them; empty for none."""
    record = json.loads(version.with_name(f'{version.name.removesuffix(suffix)}.json').read_text(encoding='utf-8'))
    return {'imports': record['imports']} if 'imports' in record else {}


def _named(root: Path, path: Path) -> str:
    return f'/{path.relative_to(root).as_posix()}'


def _copy(file: Path, versions: Path) -> Path:
    """The store's copy of `file`, named by its content, so a copy never changes once written."""
    data = file.read_bytes()
    copy = versions / 'imports' / f'{hashlib.sha256(data).hexdigest()}{file.suffix.lower()}'
    if not copy.exists():
        copy.parent.mkdir(exist_ok=True)
        written = copy.with_name(f'.{copy.name}.{uuid.uuid4().hex}')
        written.write_bytes(data)
        written.replace(copy)
    return copy
