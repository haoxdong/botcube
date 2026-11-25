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
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import SystemMessage
from langgraph.types import Command

from . import turn_timing
from .memory_index import MemoryIndexEntry, memory_index_line

MEMORY_LIMIT = 100
PROMPT_CACHE_TTL_SECONDS = 300
PREFERENCE_SECTION = 'user preferences:'
FACT_SECTION = 'semantic facts:'
log = logging.getLogger(__name__)


@dataclass
class Prefetch:
    """Memory read alongside the Transcript. `taken` marks use by the Turn."""

    run_id: str
    read: asyncio.Task[str]
    taken: bool = False


_prefetched: ContextVar[Prefetch | None] = ContextVar('session_memory_prefetched', default=None)


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
    return await asyncio.to_thread(lambda: OpeningRead(load(), perf_counter()))


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


def render_memory(preferences: Sequence[MemoryIndexEntry], facts: Sequence[MemoryIndexEntry]) -> str:
    sections = [
        label + '\n' + '\n'.join(memory_index_line(entry) for entry in entries[:MEMORY_LIMIT])
        for label, entries in ((PREFERENCE_SECTION, preferences), (FACT_SECTION, facts))
        if entries
    ]
    remaining = [f'{len(entries) - MEMORY_LIMIT} more {kind}'
                 for kind, entries in (('preferences', preferences), ('facts', facts)) if len(entries) > MEMORY_LIMIT]
    if remaining:
        sections.append('(' + '; '.join(remaining) + '; use memory list or retrieve)')
    return '\n\n'.join(sections)


def prefetch(load: Callable[[], str], run_id: str, warmed: str | None = None) -> Prefetch:
    """Supply the Turn's Memory block from its completed warmup or a read alongside the transcript."""
    async def read() -> str:
        with turn_timing.phase('personal_memory'):
            return warmed if warmed is not None else await asyncio.to_thread(load)

    prefetched = Prefetch(run_id, asyncio.create_task(read()))
    adopt_prefetch(prefetched)
    return prefetched


def adopt_prefetch(prefetched: Prefetch | None) -> None:
    _prefetched.set(prefetched)


async def settle_prefetch(prefetched: Prefetch | None = None, *, wait: bool = False) -> None:
    """At the Turn's end, log the failure of a read it never took, as a hedge that lost (ADR 0030); one it took failed the Turn."""
    prefetched = prefetched or _prefetched.get()
    if prefetched is not None and wait:
        await asyncio.gather(prefetched.read, return_exceptions=True)
    if prefetched is not None and not prefetched.taken:
        prefetched.read.add_done_callback(partial(_log_unused_failure, prefetched.run_id))
    if _prefetched.get() is prefetched:
        _prefetched.set(None)


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
        if prefetched is not None:
            prefetched.taken = True
            return {'session_memory': await asyncio.shield(prefetched.read)}
        with turn_timing.phase('personal_memory'):
            return {'session_memory': await asyncio.to_thread(self._load, runtime.store)}

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ExtendedModelResponse:
        block = request.state.get('session_memory')
        if block:
            blocks = list(request.system_message.content_blocks) if request.system_message else []
            text = f'<agent_memory>\n{block}\n</agent_memory>'
            blocks.append({'type': 'text', 'text': f'\n\n{text}' if blocks else text})
            request = request.override(system_message=SystemMessage(content_blocks=blocks))
        response = await handler(request)
        return ExtendedModelResponse(model_response=response, command=Command(update={'last_model_call_at': time()}))
