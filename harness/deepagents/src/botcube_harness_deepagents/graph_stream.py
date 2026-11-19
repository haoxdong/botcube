from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Callable
from contextlib import aclosing
from typing import Any

from ag_ui.core import EventType, StateDeltaEvent
from langchain_core.messages import AIMessage
from langchain_core.runnables.schema import StreamEvent

from . import message_times


def _clock_delta(clock: message_times.TurnClock) -> StateDeltaEvent:
    return StateDeltaEvent(delta=[{'op': 'add', 'path': '/worklog_clock', 'value': clock.snapshot(message_times.now())}])


def _identify(event: Any, clock: message_times.TurnClock, lane: str | None) -> None:
    timing_id = None
    if event.type in {EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_END}:
        timing_id = lane
    elif event.type in {EventType.TOOL_CALL_START, EventType.TOOL_CALL_RESULT}:
        timing_id = clock.tool_id(event.tool_call_id)
    elif event.type in {EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_END}:
        timing_id = event.message_id
    if timing_id in clock.steps:
        event.metadata = {**(event.metadata or {}), 'timing_id': timing_id}
        if event.type == EventType.TOOL_CALL_START:
            event.metadata['worklog_started_at'] = clock.steps[timing_id]['started_at']


def _published(event: Any, clock: message_times.TurnClock) -> None:
    timing_id = (event.metadata or {}).get('timing_id')
    if timing_id is None:
        return
    if event.type in {EventType.TEXT_MESSAGE_START, EventType.REASONING_MESSAGE_START, EventType.TOOL_CALL_START}:
        clock.public_start(timing_id)
    elif event.type in {EventType.REASONING_MESSAGE_END, EventType.TOOL_CALL_RESULT, EventType.TEXT_MESSAGE_END}:
        clock.public_end(timing_id, closes_text=event.type == EventType.TEXT_MESSAGE_END)



async def _produce_events(source: AsyncGenerator[Any, None], lane: Callable[[], str | None], clock: message_times.TurnClock, queue: asyncio.Queue[Any]) -> None:
    with message_times.record_turn(clock):
        async with aclosing(source):
            async for event in source:
                _identify(event, clock, lane())
                await queue.put(event)
                if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
                    return


async def _paced_events(source: AsyncGenerator[Any, None], lane: Callable[[], str | None], clock: message_times.TurnClock) -> AsyncGenerator[Any, None]:
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=1)

    producer = asyncio.create_task(_produce_events(source, lane, clock, queue))
    pending = asyncio.create_task(queue.get())
    terminal = False
    try:
        while True:
            ready, _ = await asyncio.wait({producer, pending}, timeout=1, return_when=asyncio.FIRST_COMPLETED)
            if pending in ready:
                event = pending.result()
                terminal = event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}
                yield event
                if terminal:
                    await producer
                    return
                pending = asyncio.create_task(queue.get())
            elif producer in ready:
                producer.result()
                if queue.empty():
                    return
            else:
                yield None
    finally:
        pending.cancel()
        if terminal:
            await producer
        else:
            producer.cancel()
        await asyncio.gather(pending, producer, return_exceptions=True)


def clock_events(source: AsyncGenerator[Any, None], lane: Callable[[], str | None], *, canonical: bool = False) -> AsyncGenerator[Any, None]:
    return _clock_events(source, lane) if canonical else source


async def _clock_events(source: AsyncGenerator[Any, None], lane: Callable[[], str | None]) -> AsyncGenerator[Any, None]:
    clock = message_times.TurnClock()
    published_revision = -1
    published_at = 0
    try:
        async with aclosing(_paced_events(source, lane, clock)) as events:
            async for event in events:
                for framed in _clock_boundary(event, clock):
                    yield framed
                if event is None:
                    published_at = message_times.now()
                    continue
                _published(event, clock)
                if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
                    return
                changed = clock.revision != published_revision or event.type == EventType.MESSAGES_SNAPSHOT
                if clock.question_id is not None and (changed or message_times.now() - published_at >= 1000):
                    published_revision = clock.revision
                    published_at = message_times.now()
                    yield _clock_delta(clock)
    except Exception:
        if clock.question_id is not None:
            clock.stop(message_times.now())
            yield _clock_delta(clock)
        raise


def _clock_boundary(event: Any, clock: message_times.TurnClock) -> list[Any]:
    if event is None:
        return [_clock_delta(clock)] if clock.question_id is not None else []
    if clock.question_id is None:
        return [event]
    if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
        clock.stop(message_times.now())
        return [_clock_delta(clock), event]
    if event.type == EventType.RUN_STARTED:
        event.metadata = {**(event.metadata or {}), 'worklog_clock': clock.snapshot(message_times.now())}
    return [event]


def answering_model_step(event: StreamEvent) -> bool:
    if event.get('parent_ids') != [] or event['event'] != 'on_chain_stream':
        return False
    chunk = event.get('data', {}).get('chunk')
    if isinstance(chunk, tuple):
        if chunk[0] != ():
            return False
        chunk = chunk[-1]
    if not isinstance(chunk, dict) or not isinstance(chunk.get('model'), dict):
        return False
    messages = chunk['model'].get('messages', [])
    return bool(messages and isinstance(messages[-1], AIMessage) and not messages[-1].tool_calls)


async def drain_after_answer(source: AsyncGenerator[StreamEvent, None], *, early: bool) -> AsyncGenerator[StreamEvent, None]:
    terminal = False
    held: StreamEvent | None = None
    async with aclosing(source):
        try:
            async for event in source:
                terminal |= event.get('parent_ids') == [] and event['event'] == 'on_chain_end'
                terminal |= early and answering_model_step(event)
                if event.get('parent_ids') == [] and event['event'] == 'on_chain_end' and not early:
                    held = event
                    continue
                yield event
        finally:
            if terminal:
                async for _ in source:
                    pass
    if held is not None:
        yield held
