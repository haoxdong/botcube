from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from deepagents.middleware._utils import append_to_system_message
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langgraph.config import get_config


def now() -> datetime:
    return datetime.now(UTC)


class TodayMiddleware(AgentMiddleware):
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        name = get_config().get('configurable', {}).get('timezone')
        zone = ZoneInfo(name if name is not None else 'UTC')
        today = now().astimezone(zone)
        line = f'Today is {today:%A}, {today.day} {today:%B %Y} ({zone.key}).'
        return await handler(request.override(system_message=append_to_system_message(request.system_message, line)))
