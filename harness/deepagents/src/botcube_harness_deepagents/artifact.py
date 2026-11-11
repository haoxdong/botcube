"""The `Artifact` tool: Claude Code's tool of that name, publishing a page the reply shows as a card (ADR 0087).

An Artifact's identity is its Source's path in Files. Each publish copies the Source into Files as the next Artifact
Version, at `/artifacts/<Source path>.versions/<n>.html`, so a version never changes once published.

`file_path` is a Files path, rooted at the Files mount: `/reports/q3.html` and `reports/q3.html` are both
`<root>/reports/q3.html`, whether or not a file of that absolute path exists on the host. The one other spelling is the
mount's own location on disk, which the shell shows the agent: `<root>/reports/q3.html` names the same file.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool

from .files import excluded_paths, is_files_path
from .lazy_files import current_turn_files, finish_in_thread
from .publish import publish_tool

ARTIFACTS_DIRECTORY = 'artifacts'
_TITLE = re.compile(r'<title[^>]*>([^<]*)</title>', re.IGNORECASE)


def publishing_tools(root: Path, skills: Iterable[str]) -> list[BaseTool]:
    """The tool the agent publishes with: `Artifact` behind the Artifacts flag, else `publish`.

    Flag BOTCUBE_ARTIFACTS=1, off by default; removing it also retires `publish`.
    """
    if os.environ.get('BOTCUBE_ARTIFACTS') == '1':
        return [artifact_tool(root, skills)]
    return [publish_tool(root, skills)]


def artifact_tool(root: Path, skills: Iterable[str] = ()) -> BaseTool:
    excluded = excluded_paths(skills)

    def artifact(
        file_path: str, action: str = 'publish', title: str | None = None, description: str | None = None,
        url: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """Publish an HTML page you wrote in Files as an Artifact, which the reply shows as a card that opens the page.

        Publish the same file_path again to make a new version of the same Artifact. The page runs its scripts in a
        sandbox and loads libraries only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com at a pinned version.
        `title` defaults to the page's <title>; `description` is one sentence for the card.
        """
        if action != 'publish':
            raise ValueError(f"Only action 'publish' is available; got {action!r}.")
        if url is not None:
            raise ValueError(
                f'Publishing takes no url; got {url!r}. To update an Artifact, publish the same file_path again.',
            )
        if (readiness := current_turn_files()) is not None:
            readiness.ensure()
        return _publish(root.resolve(), excluded, file_path, title, description)

    async def aartifact(
        file_path: str, action: str = 'publish', title: str | None = None, description: str | None = None,
        url: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        return await finish_in_thread(artifact, file_path, action, title, description, url)

    return StructuredTool.from_function(
        artifact, coroutine=aartifact, name='Artifact', response_format='content_and_artifact',
    )


def _publish(
    root: Path, excluded: tuple[str, ...], file_path: str, title: str | None, description: str | None,
) -> tuple[str, dict[str, Any]]:
    on_disk = Path(file_path)
    source = on_disk if on_disk.is_relative_to(root) else root / file_path.lstrip('/')
    if not source.is_file():
        raise FileNotFoundError(f'No file at {file_path}. Write the page there, then publish it.')
    if source.suffix.lower() not in ('.html', '.htm'):
        raise ValueError(f'An Artifact is an .html file for now: {source.name}')
    resolved = source.resolve()
    name = resolved.relative_to(root).as_posix() if resolved.is_relative_to(root) else None
    if name is None or not is_files_path(name, excluded):
        raise ValueError(f'Save the page in Files to publish it: /{name or resolved}')
    versions = root / ARTIFACTS_DIRECTORY / f'{name}.versions'
    version = 1 + max((int(path.stem) for path in versions.glob('*.html') if path.stem.isdigit()), default=0)
    versions.mkdir(parents=True, exist_ok=True)
    stored = versions / f'{version}.html'
    shutil.copyfile(resolved, stored)
    page = resolved.read_text(encoding='utf-8', errors='replace')
    found = _TITLE.search(page)
    published = {
        'id': f'/{name}',
        'type': None,
        'title': title or (found.group(1).strip() if found else resolved.name),
        'description': description or '',
        'version': version,
        'path': f'/{stored.relative_to(root).as_posix()}',
    }
    return json.dumps(published), published
