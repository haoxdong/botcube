from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from functools import partial
from time import perf_counter, time
from typing import Any

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import SystemMessage

from . import turn_timing

MEMORY_LIMIT = 50
PROMPT_CACHE_TTL_SECONDS = 300
PREFERENCE_SECTION = 'user preferences:'
FACT_SECTION = 'semantic facts:'
SPILLOVER_NOTE = 'More memories are available. Use memory retrieve to search beyond the startup memory block.'
log = logging.getLogger(__name__)


@dataclass
class _Prefetch:
    """The Turn's Memory block, read while the Turn reads its history; `taken` once the Turn uses it."""

    run_id: str
    read: asyncio.Task[str]
    taken: bool = False


_prefetched: ContextVar[_Prefetch | None] = ContextVar('session_memory_prefetched', default=None)


@dataclass(frozen=True)
class OpeningRead:
    block: str
    completed_at: float


@dataclass
class _Warmup:
    actor_id: str
    result: OpeningRead | None = None


WARMUP_LIMIT = 16
_warmups: dict[tuple[str, str], _Warmup] = {}


def begin_warmup(session: tuple[str, str], actor_id: str) -> _Warmup:
    """Register before preparation awaits, so an arriving Turn can invalidate its pending read."""
    now = perf_counter()
    for key, read in list(_warmups.items()):
        if read.result is not None and now - read.result.completed_at > PROMPT_CACHE_TTL_SECONDS:
            del _warmups[key]
    _warmups.pop(session, None)
    while len(_warmups) >= WARMUP_LIMIT:
        del _warmups[next(iter(_warmups))]
    read = _Warmup(actor_id)
    _warmups[session] = read
    return read


async def read_warmup(load: Callable[[], str]) -> OpeningRead:
    def read() -> OpeningRead:
        return OpeningRead(load(), perf_counter())

    return await asyncio.to_thread(read)


def finish_warmup(session: tuple[str, str], read: _Warmup, result: OpeningRead | None) -> None:
    """Publish successful preparation only while its Session still awaits its first Turn."""
    if _warmups.get(session) is read:
        if result is None:
            del _warmups[session]
        else:
            read.result = result


def take_warmup(session: tuple[str, str], actor_id: str, started_at: float) -> str | None:
    read = _warmups.pop(session, None)
    if (
        read is not None
        and read.actor_id == actor_id
        and read.result is not None
        and 0 <= started_at - read.result.completed_at <= PROMPT_CACHE_TTL_SECONDS
    ):
        return read.result.block
    return None


def render_memory(preferences: Sequence[str], facts: Sequence[str]) -> str:
    """The block for up to 50 preferences and 50 facts, as given (newest first); empty when there are none."""
    sections = [
        label + '\n' + '\n'.join(f'- {text}' for text in texts[:MEMORY_LIMIT])
        for label, texts in ((PREFERENCE_SECTION, preferences), (FACT_SECTION, facts))
        if texts
    ]
    if len(preferences) > MEMORY_LIMIT or len(facts) > MEMORY_LIMIT:
        sections.append(SPILLOVER_NOTE)
    return '\n\n'.join(sections)


def prefetch(load: Callable[[], str], run_id: str, warmed: str | None = None) -> None:
    """Supply the Turn's Memory block from its completed warmup or a read alongside history."""
    async def read() -> str:
        return warmed if warmed is not None else await asyncio.to_thread(load)

    _prefetched.set(_Prefetch(run_id, asyncio.create_task(read())))


def settle_prefetch() -> None:
    """At the Turn's end, log the failure of a read it never took, as a hedge that lost (ADR 0030); one it took failed the Turn."""
    prefetched = _prefetched.get()
    if prefetched is not None and not prefetched.taken:
        prefetched.read.add_done_callback(partial(_log_unused_failure, prefetched.run_id))


def _log_unused_failure(run_id: str, read: asyncio.Task[str]) -> None:
    if not read.cancelled() and (error := read.exception()) is not None:
        log.warning(json.dumps(
            {'event': 'harness_unused_memory_read_failed', 'runId': run_id, 'errorClass': type(error).__name__},
            separators=(',', ':'),
        ))


class SessionMemoryMiddleware(AgentMiddleware):
    def __init__(self, load: Callable[[Any], str]) -> None:
        super().__init__()
        self._load = load

    async def abefore_agent(self, state: Any, runtime: Any) -> dict[str, str] | None:
        last_model_call_at = state.get('last_model_call_at')
        prefetched = _prefetched.get()
        if (
            state.get('session_memory')
            and last_model_call_at is not None
            and time() - last_model_call_at <= PROMPT_CACHE_TTL_SECONDS
        ):
            return None
        with turn_timing.phase('personal_memory'):
            if prefetched is not None:
                prefetched.taken = True
                return {'session_memory': await prefetched.read}
            return {'session_memory': await asyncio.to_thread(self._load, runtime.store)}

    async def aafter_model(self, state: Any, runtime: Any) -> dict[str, float]:
        return {'last_model_call_at': time()}

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        block = request.state.get('session_memory')
        if block:
            blocks = list(request.system_message.content_blocks) if request.system_message else []
            text = f'<agent_memory>\n{block}\n</agent_memory>'
            blocks.append({'type': 'text', 'text': f'\n\n{text}' if blocks else text})
            request = request.override(system_message=SystemMessage(content_blocks=blocks))
        return await handler(request)
