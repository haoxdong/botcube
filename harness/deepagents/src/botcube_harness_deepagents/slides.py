"""Slides, the Artifact Type whose Source is a deck: `project/deck.json` and one `project/slides/<id>.html` per slide.

A publish copies the deck's own files, and only those, into a staging folder in the version store, runs the checker
(the `artifact-check` Node package beside this harness) over that copy, and renames it into place as the next version
only when it passes; each error names the file, the element and the nearest allowed form. What is saved is exactly
what was checked, and a refused or failed publish leaves no version behind.
A version is at `/artifacts/<deck folder>.versions/<n>/project/`; the `artifact` tool records its author beside it.
"""

from __future__ import annotations

import errno
import json
import os
import shutil
import stat
import subprocess
import uuid
from pathlib import Path

# In the image the Dockerfile sets BOTCUBE_ARTIFACT_CHECK; from a checkout the package sits beside the harness source.
CHECKER = Path(os.environ.get('BOTCUBE_ARTIFACT_CHECK') or Path(__file__).resolve().parents[2] / 'artifact-check/src/cli.mjs')
INDEX = 'project/deck.json'
# The checker CLI's exit code for a deck with errors; any code but this and 0 is the checker itself failing.
FOUND_ERRORS = 3


def deck_folder(source: Path) -> Path | None:
    """The deck a publish names: its folder, or its `project/deck.json`. None when `source` names no deck."""
    if source.name == 'deck.json' and source.parent.name == 'project':
        return source.parent.parent
    if source.is_dir() and (source / INDEX).is_file():
        return source
    return None


def check(folder: Path) -> list[str]:
    """Every error in the deck at `folder`, as the agent reads it; an empty list when it may be published."""
    run = subprocess.run(
        ['node', str(CHECKER), 'slides', str(folder)], capture_output=True, text=True, timeout=60, check=False,
    )
    if run.returncode not in (0, FOUND_ERRORS):
        raise RuntimeError(f'The slide checker failed (exit {run.returncode}): {run.stderr.strip()}')
    return [error['text'] for error in json.loads(run.stdout)['errors']]


def publish_deck(versions: Path, folder: Path) -> tuple[int, str | None]:
    """Checks the deck at `folder` and saves it in `versions` as its next version: the number and the deck's title."""
    versions.mkdir(parents=True, exist_ok=True)
    staging = versions / f'.staging-{uuid.uuid4().hex}'
    try:
        _stage(folder / 'project', staging / 'project')
        if errors := check(staging):
            raise ValueError(
                'The deck breaks the slide format, so nothing was published. Fix every error, then publish again:\n'
                + '\n'.join(f'- {error}' for error in errors),
            )
        deck = json.loads((staging / INDEX).read_text(encoding='utf-8'))
        version = _store(staging, versions)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return version, deck.get('title')


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


def _store(staging: Path, versions: Path) -> int:
    """Renames the checked `staging` folder into place as the next version, skipping a number another publish took."""
    version = 1 + max((int(path.name) for path in versions.iterdir() if path.name.isdigit()), default=0)
    while True:
        stored = versions / str(version)
        try:
            # A rename onto a published version, which is never an empty folder, fails instead of replacing it.
            os.rename(staging, stored)
        except OSError as taken:
            if taken.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            version += 1
        else:
            return version
