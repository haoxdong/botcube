from __future__ import annotations

import json
import logging
from collections.abc import Callable
from contextvars import ContextVar
from time import monotonic
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

log = logging.getLogger(__name__)


class PendingSteering:
    def __init__(self) -> None:
        self.messages: dict[str, str] = {}
        self.consumed: set[str] = set()
        self.withdrawn: set[str] = set()
        self.added: dict[str, float] = {}

    def add(self, message_id: str, content: str) -> None:
        if message_id not in self.consumed and message_id not in self.withdrawn:
            self.messages.setdefault(message_id, content)
            self.added.setdefault(message_id, monotonic())

    def withdraw(self, message_id: str) -> bool:
        if message_id in self.consumed:
            return False
        self.messages.pop(message_id, None)
        self.added.pop(message_id, None)
        self.withdrawn.add(message_id)
        return True

    def take(self, publish: Callable[[Any], None]) -> list[HumanMessage]:
        pending, self.messages = self.messages, {}
        taken = monotonic()
        messages = []
        for message_id, content in pending.items():
            self.consumed.add(message_id)
            wait_ms = round((taken - self.added.pop(message_id)) * 1000)
            log.info(json.dumps({'event': 'harness_steering_wait', 'messageId': message_id, 'waitMs': wait_ms}))
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
        if not pending.messages:
            return None
        if (files := current_turn_files()) is not None:
            await files.arefresh()
        if not (messages := pending.take(publish)):
            return None
        return {'messages': messages}
