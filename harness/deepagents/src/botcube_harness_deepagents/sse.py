from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator

_KEEPALIVE = ': keepalive\n\n'


async def keep_alive(frames: AsyncIterator[str], interval: float) -> AsyncGenerator[str, None]:
    """Yield frames and quiet-interval SSE comments from a single producer context."""
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def read() -> None:
        try:
            async for frame in frames:
                queue.put_nowait(frame)
        finally:
            queue.put_nowait(None)

    reading = asyncio.create_task(read())
    waiting = asyncio.create_task(queue.get())
    try:
        while True:
            done, _pending = await asyncio.wait({waiting}, timeout=interval)
            if not done:
                yield _KEEPALIVE
                continue
            frame = waiting.result()
            if frame is None:
                break
            yield frame
            waiting = asyncio.create_task(queue.get())
        await reading
    finally:
        await _cancel_keepalive_tasks(reading, waiting)


async def _cancel_keepalive_tasks(*tasks: asyncio.Task[object]) -> None:
    cancelled = [task.cancel() for task in tasks]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for result, requested in zip(results, cancelled, strict=True):
        if isinstance(result, BaseException) and not (requested and isinstance(result, asyncio.CancelledError)):
            raise result
