"""Quiet stream and producer cleanup regressions."""
import asyncio
from collections.abc import AsyncIterator

import pytest

from botcube_harness_deepagents import sse


def test_quiet_keepalive_retains_the_frame_order_and_producer_context() -> None:
    async def exercise() -> None:
        readers: set[asyncio.Task[object] | None] = set()
        answer = asyncio.Event()

        async def frames() -> AsyncIterator[str]:
            readers.add(asyncio.current_task())
            yield 'first'
            await answer.wait()
            readers.add(asyncio.current_task())
            yield 'last'

        received = []
        async with asyncio.timeout(1):
            async for frame in sse.keep_alive(frames(), 0.005):
                received.append(frame)
                if received.count(sse._KEEPALIVE) == 2:
                    answer.set()
        assert [frame for frame in received if frame != sse._KEEPALIVE] == ['first', 'last']
        assert received.count(sse._KEEPALIVE) >= 2
        assert len(readers) == 1

    asyncio.run(exercise())


def test_keepalive_propagates_the_producers_timeout_instead_of_treating_it_as_quiet() -> None:
    failure = TimeoutError('The upstream stream failed')

    async def exercise() -> None:
        fail = asyncio.Event()

        async def frames() -> AsyncIterator[str]:
            yield 'first'
            await fail.wait()
            raise failure

        stream = sse.keep_alive(frames(), 0.005)
        assert await anext(stream) == 'first'
        with pytest.raises(TimeoutError) as caught:
            async with asyncio.timeout(1):
                async for frame in stream:
                    if frame == sse._KEEPALIVE:
                        fail.set()
        assert caught.value is failure

    asyncio.run(exercise())


@pytest.mark.parametrize('fails', [False, True])
def test_keepalive_awaits_producer_cleanup_and_propagates_its_failure(fails: bool) -> None:
    failure = RuntimeError('The upstream stream cleanup failed')

    async def exercise() -> None:
        closed = asyncio.Event()

        async def frames() -> AsyncIterator[str]:
            try:
                yield 'first'
                await asyncio.Event().wait()
            finally:
                closed.set()
                if fails:
                    raise failure

        stream = sse.keep_alive(frames(), 0.005)
        assert await anext(stream) == 'first'
        if fails:
            with pytest.raises(RuntimeError) as caught:
                await stream.aclose()
            assert caught.value is failure
        else:
            await stream.aclose()
        assert closed.is_set()

    asyncio.run(exercise())
