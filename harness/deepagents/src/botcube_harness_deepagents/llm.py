from __future__ import annotations

import asyncio
import os
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Iterator,
    Mapping,
    MutableMapping,
    Sequence,
)
from contextlib import aclosing
from contextvars import ContextVar
from functools import cached_property
from typing import Any, Literal, Protocol
from uuid import uuid4

import anthropic
import httpx
import httpx2
import openai
from langchain_anthropic import ChatAnthropic
from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel, SimpleChatModel
from langchain_core.messages import AIMessageChunk, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGenerationChunk
from langchain_openai import ChatOpenAI
from opentelemetry import baggage, propagate
from pydantic import Field

from . import aws_clients, turn_timing
from .definition import ModelRelay
from .deployment import deployed_config

DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-6'
AVAILABLE_MODELS: dict[str, str] = {
    'sonnet-4.6': 'us.anthropic.claude-sonnet-4-6',
    'opus-4.6': 'us.anthropic.claude-opus-4-6-v1',
    'opus-5.5': 'us.anthropic.claude-opus-5-5',
    'sonnet-5.5': 'us.anthropic.claude-sonnet-5-5',
    'deepseek-v3.2': 'deepseek.v3.2',
}
Effort = Literal['low', 'medium', 'high', 'max']
EFFORT_LEVELS: tuple[Effort, ...] = ('low', 'medium', 'high', 'max')
DEFAULT_EFFORT = 'medium'
BEDROCK_MAX_TOKENS = 16000
# A model on the account's ChatGPT plan, named by its slug in the plan's catalog (ADR 0078).
PLAN_MODEL_PREFIX = 'openai-plan:'
OPENAI_COMPATIBLE = 'openai-compatible'
ECHO_PROVIDER = 'echo'
RETRIED_STATUSES = frozenset({502, 503, 504})
ENDPOINT_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 0.2
MODEL_IDLE_SECONDS = 180.0
# The `type` of the classified Plan Usage errors the Credential Service relay answers.
PLAN_USAGE_ERROR_TYPE = 'plan_usage'


class PlanUsageError(RuntimeError):
    """A Plan Usage failure the Credential Service relay classified; the Turn ends with it (ADR 0078 decision 7).

    No other model takes the Turn over.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ModelIdleError(TimeoutError):
    """A gateway model's stream sent no model output for MODEL_IDLE_SECONDS; the Turn ends with it."""


_answered: ContextVar[list[int] | None] = ContextVar('model_reply_answered', default=None)


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
    provider: str | None = None,
) -> Any:
    """Build the Turn's model: on its `provider`'s own API through the model gateway, on Bedrock, or on a plan.

    `relay` answers the current Turn's relay, so a cached gateway or plan model takes each Turn's token.
    """
    selected_model = resolve_model(model)

    if not selected_model.startswith(PLAN_MODEL_PREFIX) and models_on_endpoint():
        if provider == ECHO_PROVIDER:
            return EchoChatModel()
        return _gateway_model(model, provider, relay, max_tokens, effort)

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
        'max_tokens': BEDROCK_MAX_TOKENS if max_tokens is None else max_tokens,
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


def has_model_profile(key: str, provider: str) -> bool:
    """Whether LangChain profiles the model `key` on the chat model a gateway builds for `provider`, giving an unset max_tokens its value."""
    if provider == 'anthropic':
        return ChatAnthropic(model_name=key, api_key='botcube-invocation').profile is not None
    return ChatOpenAI(model=key, api_key='botcube-invocation').profile is not None


def models_on_endpoint() -> bool:
    """Whether the BotCube Config puts the agent's models on a model gateway, relayed by the Credential Service."""
    return deployed_config()['config']['integrations']['modelGateway']['kind'] == OPENAI_COMPATIBLE


class _Request(Protocol):
    @property
    def headers(self) -> MutableMapping[str, str]: ...


class _Response(Protocol):
    @property
    def status_code(self) -> int: ...


def _gateway_hooks(relay: Callable[[], ModelRelay]) -> dict[str, list[Callable[..., Awaitable[None]]]]:
    """A gateway model's HTTP client hooks: the Turn's invocation as its bearer, and each answer's status for its reply's retry."""

    async def invocation(request: _Request) -> None:
        request.headers.pop('x-api-key', None)
        request.headers['authorization'] = f'Bearer {relay().token}'

    async def answered(response: _Response) -> None:
        if (statuses := _answered.get()) is not None:
            statuses.append(response.status_code)

    return {'request': [invocation, turn_timing.dispatched], 'response': [answered]}


def _output(chunk: ChatGenerationChunk) -> bool:
    message = chunk.message
    return bool(message.content) or (isinstance(message, AIMessageChunk) and bool(message.tool_call_chunks))


def _retried(error: BaseException, answered: Sequence[int]) -> bool:
    if answered:
        return answered[-1] == 200 or answered[-1] in RETRIED_STATUSES
    return _dropped_before_response(error)


async def _answered_reply(stream: Callable[[], AsyncIterator[ChatGenerationChunk]]) -> AsyncIterator[ChatGenerationChunk]:
    """Retry a reply that fails before its first output, and end one that sends no output for MODEL_IDLE_SECONDS.

    A reply is retried when the gateway answered 502, 503 or 504, dropped the connection before answering, or failed after its 200.
    The idle time counts model output, not bytes, since a gateway's keepalives would hold a stalled stream open.
    """
    attempt = 1
    while True:
        reply = _ReplyAttempt(stream, last=attempt == ENDPOINT_ATTEMPTS)
        async with aclosing(reply.chunks()) as chunks:
            async for chunk in chunks:
                yield chunk
        if not reply.retry:
            return
        await asyncio.sleep(RETRY_DELAY_SECONDS * attempt)
        attempt += 1


class _IdleDeadline:
    """When a reply that has sent no model output for MODEL_IDLE_SECONDS ends."""

    def __init__(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._renew()

    def _renew(self) -> None:
        self._at = self._loop.time() + MODEL_IDLE_SECONDS

    async def next_chunk(self, chunks: AsyncIterator[ChatGenerationChunk]) -> ChatGenerationChunk:
        """The next chunk of `chunks`, renewing the deadline when it is model output."""
        idle = asyncio.timeout_at(self._at)
        try:
            async with idle:
                chunk = await anext(chunks)
        except StopAsyncIteration:
            raise
        except Exception as error:
            if idle.expired():
                raise ModelIdleError(f'The model sent no output for {MODEL_IDLE_SECONDS:g} seconds') from error
            raise
        if _output(chunk):
            self._renew()
        return chunk


class _HeldChunks:
    """A reply's chunks before its first output, held back while the reply can still be retried."""

    def __init__(self) -> None:
        self._held: list[ChatGenerationChunk] | None = []

    @property
    def released(self) -> bool:
        return self._held is None

    def passed(self, chunk: ChatGenerationChunk) -> tuple[ChatGenerationChunk, ...]:
        """The chunks to send on now that `chunk` arrived: none while held back, then those held and `chunk`."""
        if self._held is None:
            return (chunk,)
        if not _output(chunk):
            self._held.append(chunk)
            return ()
        passed, self._held = (*self._held, chunk), None
        return passed

    def rest(self) -> tuple[ChatGenerationChunk, ...]:
        return tuple(self._held or ())


class _ReplyAttempt:
    """One stream of a reply; `retry` when it failed before its first output in a way worth another attempt."""

    def __init__(self, stream: Callable[[], AsyncIterator[ChatGenerationChunk]], *, last: bool) -> None:
        self._stream = stream
        self._last = last
        self._answered: list[int] = []
        self._held = _HeldChunks()
        self.retry = False

    async def chunks(self) -> AsyncGenerator[ChatGenerationChunk]:
        _answered.set(self._answered)
        deadline = _IdleDeadline()
        chunks = aiter(self._stream())
        try:
            while True:
                try:
                    chunk = await deadline.next_chunk(chunks)
                except StopAsyncIteration:
                    break
                except ModelIdleError:
                    raise
                except Exception as error:
                    if not self._worth_retrying(error):
                        raise
                    self.retry = True
                    return
                for each in self._held.passed(chunk):
                    yield each
            for each in self._held.rest():
                yield each
        finally:
            if isinstance(chunks, AsyncGenerator):
                await chunks.aclose()

    def _worth_retrying(self, error: Exception) -> bool:
        return not self._held.released and not self._last and _retried(error, self._answered)


def _dropped_before_response(error: BaseException | None) -> bool:
    if isinstance(error, (httpx.ConnectTimeout, httpx2.ConnectTimeout, ConnectionResetError, ConnectionRefusedError)):
        return True
    if isinstance(error, BaseExceptionGroup):
        return all(_dropped_before_response(each) for each in error.exceptions)
    return error is not None and _dropped_before_response(error.__cause__ or error.__context__)


class _AnsweredReplies(BaseChatModel):
    """A chat model whose every reply streams through `_answered_reply`."""

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        stream = super()._astream
        async for chunk in _answered_reply(lambda: stream(messages, stop, run_manager, **kwargs)):
            yield chunk


class _GatewayAnthropic(_AnsweredReplies, ChatAnthropic):
    http_async_client: httpx2.AsyncClient = Field(exclude=True)

    # init_chat_model cannot carry the relay's HTTP hooks: langchain-anthropic takes no HTTP client, so this overrides its
    # private `_async_client` to hand the Anthropic SDK its `http_client`. A langchain-anthropic upgrade breaks here first.
    @cached_property
    def _async_client(self) -> anthropic.AsyncClient:
        return anthropic.AsyncClient(
            api_key=self.anthropic_api_key.get_secret_value(),
            base_url=self.anthropic_api_url,
            default_headers=self.default_headers,
            max_retries=0,
            http_client=self.http_async_client,
        )


class _GatewayOpenAI(_AnsweredReplies, ChatOpenAI):
    pass


def _gateway_model(
    key: str | None, provider: str | None, relay: Callable[[], ModelRelay] | None, max_tokens: int | None, effort: str | None,
) -> BaseChatModel:
    """The model `provider:key` on its provider's own API, as LangChain names it, through the Credential Service's gateway relay."""
    if not key:
        raise RuntimeError('The model gateway needs a model key, and this Turn names no model')
    if provider is None:
        raise RuntimeError(f'Model "{key}" is not one of the bot settings\' models, so the model gateway has no provider for it')
    if relay is None:
        raise RuntimeError(f'Model "{key}" runs on the model gateway, which needs the Credential Service relay; this Turn has none')
    current = relay()
    common: dict[str, Any] = {
        'model': key,
        'base_url': f'{current.models_url}/{provider}',
        'api_key': 'botcube-invocation',
        'default_headers': dict(current.headers),
        'max_retries': 0,
        'streaming': True,
        **({} if max_tokens is None else {'max_tokens': max_tokens}),
    }
    hooks = _gateway_hooks(relay)
    if provider == 'anthropic':
        return _GatewayAnthropic(
            **common, http_async_client=anthropic.DefaultAsyncHttpxClient(event_hooks=hooks),
            # Claude 4.7+ default display to "omitted": thinking streams empty.
            thinking={'type': 'adaptive', 'display': 'summarized'}, effort=resolve_effort(effort),
        )
    route = deployed_config()['modelGateway']['openai']['route']
    responses = route is not None and route['useResponsesApi']
    reasoning = {} if effort is None else _openai_reasoning(resolve_effort(effort), responses)
    return _GatewayOpenAI(
        **common, http_async_client=openai.DefaultAsyncHttpxClient(event_hooks=hooks), stream_usage=True, use_responses_api=responses, **reasoning,
        # OpenAI caches a shared prefix by itself; one key per Session routes its calls to the same cache.
        model_kwargs={'prompt_cache_key': current.session_id},
    )


def _openai_reasoning(effort: Effort, responses: bool) -> dict[str, Any]:
    """The reasoning fields for the Turn's chosen effort, `max` as OpenAI's highest, `high`."""
    level = 'high' if effort == 'max' else effort
    return {'reasoning': {'effort': level, 'summary': 'auto'}} if responses else {'reasoning_effort': level}


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
    selected = model or DEFAULT_MODEL
    return AVAILABLE_MODELS.get(selected, selected)


def resolve_effort(effort: str | None = None) -> Effort:
    value = (effort or DEFAULT_EFFORT).strip().lower()
    for level in EFFORT_LEVELS:
        if level == value:
            return level
    raise ValueError(
        f'Invalid effort level {value!r}; must be one of {EFFORT_LEVELS}'
    )
