"""The `Artifact` tool: Claude Code's tool of that name, publishing a page the reply shows as a card (ADR 0087).

An Artifact's identity is its Source's path in Files. Each publish copies the Source into Files as the next Artifact
Version, at `/artifacts/<Source path>.versions/<n>.html` (a deck's folder at `<n>/`, see `slides`), so a version never
changes once published. Beside it,
`<n>.json` records who made the version (`agent` or `user`), its title and description, and `read.json` holds the
agent's read mark: the newest version it has published or read. Files are per account, so every chat of the account
finds the same Artifacts. Only this tool and a User save write the store: the agent's file tools are refused there.

`file_path` is a Files path, rooted at the Files mount: `/reports/q3.html` and `reports/q3.html` are both
`<root>/reports/q3.html`, whether or not a file of that absolute path exists on the host. The one other spelling is the
mount's own location on disk, which the shell shows the agent: `<root>/reports/q3.html` names the same file. `read`
takes the same spellings, as `file_path` or as the Artifact's id in `url`; only `read` takes a `url`.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool

from .agent import TOOL_SKILLS
from .files import ARTIFACTS_DIRECTORY, HARNESS_DIRECTORY, excluded_paths, is_files_path
from .lazy_files import current_turn_files, finish_in_thread
from .publish import publish_tool
from .slides import CHECKER, deck_folder, publish_deck

_TITLE = re.compile(r'<title[^>]*>([^<]*)</title>', re.IGNORECASE)

# The `artifacts` skill, which teaches each Artifact type's format, ships with the checker that holds Sources to it.
SKILLS = CHECKER.parent.parent / 'skills'
# Under the Harness's directory, which is never the user's Files.
SKILLS_SOURCE = f'/{HARNESS_DIRECTORY}/skills/'


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
        """Publish an HTML page you wrote in Files as an Artifact, which the reply shows as a card that opens the page.

        Publish the same file_path again to make a new version of the same Artifact. The page runs its scripts in a
        sandbox and loads libraries only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com at a pinned version.
        `title` defaults to the page's <title>; `description` is one sentence for the card. A deck's
        `project/deck.json` publishes the deck as Slides, once it passes the slide format's check.
        action 'list' lists the Artifacts of every chat; 'read' returns one's latest page (a deck's files) and its
        versions, each with its author (you or the User), by its id as `url` or its `file_path`. Read one before
        updating it from another chat.
        """
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
        artifact, coroutine=aartifact, name='Artifact', response_format='content_and_artifact',
        metadata={TOOL_SKILLS: {SKILLS_SOURCE: str(SKILLS)}},
    )


def _read_identity(url: str | None, file_path: str | None) -> str:
    if not (identity := url or file_path):
        raise ValueError("Name the Artifact to read by its id as url, or list them with action 'list'.")
    return identity


def _publish(
    root: Path, excluded: tuple[str, ...], file_path: str, title: str | None, description: str | None,
) -> tuple[str, dict[str, Any]]:
    source = _in_files(root, file_path)
    if (deck := deck_folder(source)) is not None:
        return _publish_deck(root, excluded, file_path, deck.resolve(), title, description)
    if not source.is_file():
        raise FileNotFoundError(f'No file at {file_path}. Write the page there, then publish it.')
    if source.suffix.lower() not in ('.html', '.htm'):
        raise ValueError(f'An Artifact is an .html file for now: {source.name}')
    resolved = source.resolve()
    if (name := _files_name(root, excluded, resolved)) is None:
        raise ValueError(f'Save the page in Files to publish it: {file_path}')
    versions = _versions(root, f'/{name}')
    versions.mkdir(parents=True, exist_ok=True)
    body = resolved.read_bytes()
    version = _store(versions, body)
    found = _TITLE.search(body.decode('utf-8', errors='replace'))
    title = title or (found.group(1).strip() if found else resolved.name)
    return _published(root, versions, f'/{name}', version, title, description)


def _publish_deck(
    root: Path, excluded: tuple[str, ...], file_path: str, deck: Path, title: str | None, description: str | None,
) -> tuple[str, dict[str, Any]]:
    """Publishes the deck folder `deck` as Slides: its own checked, staged store, then the same records as a page."""
    if (name := _files_name(root, excluded, deck)) is None:
        raise ValueError(f'Save the deck in Files to publish it: {file_path}')
    versions = _versions(root, f'/{name}')
    version, deck_title = publish_deck(versions, deck)
    return _published(root, versions, f'/{name}', version, title or deck_title or deck.name, description)


def _published(
    root: Path, versions: Path, identity: str, version: int, title: str, description: str | None,
) -> tuple[str, dict[str, Any]]:
    """Records the agent as the new version's author and moves its read mark there; the tool's result."""
    _write_json(versions / f'{version}.json', {'author': 'agent', 'title': title, 'description': description or ''})
    _write_json(versions / 'read.json', {'version': version})
    published = {
        'id': identity,
        'type': _type(versions, version),
        'title': title,
        'description': description or '',
        'version': version,
        'path': _path(root, versions, version),
    }
    return json.dumps(published), published


def _store(versions: Path, body: bytes) -> int:
    """Store `body` as the next version, creating it exclusively so a concurrent save takes the number after it."""
    version = 1 + max(_numbers(versions), default=0)
    while True:
        try:
            with (versions / f'{version}.html').open('xb') as stored:
                stored.write(body)
            return version
        except FileExistsError:
            version += 1


def _read(root: Path, excluded: tuple[str, ...], named: str) -> tuple[str, dict[str, Any]]:
    """The Artifact's latest version with its page and every version's author, moving the agent's read mark to it."""
    named_path = _in_files(root, named)
    if (name := _files_name(root, excluded, (deck_folder(named_path) or named_path).resolve())) is None:
        raise ValueError(f"Name an Artifact in Files: {named}. List them with action 'list'.")
    identity = f'/{name}'
    versions = _versions(root, identity)
    numbers = sorted(_numbers(versions))
    if not numbers:
        raise FileNotFoundError(f"No Artifact {identity}. List them with action 'list'.")
    _write_json(versions / 'read.json', {'version': numbers[-1]})
    found = {
        **_summary(root, identity),
        **_content(versions, numbers[-1]),
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
        'type': _type(versions, latest),
        'title': record['title'],
        'description': record['description'],
        'version': latest,
        'author': record['author'],
        'path': _path(root, versions, latest),
        'read': json.loads((versions / 'read.json').read_text())['version'],
    }


def _in_files(root: Path, file_path: str) -> Path:
    """The Files path `file_path` names: rooted at the mount, or already the mount's own location on disk."""
    on_disk = Path(file_path)
    return on_disk if on_disk.is_relative_to(root) else root / file_path.lstrip('/')


def _files_name(root: Path, excluded: tuple[str, ...], resolved: Path) -> str | None:
    """The Files name of a resolved path, or None past the root or outside the agent's files."""
    name = resolved.relative_to(root).as_posix() if resolved.is_relative_to(root) else None
    return name if name is not None and is_files_path(name, excluded) else None


def _versions(root: Path, identity: str) -> Path:
    return root / ARTIFACTS_DIRECTORY / f"{identity.lstrip('/')}.versions"


def _numbers(versions: Path) -> list[int]:
    """The published version numbers: a page's `<n>.html`, or a deck's `<n>/` folder."""
    pages = [int(path.stem) for path in versions.glob('*.html') if path.stem.isdigit()]
    return pages + [int(path.name) for path in versions.glob('*') if path.name.isdigit() and path.is_dir()]


def _type(versions: Path, number: int) -> str | None:
    """The version's Artifact Type: 'slides' for a deck's folder, None for a page."""
    return 'slides' if (versions / str(number)).is_dir() else None


def _content(versions: Path, number: int) -> dict[str, Any]:
    """A page's HTML as `html`, or a deck's files by their path in the deck as `files`."""
    if _type(versions, number) is None:
        return {'html': (versions / f'{number}.html').read_text(encoding='utf-8', errors='replace')}
    folder = versions / str(number)
    return {'files': {
        path.relative_to(folder).as_posix(): path.read_text(encoding='utf-8', errors='replace')
        for path in sorted(folder.rglob('*')) if path.is_file()
    }}


def _record(versions: Path, number: int) -> dict[str, str]:
    return json.loads((versions / f'{number}.json').read_text())


def _path(root: Path, versions: Path, number: int) -> str:
    stored = versions / str(number) if _type(versions, number) else versions / f'{number}.html'
    return f'/{stored.relative_to(root).as_posix()}'


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value))
