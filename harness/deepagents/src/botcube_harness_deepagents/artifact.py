"""The `Artifact` tool: Claude Code's tool of that name, publishing a page the reply shows as a card (ADR 0087).

An Artifact's identity is its Source's path in Files. Each publish copies the Source into Files as the next Artifact
Version, at `/artifacts/<Source path>.versions/<n><suffix>` as its type stores it (`artifact_types.py`), so a version
never changes once published. Beside it, `<n>.json` records who made the version (`agent` or `user`), its title and
description, and `read.json` holds the agent's read mark: the newest version it has published or read. Files are per
account, so every chat of the account finds the same Artifacts. Only this tool and a User save write the store: the
agent's file tools are refused there.

`file_path` is a Files path, rooted at the Files mount: `/reports/q3.html` and `reports/q3.html` are both
`<root>/reports/q3.html`, whether or not a file of that absolute path exists on the host. The one other spelling is the
mount's own location on disk, which the shell shows the agent: `<root>/reports/q3.html` names the same file. `read`
takes the same spellings, as `file_path` or as the Artifact's id in `url`; only `read` takes a `url`.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool

from .agent import TOOL_SKILLS
from .artifact_check import CHECKER
from .artifact_types import NAMED, PUBLISHES, TYPES, ArtifactType
from .files import ARTIFACTS_DIRECTORY, HARNESS_DIRECTORY, excluded_paths, is_files_path
from .lazy_files import current_turn_files, finish_in_thread
from .publish import publish_tool

# The `artifacts` skill, which teaches each Artifact type's format, ships with the checker that holds Sources to it.
SKILLS = CHECKER.parent.parent / 'skills'
# Under the Harness's directory, which is never the user's Files.
SKILLS_SOURCE = f'/{HARNESS_DIRECTORY}/skills/'
# How long a publish waits for another's claimed version to be written in full before it fails.
CLAIM_SECONDS = 30.0

# The `Artifact` tool's description, telling the agent how to publish every type in TYPES.
DESCRIPTION = (
    'Publish a file you wrote in Files as an Artifact, which the reply shows as a card that opens it.\n\n'
    f'Publish the same file_path again to make a new version of the same Artifact. {PUBLISHES} '
    "`title` defaults to the Artifact's own title; `description` is one sentence for the card. "
    "action 'list' lists the Artifacts of every chat; 'read' returns one's latest version (a deck's files) and its "
    'versions, each with its author (you or the User), by its id as `url` or its `file_path`. Read one before '
    'updating it from another chat.'
)


def artifacts_enabled() -> bool:
    """The Artifacts flag, BOTCUBE_ARTIFACTS=1, off by default; removing it also retires `publish`."""
    return os.environ.get('BOTCUBE_ARTIFACTS') == '1'


def publishing_tools(root: Path, skills: Iterable[str]) -> list[BaseTool]:
    """The tool the agent publishes with: `Artifact` behind the Artifacts flag, else `publish`."""
    if artifacts_enabled():
        return [artifact_tool(root, skills)]
    return [publish_tool(root, skills)]


def artifact_tool(root: Path, skills: Iterable[str] = ()) -> BaseTool:
    excluded = excluded_paths(skills)

    def artifact(
        file_path: str | None = None, action: str = 'publish', title: str | None = None,
        description: str | None = None, url: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        if action not in ('publish', 'read', 'list'):
            raise ValueError(f"action is 'publish', 'read' or 'list'; got {action!r}.")
        if action == 'publish' and url is not None:
            raise ValueError(
                f'Publishing takes no url; got {url!r}. To update an Artifact, publish the same file_path again.',
            )
        if (readiness := current_turn_files()) is not None:
            readiness.ensure()
        if action == 'list':
            return _list(root.resolve())
        if action == 'read':
            return _read(root.resolve(), excluded, _read_identity(url, file_path))
        if not file_path:
            raise ValueError('Name the page to publish with file_path.')
        return _publish(root.resolve(), excluded, file_path, title, description)

    async def aartifact(
        file_path: str | None = None, action: str = 'publish', title: str | None = None,
        description: str | None = None, url: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        return await finish_in_thread(artifact, file_path, action, title, description, url)

    # The tool brings the `artifacts` skill, read from the Harness's own copy: it never lands in the user's Files.
    return StructuredTool.from_function(
        artifact, coroutine=aartifact, name='Artifact', description=DESCRIPTION, response_format='content_and_artifact',
        metadata={TOOL_SKILLS: {SKILLS_SOURCE: str(SKILLS)}},
    )


def _read_identity(url: str | None, file_path: str | None) -> str:
    if not (identity := url or file_path):
        raise ValueError("Name the Artifact to read by its id as url, or list them with action 'list'.")
    return identity


def _publish(
    root: Path, excluded: tuple[str, ...], file_path: str, title: str | None, description: str | None,
) -> tuple[str, dict[str, Any]]:
    kind, source = _source(_in_files(root, file_path))
    if not source.exists():
        raise FileNotFoundError(f'No file at {file_path}. Write the page there, then publish it.')
    if kind is None:
        raise ValueError(f'An Artifact is {NAMED}: {source.name}')
    resolved = source.resolve()
    if (name := _files_name(root, excluded, resolved)) is None:
        raise ValueError(f'Save the page in Files to publish it: {file_path}')
    versions = _versions(root, f'/{name}')
    observed = _refuse_unread(root, versions)
    stored = (title, description or '', lambda asset: _file_in(root, excluded, asset))
    version, record = _store(root, versions, observed, (kind, resolved), stored)
    _write_json(versions / 'read.json', {'version': version})
    published = {
        'id': f'/{name}',
        'type': kind.name,
        'title': record['title'],
        'description': record['description'],
        'version': version,
        'path': _path(root, versions, version),
    }
    return json.dumps(published), published


def _source(path: Path) -> tuple[ArtifactType | None, Path]:
    """The type whose Source `path` names, the first in TYPES, and that Source; no type when none does."""
    return next(((kind, found) for kind in TYPES if (found := kind.source(path)) is not None), (None, path))


def _store(
    root: Path, versions: Path, observed: int, typed: tuple[ArtifactType, Path],
    described: tuple[str | None, str, Callable[[str], Path | None]],
) -> tuple[int, dict[str, Any]]:
    """Builds the version under a hidden name, checks that copy, claims its number by creating its record (the agent
    as author, and what else the type keeps), then renames it into place: what is stored is what was checked, and a
    refusal leaves nothing behind. `observed` is the newest version when the publish checked for an unread User save.
    """
    (kind, source), (title, description, find) = typed, described
    versions.mkdir(parents=True, exist_ok=True)
    building = versions / f'.building-{uuid.uuid4().hex}{kind.suffix}'
    try:
        kind.store(source, building)
        kind.check(building, source.name)
        claimed = {
            'author': 'agent', 'title': title or kind.title(building) or source.name, 'description': description,
            **kind.keep(building, versions, root, find),
        }
        version = _claim(root, versions, observed, claimed)
        building.rename(versions / f'{version}{kind.suffix}')
    except BaseException:
        if building.is_dir():
            shutil.rmtree(building)
        building.unlink(missing_ok=True)
        raise
    return version, claimed


def _claim(root: Path, versions: Path, observed: int, record: dict[str, Any]) -> int:
    """Claims the version after `observed` by creating its record. A number another agent publish claimed first is
    skipped; one a User's save claimed refuses the publish, since its staged copy predates what the User saved.
    """
    version = observed + 1
    while True:
        try:
            with (versions / f'{version}.json').open('x', encoding='utf-8') as claimed:
                json.dump(record, claimed)
            return version
        except FileExistsError:
            pass
        author = _claimed_by(versions, version)
        if author == 'user':
            _settle(versions, version)
            raise _unread(root, versions, _read_mark(versions), version)
        # A claim withdrawn (its publish or save failed) frees its number to claim again.
        if author is not None:
            version += 1


def _claimed_by(versions: Path, number: int) -> str | None:
    """Who claimed `number`, once its record is whole; None when the claim was withdrawn."""
    deadline = time.monotonic() + CLAIM_SECONDS
    while True:
        if not (versions / f'{number}.json').exists():
            return None
        try:
            return _record(versions, number)['author']
        except (json.JSONDecodeError, FileNotFoundError):
            # The claimant creates the record, then writes it; a withdrawn claim is gone on the next look.
            _wait(deadline, versions, number)


def _settle(versions: Path, number: int) -> None:
    """Waits for a claimed version to be renamed into place: its claim comes first."""
    deadline = time.monotonic() + CLAIM_SECONDS
    while number not in _numbers(versions):
        _wait(deadline, versions, number)


def _wait(deadline: float, versions: Path, number: int) -> None:
    if time.monotonic() > deadline:
        raise RuntimeError(f'Artifact Version {number} in {versions} was claimed but not written in {CLAIM_SECONDS:g}s.')
    time.sleep(0.01)


def _refuse_unread(root: Path, versions: Path) -> int:
    """Refuses a publish while the newest version is a User's save the agent has not read, naming what they changed.

    The Source in Files may already hold a stale write over the User's save, so the refusal says to redo the change on
    what `read` returns: the User's version as they saved it, which no write to the Source can change. Returns the
    newest version, 0 when there is none: the publish claims the one after it.
    """
    if not (numbers := _numbers(versions)):
        return 0
    latest = max(numbers)
    read = _read_mark(versions)
    if latest > read and _record(versions, latest)['author'] == 'user':
        raise _unread(root, versions, read, latest)
    return latest


def _unread(root: Path, versions: Path, read: int, saved: int) -> ValueError:
    identity = f"/{versions.relative_to(root / ARTIFACTS_DIRECTORY).as_posix().removesuffix('.versions')}"
    since = f'Artifact Version {read}' if read else 'none'
    return ValueError(
        f'Refused: the User saved Artifact Version {saved} after your last read ({since}). '
        f"Read it first (action: 'read'), redo your change on what the User saved, then publish. "
        f"Changed: {', '.join(_changed(versions, read, saved, identity))}",
    )


def _changed(versions: Path, before: int, after: int, identity: str) -> list[str]:
    """The Source's files that differ between two versions, as Files paths: a one-file Source is itself."""
    if _type(versions, after).suffix:
        return [identity]
    old, new = _tree(versions / str(before)), _tree(versions / str(after))
    return [f'{identity}/{path}' for path in sorted(old.keys() | new.keys()) if old.get(path) != new.get(path)]


def _tree(folder: Path) -> dict[str, bytes]:
    return {path.relative_to(folder).as_posix(): path.read_bytes() for path in folder.rglob('*') if path.is_file()}


def _read(root: Path, excluded: tuple[str, ...], named: str) -> tuple[str, dict[str, Any]]:
    """The Artifact's latest version with its content and every version's author, moving the agent's read mark to it."""
    if (name := _files_name(root, excluded, _source(_in_files(root, named))[1].resolve())) is None:
        raise ValueError(f"Name an Artifact in Files: {named}. List them with action 'list'.")
    identity = f'/{name}'
    versions = _versions(root, identity)
    numbers = sorted(_numbers(versions))
    if not numbers:
        raise FileNotFoundError(f"No Artifact {identity}. List them with action 'list'.")
    _write_json(versions / 'read.json', {'version': numbers[-1]})
    found = {
        **_summary(root, identity),
        **_type(versions, numbers[-1]).read(_stored(versions, numbers[-1])),
        'versions': [
            {'version': number, 'author': _record(versions, number)['author'], 'path': _path(root, versions, number)}
            for number in numbers
        ],
    }
    return json.dumps(found), found


def _list(root: Path) -> tuple[str, dict[str, Any]]:
    """Every Artifact in the account's Files, as its latest version describes it."""
    store = root / ARTIFACTS_DIRECTORY
    listed = {'artifacts': [
        _summary(root, f"/{versions.relative_to(store).as_posix().removesuffix('.versions')}")
        for versions in sorted(store.glob('**/*.versions')) if _numbers(versions)
    ]}
    return json.dumps(listed), listed


def _summary(root: Path, identity: str) -> dict[str, Any]:
    versions = _versions(root, identity)
    latest = max(_numbers(versions))
    record = _record(versions, latest)
    return {
        'id': identity,
        'type': _type(versions, latest).name,
        'title': record['title'],
        'description': record['description'],
        'version': latest,
        'author': record['author'],
        'path': _path(root, versions, latest),
        'read': _read_mark(versions),
    }


def _in_files(root: Path, file_path: str) -> Path:
    """The Files path `file_path` names: rooted at the mount, or already the mount's own location on disk."""
    on_disk = Path(file_path)
    return on_disk if on_disk.is_relative_to(root) else root / file_path.lstrip('/')


def _files_name(root: Path, excluded: tuple[str, ...], resolved: Path) -> str | None:
    """The Files name of a resolved path, or None past the root or outside the agent's files."""
    name = resolved.relative_to(root).as_posix() if resolved.is_relative_to(root) else None
    return name if name is not None and is_files_path(name, excluded) else None


def _file_in(root: Path, excluded: tuple[str, ...], file_path: str) -> Path | None:
    """The file in the agent's Files that `file_path` names, resolved; None when there is none."""
    resolved = _in_files(root, file_path).resolve()
    return resolved if resolved.is_file() and _files_name(root, excluded, resolved) is not None else None


def _versions(root: Path, identity: str) -> Path:
    return root / ARTIFACTS_DIRECTORY / f"{identity.lstrip('/')}.versions"


_VERSION = re.compile(r'(\d+)(.*)')


def _numbers(versions: Path) -> list[int]:
    """The stored versions: each a `<n><suffix>` of a type. A version claimed but still being built is not one yet."""
    suffixes = {kind.suffix for kind in TYPES}
    return [
        int(found[1]) for path in versions.glob('*')
        if (found := _VERSION.fullmatch(path.name)) is not None and found[2] in suffixes
    ]


def _type(versions: Path, number: int) -> ArtifactType:
    return next(kind for kind in TYPES if (versions / f'{number}{kind.suffix}').exists())


def _stored(versions: Path, number: int) -> Path:
    return versions / f'{number}{_type(versions, number).suffix}'


def _record(versions: Path, number: int) -> dict[str, str]:
    return json.loads((versions / f'{number}.json').read_text())


def _read_mark(versions: Path) -> int:
    """The newest version the agent published or read; 0 before it has done either."""
    mark = versions / 'read.json'
    return json.loads(mark.read_text())['version'] if mark.exists() else 0


def _path(root: Path, versions: Path, number: int) -> str:
    return f'/{_stored(versions, number).relative_to(root).as_posix()}'


def _write_json(path: Path, value: dict[str, Any]) -> None:
    written = path.with_name(f'.{path.name}.{uuid.uuid4().hex}')
    written.write_text(json.dumps(value))
    written.replace(path)
