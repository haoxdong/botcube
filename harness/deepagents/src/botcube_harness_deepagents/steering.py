from __future__ import annotations

import json
import logging
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from time import monotonic
from typing import Any, Literal

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


@dataclass(frozen=True)
class _Waiting:
    content: str
    added: float


class PendingSteering:
    def __init__(self) -> None:
        self._entries: dict[str, _Waiting | Literal['taken', 'withdrawn']] = {}

    def add(self, message_id: str, content: str) -> None:
        if message_id not in self._entries:
            self._entries[message_id] = _Waiting(content, monotonic())

    def withdraw(self, message_id: str) -> bool:
        if self._entries.get(message_id) == 'taken':
            return False
        self._entries[message_id] = 'withdrawn'
        return True

    def waiting_ids(self) -> tuple[str, ...]:
        return tuple(message_id for message_id, entry in self._entries.items() if isinstance(entry, _Waiting))

    def take(self, batch: tuple[str, ...], publish: Callable[[Any], None]) -> list[HumanMessage]:
        taken = monotonic()
        messages = []
        for message_id in batch:
            entry = self._entries[message_id]
            if not isinstance(entry, _Waiting):
                continue
            self._entries[message_id] = 'taken'
            content = entry.content
            wait_ms = round((taken - entry.added) * 1000)
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
        if not (batch := pending.waiting_ids()):
            return None
        if (files := current_turn_files()) is not None:
            await files.arefresh()
        if not (messages := pending.take(batch, publish)):
            return None
        return {'messages': messages}
