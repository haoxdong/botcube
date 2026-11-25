from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from contextlib import aclosing

from anyio import CancelScope, create_memory_object_stream, move_on_after

_KEEPALIVE = ': keepalive\n\n'


async def keep_alive(frames: AsyncGenerator[str, None], interval: float) -> AsyncGenerator[str, None]:
    outgoing, incoming = create_memory_object_stream[str](1)

    async def read() -> None:
        with outgoing:
            async with aclosing(frames):
                async for frame in frames:
                    await outgoing.send(frame)

    reading = asyncio.create_task(read())
    try:
        with incoming:
            while True:
                frame = _KEEPALIVE
                with move_on_after(interval):
                    frame = await anext(incoming, None)
                if frame is None:
                    break
                yield frame
    finally:
        cancelled_here = reading.cancel()
        with CancelScope(shield=True):
            [result] = await asyncio.gather(reading, return_exceptions=True)
        if isinstance(result, BaseException) and not (cancelled_here and isinstance(result, asyncio.CancelledError)):
            raise result
