from __future__ import annotations

from collections.abc import Callable
from contextvars import ContextVar
from typing import Any

from ag_ui.core import (
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime

from .lazy_files import current_turn_files


class PendingSteering:
    def __init__(self) -> None:
        self.messages: dict[str, str] = {}
        self.consumed: set[str] = set()

    def add(self, message_id: str, content: str) -> None:
        if message_id not in self.consumed:
            self.messages.setdefault(message_id, content)

    def take(self, publish: Callable[[Any], None], message_ids: list[str]) -> list[HumanMessage]:
        pending = [(message_id, self.messages.pop(message_id)) for message_id in message_ids]
        messages = []
        for message_id, content in pending:
            self.consumed.add(message_id)
            publish(TextMessageStartEvent(message_id=message_id, role='user'))
            publish(TextMessageContentEvent(message_id=message_id, delta=content))
            publish(TextMessageEndEvent(message_id=message_id))
            messages.append(HumanMessage(content, id=message_id))
        return messages


active_steering: ContextVar[tuple[PendingSteering, Callable[[Any], None]] | None] = ContextVar('active_steering', default=None)


class SteeringMiddleware(AgentMiddleware):
    async def abefore_model(self, state: AgentState[Any], runtime: Runtime[Any]) -> dict[str, Any] | None:
        active = active_steering.get()
        if active is None:
            return None
        pending, publish = active
        message_ids = list(pending.messages)
        if not message_ids:
            return None
        if (files := current_turn_files()) is not None:
            await files.arefresh()
        return {'messages': pending.take(publish, message_ids)}
