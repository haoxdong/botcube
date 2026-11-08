from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Generator, Iterable
from concurrent.futures import Future
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import Lock
from typing import Any, TypeVar, get_args

from deepagents.middleware.filesystem import FsToolName
from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from . import turn_timing
from .files_mount import FilesMount
from .files_sync import Files, install_staged_files

_WORKSPACE_TOOLS = frozenset(get_args(FsToolName))
_T = TypeVar('_T')


class TurnFiles:
    def __init__(self, files: Files | None, root: Path, excluded: Iterable[str]) -> None:
        self._files = files
        self._root = root
        self._excluded = tuple(excluded)
        self._claim = Lock()
        self._pull: Future[None] | None = None
        self._prefetch: asyncio.Task[None] | None = None
        self.used = False

    def prefetch(self) -> None:
        if self._files is not None and self._prefetch is None:
            self._prefetch = asyncio.create_task(asyncio.to_thread(self._ensure))

    async def settle_prefetch(self) -> None:
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
            try:
                with turn_timing.phase('files_pull'):
                    self._files.pull(self._root, self._excluded)
            except BaseException as error:
                pull.set_exception(error)
                raise
            else:
                pull.set_result(None)
        pull.result()

    async def arefresh(self) -> None:
        await self.settle_prefetch()
        self._prefetch = None
        with self._claim:
            self._pull = None
        await self.aensure()

    async def aensure(self) -> None:
        if self._files is not None:
            await finish_in_thread(self.ensure)


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
