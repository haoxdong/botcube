from __future__ import annotations

import asyncio
import hashlib
import importlib
import importlib.metadata
import json
import logging
import logging.config
import os
import tempfile
import threading
from collections.abc import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing, asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from time import perf_counter
from typing import Any, Literal, NamedTuple, TypeGuard, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ag_ui.core import (
    CustomEvent,
    EventType,
    Message,
    MessagesSnapshotEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
)
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.utils import resolve_reasoning_content
from botcube_cartridge import HarnessDefinition, InvocationAuth, ModelRelay
from deepagents.backends import LocalShellBackend
from deepagents.middleware._utils import append_to_system_message
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.config import get_config
from langgraph.store.memory import InMemoryStore
from opentelemetry import baggage, trace
from opentelemetry import context as otel_context
from pydantic import TypeAdapter
from starlette.types import Receive, Scope, Send

from . import (
    aws_clients,
    message_times,
    process_observation,
    restore_prime,
    session_memory,
    turn_output,
    turn_timing,
)
from .actor_identity import ANONYMOUS_ACTOR_ID
from .agent import build_agent, general_purpose_subagent
from .agent_documents import (
    AgentDocuments,
    AgentDocumentsError,
    agent_document_tools,
    pop_agent_documents,
)
from .conversation import conversation
from .files_sync import (
    Files,
    FilesSyncError,
    FilesSyncRecordError,
    excluded_paths,
    files_prompt,
    pop_files_sync,
)
from .lazy_files import TurnFiles, current_turn_files, turn_files
from .llm import (
    PLAN_MODEL_PREFIX,
    PlanUsageError,
    build_model,
    resolve_effort,
    resolve_model,
)
from .memory import agentcore as agentcore_memory_backend
from .memory import inmem as inmem_memory_backend
from .memory import local as local_memory_backend
from .memory.agentcore import TurnIdentityError
from .memory.agentcore.warm_session import WarmSessionSaver
from .memory_tools import AGENTCORE_MEMORY_ID, AGENTCORE_REGION
from .prompt_cache_observability import (
    PromptCacheUsageMiddleware,
    prompt_cache_turn,
)
from .publish import publish_finished_files, publish_tool
from .scheduled_tasks import propose_scheduled_task
from .session_format import SessionFormatLegacyError, latest_checkpoint
from .shell_backend import WorkerShellBackend
from .snapshot_build import answer_once, prime_process, walk_graph, workspace_at
from .sse import keep_alive
from .steering import SteeringMiddleware, active_steering
from .trace_relay import FailedCalls, counting_failed_calls, harness_trace_relay
from .turn_memory import TurnFeed, TurnFeedError, collecting_turn_feeds
from .turn_state import (
    AnsweredToolResultsMiddleware,
    _OpenReply,
    _session_config,
    _stopped,
    _Turn,
)

log = logging.getLogger(__name__)
AGENT_SYSTEM_PROMPT = """You are the user's own agent, with your own computer, Files and schedule.

<artifacts>
An artifact is a tight, skimmable file in the user's Files: an email draft (`.eml` with `X-Unsent: 1`), or a PDF, PowerPoint or Excel file when the content suits it or the user asks.
</artifacts>

<environment>
pandas, numpy, matplotlib, plotly, openpyxl, python-pptx, python-docx, reportlab, pypdf and rsvg-convert are preinstalled; use them rather than installing packages.
</environment>

<writing>
Write everything BLUF: authoritative and sharp; bold only key words, under 4 at a time; no emoji, no em dashes.
When the user opens the chat, greet them by first name, say in one line what you can do, and pitch one thing their Memory suggests they'd care about.
For longer tasks, share meaningful progress in one sentence.
</writing>

<final_response>
Write it for IM, to be read at a glance. Build it from these modules, in the order that reads best. Show, don't tell: a table or visual beats text whenever it can carry the point. The whole response stays under 100 words.

<modules>
takeaway  1, under 25 words
bullets   0–3, directly under the takeaway, each under 15 words, no final period
table     0–1, under 10 rows and 5 columns
visual    0–2, each one of:
          plotly: fig.write_json('<name>.plotly.json'), embedded as ![<caption>](<published link>)
          mermaid: a ```mermaid block
          svg: embedded as ![<caption>](<published link>)
closing   0–1, under 15 words: conviction, caveat, risk or catalyst
artifact  0–1: for anything the user will present or forward, or details bigger than a chat message, on its own line as [Download <name>](<published link>), never a numbered link
</modules>
</final_response>

<citations>
Link every factual claim to its source, in chat and in artifacts.
In chat, link each claim's key words to its source: `[key words](https://…)`.
</citations>"""


class SessionOpeningError(RuntimeError):
    code = 'SESSION_OPENING_ALREADY_STARTED'


class MissingUserIdError(RuntimeError):
    """The invocation carries no user ID; only the Chat Service resolves identity (ADR 0068)."""

    code = 'MISSING_USER_ID'


@dataclass(frozen=True)
class HarnessCartridge:
    skills: Sequence[str]
    agent_name: str
    system_prompt: str
    prepare_invocation: Callable[[Any], InvocationAuth]
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
    def build_backend(environment: dict[str, str]) -> WorkerShellBackend:
        root = _workspace()
        definition.prepare_root(root)
        return WorkerShellBackend(
            root_dir=root,
            virtual_mode=True,
            env={**definition.build_shell_env(environment), 'PYTHONDONTWRITEBYTECODE': '1'},
            command_prefixes=definition.shell_command_prefixes,
            trace_relay_endpoint=harness_trace_relay(),
            inherit_env=True,
        )

    def apply_session_id(backend: LocalShellBackend, session_id: str | None) -> None:
        cast(WorkerShellBackend, backend).set_environment_variable(  # pragma: no mutate: cast is a runtime no-op
            definition.session_id_env_var,
            str(session_id) if session_id else None,
        )

    configure_harness(
        HarnessCartridge(
            skills=definition.skills,
            agent_name=definition.agent_name,
            system_prompt=definition.system_prompt,
            prepare_invocation=definition.prepare_invocation,
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
_KEEPALIVE_SECONDS = 15.0

class _RuntimeApp(FastAPI):
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] == 'http' and scope['path'] == '/invocations':
            process_observation.mark_ingress(scope)
        await super().__call__(scope, receive, send)


# ADR 0029 uses the AgentCore container protocol, not the SDK's AGUIApp.
app = _RuntimeApp(title='BotCube DeepAgents Harness Runtime', telemetry={'auto_configure': False})


@dataclass
class _RequestContext:
    session_id: str | None


class _AgentKey(NamedTuple):
    conversation_id: str
    actor_id: str
    session_user_id: str
    persistent_memory: bool
    model: str
    effort: str | None
    environment: tuple[tuple[str, str], ...]
    documents: str
    syncs_files: bool
    invocation_prompt: str
    scheduled_run: bool
    agent_system_prompt: str
    cartridge_system_prompt: str | None


def _error_code(error: Exception) -> str:
    if isinstance(error, PlanUsageError):
        return error.code
    if agentcore_memory_backend.is_access_denied(error):
        return 'MEMORY_ACCESS_DENIED'
    return 'INTERNAL_ERROR'


@dataclass
class _Thinking:
    block: int = 0
    index: int | None = None
    # A thought opens at its first words: a model that waits, or reasons and returns no summary, shows none.
    open: bool = False


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
    _asked: int | None = None

    def __init__(self, **kwargs: Any) -> None:
        # The graph's raw events carry the Session's history, which no client reads; skip
        # building and JSON-converting them for every streamed event.
        kwargs.setdefault('emit_raw_events', False)
        super().__init__(**kwargs)
        self._model_lane: str | None = None
        self._thinking: dict[str, _Thinking] = {}

    async def _handle_stream_events(self, input: RunAgentInput) -> AsyncGenerator[Any, None]:
        try:
            async with aclosing(super()._handle_stream_events(input)) as events:
                async for event in events:
                    if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
                        for closed in self._close_thoughts():
                            yield closed
                    yield event
                    if event.type == EventType.RUN_FINISHED:
                        break
        except Exception as error:
            log.exception('Error during graph streaming')
            for closed in self._close_thoughts():
                yield closed
            yield RunErrorEvent(message=str(error) or type(error).__name__, code=_error_code(error))
        finally:
            self._model_lane = None
            self._thinking.clear()
            self.messages_in_process.clear()
            if self._graph_stream is not None:
                await self._graph_stream.aclose()
                self._graph_stream = None

    def _close_thoughts(self) -> list[Any]:
        events = []
        for lane, thought in self._thinking.items():
            self._model_lane = lane
            events.extend(self._thought_end(lane, thought))
        self._thinking.clear()
        return events

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
            run = cast(dict[str, Any], self.active_run)
            yield self._emit_success_finish(thread_id=run['thread_id'], run_id=run['id'])

    def _thought_start(self, lane: str, index: int) -> list[Any]:
        message_id = f'{lane}-reasoning-{index}'
        return [self._dispatch_event(ReasoningStartEvent(message_id=message_id)),
                self._dispatch_event(ReasoningMessageStartEvent(message_id=message_id, role='reasoning'))]

    def _thought_end(self, lane: str, thought: _Thinking) -> list[Any]:
        if not thought.open:
            return []
        thought.open = False
        message_id = f'{lane}-reasoning-{thought.block}'
        return [self._dispatch_event(ReasoningMessageEndEvent(message_id=message_id)),
                self._dispatch_event(ReasoningEndEvent(message_id=message_id))]

    def _reasoning_chunk(self, lane: str, thought: _Thinking, reasoning: Any) -> list[Any]:
        events = []
        if reasoning['text']:
            index = reasoning.get('index', 0)
            if thought.open and thought.index != index:
                events.extend(self._thought_end(lane, thought))
                thought.block += 1
            if not thought.open:
                events.extend(self._thought_start(lane, thought.block))
                thought.open = True
            thought.index = index
            events.append(self._dispatch_event(ReasoningMessageContentEvent(
                message_id=f'{lane}-reasoning-{thought.block}', delta=reasoning['text'])))
        return events

    def _thought_chunk(self, event: Any, lane: str, thought: _Thinking | None, chunk: Any) -> list[Any] | None:
        if thought is None or chunk is None:
            return None
        reasoning = resolve_reasoning_content(chunk)
        if reasoning is not None:
            return self._reasoning_chunk(lane, thought, reasoning)
        if not chunk.text and not chunk.tool_call_chunks:
            self._record_usage(event, chunk.usage_metadata, streamed=True)
            return []
        return None

    async def _handle_model_event(self, event: Any, state: Any) -> AsyncGenerator[Any, None]:
        kind = event.get('event')
        if kind not in {'on_chat_model_start', 'on_chat_model_stream', 'on_chat_model_end'}:
            async for emitted in super()._handle_single_event(event, state):
                yield emitted
            return
        metadata = event.get('metadata', {})
        if metadata.get('lc_source') == 'summarization':
            # The summary stays internal, but its model call spent the Turn's tokens.
            data = event.get('data', {})
            if kind == 'on_chat_model_stream':
                self._record_usage(event, getattr(data.get('chunk'), 'usage_metadata', None), streamed=True)
            elif kind == 'on_chat_model_end':
                self._record_usage(event, getattr(data.get('output'), 'usage_metadata', None), streamed=False)
            return
        lane = event['run_id']
        self._model_lane = lane
        try:
            if kind == 'on_chat_model_start' and metadata.get('botcube_thinking'):
                self._thinking[lane] = _Thinking()
            thought = self._thinking.get(lane)
            chunk = event.get('data', {}).get('chunk')
            handled = self._thought_chunk(event, lane, thought, chunk)
            if handled is not None:
                for emitted in handled:
                    yield emitted
                return
            async with aclosing(self._model_output(event, state, lane, thought)) as events:
                async for emitted in events:
                    yield emitted
        finally:
            self._model_lane = None

    async def _model_output(self, event: Any, state: Any, lane: str, thought: _Thinking | None) -> AsyncGenerator[Any, None]:
        if event['event'] == 'on_chat_model_start' and (files := current_turn_files()) is not None:
            files.prefetch()
        async with aclosing(super()._handle_single_event(event, state)) as events:
            async for emitted in events:
                if thought is not None and emitted.type in {EventType.TEXT_MESSAGE_START, EventType.TOOL_CALL_START}:
                    for closed in self._thought_end(lane, thought):
                        yield closed
                    self._thinking.pop(lane)
                    thought = None
                yield emitted

    def _current_lane(self) -> str:
        return self._model_lane or super()._current_lane()

    async def get_state_and_messages_snapshots(self, config: RunnableConfig) -> AsyncGenerator[Any, None]:
        if self._graph_ended_at is not None:
            return
        state = await self.graph.aget_state(config)
        if not isinstance(state.values, dict):
            raise TypeError('Checkpoint snapshot must contain a state mapping')
        if not (self.emit_subagent_events and cast(dict[str, Any], self.active_run).get('current_subagent_run_id')):
            yield self._dispatch_event(StateSnapshotEvent(snapshot=self.get_state_snapshot(state.values)))
        messages = self._filter_orphan_tool_messages(state.values.get('messages', []))
        projected = TypeAdapter(list[Message]).validate_python(conversation(messages))
        yield self._dispatch_event(MessagesSnapshotEvent(messages=self._merge_subagent_messages(
            self._translate_snapshot_ids(projected))))

    async def prepare_stream(self, input: RunAgentInput, agent_state: Any, config: RunnableConfig) -> Any:
        self._graph_ended_at = None
        self._interrupted = False
        self._thinking.clear()
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
        if (timing := turn_timing.current()) is not None:
            timing.history_messages = len(agent_state.values.get('messages', []))
        configurable = config.setdefault('configurable', {})
        configurable['scheduled_task_model'] = (input.forwarded_props or {}).get('model')
        configurable['timezone'] = (input.forwarded_props or {}).get('timezone')
        self._asked = message_times.turn_start((input.forwarded_props or {}).get('turn_started_at'))
        with turn_timing.phase('state_preparation'):
            prepared = await super().prepare_stream(input, agent_state, config)
        self._graph_stream = prepared.get('stream')
        return prepared

    def langgraph_default_merge_state(self, state: Any, messages: list[Any], input: RunAgentInput) -> Any:
        merged = super().langgraph_default_merge_state(state, messages, input)
        recorded = state.get('messages', [])
        recorded_ids = {message.id for message in recorded}
        answered = {message.tool_call_id for message in recorded if isinstance(message, ToolMessage)}
        called = {call['id'] for message in recorded if isinstance(message, AIMessage) for call in message.tool_calls}
        asked = self._asked
        merged['messages'] = [
            message_times.asked(message, asked)
            if asked is not None and isinstance(message, HumanMessage) and message.id not in recorded_ids else message
            for message in merged['messages']
            if message.id in recorded_ids
            or not (
                (isinstance(message, ToolMessage) and message.tool_call_id in answered)
                or (isinstance(message, AIMessage) and message.tool_calls and {call['id'] for call in message.tool_calls} <= called)
            )
        ]
        return merged



def now() -> datetime:
    return datetime.now(UTC)


class _TodayMiddleware(AgentMiddleware):
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


_AGENTS: dict[_AgentKey, LangGraphAgent] = {}
_CHECKPOINTER: Any | None = None
_STORE: InMemoryStore | None = None
_BACKENDS: dict[tuple[str, str, str, tuple[tuple[str, str], ...]], LocalShellBackend] = {}
_BACKEND_BY_AGENT: dict[Any, LocalShellBackend] = {}
_MODEL_RELAYS: dict[_AgentKey, ModelRelay] = {}
_CACHE_LOCK = threading.RLock()


def _build_checkpointer() -> Any:
    checkpoint_path = os.getenv('BOTCUBE_CHECKPOINT_PATH', '').strip()
    if checkpoint_path:
        return local_memory_backend.build_checkpointer(checkpoint_path)
    return inmem_memory_backend.build_checkpointer()


def _workspace() -> Path:
    root = Path(os.getenv('BOTCUBE_WORKSPACE', '').strip() or Path.home())
    root.mkdir(parents=True, exist_ok=True)
    return root


def _user_prompt(profile: str, synced_skills: Sequence[str] | None, documents: AgentDocuments | None) -> str:
    return '\n\n'.join(
        part
        for part in (
            profile and f'<user_profile>\n{profile}\n</user_profile>',
            synced_skills is not None and f'<files>\n{files_prompt(excluded_paths(synced_skills))}\n</files>',
            documents.prompt() if documents else '',
        )
        if part
    )


def _cartridge_instructions(cartridge: HarnessCartridge, candidate: str | None) -> str:
    return cartridge.system_prompt if candidate is None else candidate


def _get_agent(
    *,
    actor_id: str,
    session_user_id: str,
    persistent_memory: bool,
    model: str | None = None,
    effort: str | None = None,
    thread_id: str | None = None,
    invocation_prompt: str = '',
    agent_system_prompt: str = AGENT_SYSTEM_PROMPT,
    cartridge_system_prompt: str | None = None,
    environment: Mapping[str, str] | None = None,
    model_relay: ModelRelay | None = None,
    documents: AgentDocuments | None = None,
    syncs_files: bool = False,
    scheduled_run: bool = False,
    preparing: bool = False,
) -> LangGraphAgent:
    with _CACHE_LOCK:
        conversation_id = thread_id or 'default'
        resolved_model = resolve_model(model)
        resolved_effort = resolve_effort(effort)
        environment_key = _require_cartridge().environment_cache_key(
            {name: value for name, value in (environment or {}).items() if name != 'AGENT_BROWSER_CDP'}
        )
        key = _AgentKey(
            conversation_id,
            actor_id,
            session_user_id,
            persistent_memory,
            resolved_model,
            effort,
            environment_key,
            documents.cache_key() if documents else '',
            syncs_files,
            invocation_prompt,
            scheduled_run,
            agent_system_prompt,
            cartridge_system_prompt,
        )
        cached = _AGENTS.get(key)
        if preparing and cached is not None:
            return cached
        if model_relay is not None:
            _MODEL_RELAYS[key] = model_relay
        if cached is not None:
            backend = _BACKEND_BY_AGENT[cached]
            _apply_environment(backend, environment)
            return cached

        with turn_timing.phase('memory_backends'):
            store = _ensure_memory_backends()
        with turn_timing.phase('workspace'):
            backend = _backend_for((conversation_id, session_user_id, actor_id, environment_key), environment)

        with turn_timing.phase('model_client'):
            m = build_model(
                model=model,
                effort=effort,
                max_tokens=16000,
                relay=None if model_relay is None else lambda: _MODEL_RELAYS[key],
            )
        prompt_cache_middleware = PromptCacheUsageMiddleware(
            thread_id=conversation_id,
            model=resolved_model,
            effort=resolved_effort,
        )
        middleware = [
            AnsweredToolResultsMiddleware(),
            SteeringMiddleware(),
            prompt_cache_middleware,
            message_times.MessageTimesMiddleware(),
        ]
        tools: list[Any] = [] if scheduled_run else [propose_scheduled_task]
        if syncs_files:
            tools.append(publish_tool(Path(backend.cwd), _require_cartridge().skills))
        if persistent_memory:
            memory_tools, memory_middleware = _memory_tools(store, actor_id, conversation_id)
            tools.extend(memory_tools)
            middleware.extend(memory_middleware)
        middleware.append(_TodayMiddleware())
        if documents:
            tools.extend(agent_document_tools(documents))
        cartridge = _require_cartridge()
        cartridge_prompt = _cartridge_instructions(cartridge, cartridge_system_prompt)
        system_prompt = '\n\n'.join(part for part in (agent_system_prompt, cartridge_prompt) if part)
        user_prompt = _user_prompt(invocation_prompt, cartridge.skills if syncs_files else None, documents)
        with turn_timing.phase('graph_build'):
            graph = build_agent(
                model=m,
                tools=tools,
                middleware=middleware,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                backend=backend,
                skills=_require_cartridge().skills,
                subagents=[general_purpose_subagent(cartridge_prompt, cartridge.skills)] if cartridge_prompt else None,
                checkpointer=_CHECKPOINTER,
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
        with turn_timing.phase('stream_adapter'):
            agent = _SessionAgent(**identity, graph=graph, config=config)
        _AGENTS[key] = agent
        _BACKEND_BY_AGENT[agent] = backend
        return agent


def _ensure_memory_backends() -> InMemoryStore | None:
    global _CHECKPOINTER, _STORE
    if AGENTCORE_MEMORY_ID:
        return None
    with _CACHE_LOCK:
        if _STORE is not None:
            return _STORE
        checkpointer = _build_checkpointer()
        store = inmem_memory_backend.build_store()
        _CHECKPOINTER = checkpointer
        _STORE = store
        return store


def _backend_for(
    backend_key: tuple[str, str, str, tuple[tuple[str, str], ...]],
    environment: Mapping[str, str] | None,
) -> LocalShellBackend:
    backend = _BACKENDS.get(backend_key)
    if backend is None:
        backend = _require_cartridge().build_backend(dict(environment or {}))
        _BACKENDS[backend_key] = backend
    else:
        _apply_environment(backend, environment)
    return backend


def _memory_tools(
    store: InMemoryStore | None,
    actor_id: str,
    conversation_id: str,
) -> tuple[list[Any], list[Any]]:
    if AGENTCORE_MEMORY_ID:
        return agentcore_memory_backend.build_memory_tools(actor_id=actor_id, thread_id=conversation_id)
    return inmem_memory_backend.build_memory_tools(store=cast(InMemoryStore, store), actor_id=actor_id, thread_id=conversation_id)


def _agent_and_backend(**kwargs: Any) -> tuple[LangGraphAgent, LocalShellBackend]:
    with _CACHE_LOCK:
        agent = _get_agent(**kwargs)
        backend = _BACKEND_BY_AGENT[agent]
    if (timing := turn_timing.current()) is not None:
        timing.prepared()
    return agent, backend


async def _turn_memory(turn_identity: str, run_id: str) -> tuple[Any, Any]:
    turn = agentcore_memory_backend.next_turn()
    with turn_timing.phase('memory_credentials'):
        return await asyncio.to_thread(
            agentcore_memory_backend.turn_memory, AGENTCORE_MEMORY_ID, turn_identity,
            region_name=AGENTCORE_REGION, run_id=run_id, turn=turn,
        )


async def _turn_agent(
    build: Callable[[], tuple[LangGraphAgent, LocalShellBackend]], turn_identity: str | None, run_id: str, persistent_memory: bool,
) -> tuple[LangGraphAgent, LocalShellBackend]:
    building = asyncio.to_thread(build)
    if not AGENTCORE_MEMORY_ID or turn_identity is None:
        return await building
    built, memory = await asyncio.gather(building, _turn_memory(turn_identity, run_id), return_exceptions=True)
    for outcome in (built, memory):
        if isinstance(outcome, BaseException):
            raise outcome
    agent, backend = cast(tuple[LangGraphAgent, LocalShellBackend], built)
    saver, store = cast(tuple[Any, Any], memory)
    graph = agent.graph.copy({'checkpointer': saver, 'store': store if persistent_memory else None})
    return _SessionAgent(name=agent.name, graph=graph, config=agent.config), backend


def _apply_environment(backend: LocalShellBackend, environment: Mapping[str, str] | None) -> None:
    if not environment:
        return
    env = backend._env
    for key, value in environment.items():
        env[str(key)] = str(value)


def _with_agent_computer(auth: InvocationAuth, forwarded: dict[str, Any], session: tuple[str, str]) -> InvocationAuth:
    cdp_url = forwarded.pop('agentComputerCdpUrl', None)
    if cdp_url is None:
        return auth
    if not isinstance(cdp_url, str) or not cdp_url:
        raise RuntimeError('agentComputerCdpUrl must be a non-empty URL')
    return replace(auth, environment={
        **(auth.environment or {}),
        'AGENT_BROWSER_CDP': cdp_url,
        'AGENT_BROWSER_SESSION': hashlib.sha256(json.dumps(session).encode()).hexdigest()[:32],
        # agent-browser's daemon outlives its browser; idle expiry follows the Turn token.
        'AGENT_BROWSER_IDLE_TIMEOUT_MS': str(60 * 60 * 1000),
    })


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
    handler = _invoke_temporary if forwarded.get('temporary') is True else _invoke_user
    async for event in handler(input_data, context, forwarded):
        yield event


async def _invoke_user(input_data: RunAgentInput, context: _RequestContext, forwarded: dict[str, Any]):
    warmup = forwarded.get('warmup')
    session_user_id = forwarded.get('sessionUserId')
    if warmup and not session_user_id:
        if 'preparationScope' in forwarded:
            _require_session_user_id(session_user_id)
        return
    if forwarded.get('steering'):
        session_user_id = _require_session_user_id(session_user_id)
        accepted = _SESSION_TURNS.steer((session_user_id, input_data.thread_id), input_data)
        yield CustomEvent(name='STEERING_ACCEPTED', value={'accepted': accepted})
        return
    if forwarded.get('stop'):
        session_user_id = _require_session_user_id(session_user_id)
        # AgentCore keeps a Turn running after its caller goes away, so the Chat Service stops it by name.
        _SESSION_TURNS.stop((session_user_id, input_data.thread_id), input_data.run_id)
        return
    documents = pop_agent_documents(forwarded)
    if 'agentSystemPrompt' in forwarded:
        documents = None
    files = pop_files_sync(forwarded)
    with turn_timing.phase('invocation_auth'):
        auth = _require_cartridge().prepare_invocation(input_data)
    forwarded.pop('sessionUserId', None)
    if not auth.actor_id:
        raise MissingUserIdError(
            'Invocation carries no user ID; the Chat Service must forward the account ID'
        )
    session_user_id = _require_session_user_id(session_user_id)
    auth = _with_agent_computer(auth, forwarded, (session_user_id, input_data.thread_id))
    turn_identity = forwarded.pop('turnIdentity', None)
    if AGENTCORE_MEMORY_ID and not (isinstance(turn_identity, str) and turn_identity):
        raise TurnIdentityError('Invocation carries no Turn identity; the Chat Service must forward turnIdentity')
    async for event in _invoke_agent(input_data, context, forwarded, auth, session_user_id,
                                   documents, files, warmup, turn_identity):
        yield event


class InvalidTemporaryChatError(RuntimeError):
    code = 'INVALID_TEMPORARY_CHAT'


async def _invoke_temporary(input_data: RunAgentInput, context: _RequestContext, forwarded: dict[str, Any]):
    allowed = {'temporary', 'model', 'effort', 'stop', 'opening', 'agentIdentity', 'soul'}
    if forbidden := forwarded.keys() - allowed:
        raise InvalidTemporaryChatError(f'Temporary chat cannot carry {", ".join(sorted(forbidden))}')
    if forwarded.get('opening') is True and input_data.messages:
        raise InvalidTemporaryChatError('An opening Turn cannot contain messages')
    session = (None, input_data.thread_id)
    if forwarded.get('stop') is True:
        _SESSION_TURNS.stop(session, input_data.run_id)
        return
    documents = pop_agent_documents(forwarded)

    def build() -> LangGraphAgent:
        cartridge = _require_cartridge()
        graph = build_agent(
            backend=None, skills=(),
            model=build_model(model=forwarded.get('model'), effort=forwarded.get('effort'), max_tokens=16000),
            system_prompt='\n\n'.join(part for part in (AGENT_SYSTEM_PROMPT, cartridge.system_prompt) if part),
            user_prompt=documents.prompt() if documents is not None else '',
            middleware=[AnsweredToolResultsMiddleware(), message_times.MessageTimesMiddleware(), _TodayMiddleware()],
            checkpointer=InMemorySaver(),
        )
        return _SessionAgent(name=cartridge.agent_name, graph=graph, config={'recursion_limit': graph.config['recursion_limit']})

    async def prepare() -> tuple[LangGraphAgent, Path]:
        return await asyncio.to_thread(build), _workspace()

    async with aclosing(_SESSION_TURNS.stream(session, prepare, input_data, None, context)) as events:
        async for event in events:
            yield event


def _opening_prompt(input_data: RunAgentInput, invocation_prompt: str) -> str:
    if (input_data.forwarded_props or {}).get('opening') is not True:
        return invocation_prompt
    if input_data.messages:
        raise SessionOpeningError('An opening Turn cannot contain messages')
    first_name = (input_data.forwarded_props or {}).get('openingFirstName')
    name = f'The user\'s first name is {json.dumps(first_name)}.\n' if first_name else ''
    return invocation_prompt + (
        f'\n\n<chat_opened>\n{name}The user opened this empty chat. Apply the opening greeting instruction in <writing>. '
        'If Memory is empty, skip the Memory pitch; never invent one. '
        'There is no user message to answer.\n</chat_opened>'
    )


def _require_empty_opening_checkpoint(checkpoint: object | None) -> None:
    if checkpoint is not None:
        raise SessionOpeningError('This Session already has a Turn')


async def _invoke_agent(input_data: RunAgentInput, context: _RequestContext, forwarded: dict[str, Any],
                        auth: Any, session_user_id: str, documents: Any,
                        files: Files | None, warmup: Any, turn_identity: str | None):
    session = (session_user_id, input_data.thread_id)
    persistent_memory = auth.persistent_memory and auth.actor_id != ANONYMOUS_ACTOR_ID and 'agentSystemPrompt' not in forwarded
    opening = forwarded.get('opening') is True
    build = partial(
        _agent_and_backend,
        actor_id=auth.actor_id,
        session_user_id=session_user_id,
        persistent_memory=persistent_memory,
        model=forwarded.get('model'),
        effort=forwarded.get('effort'),
        thread_id=input_data.thread_id,
        invocation_prompt=_opening_prompt(input_data, auth.system_prompt),
        agent_system_prompt=forwarded.get('agentSystemPrompt', AGENT_SYSTEM_PROMPT),
        cartridge_system_prompt=forwarded.get('cartridgeSystemPrompt'),
        environment=auth.environment,
        model_relay=auth.model_relay,
        documents=documents,
        syncs_files=files is not None,
        scheduled_run=forwarded.get('scheduledRun') is True,
        preparing=bool(warmup),
    )
    if not warmup:
        timing = turn_timing.current()
        warmed = session_memory.take_warmup(
            session, auth.actor_id, timing.receipt if timing is not None else perf_counter(),
        )

        async def prepare() -> tuple[LangGraphAgent, Path]:
            agent, backend = await _turn_agent(build, turn_identity, input_data.run_id, persistent_memory)
            if AGENTCORE_MEMORY_ID and persistent_memory:
                store = agent.graph.store
                session_memory.prefetch(lambda: agentcore_memory_backend.opening(store, auth.actor_id), input_data.run_id, warmed)
            _require_cartridge().apply_session_id(backend, input_data.thread_id)
            return agent, Path(backend.cwd)

        read_locked = partial(
            _read_turn_checkpoint, session=session, opening=opening, actor_id=auth.actor_id,
            run_id=input_data.run_id, epoch=forwarded.get('sessionSnapshotEpoch'), turn_identity=turn_identity,
        )

        candidate = forwarded.get('agentSystemPrompt')
        async with aclosing(_SESSION_TURNS.stream(session, prepare, input_data, files, context, read_locked)) as events:
            async for event in events:
                yield event
                if candidate is not None and event.type == EventType.RUN_STARTED:
                    yield CustomEvent(name='AGENT_SYSTEM_PROMPT', value=hashlib.sha256(candidate.encode()).hexdigest())
        return
    reads_history = forwarded.get('preparationScope', 'recorded') != 'startup'
    async with _SESSION_TURNS.preparation(session) as allowed:
        if allowed:
            await _prepare_agent(
                build, turn_identity, input_data.run_id, persistent_memory, session, auth.actor_id,
                files, reads_history,
            )
    yield _preparation_event(input_data, 'prepared' if allowed else 'skipped-busy')


async def _read_turn_checkpoint(
    agent: LangGraphAgent, *, session: tuple[str | None, str | None], opening: bool,
    actor_id: str, run_id: str, epoch: Any, turn_identity: str | None,
) -> None:
    saver = getattr(agent.graph, 'checkpointer', None)
    if isinstance(saver, WarmSessionSaver):
        saver.admit_finished_reuse(
            _session_config(session), actor_id, run_id,
            agentcore_memory_backend.finished_snapshot_epoch(turn_identity, epoch),
        )
    with turn_timing.phase('checkpoint_read'):
        saved = await latest_checkpoint(agent.graph, _session_config(session))
        if opening:
            _require_empty_opening_checkpoint(saved)


def _settle_finished_reuse(saver: Any, finished: bool) -> None:
    if isinstance(saver, WarmSessionSaver):
        if finished:
            saver.finish_run()
        else:
            saver.abandon_run()


async def _prepare_agent(
    build: Callable[[], tuple[LangGraphAgent, LocalShellBackend]], turn_identity: str | None,
    run_id: str, persistent_memory: bool, session: tuple[str, str], actor_id: str,
    files: Files | None, reads_history: bool,
) -> None:
    memory_warmup = (
        session_memory.begin_warmup(session, actor_id)
        if reads_history and AGENTCORE_MEMORY_ID and persistent_memory else None
    )
    memory_read: session_memory.OpeningRead | None = None
    try:
        agent, backend = await _turn_agent(
            build, turn_identity if reads_history else None, run_id, persistent_memory,
        )

        async def read_history() -> None:
            nonlocal memory_read
            reads: list[Awaitable[Any]] = [latest_checkpoint(agent.graph, _session_config(session))]
            if AGENTCORE_MEMORY_ID and persistent_memory:
                reads.append(session_memory.read_warmup(
                    lambda: agentcore_memory_backend.opening(agent.graph.store, actor_id),
                ))
            with turn_timing.phase('warmup_history'):
                results = await asyncio.gather(*reads)
                if memory_warmup is not None:
                    memory_read = results[1]

        pull = asyncio.create_task(
            TurnFiles(files, Path(backend.cwd), excluded_paths(_require_cartridge().skills)).aensure()
        )
        work = [pull, asyncio.create_task(read_history())] if reads_history else [pull]
        await _finish_preparation(work)
    except BaseException:
        if memory_warmup is not None:
            session_memory.finish_warmup(session, memory_warmup, None)
        raise
    if memory_warmup is not None:
        session_memory.finish_warmup(session, memory_warmup, memory_read)


async def _finish_preparation(work: list[asyncio.Task[Any]]) -> None:
    try:
        done, _ = await asyncio.wait(work, return_when=asyncio.FIRST_EXCEPTION)
    finally:
        # A failure stops the history read; the pull, mutating the workspace, ends before the lock is released.
        for task in work[1:]:
            task.cancel()
        await asyncio.wait(work)
    for task in [*done, *work]:
        task.result()


def _preparation_event(
    run_input: RunAgentInput, outcome: Literal['prepared', 'skipped-busy', 'failed'],
    error: RunErrorEvent | None = None,
) -> CustomEvent:
    value: dict[str, Any] = {'runId': run_input.run_id, 'sessionId': run_input.thread_id, 'outcome': outcome}
    if error is not None:
        value['error'] = {'code': error.code, 'message': error.message}
    return CustomEvent(name='SESSION_PREPARATION', value=value)


class _SessionTurns:
    """Own replacement, Stop and streaming until each Turn's checkpoints persist."""

    def __init__(self) -> None:
        self._turns: dict[tuple[str | None, str | None], _Turn] = {}
        self._locks: dict[tuple[str | None, str | None], asyncio.Lock] = {}
        self._flush_failures: dict[tuple[str | None, str | None], Exception] = {}
        self._feeds: dict[tuple[str | None, str | None], asyncio.Task[None]] = {}
        self._end = object()

    @asynccontextmanager
    async def preparation(self, session: tuple[str | None, str | None]) -> AsyncGenerator[bool, None]:
        lock = self._locks.setdefault(session, asyncio.Lock())
        turn = self._turns.get(session)
        if lock.locked() or (turn is not None and not turn.finished):
            yield False
            return
        async with lock:
            yield True

    def steer(self, session: tuple[str | None, str | None], input_data: RunAgentInput) -> bool:
        turn = self._turns.get(session)
        if turn is None or turn.stopped or turn.finished:
            return False
        for message in input_data.messages:
            if message.role != 'user' or not isinstance(message.content, str) or not message.content:
                raise ValueError('Steering requires user text messages')
            turn.steering.add(message.id, message.content)
        return True

    def stop(self, session: tuple[str | None, str | None], run_id: str) -> None:
        turn = self._turns.get(session)
        if turn is not None and turn.run_id == run_id:
            turn.stop()

    def _feed(self, session: tuple[str | None, str | None], turn: _Turn, feeds: list[TurnFeed]) -> None:
        if not turn.finished or not feeds:
            return
        previous = self._feeds.get(session)

        async def feed() -> None:
            if previous is not None:
                await asyncio.wait([previous])
            for each in feeds:
                await each()

        def fed(task: asyncio.Task[None]) -> None:
            if self._feeds.get(session) is task:
                del self._feeds[session]
            if not task.cancelled() and isinstance(failure := task.exception(), Exception):
                log.error('Harness Turn feed failed run_id=%s code=%s', turn.run_id, getattr(failure, 'code', 'INTERNAL_ERROR'),
                          exc_info=(type(failure), failure, failure.__traceback__))
                self._flush_failures[session] = failure

        self._feeds[session] = task = asyncio.create_task(feed())
        task.add_done_callback(fed)

    async def stream(
        self,
        session: tuple[str | None, str | None],
        prepare: Callable[[], Awaitable[tuple[LangGraphAgent, Path]]],
        input_data: RunAgentInput,
        files: Files | None,
        context: _RequestContext,
        read_locked: Callable[[LangGraphAgent], Awaitable[None]] | None = None,
    ) -> AsyncGenerator[Any, None]:
        previous = self._turns.get(session)
        if previous is not None:
            previous.stop()
        self._turns[session] = turn = _Turn(input_data.run_id)
        queue: asyncio.Queue[Any] = asyncio.Queue()
        run = asyncio.create_task(self._run(session, turn, prepare, input_data, files, context, queue.put_nowait, read_locked))
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
            # Stop or a lost client: only the Turn's graph work is cancelled, never its checkpoint writes.
            turn.stop()

    async def _run(
        self,
        session: tuple[str | None, str | None],
        turn: _Turn,
        prepare: Callable[[], Awaitable[tuple[LangGraphAgent, Path]]],
        input_data: RunAgentInput,
        files: Files | None,
        context: _RequestContext,
        put: Callable[[Any], None],
        read_locked: Callable[[LangGraphAgent], Awaitable[None]] | None = None,
    ) -> None:
        """Stop leaves the stopped Turn running here. Were the next Turn to start
        before the stopped one's checkpoints persist, the stopped Turn's would
        become the Session's latest, and replay would lose the next Turn.
        LangGraph waits for a cancelled run's checkpoint writes, and nothing cancels this task.
        The Turn prepares while the Session's previous Turn settles.
        """
        trace_context = (
            baggage.set_baggage('session.id', context.session_id)
            if context.session_id else otel_context.get_current()
        )
        trace_context = baggage.set_baggage('run.id', input_data.run_id, context=trace_context)
        trace_token = otel_context.attach(trace_context)
        lock = self._locks.setdefault(session, asyncio.Lock())
        saver: Any = None
        steering_token = active_steering.set((turn.steering, put))
        try:
            agent, root = await prepare()
            async with lock:
                if turn.stopped:
                    put(_stopped())
                    return
                if (failure := self._flush_failures.pop(session, None)) is not None:
                    raise failure
                saver = getattr(getattr(agent, 'graph', None), 'checkpointer', None)
                if read_locked is not None:
                    await read_locked(agent)
                if turn.stopped:
                    _settle_finished_reuse(saver, False)
                    put(_stopped())
                    return
                reply = _OpenReply()

                completion: RunFinishedEvent | None = None

                def publish(event: Any) -> None:
                    nonlocal completion
                    turn.observe(event)
                    if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
                        completion = event
                        return
                    put(event)
                with turn_files(files, root, excluded_paths(_require_cartridge().skills)) as readiness:
                    with prompt_cache_turn(context.session_id), collecting_turn_feeds() as feeds:
                        turn.work = asyncio.create_task(_turn_events(agent, input_data, reply.watching(publish)))
                    await asyncio.wait([turn.work])
                    try:
                        await readiness.settle_prefetch()
                        if not turn.work.cancelled():
                            turn.work.result()
                            readiness.raise_if_failed()
                            await publish_finished_files(files, root, readiness.used, completion, reply.text, _require_cartridge().skills)
                    finally:
                        if turn.work.cancelled():
                            await reply.keep(agent, session)
                            await reply.answer_cut_calls(agent, session)
                if turn.work.cancelled():
                    _settle_finished_reuse(saver, False)
                    reply.finish_stopped(put)
                elif completion is not None:
                    put(completion)
                    self._feed(session, turn, feeds)
                    _settle_finished_reuse(saver, turn.finished_without_interruption(agent))
        except Exception as failure:
            _settle_finished_reuse(saver, False)
            if turn.finished:
                self._flush_failures[session] = failure
            raise
        finally:
            active_steering.reset(steering_token)
            session_memory.settle_prefetch()
            otel_context.detach(trace_token)
            if self._turns.get(session) is turn:
                del self._turns[session], self._locks[session]
            put(self._end)


_SESSION_TURNS = _SessionTurns()


async def _turn_events(
    agent: LangGraphAgent,
    input_data: RunAgentInput,
    put: Callable[[Any], None],
) -> None:
    async for event in agent.run(input_data):
        if event.type != EventType.STATE_SNAPSHOT:
            put(event)
            if event.type == EventType.RUN_FINISHED:
                graph_end = getattr(agent, '_graph_ended_at', None)
                if graph_end is not None:
                    log.info('Harness Turn graph timing run_id=%s graph_end_to_completion_ms=%.3f snapshot=omitted',
                             input_data.run_id, (perf_counter() - graph_end) * 1000)


def _is_assistant_text(event: Any) -> TypeGuard[TextMessageContentEvent]:
    return event.type == EventType.TEXT_MESSAGE_CONTENT and bool(event.delta.strip())


async def _events_with_response_check(run_input: RunAgentInput, context: _RequestContext):
    saw_assistant_text = False
    async for event in invoke(run_input, context):
        saw_assistant_text |= _is_assistant_text(event)
        if event.type == EventType.RUN_FINISHED and not saw_assistant_text:
            event = RunErrorEvent(
                message='Agent run completed without an assistant response',
                code='AGENT_EMPTY_RESPONSE',
                usage=event.usage,
            )
        yield event


@app.post('/invocations')
async def invocations(request: Request) -> Any:
    """Parse RunAgentInput → run the agent → stream AG-UI events as SSE.

    Malformed bodies get HTTP 400 (the stream hasn't started). Errors raised
    mid-stream are emitted as a RunErrorEvent on the open SSE connection,
    matching the AG-UI spec (parity with AGUIApp).
    """
    receipt = perf_counter()
    process_observation.mark('first_invocation')
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
    forwarded = run_input.forwarded_props or {}
    if 'timezone' in forwarded:
        name = forwarded['timezone']
        if not isinstance(name, str):
            return JSONResponse({'error': 'forwardedProps.timezone must be an IANA timezone string'}, status_code=400)
        try:
            ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            return JSONResponse({'error': 'Invalid forwardedProps.timezone', 'details': str(exc)}, status_code=400)
    warmup = bool(forwarded.get('warmup'))
    timing = turn_timing.TurnTiming(
        run_input.run_id, run_input.thread_id, forwarded.get('model'), warmup=warmup, receipt=receipt,
    )

    return StreamingResponse(
        keep_alive(_invocation_frames(run_input, context, encoder, timing), _KEEPALIVE_SECONDS), media_type=encoder.get_content_type(),
    )


async def _invocation_frames(
    run_input: RunAgentInput, context: _RequestContext, encoder: EventEncoder, timing: turn_timing.TurnTiming,
) -> AsyncGenerator[str, None]:
    error: RunErrorEvent | None = None
    failed = finished = False
    calls = FailedCalls()
    reply = _OpenReply()
    observe = reply.watching(lambda event: None)
    forwarded = run_input.forwarded_props or {}
    environment = {
        **os.environ, **{key: value for key, value in forwarded.items() if isinstance(value, str)},
        **(forwarded.get('env') or {}), 'session_id': context.session_id or '',
    }
    try:
        with turn_timing.use(timing), counting_failed_calls(calls):
            try:
                async for event in _events_with_response_check(run_input, context):
                    observe(event)
                    frame = encoder.encode(event)
                    if _is_assistant_text(event):
                        timing.text()
                    failed |= event.type == EventType.RUN_ERROR
                    yield frame
                finished = not failed
            except (
                MissingUserIdError,
                InvalidTemporaryChatError,
                AgentDocumentsError,
                FilesSyncError,
                FilesSyncRecordError,
                PlanUsageError,
                SessionFormatLegacyError,
                SessionOpeningError,
                TurnFeedError,
                TurnIdentityError,
            ) as e:
                log.error('Rejected invocation: %s', e)
                yield encoder.encode(error := RunErrorEvent(message=str(e), code=e.code))
            except Exception as e:
                log.exception('Error during AG-UI event streaming')
                yield encoder.encode(error := RunErrorEvent(message=str(e), code=_error_code(e)))
        if error is not None and timing.warmup:
            yield encoder.encode(_preparation_event(run_input, 'failed', error))
    finally:
        _record_failed_calls(calls, responded=finished)
        if finished and not timing.warmup:
            turn_output.retain(reply.text, environment)
        timing.finish('finished' if finished else 'failed')


def _record_failed_calls(calls: FailedCalls, *, responded: bool) -> None:
    """The Turn's span records its CLI calls that failed, and whether its response followed one (ADR 0085 decision 3)."""
    if not calls.count:
        return
    span = trace.get_current_span()
    span.set_attribute('botcube.turn.failed_cli_calls', calls.count)
    if responded:
        span.set_attribute('botcube.turn.response_after_failed_call', True)


@app.get('/ping')
def ping() -> JSONResponse:
    """Health check — bare ``{"status": "Healthy"}`` with no ``time_of_last_update``.

    Omitting the timestamp lets AgentCore anchor idle to the last /invocations
    (which it tracks independently), so idle microVMs reap at ~300 s instead of
    running to maxLifetime. See ADR 0029.
    """
    process_observation.mark('first_ping')
    return JSONResponse({'status': 'Healthy'})


# Runtime V2 restores each microVM from a snapshot taken at the first healthy /ping, and pays heavily for code the
# snapshot never ran (2026-11-02: a 10.8 s graph build). So with BOTCUBE_SNAPSHOT_PRIME=1 the first agent build runs
# before serving, on the plan model, a placeholder relay, synthetic ids and a temporary workspace, then is dropped.
_SNAPSHOT_MODEL = f'{PLAN_MODEL_PREFIX}gpt-6.1-sol'
_SNAPSHOT_ID = 'snapshot-prime'


def _prime_snapshot() -> None:
    if _AGENTS or _BACKENDS or _BACKEND_BY_AGENT or _MODEL_RELAYS:
        raise RuntimeError('The snapshot build must run before any agent is cached')
    relay = ModelRelay(base_url='https://snapshot.invalid/v1', token=_SNAPSHOT_ID, headers={}, session_id=_SNAPSHOT_ID)
    prime_process()
    try:
        with tempfile.TemporaryDirectory() as root, workspace_at(root):
            walk_graph(_get_agent(
                actor_id=_SNAPSHOT_ID, session_user_id=_SNAPSHOT_ID, persistent_memory=True,
                model=_SNAPSHOT_MODEL, thread_id=_SNAPSHOT_ID, model_relay=relay,
            ))
            model = build_model(model=_SNAPSHOT_MODEL, max_tokens=16000, relay=lambda: relay)
            # Prime lazy imports and /etc/os-release access before the V2 snapshot; answer in-process.
            asyncio.run(answer_once(model, _SNAPSHOT_ID))
        agentcore_memory_backend.prime_memory_client(AGENTCORE_REGION)
        region = os.environ.get('AWS_REGION') or AGENTCORE_REGION
        aws_clients.prime(region)
        restore_prime.prime_if_enabled(region, AGENTCORE_MEMORY_ID)
    finally:
        _AGENTS.clear()
        _BACKENDS.clear()
        _BACKEND_BY_AGENT.clear()
        _MODEL_RELAYS.clear()


def main() -> None:
    import uvicorn

    # `openai.resources` leaves out the Responses resource the plan model's first request imports.
    importlib.import_module('openai.resources.responses')
    if AGENTCORE_MEMORY_ID:
        agentcore_memory_backend.sts_client(AGENTCORE_REGION)
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
            'botcube_harness_deepagents.process_observation': {'level': 'INFO', 'handlers': ['bare'], 'propagate': False},
            'botcube_harness_deepagents.turn_timing': {'level': 'INFO', 'handlers': ['bare'], 'propagate': False},
            'botcube_harness_deepagents.prompt_cache': {'level': 'INFO', 'handlers': ['bare'], 'propagate': False},
        },
    })
    if os.getenv('BOTCUBE_SNAPSHOT_PRIME') == '1':
        _prime_snapshot()
    process_observation.name_spans(trace.get_tracer_provider())
    process_observation.mark('serve_handoff')
    uvicorn.run(app, host=os.getenv('BOTCUBE_HARNESS_HOST', '0.0.0.0'), port=int(os.getenv('PORT', '8080')))


if __name__ == '__main__':
    main()
