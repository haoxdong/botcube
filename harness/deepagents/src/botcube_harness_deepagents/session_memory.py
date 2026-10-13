from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from functools import partial
from time import time
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


def prefetch(load: Callable[[], str], run_id: str) -> None:
    """Start reading the Turn's Memory block on a worker thread; the Turn's middleware takes it rather than reading again."""
    _prefetched.set(_Prefetch(run_id, asyncio.create_task(asyncio.to_thread(load))))


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
