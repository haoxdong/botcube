"""The member's Memory, loaded on a Session's first Turn and kept unchanged in its system prompt (ADR 0031).

The block lives in graph state, so the Session record carries it across Turns and Harness
restarts, and the system prompt stays byte-identical for the prompt cache. A new Session
loads afresh; the `memory` tool reads live records.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import SystemMessage

from . import answer_timing

MEMORY_LIMIT = 50
PREFERENCE_SECTION = 'user preferences:'
FACT_SECTION = 'semantic facts:'
SPILLOVER_NOTE = 'More memories are available. Use memory retrieve to search beyond the startup memory block.'


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


class SessionMemoryMiddleware(AgentMiddleware):
    """Load the block once per Session from the graph's store, and add it to every model call's system prompt.

    Its `session_memory` state is `agent.PlainState`'s, which every graph on the Session record carries.
    """

    def __init__(self, load: Callable[[Any], str]) -> None:
        super().__init__()
        self._load = load

    async def abefore_agent(self, state: Any, runtime: Any) -> dict[str, str] | None:
        if 'session_memory' in state:
            return None
        with answer_timing.phase('personal_memory'):
            return {'session_memory': await asyncio.to_thread(self._load, runtime.store)}

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
