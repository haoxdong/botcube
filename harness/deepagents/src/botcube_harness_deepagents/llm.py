from __future__ import annotations

import functools
import os
from collections.abc import AsyncIterator, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import SimpleChatModel
from langchain_core.messages import AIMessageChunk, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGenerationChunk
from opentelemetry import baggage, propagate

from . import aws_clients, turn_timing
from .definition import ModelRelay

DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-6'
AVAILABLE_MODELS: dict[str, str] = {
    'sonnet-4.6': 'us.anthropic.claude-sonnet-4-6',
    'opus-4.6': 'us.anthropic.claude-opus-4-6-v1',
    'opus-5.5': 'us.anthropic.claude-opus-5-5',
    'sonnet-5.5': 'us.anthropic.claude-sonnet-5-5',
    'deepseek-v3.2': 'deepseek.v3.2',
}
EFFORT_LEVELS = ('low', 'medium', 'high', 'max')
DEFAULT_EFFORT = 'medium'
DEFAULT_MAX_TOKENS = 128
# A model on the account's ChatGPT plan, named by its slug in the plan's catalog (ADR 0078).
PLAN_MODEL_PREFIX = 'openai-plan:'
# The Deployment Config's `models` section, as the deploy hands it over: `MODELS_ENV` in botcube/deployment-config.
MODELS_BASE_URL_ENV = 'BOTCUBE_MODELS_BASE_URL'
MODELS_API_KEY_SECRET_ENV = 'BOTCUBE_MODELS_API_KEY_SECRET_ARN'
# The `type` of the classified Plan Usage errors the Credential Service relay answers.
PLAN_USAGE_ERROR_TYPE = 'plan_usage'


class PlanUsageError(RuntimeError):
    """A Plan Usage failure the Credential Service relay classified; the Turn ends with it (ADR 0078 decision 7).

    No other model takes the Turn over.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class EchoChatModel(SimpleChatModel):
    """Credential-free model for the local template and deterministic smoke tests."""

    @property
    def _llm_type(self) -> str:
        return 'botcube-echo'

    def _call(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> str:
        message = next(item for item in reversed(messages) if isinstance(item, HumanMessage))
        return f'Echo: {message.content}'

    def _stream(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        # Stream the reply like a real model so AG-UI emits it as text message events.
        yield ChatGenerationChunk(message=AIMessageChunk(content=self._call(messages)))

    def bind_tools(
        self,
        tools: Sequence[Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> EchoChatModel:
        return self


def build_model(
    *,
    model: str | None = None,
    region_name: str | None = None,
    max_tokens: int | None = None,
    effort: str | None = None,
    relay: Callable[[], ModelRelay] | None = None,
) -> Any:
    """Build the configured Bedrock or plan model.

    `relay` answers the current Turn's relay, so a cached plan model takes each Turn's token.
    """
    selected_model = resolve_model(model)

    if not selected_model.startswith(PLAN_MODEL_PREFIX) and (endpoint := openai_compatible_endpoint()) is not None:
        # Every model but Plan Usage's runs on the endpoint, by its key in the bot settings; the Bedrock default is no key there.
        key = model or os.environ.get('BOTCUBE_MODEL')
        if not key:
            raise RuntimeError('The OpenAI-compatible models endpoint needs a model key, and this Turn names no model and BOTCUBE_MODEL is unset')
        return _openai_compatible_model(key, endpoint, max_tokens)

    if selected_model == 'echo':
        return EchoChatModel()

    if selected_model.startswith(PLAN_MODEL_PREFIX):
        if relay is None:
            raise RuntimeError(
                f'Model "{selected_model}" runs on Plan Usage, which needs the Credential Service relay; '
                'this Turn has none'
            )
        return _plan_model(selected_model.removeprefix(PLAN_MODEL_PREFIX), relay, effort)

    resolved_effort = resolve_effort(effort)
    from langchain_aws import ChatBedrockConverse

    selected_region = (
        region_name
        or os.environ.get('AWS_REGION')
        or os.environ.get('AWS_DEFAULT_REGION')
    )
    is_anthropic = 'anthropic' in selected_model
    kwargs: dict[str, Any] = {
        'model': selected_model,
        'temperature': None if is_anthropic else 0,
        'max_tokens': DEFAULT_MAX_TOKENS if max_tokens is None else max_tokens,
    }
    if selected_region:
        kwargs['region_name'] = selected_region
        kwargs['client'], kwargs['bedrock_client'] = aws_clients.bedrock(selected_region)
    if is_anthropic:
        kwargs['additional_model_request_fields'] = {
            # Claude 4.7+ default display to "omitted": thinking streams empty.
            'thinking': {'type': 'adaptive', 'display': 'summarized'},
            'output_config': {'effort': resolved_effort},
        }
    elif selected_model.startswith('deepseek.'):
        # Bedrock's DeepSeek reasons only at "high"; "low" and "medium" are accepted but skip it.
        kwargs['additional_model_request_fields'] = {'reasoning_config': 'high'}
    return ChatBedrockConverse(**kwargs)


@dataclass(frozen=True)
class OpenAICompatibleEndpoint:
    """The Deployment Config's `models` section on an OpenAI-compatible endpoint (ADR 0091)."""

    base_url: str
    api_key: str = field(repr=False)


@functools.cache
def openai_compatible_endpoint() -> OpenAICompatibleEndpoint | None:
    """The endpoint the deploy names in `BOTCUBE_MODELS_*`, its API key read from Secrets Manager once; None on Bedrock."""
    base_url = os.getenv(MODELS_BASE_URL_ENV, '').strip().rstrip('/')
    secret_arn = os.getenv(MODELS_API_KEY_SECRET_ENV, '').strip()
    if not base_url and not secret_arn:
        return None
    if not base_url or not secret_arn:
        raise RuntimeError(f'An OpenAI-compatible models endpoint needs both {MODELS_BASE_URL_ENV} and {MODELS_API_KEY_SECRET_ENV}')
    parts = secret_arn.split(':')
    if len(parts) < 7 or parts[2] != 'secretsmanager':
        raise RuntimeError(f'{MODELS_API_KEY_SECRET_ENV} is not a Secrets Manager secret ARN: {secret_arn}')
    client = aws_clients.session().client('secretsmanager', region_name=parts[3])
    api_key = client.get_secret_value(SecretId=secret_arn).get('SecretString')
    if not api_key:
        raise RuntimeError(f'The secret {MODELS_API_KEY_SECRET_ENV} names holds no string')
    return OpenAICompatibleEndpoint(base_url=base_url, api_key=api_key)


def _openai_compatible_model(key: str, endpoint: OpenAICompatibleEndpoint, max_tokens: int | None) -> Any:
    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(
        model=key,
        base_url=endpoint.base_url,
        api_key=endpoint.api_key,
        max_completion_tokens=DEFAULT_MAX_TOKENS if max_tokens is None else max_tokens,
        streaming=True,
        stream_usage=True,
        use_responses_api=False,
    )
    model.root_async_client._client.event_hooks['request'].append(turn_timing.dispatched)
    return model


def _plan_request_headers(kwargs: Mapping[str, Any]) -> dict[str, str]:
    headers = dict(kwargs.get('extra_headers') or {})
    if (run_id := baggage.get_baggage('run.id')) is not None:
        headers['x-botcube-run-id'] = str(run_id)
    manager = kwargs.get('run_manager')
    step = manager.run_id if manager is not None else turn_timing.model_run()
    headers['x-botcube-model-step-id'] = str(step or uuid4())
    propagate.inject(headers)
    return headers


def _plan_model(slug: str, relay: Callable[[], ModelRelay], effort: str | None = None) -> Any:
    """A ChatGPT plan model under the plan request rules: streamed, unstored, no sampling or length limits."""
    import openai
    from langchain_openai import ChatOpenAI

    class ChatGPTPlanModel(ChatOpenAI):
        # The plan route rejects role=system input items; send them as developer messages.
        def _get_request_payload(self, input_: Any, **kwargs: Any) -> dict[str, Any]:
            payload = super()._get_request_payload(input_, **kwargs)
            # One key per Session routes its steps to the provider's warm cache of their shared prefix.
            payload['prompt_cache_key'] = relay().session_id
            for item in payload['input']:
                if isinstance(item, dict) and item.get('role') == 'system':
                    item['role'] = 'developer'
            # LangChain has serialized the conversation to Responses JSON; avoid the SDK's
            # repeated union traversal over every message in a long conversation.
            payload['extra_body'] = {'input': payload.pop('input'), **(payload.get('extra_body') or {})}
            return payload

        async def _astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
            headers = _plan_request_headers(kwargs)
            kwargs['extra_headers'] = headers
            try:
                async for chunk in super()._astream(*args, **kwargs):
                    yield chunk
            except openai.APIError as error:
                body = error.body
                if not isinstance(body, Mapping) or body.get('type') != PLAN_USAGE_ERROR_TYPE:
                    raise
                raise PlanUsageError(str(body['code']), str(body['message'])) from error

    current = relay()
    model = ChatGPTPlanModel(
        model=slug,
        base_url=current.base_url,
        api_key=lambda: relay().token,
        default_headers=dict(current.headers),
        use_responses_api=True,
        reasoning={'summary': 'auto', **({'effort': resolve_effort(effort)} if effort is not None else {})},
        verbosity='low',
        streaming=True,
        store=False,
        max_retries=0,
    )
    # Inference Latency starts when the request leaves, after LangChain serializes the conversation.
    model.root_async_client._client.event_hooks['request'].append(turn_timing.dispatched)
    return model


def resolve_model(model: str | None = None) -> str:
    selected = model or os.environ.get('BOTCUBE_MODEL', DEFAULT_MODEL)
    return AVAILABLE_MODELS.get(selected, selected)


def resolve_effort(effort: str | None = None) -> str:
    value = (effort or DEFAULT_EFFORT).strip().lower()
    if value not in EFFORT_LEVELS:
        raise ValueError(
            f'Invalid effort level {value!r}; must be one of {EFFORT_LEVELS}'
        )
    return value
