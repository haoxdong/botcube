from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import json
import logging
import logging.config
import os
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import perf_counter
from typing import TYPE_CHECKING, Any, NamedTuple, TypeGuard, cast

from ag_ui.core import (
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    TextMessageContentEvent,
)
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from botcube_cartridge import (
    HarnessDefinition,
    InvocationAuth,
    ModelRelay,
)
from deepagents.backends import LocalShellBackend
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.store.memory import InMemoryStore
from langgraph_checkpoint_aws import AgentCoreMemoryStore
from opentelemetry import baggage
from opentelemetry import context as otel_context

from . import answer_timing
from ._env import positive_float, positive_int
from .actor_identity import (
    actor_path_segment,
    record_belongs_to_actor,
    sanitize_actor_id,
)
from .agent import build_agent
from .agent_documents import (
    AgentDocuments,
    AgentDocumentsError,
    agent_document_tools,
    pop_agent_documents,
)
from .files_sync import (
    FilesSync,
    FilesSyncError,
    FilesSyncRecordError,
    excluded_paths,
    files_prompt,
    pop_files_sync,
)
from .llm import PlanUsageError, build_model, resolve_effort, resolve_model
from .memory import agentcore as agentcore_memory_backend
from .memory import inmem as inmem_memory_backend
from .memory import local as local_memory_backend
from .memory.agentcore.snapshot_saver import reading_once
from .memory.agentcore.turn_saver import TurnCheckpointSaver
from .memory_broker import MemoryCapability, turn_memory
from .memory_document import actor_memory_records, record_text
from .memory_files import MEMORY_FILENAME
from .memory_tools import (
    AGENTCORE_MEMORY_ID,
    AGENTCORE_REGION,
)
from .messages_snapshot import state_snapshot
from .pending_memory import (
    pending_memory_session_ids,
    pending_memory_texts,
    utc_now,
)
from .prompt_cache_observability import (
    PromptCacheUsageMiddleware,
    install_prompt_cache_usage_callback,
    prompt_cache_turn,
)
from .scheduled_tasks import propose_scheduled_task
from .shell_backend import PolicyShellBackend

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore.type_defs import EventTypeDef

log = logging.getLogger(__name__)
LTM_PREFERENCE_LIMIT = positive_int('BOTCUBE_LTM_PREFERENCE_LIMIT', 50)
LTM_FACT_LIMIT = positive_int('BOTCUBE_LTM_FACT_LIMIT', 50)
LTM_PREFERENCE_SECTION_LABEL = 'user preferences:'
LTM_FACT_SECTION_LABEL = 'semantic facts:'
LTM_SPILLOVER_NOTE = (
    'More memories are available. '
    'Use agent_core_memory retrieve to search beyond the startup memory block.'
)
AGENT_SYSTEM_PROMPT = """You are the user's own agent, with your own computer, Files and schedule; they text you like a colleague, so reply like a text.
Be authoritative, sharp and concise.
Write like a person, in plain sentences: no emoji, no em dashes.
When the user opens the chat, greet them by first name, say in one line what you can do, and pitch one thing their Memory suggests they'd care about.
Link every factual claim to its source, in every paragraph, bullet and table cell, as a numbered link: `claim [[1]](https://…)`.

## Long answers

Put a long answer in a Report, a file in the user's Files; in chat, give only its bottom line, a one-line summary of what it covers, and its link.
Structure a Report BLUF: `Summary` (the bottom line in 1-2 sentences), then `More Details` (supporting data, tables and analysis).
Write a Report as an email draft (`.eml` with `X-Unsent: 1`), or as HTML or PDF when the user asks."""

class MissingUserIdError(RuntimeError):
    """The invocation carries no user ID; only the Chat Service resolves identity (ADR 0068)."""

    code = 'MISSING_USER_ID'


class InvalidMemoryRevisionError(RuntimeError):
    """The invocation's Memory revision is not a whole number."""

    code = 'INVALID_MEMORY_REVISION'


@dataclass(frozen=True)
class HarnessCartridge:
    skills: Sequence[str]
    agent_name: str
    system_prompt: str
    execute_description: str
    prepare_invocation: Callable[[Any], InvocationAuth]
    record_belongs_to_actor: Callable[[Mapping[str, Any], str], bool]
    actor_path_segment: Callable[[str], str]
    sanitize_actor_id: Callable[[str], str]
    build_backend: Callable[[dict[str, str]], LocalShellBackend]
    apply_session_id: Callable[[LocalShellBackend, str | None], None]
    environment_cache_key: Callable[[Mapping[str, str] | None], tuple[tuple[str, str], ...]]


_cartridge: HarnessCartridge | None = None


def configure_harness(cartridge: HarnessCartridge) -> None:
    global _cartridge
    if _cartridge is not None:
        raise RuntimeError('Harness Cartridge is already configured')
    _cartridge = cartridge


def configure_harness_definition(definition: HarnessDefinition) -> None:
    """Adapt a framework-neutral Cartridge definition to this Harness."""

    def build_backend(environment: dict[str, str]) -> PolicyShellBackend:
        root = _workspace()
        definition.prepare_root(root)
        return PolicyShellBackend(
            root_dir=root,
            virtual_mode=True,
            timeout=definition.shell_timeout,
            max_output_bytes=definition.max_output_bytes,
            env=definition.build_shell_env(environment),
            inherit_env=True,
            command_validator=definition.command_validator,
        )

    def apply_session_id(backend: LocalShellBackend, session_id: str | None) -> None:
        # The backend is the PolicyShellBackend build_backend made.
        cast(PolicyShellBackend, backend).set_environment_variable(  # pragma: no mutate: cast is a runtime no-op
            definition.session_id_env_var,
            str(session_id) if session_id else None,
        )

    configure_harness(
        HarnessCartridge(
            skills=definition.skills,
            agent_name=definition.agent_name,
            system_prompt=definition.system_prompt,
            execute_description=definition.execute_description,
            prepare_invocation=definition.prepare_invocation,
            record_belongs_to_actor=record_belongs_to_actor,
            actor_path_segment=actor_path_segment,
            sanitize_actor_id=sanitize_actor_id,
            build_backend=build_backend,
            apply_session_id=apply_session_id,
            environment_cache_key=definition.environment_cache_key,
        )
    )


def configure_harness_from_module(module_name: str) -> None:
    module = importlib.import_module(module_name)
    definition = getattr(module, 'CARTRIDGE', None)
    if definition is None:
        raise RuntimeError(f'{module_name} does not export CARTRIDGE')
    configure_harness_definition(definition)


def configure_installed_cartridge() -> None:
    entries = list(importlib.metadata.entry_points(group='botcube.cartridge'))
    if len(entries) != 1:
        raise RuntimeError(
            'Exactly one installed botcube.cartridge entry point is required; '
            f'found {len(entries)}'
        )
    configure_harness_definition(entries[0].load())


def _require_cartridge() -> HarnessCartridge:
    if _cartridge is None:
        raise RuntimeError('Harness Cartridge is not configured')
    return _cartridge


# AgentCore passes the runtime session id on this header (what AGUIApp read via
# RequestContext). The Cartridge maps it into its tool session environment.
SESSION_ID_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'
# An SSE comment the Turn's stream sends after each quiet stretch this long: the Chat Service's read of the
# stream fails after 300 s with nothing sent. The interval is the SSE spec's suggestion for proxies.
_KEEPALIVE = ': keepalive\n\n'
_KEEPALIVE_SECONDS = positive_float('BOTCUBE_HARNESS_KEEPALIVE_SECONDS', 15.0)

# Hand-written AG-UI serving shell (ADR 0029). Depends only on the GA AgentCore
# container contract (:8080 + POST /invocations + GET /ping) and the ag_ui
# protocol library — not on the bedrock-agentcore SDK's AGUIApp.
app = FastAPI(title='BotCube DeepAgents Harness Runtime')


class _RequestContext:
    """Minimal per-request context carrying the AgentCore session id.

    Parity with the ``session_id`` attribute of AGUIApp's ``RequestContext``,
    which is all ``_apply_session_env`` reads.
    """

    def __init__(self, session_id: str | None) -> None:
        self.session_id = session_id


class _AgentKey(NamedTuple):
    """What an agent is cached per, so actor-scoped memory, Credential Service auth,
    and the copilot selector all take effect."""

    conversation_id: str
    actor_id: str
    session_user_id: str
    persistent_memory: bool
    model: str
    effort: str
    environment: tuple[tuple[str, str], ...]
    # Agent Identity and Soul: an edit builds a new agent, so it takes effect from the next message.
    documents: str
    # Each edit of the member's Memory bumps it: the next message reads Memory afresh.
    memory_revision: int
    # Whether the Turn syncs the user's Files, which the system prompt then locates.
    syncs_files: bool
    invocation_prompt: str


class _SessionAgent(LangGraphAgent):
    """A LangGraphAgent that takes no tool result the Session's record already holds.

    TOOL_CALL_RESULT carries a fresh message ID, which only the run's closing
    MESSAGES_SNAPSHOT replaces with the recorded one. A client that missed the
    snapshot resends the result under its streamed ID, and the ID-keyed merge
    would append it as a second answer to an answered call. So too the
    tool calls: a model that names its message only at the stream's end records
    it under another ID than the one streamed, and a resent call would land as
    a second step before the new user message. The web has sent only its
    new user messages, so only an older client resends either.
    """

    _graph_ended_at: float | None = None
    _interrupted: bool = False
    _graph_stream: Any = None

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._model_lane: str | None = None

    def get_stream_kwargs(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        stream_kwargs = super().get_stream_kwargs(*args, **kwargs)
        stream_kwargs['durability'] = 'sync'
        return stream_kwargs

    async def _handle_stream_events(self, input: RunAgentInput) -> AsyncGenerator[Any, None]:
        try:
            async with aclosing(super()._handle_stream_events(input)) as events:
                async for event in events:
                    yield event
                    if event.type == EventType.RUN_FINISHED:
                        break
        except Exception as error:
            log.exception('Error during graph streaming')
            yield RunErrorEvent(message=str(error), code=error.code if isinstance(error, PlanUsageError) else 'INTERNAL_ERROR')
        finally:
            self._model_lane = None
            self.messages_in_process.clear()
            if self._graph_stream is not None:
                await self._graph_stream.aclose()
                self._graph_stream = None

    async def _handle_single_event(self, event: Any, state: Any) -> AsyncGenerator[Any, None]:
        root = event.get('parent_ids') == []
        chunk = event.get('data', {}).get('chunk')
        if isinstance(chunk, tuple):
            chunk = chunk[-1]
        if root and event.get('event') == 'on_chain_stream' and isinstance(chunk, dict) and '__interrupt__' in chunk:
            self._interrupted = True
        ended = root and event.get('event') == 'on_chain_end'
        if ended:
            self._graph_ended_at = perf_counter()
        async with aclosing(self._handle_model_event(event, state)) as events:
            async for emitted in events:
                yield emitted
        if ended and not self._interrupted:
            for emitted in self.handle_node_change(None):
                yield emitted
            if self.active_run is None:
                raise RuntimeError('Graph ended outside an active run')
            thread_id = self.active_run.get('thread_id')
            if thread_id is None:
                raise RuntimeError('Graph ended without a Session ID')
            yield RunFinishedEvent(thread_id=thread_id, run_id=self.active_run['id'])

    async def _handle_model_event(self, event: Any, state: Any) -> AsyncGenerator[Any, None]:
        if event.get('event') not in {'on_chat_model_stream', 'on_chat_model_end'}:
            async for emitted in super()._handle_single_event(event, state):
                yield emitted
            return
        if event.get('metadata', {}).get('lc_source') == 'summarization':
            return
        if self.active_run is None:
            raise RuntimeError('Model event outside an active run')
        self._model_lane = event['run_id']
        try:
            async with aclosing(super()._handle_single_event(event, state)) as events:
                async for emitted in events:
                    timing = answer_timing.current()
                    if timing and _is_assistant_text(emitted):
                        timing.alias(event.get('data', {}).get('chunk'), emitted.message_id)
                    yield emitted
        finally:
            self._model_lane = None

    def _current_lane(self) -> str:
        return self._model_lane or super()._current_lane()

    async def get_state_and_messages_snapshots(self, config: RunnableConfig) -> AsyncGenerator[Any, None]:
        if self._graph_ended_at is not None:
            return
        async for event in super().get_state_and_messages_snapshots(config):
            yield event

    async def prepare_stream(self, input: RunAgentInput, agent_state: Any, config: RunnableConfig) -> Any:
        self._graph_ended_at = None
        self._interrupted = False
        self._model_lane = None
        self.messages_in_process.clear()
        # Stop records the visible text before a model finishes its tool call.
        # A client can resend that message with unfinished JSON arguments; the
        # library decodes those before its merge discards already-recorded IDs.
        kept_text_ids = {
            message.id
            for message in agent_state.values.get('messages', [])
            if isinstance(message, AIMessage) and not message.tool_calls
        }
        input = input.model_copy(update={'thread_id': input.thread_id or config.get('configurable', {})['thread_id'], 'messages': [
            message for message in input.messages
            if not (message.role == 'assistant' and message.id in kept_text_ids and message.tool_calls)
        ]})
        for message in input.messages:
            if message.role == 'assistant':
                for call in message.tool_calls or []:
                    if call.function.arguments:
                        json.loads(call.function.arguments)
        prepared = await super().prepare_stream(input, agent_state, config)
        self._graph_stream = prepared.get('stream')
        prepared['stream'] = await self._prime_initial_record(self._graph_stream, agent_state)
        return prepared

    async def _prime_initial_record(self, stream: Any, agent_state: Any) -> Any:
        if stream is None or getattr(self.graph, 'checkpointer', None) is None or agent_state.values.get('messages'):
            return stream
        buffered = []
        # The library emits RUN_STARTED before iterating the lazy graph. With sync
        # durability, the first node starts only after the initial question is durable.
        async for event in stream:
            buffered.append(event)
            metadata = event.get('metadata', {})
            if len(event.get('parent_ids', [])) == 1 and metadata.get('langgraph_step', -1) >= 1:
                break

        async def replay() -> AsyncGenerator[Any, None]:
            for event in buffered:
                yield event
            async for event in stream:
                yield event

        return replay()

    def langgraph_default_merge_state(self, state: Any, messages: list[Any], input: RunAgentInput) -> Any:
        merged = super().langgraph_default_merge_state(state, messages, input)
        recorded = state.get('messages', [])
        recorded_ids = {message.id for message in recorded}
        answered = {message.tool_call_id for message in recorded if isinstance(message, ToolMessage)}
        called = {call['id'] for message in recorded if isinstance(message, AIMessage) for call in message.tool_calls}
        merged['messages'] = [
            message
            for message in merged['messages']
            if message.id in recorded_ids
            or not (
                (isinstance(message, ToolMessage) and message.tool_call_id in answered)
                or (isinstance(message, AIMessage) and message.tool_calls and {call['id'] for call in message.tool_calls} <= called)
            )
        ]
        return merged


class _AnsweredToolResultsMiddleware(AgentMiddleware):
    """Sends the model only the first recorded result of each tool call.

    A Session recorded before _SessionAgent's guard can hold a resent result after
    its call was answered, and Bedrock refuses every later Turn on it. The
    record keeps that result; only the model's request leaves it out. Read the
    first result's identity from the full state because native summarization
    can remove it from the request while keeping the replayed result.
    """

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        first_results: dict[str, str | None] = {}
        for message in request.state['messages']:
            if isinstance(message, ToolMessage):
                first_results.setdefault(message.tool_call_id, message.id)
        messages = [
            message for message in request.messages
            if not isinstance(message, ToolMessage) or message.id == first_results[message.tool_call_id]
        ]
        return await handler(request.override(messages=messages))


class _ExecuteDescriptionMiddleware(AgentMiddleware):
    """Describes `execute` by the Cartridge's command policy.

    deepagents describes a general shell, with python and pytest examples, so the
    model ran python against a policy that refuses it.
    """

    def __init__(self, description: str) -> None:
        super().__init__()
        self.description = description

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        tools = [
            tool.model_copy(update={'description': self.description})
            if isinstance(tool, BaseTool) and tool.name == 'execute' else tool
            for tool in request.tools
        ]
        return await handler(request.override(tools=tools))


# Module-level singletons — built once, reused across requests.
# The graph is compiled once so the checkpointer can load prior
# conversation state from the same compiled channels. Rebuilding per request created a fresh graph
# each time, which broke checkpoint continuity and lost context.
# Backends are shared across model switches only when the Credential Service binding is the same.
_AGENTS: dict[_AgentKey, LangGraphAgent] = {}
_CHECKPOINTER: Any | None = None
_STORE: AgentCoreMemoryStore | InMemoryStore | None = None
_THREAD_LTM_CONTEXTS: dict[tuple[str, str, int], str | None] = {}
_DEFERRED_SAVER: TurnCheckpointSaver | None = None
_BACKENDS: dict[tuple[str, str, tuple[tuple[str, str], ...]], LocalShellBackend] = {}
_AGENT_BACKENDS: dict[_AgentKey, LocalShellBackend] = {}
# The backend each agent's graph was built with, looked up by the invoking agent.
_BACKEND_BY_AGENT: dict[Any, LocalShellBackend] = {}
# The latest Turn's relay per agent: its invocation token rotates without a rebuild, as the shell's does.
_MODEL_RELAYS: dict[_AgentKey, ModelRelay] = {}


def _build_checkpointer() -> Any:
    """Return TurnCheckpointSaver wrapping AgentCoreMemorySaver, or a local checkpointer.

    TurnCheckpointSaver buffers a Turn's checkpoints in memory and persists
    all of them in one batch on flush, instead of one API call per LangGraph
    super-step (~62 per Turn, ~8-15 s of checkpoint overhead).
    """
    global _DEFERRED_SAVER
    if AGENTCORE_MEMORY_ID:
        _DEFERRED_SAVER = agentcore_memory_backend.build_checkpointer(
            AGENTCORE_MEMORY_ID,
            region_name=AGENTCORE_REGION,
            wrapper=TurnCheckpointSaver,
            broker=True,
        )
        return _DEFERRED_SAVER
    checkpoint_path = os.getenv('BOTCUBE_CHECKPOINT_PATH', '').strip()
    if checkpoint_path:
        return local_memory_backend.build_checkpointer(checkpoint_path)
    return inmem_memory_backend.build_checkpointer()


def _build_store() -> AgentCoreMemoryStore | InMemoryStore:
    """Return the selected memory backend's store."""
    if AGENTCORE_MEMORY_ID:
        return agentcore_memory_backend.build_store(
            AGENTCORE_MEMORY_ID,
            broker=True,
            region_name=AGENTCORE_REGION,
        )
    return inmem_memory_backend.build_store()


def _prewarm_ltm(
    store: AgentCoreMemoryStore,
    actor_id: str,
    *,
    thread_id: str | None = None,
) -> str | None:
    """Fetch this actor's UserPreference records for memory injection.

    Listing avoids semantic relevance cutoffs that can silently drop durable
    preferences while still filtering the shared strategy namespace client-side.
    Also reads back Pending Memory (explicit saves from today's and
    yesterday's sessions) while asynchronous strategy extraction catches up.
    """
    current = utc_now()
    preference_records, fact_records = actor_memory_records(
        store.client,
        memory_id=AGENTCORE_MEMORY_ID,
        actor_id=actor_id,
        belongs=lambda record, actor: _require_cartridge().record_belongs_to_actor(record, actor),  # pragma: no mutate: every cartridge owns records as actor_identity, the default
    )
    preferences = _record_texts(preference_records)
    facts = _record_texts(fact_records)

    pending_memory_events = _list_pending_memory_events(store, actor_id, now=current, thread_id=thread_id)

    facts = [*pending_memory_texts(pending_memory_events, now=current), *facts]

    return _render_ltm_context(preferences, facts)


def _list_pending_memory_events(
    store: AgentCoreMemoryStore,
    actor_id: str,
    *,
    now: datetime,
    thread_id: str | None,
) -> list[EventTypeDef]:
    events: list[EventTypeDef] = []
    for session_id in pending_memory_session_ids(now, actor_id=actor_id, thread_id=thread_id):
        kwargs: dict[str, Any] = {
            'memoryId': AGENTCORE_MEMORY_ID,
            'actorId': actor_id,
            'sessionId': session_id,
            'includePayloads': True,
            'maxResults': 100,
        }
        while True:
            try:
                response = store.client.list_events(**kwargs)
            except store.client.exceptions.ResourceNotFoundException:
                break
            events += response['events']
            if 'nextToken' not in response:
                break
            kwargs['nextToken'] = response['nextToken']
    return events


def _record_texts(records: Sequence[Mapping[str, Any]]) -> list[str]:
    texts: list[str] = []
    for record in records:
        text = record_text(record)
        if text:
            texts.append(text)
    return texts


def _render_ltm_context(
    preferences: Sequence[str],
    facts: Sequence[str],
) -> str | None:
    sections: list[str] = []
    preference_spillover = len(preferences) > LTM_PREFERENCE_LIMIT
    fact_spillover = len(facts) > LTM_FACT_LIMIT
    preference_lines = [f'- {p}' for p in preferences[:LTM_PREFERENCE_LIMIT]]
    if preference_lines:
        sections.append(LTM_PREFERENCE_SECTION_LABEL + '\n' + '\n'.join(preference_lines))

    fact_lines = [f'- {fact}' for fact in facts[:LTM_FACT_LIMIT]]
    if fact_lines:
        sections.append(LTM_FACT_SECTION_LABEL + '\n' + '\n'.join(fact_lines))

    if preference_spillover or fact_spillover:
        sections.append(LTM_SPILLOVER_NOTE)

    return '\n\n'.join(sections) or None


def _workspace() -> Path:
    """The agent's working directory: BOTCUBE_WORKSPACE (the Runtime's session storage), else home."""
    workspace = os.getenv('BOTCUBE_WORKSPACE', '').strip()
    return Path(workspace) if workspace else Path.home()


def _ltm_memory_path(conversation_id: str, actor_id: str) -> Path:
    return (
        _workspace()
        / 'botcube-harness-deepagents'
        / 'threads'
        / _require_cartridge().sanitize_actor_id(conversation_id)
        / 'actors'
        / _require_cartridge().actor_path_segment(actor_id)
        / MEMORY_FILENAME
    )


def _get_agent(
    *,
    actor_id: str,
    session_user_id: str,
    persistent_memory: bool,
    model: str | None = None,
    effort: str | None = None,
    thread_id: str | None = None,
    invocation_prompt: str = '',
    environment: Mapping[str, str] | None = None,
    model_relay: ModelRelay | None = None,
    documents: AgentDocuments | None = None,
    memory_revision: int = 0,  # pragma: no mutate: any constant serves callers that never edit Memory
    syncs_files: bool = False,
) -> LangGraphAgent:
    """Return the cached agent for the requested model/effort, building on first use.

    The Session's checkpoints are filed under (session_user_id, thread_id): the
    Session's stored filing ID, which a claimed Session keeps (ADR 0067 §7).
    Memory is the requester's (actor_id). The Chat Service forwards both; they
    are never resolved here (ADR 0068).
    """
    conversation_id = thread_id or 'default'
    resolved_model = resolve_model(model)
    resolved_effort = resolve_effort(effort)
    environment_key = _require_cartridge().environment_cache_key(environment)
    key = _AgentKey(
        conversation_id,
        actor_id,
        session_user_id,
        persistent_memory,
        resolved_model,
        resolved_effort,
        environment_key,
        documents.cache_key() if documents else '',
        memory_revision,
        syncs_files,
        invocation_prompt,
    )
    if model_relay is not None:
        _MODEL_RELAYS[key] = model_relay
    cached = _AGENTS.get(key)
    if cached is not None:
        backend = _AGENT_BACKENDS[key]
        _apply_environment(backend, environment)
        _BACKEND_BY_AGENT[cached] = backend
        return cached

    store = _ensure_memory_backends()
    backend = _backend_for((conversation_id, actor_id, environment_key), environment)
    ltm_context = _thread_ltm_context(conversation_id, actor_id, memory_revision, store) if persistent_memory else None

    m = install_prompt_cache_usage_callback(
        build_model(
            model=model,
            effort=effort,
            max_tokens=positive_int('BOTCUBE_TURN_MAX_TOKENS', 16000),
            relay=None if model_relay is None else lambda: _MODEL_RELAYS[key],
        )
    )
    prompt_cache_middleware = PromptCacheUsageMiddleware(
        thread_id=conversation_id,
        model=resolved_model,
        effort=resolved_effort,
    )
    middleware = [
        _AnsweredToolResultsMiddleware(),
        _ExecuteDescriptionMiddleware(_require_cartridge().execute_description),
        prompt_cache_middleware,
    ]
    tools: list[Any] = [propose_scheduled_task]
    if persistent_memory:
        memory_tools, memory_middleware = _memory_tools(store, actor_id, conversation_id)
        tools.extend(memory_tools)
        middleware.extend(memory_middleware)
    if documents:
        tools.extend(agent_document_tools(documents))
    files_line = files_prompt(excluded_paths(_require_cartridge().skills)) if syncs_files else ''
    cartridge = _require_cartridge()
    system_prompt = '\n\n'.join(
        part for part in (AGENT_SYSTEM_PROMPT, cartridge.system_prompt, invocation_prompt, files_line, documents and documents.prompt()) if part
    )
    graph = build_agent(
        model=m,
        tools=tools,
        middleware=middleware,
        system_prompt=system_prompt,
        # AgentCore LTM is the only persistent memory store (ADR 0031);
        # build_agent appends the prewarmed ltm.md render file as the sole
        # memory source.
        memory=[],
        ltm_context=ltm_context,
        memory_path=_ltm_memory_path(conversation_id, actor_id),
        backend=backend,
        skills=_require_cartridge().skills,
        checkpointer=_CHECKPOINTER,
        # Guests get no store: nothing in their graph may reach memory.
        store=store if persistent_memory else None,
    )
    config = {
        'recursion_limit': graph.config['recursion_limit'],
        'configurable': {'actor_id': session_user_id},
    }
    # LangGraphAgent requires a name but reads it only in clone() and ag_ui's
    # add_langgraph_fastapi_endpoint, neither of which the Harness calls; no event,
    # checkpoint or log carries it. The _SessionAgent call below stays mutated, and dropping
    # the name there fails the required argument.
    identity: dict[str, Any] = {'name': _require_cartridge().agent_name}  # pragma: no mutate: the name is never read
    agent = _SessionAgent(**identity, graph=graph, config=config)
    _AGENTS[key] = agent
    _AGENT_BACKENDS[key] = backend
    _BACKEND_BY_AGENT[agent] = backend
    return agent


def _ensure_memory_backends() -> AgentCoreMemoryStore | InMemoryStore:
    global _CHECKPOINTER, _STORE
    if _STORE is not None:
        return _STORE
    # Build core dependencies into locals first — publish only if they
    # succeed, so a transient failure is retried on the next request
    # instead of leaving the checkpointer/store permanently None.
    checkpointer = _build_checkpointer()
    store = _build_store()
    _CHECKPOINTER = checkpointer
    _STORE = store
    return store


def _backend_for(
    backend_key: tuple[str, str, tuple[tuple[str, str], ...]],
    environment: Mapping[str, str] | None,
) -> LocalShellBackend:
    backend = _BACKENDS.get(backend_key)
    if backend is None:
        backend = _require_cartridge().build_backend(dict(environment or {}))
        _BACKENDS[backend_key] = backend
    else:
        _apply_environment(backend, environment)
    return backend


def _thread_ltm_context(
    conversation_id: str,
    actor_id: str,
    memory_revision: int,
    store: AgentCoreMemoryStore | InMemoryStore,
) -> str | None:
    """Prewarm the actor's long-term memory once per conversation and Memory revision."""
    ltm_key = (conversation_id, actor_id, memory_revision)
    if ltm_key not in _THREAD_LTM_CONTEXTS:
        _THREAD_LTM_CONTEXTS[ltm_key] = _memory_backend(store).prewarm_ltm(
            store,
            actor_id,
            thread_id=conversation_id,
        )
    return _THREAD_LTM_CONTEXTS[ltm_key]


def _memory_tools(
    store: AgentCoreMemoryStore | InMemoryStore,
    actor_id: str,
    conversation_id: str,
) -> tuple[list[Any], list[Any]]:
    backend_options = {} if isinstance(store, InMemoryStore) else {'memory_id': AGENTCORE_MEMORY_ID}
    return _memory_backend(store).build_memory_tools(
        store=store,
        actor_id=actor_id,
        thread_id=conversation_id,
        **backend_options,
    )


def _memory_backend(store: AgentCoreMemoryStore | InMemoryStore) -> Any:
    """The memory backend module whose factory slots serve this store."""
    return inmem_memory_backend if isinstance(store, InMemoryStore) else agentcore_memory_backend


def _apply_environment(backend: LocalShellBackend, environment: Mapping[str, str] | None) -> None:
    if not environment:
        return
    env = backend._env
    for key, value in environment.items():
        env[str(key)] = str(value)


def _apply_session_env(context: Any, backend: LocalShellBackend) -> None:
    """Update the invoking agent's backend env with the per-request session id.

    Takes the backend bound to the selected agent, not the module global —
    a concurrent invocation for another thread/account can swap the global
    between agent selection and this call, and a stolen owner session id can
    break an invocation-token session match.
    """
    _require_cartridge().apply_session_id(backend, context.session_id)


def _require_session_user_id(session_user_id: str | None) -> str:
    if not session_user_id:
        raise MissingUserIdError(
            'Invocation carries no Session filing ID; the Chat Service must forward sessionUserId'
        )
    return session_user_id


async def invoke(input_data: RunAgentInput, context: _RequestContext):
    forwarded = input_data.forwarded_props
    if not isinstance(forwarded, dict):
        forwarded = {}
        input_data.forwarded_props = forwarded
    warmup = forwarded.get('warmup')
    session_user_id = forwarded.get('sessionUserId')
    if warmup and not session_user_id:
        # A warmup that names no requester only boots the Sandbox.
        return
    if forwarded.get('stop'):
        session_user_id = _require_session_user_id(session_user_id)
        # AgentCore keeps a Turn running after its caller goes away, so the Chat Service stops it by name.
        _SESSION_TURNS.stop((session_user_id, input_data.thread_id), input_data.run_id)
        return
    documents = pop_agent_documents(forwarded)
    files = pop_files_sync(forwarded)
    memory_revision = forwarded.pop('memoryRevision', 0)  # pragma: no mutate: any constant serves callers that never edit Memory
    if type(memory_revision) is not int:
        raise InvalidMemoryRevisionError('memoryRevision must be a whole number')
    auth = _require_cartridge().prepare_invocation(input_data)
    forwarded.pop('sessionUserId', None)
    if not auth.actor_id:
        raise MissingUserIdError(
            'Invocation carries no user ID; the Chat Service must forward the account ID'
        )
    session_user_id = _require_session_user_id(session_user_id)
    capability_data = forwarded.pop('turnMemory', None)
    if warmup and AGENTCORE_MEMORY_ID:
        return
    capability = None
    if AGENTCORE_MEMORY_ID:
        if not isinstance(capability_data, dict) or not all(
            isinstance(capability_data.get(key), str) and capability_data[key] for key in ('url', 'token')
        ):
            raise MissingUserIdError('Invocation carries no Turn Memory capability')
        capability = MemoryCapability(capability_data['url'], capability_data['token'], auth.actor_id)
    with turn_memory(capability):
        async for event in _invoke_agent(input_data, context, forwarded, auth, session_user_id,
                                       documents, memory_revision, files, warmup):
            yield event


async def _invoke_agent(input_data: RunAgentInput, context: _RequestContext, forwarded: dict[str, Any],
                        auth: Any, session_user_id: str, documents: Any, memory_revision: int,
                        files: FilesSync | None, warmup: Any):
    agent = _get_agent(
        actor_id=auth.actor_id,
        session_user_id=session_user_id,
        persistent_memory=auth.persistent_memory,
        model=forwarded.get('model'),
        effort=forwarded.get('effort'),
        thread_id=input_data.thread_id,
        invocation_prompt=auth.system_prompt,
        environment=auth.environment,
        model_relay=auth.model_relay,
        documents=documents,
        memory_revision=memory_revision,
        syncs_files=files is not None,
    )
    if (timing := answer_timing.current()) is not None:
        timing.prepared()
    if warmup:
        # The requester's agent is cached for their next Turn, so it starts without the build.
        return
    backend = _BACKEND_BY_AGENT[agent]
    _apply_session_env(context, backend)
    async with aclosing(_SESSION_TURNS.stream(
        (session_user_id, input_data.thread_id), agent, input_data, files, Path(backend.cwd), context,
    )) as events:
        async for event in events:
            yield event


@dataclass
class _Turn:
    """One Turn on a Session: stopping it cancels its graph work, or the work it has yet to start."""

    run_id: str
    work: asyncio.Task[None] | None = None
    stopped: bool = False
    finished: bool = False

    def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        if self.work is not None and not self.finished:
            self.work.cancel()


class _OpenReply:
    """The text the run's model call is streaming: Stop cancels the call before LangGraph records it.

    The text ends before the call does when the model goes on to a tool call, so
    only the tool's result, which follows the recorded call, closes the reply.
    """

    def __init__(self) -> None:
        self.message_id = ''
        self.text = ''

    def watching(self, put: Callable[[Any], None]) -> Callable[[Any], None]:
        def watched(event: Any) -> None:
            if event.type == EventType.TEXT_MESSAGE_START:
                self.message_id, self.text = event.message_id, ''
            elif event.type == EventType.TEXT_MESSAGE_CONTENT:
                self.text += event.delta
            elif event.type == EventType.TOOL_CALL_RESULT:
                self.message_id, self.text = '', ''
            put(event)

        return watched

    async def keep(self, agent: LangGraphAgent, session: tuple[str, str | None]) -> None:
        """Record the text the user already read as the agent's answer, under its streamed ID."""
        if not self.text:
            return
        config = _session_config(session)
        recorded = (await agent.graph.aget_state(config)).values['messages']
        # A model call that finished, as one whose tool Stop cut short, is already recorded.
        if isinstance(recorded[-1], AIMessage):
            return
        await agent.graph.aupdate_state(config, {'messages': [AIMessage(self.text, id=self.message_id)]}, as_node='model')


class _SessionTurns:
    """Own replacement, Stop and streaming until each Turn's checkpoint flush settles."""

    def __init__(self) -> None:
        # A newer Turn stops the Session's latest one, including work not yet started.
        self._turns: dict[tuple[str, str | None], _Turn] = {}
        # The lock covers graph work and checkpoint settlement, even after Stop.
        self._locks: dict[tuple[str, str | None], asyncio.Lock] = {}
        self._flush_failures: dict[tuple[str, str | None], Exception] = {}
        self._end = object()

    def stop(self, session: tuple[str, str | None], run_id: str) -> None:
        turn = self._turns.get(session)
        if turn is not None and turn.run_id == run_id:
            turn.stop()

    async def stream(
        self,
        session: tuple[str, str | None],
        agent: LangGraphAgent,
        input_data: RunAgentInput,
        files: FilesSync | None,
        root: Path,
        context: _RequestContext,
    ) -> AsyncGenerator[Any, None]:
        previous = self._turns.get(session)
        if previous is not None:
            previous.stop()
        self._turns[session] = turn = _Turn(input_data.run_id)
        queue: asyncio.Queue[Any] = asyncio.Queue()
        run = asyncio.create_task(self._run(session, turn, agent, input_data, files, root, context, queue.put_nowait))
        def completed(work: asyncio.Task[None]) -> None:
            if not work.cancelled() and (failure := work.exception()) is not None:
                log.error(
                    'Harness Turn failed run_id=%s code=%s', turn.run_id,
                    getattr(failure, 'code', 'INTERNAL_ERROR'),
                    exc_info=(type(failure), failure, failure.__traceback__),
                )

        run.add_done_callback(completed)
        try:
            while (event := await queue.get()) is not self._end:
                yield event
                if event.type == EventType.RUN_FINISHED:
                    return
            run.result()
        finally:
            # Stop or a lost client: only the Turn's graph work is cancelled, never its flush.
            turn.stop()

    async def _run(
        self,
        session: tuple[str, str | None],
        turn: _Turn,
        agent: LangGraphAgent,
        input_data: RunAgentInput,
        files: FilesSync | None,
        root: Path,
        context: _RequestContext,
        put: Callable[[Any], None],
    ) -> None:
        """Stop leaves the stopped Turn running here. Were the next Turn to start
        before the stopped one's checkpoints persist, the stopped Turn's would
        become the Session's latest, and replay would lose the next Turn.
        Nothing cancels this task, so nothing interrupts the flush.
        """
        trace_context = (
            baggage.set_baggage('session.id', context.session_id)
            if context.session_id else otel_context.get_current()
        )
        trace_context = baggage.set_baggage('run.id', input_data.run_id, context=trace_context)
        trace_token = otel_context.attach(trace_context)
        try:
            async with self._locks.setdefault(session, asyncio.Lock()):
                if turn.stopped:
                    put(_stopped())
                    return
                if (failure := self._flush_failures.pop(session, None)) is not None:
                    raise failure
                reply = _OpenReply()

                completion: RunFinishedEvent | None = None

                def publish(event: Any) -> None:
                    nonlocal completion
                    if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
                        turn.finished = event.type == EventType.RUN_FINISHED
                        completion = event
                        return
                    put(event)
                # Graph work and settlement share one read of the Session record.
                with reading_once():
                    with prompt_cache_turn(context.session_id):
                        turn.work = asyncio.create_task(_turn_events(agent, input_data, files, root, reply.watching(publish)))
                    await asyncio.wait([turn.work])
                    try:
                        if not turn.work.cancelled():
                            turn.work.result()
                            if files is not None and completion is not None and completion.type == EventType.RUN_FINISHED:
                                started = perf_counter()
                                await asyncio.to_thread(files.push, root, excluded_paths(_require_cartridge().skills))
                                log.info('Harness Files publication timing run_id=%s push_ms=%.3f',
                                         turn.run_id, (perf_counter() - started) * 1000)
                    finally:
                        await self._settle(session, turn, agent, reply if turn.work.cancelled() else None)
                if turn.work.cancelled():
                    put(_stopped())
                elif completion is not None:
                    put(completion)
        except Exception as failure:
            if turn.finished:
                self._flush_failures[session] = failure
            raise
        finally:
            otel_context.detach(trace_token)
            # Still the latest, no Turn waits on the lock: the idle Session keeps neither.
            if self._turns.get(session) is turn:
                del self._turns[session], self._locks[session]
            put(self._end)

    async def _settle(
        self, session: tuple[str, str | None], turn: _Turn, agent: LangGraphAgent,
        cut: _OpenReply | None,
    ) -> None:
        """Every settled Turn snapshots, finished, stopped or failed: each may have saved messages.
        A settlement failure fails the next Turn.
        """
        try:
            try:
                if cut is not None:
                    await cut.keep(agent, session)
            finally:
                if _DEFERRED_SAVER is not None:
                    await _DEFERRED_SAVER.aflush((session[0], session[1]) if session[1] else None)
            await _snapshot_messages(session, agent, turn.run_id)
        except Exception as e:
            self._flush_failures[session] = e
            raise


_SESSION_TURNS = _SessionTurns()


def _stopped() -> RunErrorEvent:
    return RunErrorEvent(message='The Turn was stopped, or a newer Turn on this Session replaced it', code='TURN_STOPPED')


def _session_config(session: tuple[str, str | None]) -> RunnableConfig:
    session_user_id, thread_id = session
    return {'configurable': {'thread_id': thread_id, 'actor_id': session_user_id}}


async def _snapshot_messages(session: tuple[str, str | None], agent: LangGraphAgent, run_id: str) -> None:
    """Snapshot the Session's messages beside its record; the flushed Turn's buffer holds its state."""
    session_user_id, thread_id = session
    # A Turn without a thread runs on one ag_ui_langgraph makes up for it, which no history read names.
    if not thread_id:
        return
    snapshot = await state_snapshot(agent.graph, _session_config(session), run_id)
    if snapshot is not None:
        # Every backend keeps the snapshot beside its record (messages_snapshot.py).
        checkpointer: Any = agent.graph.checkpointer
        await checkpointer.awrite_messages_snapshot(session_user_id, thread_id, snapshot)


async def _turn_events(
    agent: LangGraphAgent,
    input_data: RunAgentInput,
    files: FilesSync | None,
    root: Path,
    put: Callable[[Any], None],
) -> None:
    excluded = excluded_paths(_require_cartridge().skills)
    if files is not None:
        await asyncio.to_thread(files.pull, root, excluded)
    async for event in agent.run(input_data):
        # The graph's raw events and its state carry the Session's history, which no client reads.
        if event.type not in (EventType.RAW, EventType.STATE_SNAPSHOT):
            put(event.model_copy(update={'raw_event': None}))
            if event.type == EventType.RUN_FINISHED:
                graph_end = getattr(agent, '_graph_ended_at', None)
                if graph_end is not None:
                    log.info('Harness Turn graph timing run_id=%s graph_end_to_completion_ms=%.3f snapshot=omitted',
                             input_data.run_id, (perf_counter() - graph_end) * 1000)


def _is_assistant_text(event: Any) -> TypeGuard[TextMessageContentEvent]:
    return event.type == EventType.TEXT_MESSAGE_CONTENT and bool(event.delta.strip())


def _empty_response_error() -> RunErrorEvent:
    return RunErrorEvent(
        message='Agent run completed without an assistant response',
        code='AGENT_EMPTY_RESPONSE',
    )


async def _events_with_response_check(run_input: RunAgentInput, context: _RequestContext):
    """Relay the run's events, failing a run that finished without assistant text.

    A warmup invocation yields no events, so this check never fails it.
    """
    saw_assistant_text = False
    async for event in invoke(run_input, context):
        saw_assistant_text |= _is_assistant_text(event)
        if event.type == EventType.RUN_FINISHED and not saw_assistant_text:
            event = _empty_response_error()
        yield event


@app.post('/invocations')
async def invocations(request: Request) -> Any:
    """Parse RunAgentInput → run the agent → stream AG-UI events as SSE.

    Malformed bodies get HTTP 400 (the stream hasn't started). Errors raised
    mid-stream are emitted as a RunErrorEvent on the open SSE connection,
    matching the AG-UI spec (parity with AGUIApp).
    """
    receipt = perf_counter()
    try:
        payload = await request.json()
    except Exception as e:
        return JSONResponse({'error': 'Invalid JSON', 'details': str(e)}, status_code=400)

    try:
        run_input = RunAgentInput(**payload)
    except Exception as e:
        return JSONResponse({'error': 'Invalid RunAgentInput', 'details': str(e)}, status_code=400)

    context = _RequestContext(request.headers.get(SESSION_ID_HEADER))
    encoder = EventEncoder(accept=request.headers.get('accept', ''))
    timing = answer_timing.AnswerTiming(run_input.run_id, context.session_id,
        (run_input.forwarded_props or {}).get('model'), receipt)

    async def event_generator():
        token = answer_timing._current.set(timing)
        try:
            async for event in _events_with_response_check(run_input, context):
                frame = encoder.encode(event)
                if _is_assistant_text(event):
                    timing.frame(frame, event.message_id)
                yield frame
        except (
            MissingUserIdError,
            AgentDocumentsError,
            FilesSyncError,
            FilesSyncRecordError,
            InvalidMemoryRevisionError,
            PlanUsageError,
        ) as e:
            log.error('Rejected invocation: %s', e)
            yield encoder.encode(RunErrorEvent(message=str(e), code=e.code))
        except Exception as e:
            log.exception('Error during AG-UI event streaming')
            yield encoder.encode(RunErrorEvent(message=str(e), code='INTERNAL_ERROR'))
        finally:
            answer_timing._current.reset(token)

    return StreamingResponse(_kept_alive(event_generator(), timing), media_type=encoder.get_content_type())


async def _kept_alive(frames: AsyncIterator[str], timing: answer_timing.AnswerTiming | None = None) -> AsyncGenerator[str, None]:
    """`frames`, with `_KEEPALIVE` after each quiet `_KEEPALIVE_SECONDS`.

    One task reads `frames` from start to end, so the Turn's events are made in one context as before.
    """
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def read() -> None:
        try:
            async for frame in frames:
                queue.put_nowait(frame)
        finally:
            queue.put_nowait(None)

    reading = asyncio.create_task(read())
    waiting = asyncio.create_task(queue.get())
    try:
        while True:
            done, _pending = await asyncio.wait({waiting}, timeout=_KEEPALIVE_SECONDS)
            if not done:
                yield _KEEPALIVE
                continue
            frame = waiting.result()
            if frame is None:
                break
            if timing:
                timing.emitted(frame)
            yield frame
            waiting = asyncio.create_task(queue.get())
        await reading
    finally:
        try:
            await _cancel_keepalive_tasks(reading, waiting)
        finally:
            if timing:
                timing.finish()


async def _cancel_keepalive_tasks(*tasks: asyncio.Task[object]) -> None:
    """Join owned reads, accepting only their requested cancellation and propagating cleanup failures."""
    cancelled = [task.cancel() for task in tasks]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for result, requested in zip(results, cancelled, strict=True):
        if isinstance(result, BaseException) and not (requested and isinstance(result, asyncio.CancelledError)):
            raise result


@app.get('/ping')
def ping() -> JSONResponse:
    """Health check — bare ``{"status": "Healthy"}`` with no ``time_of_last_update``.

    Omitting the timestamp lets AgentCore anchor idle to the last /invocations
    (which it tracks independently), so idle microVMs reap at ~900 s instead of
    running to maxLifetime. See ADR 0029.
    """
    return JSONResponse({'status': 'Healthy'})


def main() -> None:
    import uvicorn

    if _cartridge is None:
        module_name = os.getenv('BOTCUBE_CARTRIDGE_MODULE', '').strip()
        if module_name:
            configure_harness_from_module(module_name)
        else:
            configure_installed_cartridge()
    # Prompt cache lines go out bare, one JSON object per line.
    logging.config.dictConfig({
        'version': 1,
        'disable_existing_loggers': False,
        'formatters': {'named': {'format': '%(name)s %(message)s'}},
        'handlers': {
            'named': {'class': 'logging.StreamHandler', 'formatter': 'named'},
            'bare': {'class': 'logging.StreamHandler'},
        },
        'root': {'level': 'INFO', 'handlers': ['named']},
        'loggers': {
            'botcube_harness_deepagents.answer_timing': {'level': 'INFO', 'handlers': ['bare'], 'propagate': False},
            'botcube_harness_deepagents.prompt_cache': {'level': 'INFO', 'handlers': ['bare'], 'propagate': False},
        },
    })
    uvicorn.run(app, host=os.getenv('BOTCUBE_HARNESS_HOST', '0.0.0.0'), port=int(os.getenv('PORT', '8080')))


if __name__ == '__main__':
    main()
