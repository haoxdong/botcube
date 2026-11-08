from __future__ import annotations

import asyncio
import logging
import shutil
from collections.abc import Iterable
from pathlib import Path
from time import perf_counter
from urllib.parse import quote

from ag_ui.core import EventType, RunFinishedEvent
from langchain_core.tools import BaseTool, StructuredTool

from .files_sync import Files, excluded_paths, import_linked_files, is_files_path
from .lazy_files import current_turn_files, finish_in_thread


def publish_tool(root: Path, skills: Iterable[str] = ()) -> BaseTool:
    root = root.resolve()
    excluded = excluded_paths(skills)

    def publish(path: str) -> tuple[str, dict[str, str]]:
        """Publish a file you made to the user's Files and return its link.

        Publish every chart, document or file your final answer shows or links, wherever you saved it,
        and use the returned link.
        """
        if (readiness := current_turn_files()) is not None:
            readiness.ensure()
        published = _publish_file(root, excluded, path)
        if readiness is not None:
            readiness.publish()
        return quote(published, safe='/'), {'path': published}

    async def apublish(path: str) -> tuple[str, dict[str, str]]:
        return await finish_in_thread(publish, path)

    return StructuredTool.from_function(publish, coroutine=apublish, response_format='content_and_artifact')


def _publish_file(root: Path, excluded: tuple[str, ...], path: str) -> str:
    source = Path(path)
    if not source.is_absolute() or not source.exists():
        source = root / path.lstrip('/')
    if source.is_dir():
        raise IsADirectoryError(path)
    if not source.is_file():
        raise FileNotFoundError(path)
    if source.is_symlink():
        raise ValueError(f'Cannot publish a symlink: {path}')
    resolved = source.resolve()
    if resolved.is_relative_to(root) and is_files_path(resolved.relative_to(root).as_posix(), excluded):
        name = resolved.relative_to(root).as_posix()
    else:
        destination = root / 'artifacts' / source.name
        if not is_files_path(destination.relative_to(root).as_posix(), excluded):
            raise ValueError(f'The published path cannot be saved in Files: {destination.name}')
        if destination.is_dir():
            raise IsADirectoryError(str(destination))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))
        name = destination.relative_to(root).as_posix()
    return f'/{name}'


async def publish_finished_files(
    files: Files | None, root: Path, ready: bool, completion: RunFinishedEvent | None, answer: str, skills: Iterable[str],
) -> None:
    if files is None or not ready or completion is None or completion.type != EventType.RUN_FINISHED:
        return
    started = perf_counter()
    excluded = excluded_paths(skills)
    await asyncio.to_thread(import_linked_files, root, answer, excluded)
    await asyncio.to_thread(files.push, root, excluded)
    logging.getLogger(__name__).info('Harness Files publication timing run_id=%s push_ms=%.3f',
                                   completion.run_id, (perf_counter() - started) * 1000)
