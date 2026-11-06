from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from functools import reduce
from typing import Any, cast

from langchain_core.callbacks import UsageMetadataCallbackHandler
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.messages.ai import UsageMetadata, add_usage
from langchain_core.outputs import ChatGeneration, LLMResult
from langchain_core.tracers.context import register_configure_hook

from .turn_memory import AnswerMiddleware, latest_turn_messages

log = logging.getLogger('botcube_harness_deepagents.prompt_cache')
_current_collector: ContextVar[_PromptCacheUsageCollector | None] = ContextVar(
    'botcube_prompt_cache_usage_collector',
    default=None,
)
register_configure_hook(_current_collector, inheritable=True)
_current_agentcore_session_id: ContextVar[str | None] = ContextVar(
    'botcube_prompt_cache_agentcore_session_id',
    default=None,
)


@contextmanager
def prompt_cache_turn(agentcore_session_id: str | None = None):
    """Collect one Turn across graph tasks and restore its caller on every exit."""
    collector_token = _current_collector.set(_PromptCacheUsageCollector())
    token = _current_agentcore_session_id.set(agentcore_session_id)
    try:
        yield
    finally:
        _current_agentcore_session_id.reset(token)
        _current_collector.reset(collector_token)


class _PromptCacheUsageCollector(UsageMetadataCallbackHandler):
    run_inline = True

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        # The library requires a model name and counts only the first generation.
        for generations in response.generations:
            for generation in generations:
                chat = cast(ChatGeneration, generation)
                message = chat.message
                normalized = message.model_copy(update={
                    'usage_metadata': _usage_from_message(message),
                    'response_metadata': {'model_name': message.response_metadata.get('model_name') or 'unknown'},
                })
                super().on_llm_end(LLMResult(generations=[[chat.model_copy(update={'message': normalized})]]))


class PromptCacheUsageMiddleware(AnswerMiddleware):
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

    def after_answer(self, state: dict[str, Any], runtime: Any) -> None:
        collector = _current_collector.get()
        usage = (reduce(add_usage, collector.usage_metadata.values(), None) if collector is not None and collector.usage_metadata
                 else prompt_cache_usage_from_messages(latest_turn_messages(state['messages'])))
        if usage is None:
            return

        details = usage.get('input_token_details', {})
        cache_read = details.get('cache_read', 0)
        cache_creation = details.get('cache_creation', 0)
        payload = {
            'event': 'bedrock_prompt_cache_usage',
            'thread_id': self.thread_id,
            'model': self.model,
            'effort': self.effort,
            'agentcore_session_id': _current_agentcore_session_id.get(),
            'input_tokens': usage['input_tokens'],
            'output_tokens': usage['output_tokens'],
            'total_tokens': usage['total_tokens'],
            'cache_read_input_tokens': cache_read,
            'cache_creation_input_tokens': cache_creation,
            'cache_read_to_creation_ratio': round(cache_read / cache_creation, 6) if cache_creation > 0 else None,
        }
        log.info(json.dumps(payload, sort_keys=True))


def prompt_cache_usage_from_messages(messages: Sequence[BaseMessage]) -> UsageMetadata | None:
    return reduce(add_usage, [usage for message in messages if (usage := _usage_from_message(message)) is not None], None)


def _usage_from_message(message: BaseMessage) -> UsageMetadata | None:
    if message.type != 'ai':
        return None
    usage = cast(AIMessage, message).usage_metadata  # pragma: no mutate: cast is a runtime no-op
    if usage is None:
        return None
    details = usage.get('input_token_details', {})
    # Some Bedrock usage carries its cache counters at the top level.
    return {
        **usage,
        'input_token_details': {
            **details,
            'cache_read': details.get('cache_read') or usage.get('cacheReadInputTokens', 0),
            'cache_creation': details.get('cache_creation') or usage.get('cacheWriteInputTokens', 0),
        },
    }
