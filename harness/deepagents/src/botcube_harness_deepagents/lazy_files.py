from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Generator, Iterable
from concurrent.futures import Future
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from pathlib import Path
from threading import Lock, Thread
from typing import Any, TypeVar, get_args

from deepagents.middleware.filesystem import FsToolName
from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from . import turn_timing
from .files_mount import FilesMount, FilesMountError
from .files_sync import Files, install_staged_files

_WORKSPACE_TOOLS = frozenset(get_args(FsToolName))
_T = TypeVar('_T')
EFS_READY_TIMEOUT = 35.0


class TurnFiles:
    def __init__(self, files: Files | None, root: Path, excluded: Iterable[str]) -> None:
        self._files = files
        self._root = root
        self._excluded = tuple(excluded)
        self._claim = Lock()
        self._pull: Future[None] | None = None
        self._prefetch: asyncio.Task[None] | None = None
        self.used = False
        self._failure: FilesMountError | None = None

    def prefetch(self) -> None:
        if self._files is not None and self._prefetch is None:
            self._prefetch = asyncio.create_task(asyncio.to_thread(self._ensure))
            if isinstance(self._files, FilesMount):
                self._prefetch.add_done_callback(observe_efs_prefetch)

    async def settle_prefetch(self) -> None:
        if isinstance(self._files, FilesMount):
            if self.used:
                await self.aensure()
            return
        if self._prefetch is not None:
            settled = asyncio.gather(self._prefetch, return_exceptions=True)
            try:
                await asyncio.shield(settled)
            except asyncio.CancelledError:
                await settled
                raise
            self.raise_if_failed()

    @property
    def ready(self) -> bool:
        with self._claim:
            pull = self._pull
        return pull is not None and pull.done() and pull.exception() is None

    def raise_if_failed(self) -> None:
        if self.used and self._failure is not None:
            raise self._failure
        with self._claim:
            pull = self._pull
        if self.used and pull is not None and pull.done():
            pull.result()

    def publish(self) -> None:
        self.ensure()
        with self._claim:
            if self._files is not None:
                self._files.push(self._root, self._excluded)

    def publish_staged(self, root: Path) -> None:
        if isinstance(self._files, FilesMount):
            self.ensure()
        if self._files is not None:
            self._files.push(root, self._excluded)
        install_staged_files(root, self._root, self._excluded)

    def ensure(self) -> None:
        self.used = True
        self.raise_if_failed()
        self._ensure()

    def _ensure(self) -> None:
        if self._files is None:
            return
        with self._claim:
            owner = self._pull is None
            if self._pull is None:
                self._pull = Future()
            pull = self._pull
        if owner:
            if isinstance(self._files, FilesMount):
                Thread(target=copy_context().run, args=(self._pull_files, pull), daemon=True).start()
            else:
                self._pull_files(pull)
        try:
            pull.result(timeout=EFS_READY_TIMEOUT if isinstance(self._files, FilesMount) else None)
        except TimeoutError as error:
            if not isinstance(self._files, FilesMount):
                raise
            self._failure = FilesMountError('Files mount readiness deadline exceeded')
            raise self._failure from error

    def _pull_files(self, pull: Future[None]) -> None:
        try:
            with turn_timing.phase('files_pull'):
                if self._files is not None:
                    self._files.pull(self._root, self._excluded)
        except BaseException as error:
            pull.set_exception(error)
        else:
            pull.set_result(None)

    async def arefresh(self) -> None:
        await self.settle_prefetch()
        self._prefetch = None
        with self._claim:
            self._pull = None
        await self.aensure()

    async def aensure(self) -> None:
        if self._files is not None:
            await finish_in_thread(self.ensure)


def observe_efs_prefetch(work: asyncio.Task[None]) -> None:
    if not work.cancelled() and (error := work.exception()) is not None:
        logging.getLogger(__name__).warning('Files prefetch unavailable: %s', error)


async def finish_in_thread(func: Callable[..., _T], *args: Any, **kwargs: Any) -> _T:
    work = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        # A cancelled graph must finish its filesystem mutation before the next Turn.
        await work
        raise


_turn_files: ContextVar[TurnFiles | None] = ContextVar('turn_files', default=None)


def current_turn_files() -> TurnFiles | None:
    return _turn_files.get()


@contextmanager
def turn_files(files: Files | None, root: Path, excluded: Iterable[str]) -> Generator[TurnFiles, None, None]:
    readiness = TurnFiles(files, root, excluded)
    token = _turn_files.set(readiness)
    try:
        yield readiness
    finally:
        _turn_files.reset(token)


class LazyFilesMiddleware(AgentMiddleware):
    def wrap_tool_call(
        self, request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        if request.tool_call['name'] in _WORKSPACE_TOOLS and (readiness := _turn_files.get()) is not None:
            readiness.ensure()
        return handler(request)

    async def awrap_tool_call(
        self, request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        if request.tool_call['name'] in _WORKSPACE_TOOLS and (readiness := _turn_files.get()) is not None:
            await readiness.aensure()
        return await handler(request)
