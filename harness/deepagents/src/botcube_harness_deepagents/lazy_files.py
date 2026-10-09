from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable, Iterator
from concurrent.futures import Future
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import Lock
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from .files_sync import FilesSync

_WORKSPACE_TOOLS = frozenset({'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute'})


class TurnFiles:
    def __init__(self, files: FilesSync | None, root: Path, excluded: Iterable[str]) -> None:
        self._files = files
        self._root = root
        self._excluded = tuple(excluded)
        self._claim = Lock()
        self._pull: Future[None] | None = None

    @property
    def ready(self) -> bool:
        with self._claim:
            pull = self._pull
        return pull is not None and pull.done() and pull.exception() is None

    def raise_if_failed(self) -> None:
        with self._claim:
            pull = self._pull
        if pull is not None and pull.done():
            pull.result()

    def ensure(self) -> None:
        if self._files is None:
            return
        with self._claim:
            owner = self._pull is None
            if self._pull is None:
                self._pull = Future()
            pull = self._pull
        if owner:
            try:
                self._files.pull(self._root, self._excluded)
            except BaseException as error:
                pull.set_exception(error)
                raise
            else:
                pull.set_result(None)
        pull.result()

    async def aensure(self) -> None:
        if self._files is None:
            return
        work = asyncio.create_task(asyncio.to_thread(self.ensure))
        try:
            await asyncio.shield(work)
        except asyncio.CancelledError:
            # A cancelled graph must finish its filesystem mutation before the next Turn.
            await work
            raise


_turn_files: ContextVar[TurnFiles | None] = ContextVar('turn_files', default=None)


@contextmanager
def turn_files(files: FilesSync | None, root: Path, excluded: Iterable[str]) -> Iterator[TurnFiles]:
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
