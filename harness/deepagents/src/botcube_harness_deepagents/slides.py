"""Slides, the Artifact Type whose Source is a deck: `project/deck.json` and one `project/slides/<id>.html` per slide.

Its entry in `artifact_types`: `store` copies the deck's own files, and only those, into the version being built in
the version store; `refuse` runs the checker (the `artifact-check` Node package beside this harness) over that copy,
which the `artifact` tool renames into place as the next version only when it passes. Each error names the file, the
element and the nearest allowed form. What is saved is exactly what was checked, and a refused or failed publish
leaves no version behind. A version is at `/artifacts/<deck folder>.versions/<n>/project/`.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from . import artifact_check

INDEX = 'project/deck.json'


def deck_folder(source: Path) -> Path | None:
    """The deck a publish names: its folder, or its `project/deck.json`. None when `source` names no deck."""
    if source.name == 'deck.json' and source.parent.name == 'project':
        return source.parent.parent
    if source.is_dir() and (source / INDEX).is_file():
        return source
    return None


def refuse(folder: Path, _name: str) -> None:
    """Refuses the deck at `folder` when it breaks the slide format, naming every error as the agent reads it."""
    if errors := artifact_check.errors('slides', folder):
        raise ValueError(
            'The deck breaks the slide format, so nothing was published. Fix every error, then publish again:\n'
            + '\n'.join(f'- {error}' for error in errors),
        )


def store(folder: Path, version: Path) -> None:
    """Copies the deck at `folder` to `version`, which does not exist yet: its `deck.json` and slides, nothing else."""
    _stage(folder / 'project', version / 'project')


def title(folder: Path) -> str | None:
    return json.loads((folder / INDEX).read_text(encoding='utf-8')).get('title')


def read(version: Path) -> dict[str, Any]:
    """A deck version's `files`, by their path in the deck folder (`project/slides/cover.html`)."""
    return {'files': {
        path.relative_to(version).as_posix(): path.read_text(encoding='utf-8', errors='replace')
        for path in sorted(version.glob('project/**/*')) if path.is_file()
    }}


def _stage(project: Path, staged: Path) -> None:
    """Copies the deck's `deck.json` and `slides/*.html`, its only files, to `staged`; nothing else is saved.

    A symbolic link anywhere in the deck is refused by name. The copy reads through descriptors opened without
    following links, so a link swapped in after the walk fails the publish instead of being read.
    """
    links = [project] if project.is_symlink() else []
    for at, folders, files in os.walk(project):
        links += [Path(at, entry) for entry in (*folders, *files) if Path(at, entry).is_symlink()]
    if links:
        raise ValueError(
            'The deck holds a symbolic link, so nothing was published. Write the file itself in the deck folder: '
            + ', '.join(link.relative_to(project.parent).as_posix() for link in links),
        )
    (staged / 'slides').mkdir(parents=True)
    no_link = os.O_RDONLY | os.O_NOFOLLOW
    project_fd = os.open(project, no_link | os.O_DIRECTORY)
    try:
        # A missing deck.json or slides folder is left for the checker to name; one that vanishes mid-copy raises.
        present = os.listdir(project_fd)
        if 'deck.json' in present:
            _copy(project_fd, 'deck.json', staged / 'deck.json', INDEX)
        if 'slides' not in present:
            return
        slides_fd = os.open('slides', no_link | os.O_DIRECTORY, dir_fd=project_fd)
        try:
            for entry in os.listdir(slides_fd):
                if entry.endswith('.html'):
                    _copy(slides_fd, entry, staged / 'slides' / entry, f'project/slides/{entry}')
        finally:
            os.close(slides_fd)
    finally:
        os.close(project_fd)


def _copy(folder_fd: int, entry: str, to: Path, shown: str) -> None:
    """Copies the regular file `entry` of the folder open at `folder_fd`."""
    fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder_fd)
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(
                f'{shown} is not a regular file, so nothing was published. Write the file itself in the deck folder.',
            )
        to.write_bytes(source.read())
