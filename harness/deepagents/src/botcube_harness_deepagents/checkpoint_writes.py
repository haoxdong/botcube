"""Admitted checkpoint I/O outlives graph cancellation and settles before invocation EOF."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

_T = TypeVar('_T')


class CheckpointWrites:
    def __init__(self) -> None:
        self._tail: asyncio.Task[Any] | None = None

    def enqueue(
        self, operation: Callable[[], Awaitable[_T]], predecessor: asyncio.Task[None] | None,
    ) -> asyncio.Task[_T]:
        previous = self._tail or predecessor

        async def write() -> _T:
            if previous is not None:
                await asyncio.shield(previous)
            return await operation()

        self._tail = task = asyncio.create_task(write())
        return task

    async def settle(self) -> None:
        if (tail := self._tail) is not None:
            try:
                await asyncio.shield(tail)
            finally:
                if tail is self._tail and tail.done():
                    self._tail = None
