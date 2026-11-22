"""Admitted checkpoint I/O outlives graph cancellation and settles under the Session lock."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any


class CheckpointWrites:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._pending: set[asyncio.Task[Any]] = set()

    async def persist(self, operation: Coroutine[Any, Any, Any]) -> Any:
        async def write() -> Any:
            async with self._lock:
                return await operation

        task = asyncio.create_task(write())
        self._pending.add(task)
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and not task.cancelled() and task.exception() is None:
                self._pending.discard(task)

    async def settle(self) -> None:
        pending = self._pending.copy()
        if pending:
            results = await asyncio.gather(*pending, return_exceptions=True)
            self._pending.difference_update(pending)
            for result in results:
                if isinstance(result, BaseException):
                    raise result
