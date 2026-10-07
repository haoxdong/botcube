from __future__ import annotations

import os
from collections.abc import Sequence
from typing import Any, ClassVar

# Set before the package's import loads the repo .env, which never overrides: tests send no runs to LangSmith.
os.environ['LANGSMITH_TRACING'] = 'false'
os.environ['LANGCHAIN_TRACING_V2'] = 'false'

import pytest
from langchain_core.language_models.fake_chat_models import (
    FakeListChatModel,
    FakeMessagesListChatModel,
)


class ToolBindableFakeModel(FakeListChatModel):
    """A scripted text model the Deep Agents graph can bind tools to."""

    def bind_tools(
        self, tools: Sequence[object], *, tool_choice: str | None = None, **kwargs: object
    ) -> ToolBindableFakeModel:
        return self


class ToolBindableFakeMessagesModel(FakeMessagesListChatModel):
    """A scripted message model the Deep Agents graph can bind tools to."""

    def bind_tools(
        self, tools: Sequence[object], *, tool_choice: str | None = None, **kwargs: object
    ) -> ToolBindableFakeMessagesModel:
        return self


class KwargsRecorder:
    """Stands in for a constructor or factory and records each call's keyword arguments."""

    calls: ClassVar[list[dict[str, Any]]]

    def __init__(self, **kwargs: Any) -> None:
        type(self).calls.append(kwargs)


@pytest.fixture
def kwargs_recorder() -> type[KwargsRecorder]:
    """A fresh KwargsRecorder class whose `calls` starts empty."""
    return type('KwargsRecorder', (KwargsRecorder,), {'calls': []})
