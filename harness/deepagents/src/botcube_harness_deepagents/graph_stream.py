from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import aclosing

from langchain_core.runnables.schema import StreamEvent


async def complete_before_root_end(source: AsyncGenerator[StreamEvent, None]) -> AsyncGenerator[StreamEvent, None]:
    terminal: StreamEvent | None = None
    async with aclosing(source):
        async for event in source:
            if event.get('parent_ids') == [] and event['event'] == 'on_chain_end':
                terminal = event
            else:
                yield event
    if terminal is not None:
        yield terminal
