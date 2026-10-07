from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, cast

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from ._env import positive_int
from .turn_memory import latest_turn_messages

log = logging.getLogger('botcube_harness_deepagents.prompt_cache')
TURN_MESSAGE_LOG_LIMIT = positive_int('BOTCUBE_TURN_MESSAGE_LOG_LIMIT', 2_000)
_TRUNCATION_SUFFIX = '...'
_current_collector: ContextVar[_PromptCacheUsageCollector | None] = ContextVar(
    'botcube_prompt_cache_usage_collector',
    default=None,
)
_current_agentcore_session_id: ContextVar[str | None] = ContextVar(
    'botcube_prompt_cache_agentcore_session_id',
    default=None,
)


@contextmanager
def prompt_cache_agentcore_session(agentcore_session_id: str | None):
    token = _current_agentcore_session_id.set(agentcore_session_id)
    try:
        yield
    finally:
        _current_agentcore_session_id.reset(token)


@dataclass
class _PromptCacheUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0

    def add(self, other: _PromptCacheUsage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.total_tokens += other.total_tokens
        self.cache_read_input_tokens += other.cache_read_input_tokens
        self.cache_creation_input_tokens += other.cache_creation_input_tokens


@dataclass
class _PromptCacheUsageCollector:
    """The model-call usage of one agent turn."""

    usage: _PromptCacheUsage | None = None
    # True once wrap_model_call recorded a model call this turn. The
    # collector middleware wraps the main agent too, so a set flag means the
    # collected total already covers the main-agent turn.
    covers_turn: bool = False
    # The turn's summarization model runs, which Deep Agents makes outside wrap_model_call.
    summarization_run_ids: set[Any] = field(default_factory=set)

    def add_messages(self, messages: Sequence[BaseMessage]) -> None:
        usage = prompt_cache_usage_from_messages(messages)
        if usage is None:
            return
        if self.usage is None:
            self.usage = usage
        else:
            self.usage.add(usage)

    def resolve(
        self, turn_usage: _PromptCacheUsage | None
    ) -> _PromptCacheUsage | None:
        """Combine collected model-call usage with the turn's message usage.

        When ``wrap_model_call`` recorded the main-agent turn (the collector
        middleware is installed), the collected total is the authoritative
        superset and replaces the message usage. When only the summarization
        callback contributed — the collector middleware is absent for unmapped
        Bedrock Converse models (ADR 0018) — the collected usage is just the
        summary, so add it to the turn's message usage instead of replacing it,
        otherwise the assistant response is dropped from the emitted counters.
        """
        if self.usage is None:
            return turn_usage
        if self.covers_turn or turn_usage is None:
            return self.usage
        turn_usage.add(self.usage)
        return turn_usage


class _PromptCacheUsageCallbackHandler(BaseCallbackHandler):
    """Capture model calls that Deep Agents runs outside wrap_model_call."""

    run_inline = True

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[BaseMessage]],
        *,
        run_id: Any,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        collector = _current_collector.get()
        if collector is not None and (metadata or {}).get('lc_source') == 'summarization':
            collector.summarization_run_ids.add(run_id)

    def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        collector = _current_collector.get()
        if collector is None or run_id not in collector.summarization_run_ids:
            return
        # A chat model's generations are chat generations, each with its message.
        collector.add_messages(
            [cast(ChatGeneration, generation).message for generations in response.generations for generation in generations]  # pragma: no mutate: cast is a runtime no-op
        )


def install_prompt_cache_usage_callback(model: Any) -> Any:
    """Record *model*'s summarization usage; the Harness builds each model fresh, without callbacks."""
    model.callbacks = [_PromptCacheUsageCallbackHandler()]
    return model


class PromptCacheUsageCollectorMiddleware(AgentMiddleware):
    """Collect model-call usage from every stack in one agent turn."""

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        response = handler(request)
        _record_model_call_usage(response)
        return response

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        response = await handler(request)
        _record_model_call_usage(response)
        return response


class PromptCacheUsageMiddleware(AgentMiddleware):
    """Log Bedrock prompt-cache token counters once per completed agent turn."""

    def __init__(
        self,
        *,
        thread_id: str,
        model: str,
        effort: str,
    ) -> None:
        self.thread_id = thread_id
        self.model = model
        self.effort = effort

    def before_agent(self, state: Any, runtime: Any) -> None:
        _current_collector.set(_PromptCacheUsageCollector())

    async def abefore_agent(self, state: Any, runtime: Any) -> None:
        _current_collector.set(_PromptCacheUsageCollector())

    def after_agent(self, state: Any, runtime: Any) -> None:
        self._log_usage(state)

    async def aafter_agent(self, state: Any, runtime: Any) -> None:
        self._log_usage(state)

    def _log_usage(self, state: Any) -> None:
        turn_messages = latest_turn_messages(state['messages'])
        usage = prompt_cache_usage_from_messages(turn_messages)
        collector = _current_collector.get()
        if collector is not None:
            usage = collector.resolve(usage)
            _current_collector.set(None)
        if usage is None:
            return

        input_message, output_message = _turn_message_text(turn_messages)

        payload = {
            'event': 'bedrock_prompt_cache_usage',
            'thread_id': self.thread_id,
            'model': self.model,
            'effort': self.effort,
            'agentcore_session_id': _current_agentcore_session_id.get(),
            'input_tokens': usage.input_tokens,
            'output_tokens': usage.output_tokens,
            'total_tokens': usage.total_tokens,
            'cache_read_input_tokens': usage.cache_read_input_tokens,
            'cache_creation_input_tokens': usage.cache_creation_input_tokens,
            'cache_read_to_creation_ratio': _ratio(
                usage.cache_read_input_tokens,
                usage.cache_creation_input_tokens,
            ),
            'input_message': input_message,
            'output_message': output_message,
        }
        log.info(json.dumps(payload, sort_keys=True))


def _turn_message_text(messages: Sequence[BaseMessage]) -> tuple[str, str]:
    # A turn opens with its one human message.
    human, *rest = messages
    replies = [text for message in rest if message.type == 'ai' and (text := _bounded_message_text(message))]
    return _bounded_message_text(human), replies[-1] if replies else ''


def _bounded_message_text(message: BaseMessage) -> str:
    normalized = _message_text(message.content).replace('\r\n', '\n').replace('\r', '\n').replace('\n', ' ')
    if len(normalized) <= TURN_MESSAGE_LOG_LIMIT:
        return normalized
    return normalized[: TURN_MESSAGE_LOG_LIMIT - len(_TRUNCATION_SUFFIX)] + _TRUNCATION_SUFFIX


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    # A content-block list: its text blocks, without images, reasoning or tool blocks.
    return ' '.join(block['text'] for block in content if block['type'] == 'text')


def prompt_cache_usage_from_messages(
    messages: Sequence[BaseMessage],
) -> _PromptCacheUsage | None:
    usages = [usage for message in messages if (usage := _usage_from_message(message)) is not None]
    if not usages:
        return None
    total = _PromptCacheUsage()
    for usage in usages:
        total.add(usage)
    return total


def _record_model_call_usage(response: ModelResponse) -> None:
    collector = _current_collector.get()
    if collector is None:
        return
    # wrap_model_call ran, so the collected total covers the main-agent turn.
    collector.covers_turn = True
    collector.add_messages(response.result)


def _usage_from_message(message: BaseMessage) -> _PromptCacheUsage | None:
    if message.type != 'ai':
        return None
    usage = cast(AIMessage, message).usage_metadata  # pragma: no mutate: cast is a runtime no-op
    if usage is None:
        return None
    details = usage.get('input_token_details', {})
    # Some Bedrock usage carries its cache counters at the top level.
    return _PromptCacheUsage(
        input_tokens=usage['input_tokens'],
        output_tokens=usage['output_tokens'],
        total_tokens=usage['total_tokens'],
        cache_read_input_tokens=details.get('cache_read') or usage.get('cacheReadInputTokens', 0),
        cache_creation_input_tokens=details.get('cache_creation') or usage.get('cacheWriteInputTokens', 0),
    )


def _ratio(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 6)
