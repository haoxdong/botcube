from __future__ import annotations

import asyncio
import gc
import hashlib
import importlib
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
    Coroutine,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from time import perf_counter, time_ns
from typing import Any, Literal, NamedTuple, TypeGuard, cast

from ag_ui.core import (
    CustomEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    TextMessageContentEvent,
)
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from deepagents.backends import LocalShellBackend
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.checkpoint.base import CheckpointTuple
from langgraph.store.memory import InMemoryStore
from opentelemetry import trace
from starlette.types import Message as ASGIMessage
from starlette.types import Receive, Scope, Send

from . import (
    aws_clients,
    diagnostic_response,
    message_times,
    process_observation,
    restore_prime,
    session_memory,
    today,
    turn_output,
    turn_timing,
)
from .actor_identity import ANONYMOUS_ACTOR_ID
from .agent import build_agent, general_purpose_subagent
from .agent_computer import with_agent_computer
from .agent_documents import (
    AgentDocuments,
    AgentDocumentsError,
    agent_document_tools,
)
from .agent_prompts import agent_prompts
from .artifact import SKILLS_SOURCE, artifact_tool
from .bot_settings import bot_from_env
from .definition import BotModel, HarnessDefinition, InvocationAuth, ModelRelay
from .definition import InvocationContext as _RequestContext
from .deployment import deployed_config, load_ca_bundle
from .files import (
    FilesBindingError,
    absolute_attachment_paths,
    excluded_paths,
)
from .files_mount import FilesMount, FilesMountError
from .invocation import InvalidBinding, InvalidInvocation, Invocation
from .lazy_files import TurnFiles
from .llm import (
    PLAN_MODEL_PREFIX,
    PlanUsageError,
    build_model,
    models_on_endpoint,
    resolve_effort,
    resolve_model,
)
from .memory import agentcore as agentcore_memory_backend
from .memory import inmem as inmem_memory_backend
from .memory import local as local_memory_backend
from .memory.agentcore import SnapshotEpoch, TurnIdentity, TurnIdentityError
from .memory.agentcore.warm_session import WarmSessionSaver
from .memory_tools import AGENTCORE_MEMORY_ID, AWS_REGION
from .prompt_cache_observability import (
    PromptCacheUsageMiddleware,
)
from .proxy_relay import shell_proxy_environment
from .scheduled_tasks import propose_scheduled_task
from .session_agent import AnsweredToolResultsMiddleware, SessionAgent
from .session_format import (
    SessionFormatLegacyError,
    latest_checkpoint,
    validate_checkpoint,
)
from .shell_backend import WorkerShellBackend
from .shell_relay import ShellRelay, bind_turn
from .snapshot_build import answer_once, prime_process, walk_graph, workspace_at
from .sse import keep_alive
from .steering import SteeringMiddleware
from .trace_relay import FailedCalls, counting_failed_calls, harness_trace_relay
from .turn_lifecycle import (
    CheckpointWriteError,
    PreparedTurn,
    SessionOpeningError,
    SessionTurns,
    session_config,
)
from .turn_lifecycle import error_code as _error_code
from .turn_lifetime import invocation_deadline
from .turn_memory import TurnFeedError

log = logging.getLogger(__name__)
AGENT_SYSTEM_PROMPT = """You are the user's own agent, with your own computer, Files and schedule.

<environment>
pandas, numpy, matplotlib, plotly, openpyxl, python-pptx, python-docx, reportlab, pypdf and rsvg-convert are preinstalled; use them rather than installing packages.
</environment>

<writing>
Write everything BLUF: authoritative and sharp; bold only key words, at most 3 at a time; no emoji, no em dashes.
When the user opens the chat, greet them by first name, say in one line what you can do, and pitch one thing their Memory suggests they'd care about.
For longer tasks, share meaningful progress in one sentence.
</writing>

<final_response>
Write it for IM, to be read at a glance. Build it from these modules, in the order that reads best. Show, don't tell: a table or visual beats text whenever it can carry the point. The whole response stays under 100 words.

<modules>
takeaway    1, under 25 words
bullets     0–3, directly under the takeaway, each under 15 words, no final period
table       0–1, under 10 rows and 5 columns
visual      0–3, as <visuals> says
closing     0–1, under 15 words: conviction, caveat, risk or catalyst
artifact    0–3: whatever the modules above can't hold, as <artifacts> says
attachment  0–3, when the user asks for a file or no Artifact type fits: a file in Files, on its own line as [<name>](<file path>); more files go in one .zip
</modules>
</final_response>

<visuals>
plotly: set the data, names, titles and on-data annotations; put the chart's source in title.subtitle. Style only what carries meaning; layout is the default theme's. fig.write_json('<name>.plotly.json') in Files, embedded as ![<caption>](<file path>)
mermaid: a ```mermaid block
svg: embedded as ![<caption>](<file path>)
</visuals>

<artifacts>
Publish each with the `Artifact` tool; the reply shows it as a card. Publishing the same file_path again makes a new version. The tool checks it first and lists every error: fix them all and publish again in the same turn. Prefer a Page for its flexibility; use another type when the user will edit it or open it in Word, Excel, PowerPoint or their mail. Before writing one, read its type's file:
Page: one self-contained HTML file, {artifacts}/page.md
Slides: a folder's project/deck.json and its slides, {artifacts}/slides.md
Doc: one Markdown file, {artifacts}/doc.md
Sheet: one <name>.sheet.json, {artifacts}/sheet.md
Email: one <name>.email.json, {artifacts}/email.md
</artifacts>

<citations>
Link every factual claim to its source, in chat and in every Artifact: at most 3 of the claim's key words, as `[key words](https://…)`.
</citations>""".replace('{artifacts}', f'{SKILLS_SOURCE}artifacts')


def _served_prompt_hash(candidate: str | None) -> str | None:
    if candidate is None:
        return None
    return hashlib.sha256(candidate.encode()).hexdigest()


class MissingUserIdError(RuntimeError):
    """The invocation carries no user ID; only the Chat Service resolves identity (ADR 0068)."""

    code = 'MISSING_USER_ID'


@dataclass(frozen=True)
class HarnessBot:
    skills: Sequence[str]
    agent_name: str
    system_prompt: str
    prepare_invocation: Callable[[Invocation, str | None], InvocationAuth]
    build_backend: Callable[[dict[str, str]], LocalShellBackend]
    apply_session_id: Callable[[LocalShellBackend, str | None], None]
    environment_cache_key: Callable[[Mapping[str, str] | None], tuple[tuple[str, str], ...]]
    default_model: str | None = None
    models: Mapping[str, BotModel] = field(default_factory=dict)
    written_memory: bool = False


_bot: HarnessBot | None = None


def configure_harness(bot: HarnessBot) -> None:
    global _bot
    if _bot is not None:
        raise RuntimeError('Harness bot is already configured')
    _bot = bot


def configure_harness_definition(definition: HarnessDefinition, default_model: str | None = None) -> None:
    def build_backend(environment: dict[str, str]) -> WorkerShellBackend:
        root = _workspace()
        definition.prepare_root(root)
        config = deployed_config()['config']
        relay = ShellRelay(definition.shell_environment, config.get('caBundle')) if definition.shell_environment else None
        backend = WorkerShellBackend(
            root_dir=root,
            virtual_mode=False,
            env={**environment, **(relay.environment if relay else {}), **shell_proxy_environment(config), 'PYTHONDONTWRITEBYTECODE': '1'},
            trace_relay_endpoint=harness_trace_relay(),
            inherit_env=True,
        )
        return relay.bound(backend) if relay else backend

    def apply_session_id(backend: LocalShellBackend, session_id: str | None) -> None:
        cast(WorkerShellBackend, backend).set_environment_variable(  # pragma: no mutate: cast is a runtime no-op
            definition.session_id_env_var,
            str(session_id) if session_id else None,
        )

    configure_harness(
        HarnessBot(
            skills=definition.skills,
            agent_name=definition.agent_name,
            system_prompt=definition.system_prompt,
            prepare_invocation=definition.prepare_invocation,
            build_backend=build_backend,
            apply_session_id=apply_session_id,
            environment_cache_key=definition.environment_cache_key,
            default_model=default_model,
            models=definition.models,
            written_memory=definition.written_memory,
        )
    )


def _require_bot() -> HarnessBot:
    if _bot is None:
        raise RuntimeError('Harness bot is not configured')
    return _bot


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


class _AgentKey(NamedTuple):
    conversation_id: str
    actor_id: str
    session_user_id: str
    persistent_memory: bool
    written_memory: bool
    model: str
    effort: str | None
    environment: tuple[tuple[str, str], ...]
    documents: str
    syncs_files: bool
    invocation_prompt: str
    scheduled_run: bool
    agent_system_prompt: str
    bot_system_prompt: str | None


_AGENTS: dict[_AgentKey, LangGraphAgent] = {}
_CHECKPOINTER: Any | None = None
_STORE: InMemoryStore | None = None
_BACKENDS: dict[tuple[str, str, str, tuple[tuple[str, str], ...]], LocalShellBackend] = {}
_BACKEND_BY_AGENT: dict[Any, LocalShellBackend] = {}
_MODEL_RELAYS: dict[_AgentKey, ModelRelay] = {}
_CACHE_LOCK = threading.RLock()
_SESSION_TURNS = SessionTurns()


def _build_checkpointer() -> Any:
    checkpoint_path = os.getenv('BOTCUBE_CHECKPOINT_PATH', '').strip()
    if checkpoint_path:
        return local_memory_backend.build_checkpointer(checkpoint_path)
    return inmem_memory_backend.build_checkpointer()


def _workspace() -> Path:
    root = Path(os.path.abspath(os.getenv('BOTCUBE_WORKSPACE', '').strip() or Path.home()))
    root.mkdir(parents=True, exist_ok=True)
    return root


def _get_agent(
    *,
    actor_id: str,
    session_user_id: str,
    persistent_memory: bool,
    written_memory: bool,
    model: str | None = None,
    effort: str | None = None,
    thread_id: str | None = None,
    invocation_prompt: str = '',
    agent_system_prompt: str = AGENT_SYSTEM_PROMPT,
    bot_system_prompt: str | None = None,
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
        bot = _require_bot()
        environment_key = bot.environment_cache_key(
            {name: value for name, value in (environment or {}).items() if name != 'AGENT_BROWSER_CDP'}
        )
        key = _AgentKey(
            conversation_id,
            actor_id,
            session_user_id,
            persistent_memory,
            written_memory,
            resolved_model,
            effort,
            environment_key,
            documents.cache_key() if documents else '',
            syncs_files,
            invocation_prompt,
            scheduled_run,
            agent_system_prompt,
            bot_system_prompt,
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

        root = Path(backend.cwd)

        with turn_timing.phase('model_client'):
            bot_model = _require_bot().models.get(model or '')
            m = build_model(
                model=model,
                effort=effort,
                provider=bot_model.provider if bot_model else None,
                max_tokens=bot_model.max_tokens if bot_model else None,
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
            tools.append(artifact_tool(root, bot.skills))
        if persistent_memory:
            memory_tools, memory_middleware = _memory_tools(store, actor_id, conversation_id)
            tools.extend(memory_tools)
            middleware.extend(memory_middleware)
        middleware.append(today.TodayMiddleware())
        if documents:
            tools.extend(agent_document_tools(documents))
        prompts = agent_prompts(
            agent_system_prompt=agent_system_prompt,
            bot_instructions=bot.system_prompt,
            candidate_bot_instructions=bot_system_prompt,
            profile=invocation_prompt,
            root=root,
            skills=bot.skills,
            syncs_files=syncs_files,
            documents=documents,
        )
        with turn_timing.phase('graph_build'):
            graph = build_agent(
                model=m,
                tools=tools,
                middleware=middleware,
                system_prompt=prompts.system,
                user_prompt=prompts.user,
                backend=backend,
                skills=bot.skills,
                subagents=[general_purpose_subagent(prompts.bot, bot.skills)] if prompts.bot else None,
                checkpointer=_CHECKPOINTER,
                store=store if persistent_memory else None,
                written_memory=written_memory,
            )
        config = {
            'recursion_limit': graph.config['recursion_limit'],
            'configurable': {'actor_id': session_user_id},
        }
        identity: dict[str, Any] = {'name': bot.agent_name}  # pragma: no mutate: the name is never read
        with turn_timing.phase('stream_adapter'):
            agent = SessionAgent(**identity, graph=graph, config=config)
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
        backend = _require_bot().build_backend(dict(environment or {}))
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


def _files_ready(files: FilesMount | None, run_id: str) -> bool:
    try:
        TurnFiles(files, _workspace(), excluded_paths(_require_bot().skills)).ensure()
    except FilesMountError as error:
        log.warning('Harness Turn answers without Written Memory run_id=%s: %s', run_id, error)
        return False
    return True


def _agent_and_backend(**kwargs: Any) -> tuple[LangGraphAgent, LocalShellBackend]:
    with _CACHE_LOCK:
        agent = _get_agent(**kwargs)
        backend = _BACKEND_BY_AGENT[agent]
    if (timing := turn_timing.current()) is not None:
        timing.prepared()
    return agent, backend


async def _turn_memory(turn_identity: TurnIdentity, run_id: str) -> tuple[Any, Any]:
    turn = agentcore_memory_backend.next_turn()
    with turn_timing.phase('memory_credentials'):
        return await asyncio.to_thread(
            agentcore_memory_backend.turn_memory, AGENTCORE_MEMORY_ID, turn_identity,
            region_name=AWS_REGION, run_id=run_id, turn=turn,
        )


async def _turn_agent(
    build: Callable[[], tuple[LangGraphAgent, LocalShellBackend]], turn_identity: TurnIdentity | None, run_id: str, persistent_memory: bool,
    read_checkpoint: Callable[[Any], Coroutine[Any, Any, CheckpointTuple | None]] | None = None,
    prefetch_memory: Callable[[Any], session_memory.Prefetch | None] = lambda store: None,
) -> tuple[LangGraphAgent, LocalShellBackend]:
    building = asyncio.to_thread(build)
    if not AGENTCORE_MEMORY_ID or turn_identity is None:
        agent, backend = await building
        if read_checkpoint is not None:
            await read_checkpoint(agent.graph.checkpointer)
        return agent, backend
    initial: asyncio.Task[CheckpointTuple | None] | None = None
    prefetched: session_memory.Prefetch | None = None

    async def memory_ready() -> tuple[Any, Any]:
        nonlocal initial, prefetched
        saver, store = await _turn_memory(turn_identity, run_id)
        prefetched = prefetch_memory(store)
        if read_checkpoint is not None:
            initial = asyncio.create_task(read_checkpoint(saver))
        return saver, store

    try:
        built, memory = await asyncio.gather(building, memory_ready(), return_exceptions=True)
        for outcome in (built, memory):
            if isinstance(outcome, BaseException):
                raise outcome
        agent, backend = cast(tuple[LangGraphAgent, LocalShellBackend], built)
        saver, store = cast(tuple[Any, Any], memory)
        session_memory.adopt_prefetch(prefetched)
        if initial is not None:
            await initial
        graph = agent.graph.copy({'checkpointer': saver, 'store': store if persistent_memory else None})
        return SessionAgent(name=agent.name, graph=graph, config=agent.config), backend
    except BaseException:
        if initial is not None:
            await asyncio.gather(initial, return_exceptions=True)
        await session_memory.settle_prefetch(prefetched, wait=True)
        raise


def _apply_environment(backend: LocalShellBackend, environment: Mapping[str, str] | None) -> None:
    if not environment:
        return
    env = backend._env
    for key, value in environment.items():
        env[str(key)] = str(value)


def _require_session_user_id(session_user_id: str | None) -> str:
    if not session_user_id:
        raise MissingUserIdError(
            'Invocation carries no Session filing ID; the Chat Service must forward sessionUserId'
        )
    return session_user_id


async def invoke(input_data: Invocation, context: _RequestContext):
    options = input_data.options
    session_user_id = options.session_user_id
    if options.warmup and not session_user_id:
        if options.preparation_scope is not None:
            _require_session_user_id(session_user_id)
        return
    absolute_attachment_paths(input_data.messages, _workspace)
    if options.steering:
        session_user_id = _require_session_user_id(session_user_id)
        accepted = _SESSION_TURNS.steer((session_user_id, input_data.thread_id), input_data)
        yield CustomEvent(name='STEERING_ACCEPTED', value={'accepted': accepted})
        return
    if options.withdraw_steering is not None:
        session_user_id = _require_session_user_id(session_user_id)
        withdrawn = _SESSION_TURNS.withdraw((session_user_id, input_data.thread_id), options.withdraw_steering)
        yield CustomEvent(name='STEERING_WITHDRAWN', value={'withdrawn': withdrawn})
        return
    if options.stop:
        session_user_id = _require_session_user_id(session_user_id)
        # AgentCore keeps a Turn running after its caller goes away, so the Chat Service stops it by name.
        _SESSION_TURNS.stop((session_user_id, input_data.thread_id), input_data.run_id)
        return
    with turn_timing.phase('invocation_auth'):
        auth = context.prepare(input_data, _require_bot().prepare_invocation)
    actor_id = auth.actor_id
    if not actor_id:
        raise MissingUserIdError(
            'Invocation carries no user ID; the Chat Service must forward the account ID'
        )
    session_user_id = _require_session_user_id(session_user_id)
    auth = with_agent_computer(auth, input_data.agent_computer_cdp_url, (session_user_id, input_data.thread_id))
    turn_identity = input_data.turn_identity
    if AGENTCORE_MEMORY_ID and turn_identity is None:
        raise TurnIdentityError('Invocation carries no Turn identity; the Chat Service must forward turnIdentity')
    async with aclosing(_invoke_agent(input_data, context, auth, actor_id, session_user_id, turn_identity)) as events:
        async for event in events:
            yield event


def _opening_turn(input_data: Invocation) -> bool:
    opening = input_data.options.opening
    if opening and input_data.messages:
        raise SessionOpeningError('An opening Turn cannot contain messages')
    return opening


async def _invoke_agent(input_data: Invocation, context: _RequestContext, auth: InvocationAuth,
                        actor_id: str, session_user_id: str, turn_identity: TurnIdentity | None):
    session = (session_user_id, input_data.thread_id)
    options = input_data.options
    candidate = options.agent_system_prompt
    files = input_data.files
    persistent_memory = auth.persistent_memory and actor_id != ANONYMOUS_ACTOR_ID and candidate is None and options.bot_memory
    written_memory = _require_bot().written_memory and options.written_memory and candidate is None and files is not None
    opening = _opening_turn(input_data)
    build = partial(
        _agent_and_backend,
        actor_id=actor_id,
        session_user_id=session_user_id,
        persistent_memory=persistent_memory,
        written_memory=written_memory,
        model=options.model or _require_bot().default_model,
        effort=options.effort,
        thread_id=input_data.thread_id,
        invocation_prompt=auth.system_prompt,
        agent_system_prompt=AGENT_SYSTEM_PROMPT if candidate is None else candidate,
        bot_system_prompt=options.bot_system_prompt,
        environment=auth.environment,
        model_relay=auth.model_relay,
        documents=input_data.documents if candidate is None else None,
        syncs_files=files is not None,
        scheduled_run=options.scheduled_run,
        preparing=options.warmup,
    )
    if not options.warmup:
        timing = turn_timing.current()
        warmed = session_memory.take_warmup(
            session, actor_id, timing.receipt if timing is not None else perf_counter(),
        )

        async def prepare() -> PreparedTurn:
            saved: CheckpointTuple | None = None

            async def read(saver: Any) -> CheckpointTuple | None:
                nonlocal saved
                saved = await _SESSION_TURNS.read_checkpoint(
                    saver, input_data, session=session, opening=opening, actor_id=actor_id,
                    epoch=options.session_snapshot_epoch, turn_identity=turn_identity,
                )
                return saved

            def prefetch(store: Any) -> session_memory.Prefetch | None:
                if persistent_memory:
                    return session_memory.prefetch(lambda: agentcore_memory_backend.opening(store, actor_id), input_data.run_id, warmed)
                return None

            def build_turn() -> tuple[LangGraphAgent, LocalShellBackend]:
                return build(written_memory=written_memory and _files_ready(files, input_data.run_id))

            agent, backend = await _turn_agent(build_turn, turn_identity, input_data.run_id, persistent_memory, read, prefetch)
            validate_checkpoint(agent.graph, session_config(session), saved)
            _require_bot().apply_session_id(backend, input_data.thread_id)
            return agent, Path(backend.cwd), bind_turn(backend, auth.model_relay)

        prompt_hash = _served_prompt_hash(candidate)
        async with aclosing(_SESSION_TURNS.stream(
            session, prepare, input_data, files, context, deadline=invocation_deadline(auth.model_relay),
            excluded=excluded_paths(_require_bot().skills),
        )) as events:
            async for event in events:
                yield event
                if prompt_hash is not None and event.type == EventType.RUN_STARTED:
                    yield CustomEvent(name='AGENT_SYSTEM_PROMPT', value=prompt_hash)
        return
    reads_transcript = options.preparation_scope != 'startup'
    async with _SESSION_TURNS.preparation(session) as allowed:
        if allowed:
            await _prepare_agent(
                build, turn_identity, input_data.run_id, persistent_memory, session, actor_id,
                files, reads_transcript, options.session_snapshot_epoch,
            )
    yield _preparation_event(input_data, 'prepared' if allowed else 'skipped-busy')


async def _prepare_agent(
    build: Callable[[], tuple[LangGraphAgent, LocalShellBackend]], turn_identity: TurnIdentity | None,
    run_id: str, persistent_memory: bool, session: tuple[str, str], actor_id: str,
    files: FilesMount | None, reads_transcript: bool, epoch: SnapshotEpoch | None = None,
) -> None:
    memory_warmup = (
        session_memory.begin_warmup(session, actor_id)
        if reads_transcript and AGENTCORE_MEMORY_ID and persistent_memory else None
    )
    memory_read: session_memory.OpeningRead | None = None
    try:
        agent, backend = await _turn_agent(
            build, turn_identity if reads_transcript else None, run_id, persistent_memory,
        )

        saver = getattr(agent.graph, 'checkpointer', None)
        if isinstance(saver, WarmSessionSaver):
            saver.discard_preparation(session_config(session))

        async def read_transcript() -> None:
            nonlocal memory_read
            reads: list[Awaitable[Any]] = [latest_checkpoint(agent.graph, session_config(session))]
            if AGENTCORE_MEMORY_ID and persistent_memory:
                reads.append(session_memory.read_warmup(
                    lambda: agentcore_memory_backend.opening(agent.graph.store, actor_id),
                ))
            with turn_timing.phase('warmup_history'):
                results = await asyncio.gather(*reads)
                if memory_warmup is not None:
                    memory_read = results[1]

        TurnFiles(files, Path(backend.cwd), excluded_paths(_require_bot().skills)).prefetch()
        if reads_transcript:
            await read_transcript()
        if reads_transcript and isinstance(saver, WarmSessionSaver):
            saver.finish_preparation(
                session_config(session), actor_id,
                agentcore_memory_backend.finished_snapshot_epoch(turn_identity, epoch),
            )
    except BaseException:
        if memory_warmup is not None:
            session_memory.finish_warmup(session, memory_warmup, None)
        raise
    if memory_warmup is not None:
        session_memory.finish_warmup(session, memory_warmup, memory_read)


def _preparation_event(
    run_input: RunAgentInput, outcome: Literal['prepared', 'skipped-busy', 'failed'],
    error: RunErrorEvent | None = None,
) -> CustomEvent:
    value: dict[str, Any] = {'runId': run_input.run_id, 'sessionId': run_input.thread_id, 'outcome': outcome}
    if error is not None:
        value['error'] = {'code': error.code, 'message': error.message}
    return CustomEvent(name='SESSION_PREPARATION', value=value)


def _is_assistant_text(event: Any) -> TypeGuard[TextMessageContentEvent]:
    return event.type == EventType.TEXT_MESSAGE_CONTENT and bool(event.delta.strip())


class _InvocationResponse(StreamingResponse):
    """Stamp the first nonempty ASGI send attempt; transport delivery is unobserved."""

    def __init__(self, content: AsyncGenerator[str, None], *, run_id: str,
                 runtime_session_id: str | None, media_type: str,
                 diagnostic_hold: Callable[[], Awaitable[None]] | None = None) -> None:
        super().__init__(content, media_type=media_type)
        self.frames = content
        self.run_id = run_id
        self.runtime_session_id = runtime_session_id
        self.diagnostic_hold = diagnostic_hold

    async def stream_response(self, send: Send) -> None:
        if self.diagnostic_hold is not None:
            await self.diagnostic_hold()
        first = True

        async def observed_send(message: ASGIMessage) -> None:
            nonlocal first
            if first and message['type'] == 'http.response.body' and message.get('body'):
                first = False
                log.info(json.dumps({'event': 'harness_response_first_body', 'runId': self.run_id,
                                     'runtimeSessionId': self.runtime_session_id, 'atUnixNs': time_ns()},
                                    separators=(',', ':')))
            await send(message)

        async with aclosing(self.frames):
            await super().stream_response(observed_send)


@app.post('/invocations')
async def invocations(request: Request) -> Any:
    """Stream AG-UI over SSE. Malformed requests get HTTP 400 before streaming."""
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

    encoder = EventEncoder(accept=request.headers.get('accept', ''))
    try:
        invocation = Invocation.parse(run_input)
    except InvalidInvocation as error:
        return JSONResponse({'error': str(error)}, status_code=400)
    except InvalidBinding as error:
        log.error('Rejected invocation: %s', error)
        return _rejected_invocation(run_input, request, encoder, receipt, error)
    options = invocation.options
    context = _RequestContext.from_request(request.headers, options.legacy_credential_token)
    timing = turn_timing.TurnTiming(
        invocation.run_id, invocation.thread_id, options.model, warmup=options.warmup, receipt=receipt,
    )

    return _InvocationResponse(
        keep_alive(_invocation_frames(invocation, context, encoder, timing), _KEEPALIVE_SECONDS),
        run_id=run_input.run_id, runtime_session_id=context.session_id, media_type=encoder.get_content_type(),
        diagnostic_hold=diagnostic_response.response_hold(
            invocation, receipt, lambda: context.prepare(invocation, _require_bot().prepare_invocation).actor_id,
        ),
    )


def _rejected_invocation(
    run: RunAgentInput, request: Request, encoder: EventEncoder, receipt: float, error: InvalidBinding,
) -> _InvocationResponse:
    options = error.options
    context = _RequestContext.from_request(request.headers, options.legacy_credential_token)
    timing = turn_timing.TurnTiming(run.run_id, run.thread_id, options.model, warmup=options.warmup, receipt=receipt)

    async def frames() -> AsyncGenerator[str, None]:
        try:
            event = RunErrorEvent(message=str(error), code=error.code)
            yield encoder.encode(event)
            if options.warmup:
                yield encoder.encode(_preparation_event(run, 'failed', event))
        finally:
            timing.finish('failed')

    return _InvocationResponse(
        frames(), run_id=run.run_id, runtime_session_id=context.session_id, media_type=encoder.get_content_type(),
    )


async def _invocation_frames(
    run_input: Invocation, context: _RequestContext, encoder: EventEncoder, timing: turn_timing.TurnTiming,
) -> AsyncGenerator[str, None]:
    error: RunErrorEvent | None = None
    stream_error: RunErrorEvent | None = None
    finished = False
    terminal_sent = False
    calls = FailedCalls()
    reply = ''
    saw_assistant_text = False
    environment = {**os.environ, **run_input.redaction_environment, 'session_id': context.session_id or ''}
    try:
        with turn_timing.use(timing), counting_failed_calls(calls):
            try:
                async with aclosing(invoke(run_input, context)) as events:
                    async for event in events:
                        saw_assistant_text |= _is_assistant_text(event)
                        if event.type == EventType.RUN_FINISHED and not saw_assistant_text:
                            event = RunErrorEvent(
                                message='Agent run completed without an assistant response',
                                code='AGENT_EMPTY_RESPONSE',
                                usage=event.usage,
                            )
                        reply = turn_output.reply_text(reply, event)
                        frame = _timed_frame(event, encoder, timing)
                        if isinstance(event, RunErrorEvent):
                            stream_error = event
                        terminal_sent |= event.type == EventType.RUN_FINISHED
                        yield frame
                finished = stream_error is None
            except (
                MissingUserIdError,
                AgentDocumentsError,
                FilesMountError,
                FilesBindingError,
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
                error = RunErrorEvent(message=str(e), code=CheckpointWriteError.code if terminal_sent else _error_code(e))
                yield _invocation_failure_frame(error, encoder, terminal_sent, run_input)
        if error is not None and timing.warmup:
            yield encoder.encode(_preparation_event(run_input, 'failed', error))
    finally:
        _record_failed_calls(calls, responded=finished)
        if finished and not timing.warmup:
            turn_output.retain(reply, environment, invocation_token=context.credential_token)
        failure = error or stream_error
        timing.finish(_invocation_status(finished, failure))


def _invocation_failure_frame(error: RunErrorEvent, encoder: EventEncoder, terminal_sent: bool, run: RunAgentInput) -> str:
    if not terminal_sent:
        return encoder.encode(error)
    value = {'error': {'code': error.code, 'message': error.message}, 'runId': run.run_id, 'sessionId': run.thread_id}
    log.error(json.dumps({'event': 'checkpoint_write_failed_after_finish', **value}))
    return 'event: error\ndata: ' + json.dumps(value, separators=(',', ':')) + '\n\n'


def _timed_frame(event: Any, encoder: EventEncoder, timing: turn_timing.TurnTiming) -> str:
    frame = encoder.encode(event)
    if _is_assistant_text(event):
        timing.text()
    return frame


def _invocation_status(finished: bool, error: RunErrorEvent | None) -> Literal['finished', 'failed', 'stopped']:
    if finished:
        return 'finished'
    if error is not None and error.code == 'TURN_STOPPED':
        return 'stopped'
    return 'failed'


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
    """Omit the timestamp so AgentCore measures idle from /invocations. See ADR 0029."""
    process_observation.mark('first_ping')
    return JSONResponse({'status': 'Healthy'})


@app.post('/warmup')
async def warmup(request: Request) -> JSONResponse:
    phase = request.headers.get('X-Amzn-Bedrock-AgentCore-Runtime-Warmup-Type')
    if phase not in ('memory', 'disk'):
        return JSONResponse({'error': 'Expected Runtime warmup type memory or disk'}, status_code=400)
    if phase == 'memory':
        await asyncio.to_thread(_prime_snapshot)
    return JSONResponse({})


_SNAPSHOT_MODEL = f'{PLAN_MODEL_PREFIX}gpt-6.1-sol'
_SNAPSHOT_ID = 'snapshot-prime'


def _prime_snapshot() -> None:
    if _AGENTS or _BACKENDS or _BACKEND_BY_AGENT or _MODEL_RELAYS:
        raise RuntimeError('Snapshot prime requires empty caches')
    started = perf_counter()
    agentcore_memory_backend.sts_client.cache_clear()
    restore_prime.prime(AWS_REGION)
    relay = ModelRelay(base_url='https://snapshot.invalid/v1', token=_SNAPSHOT_ID, headers={}, session_id=_SNAPSHOT_ID)
    prime_process()
    try:
        with tempfile.TemporaryDirectory() as root, workspace_at(root):
            walk_graph(_get_agent(
                actor_id=_SNAPSHOT_ID, session_user_id=_SNAPSHOT_ID, persistent_memory=True, written_memory=True,
                model=_SNAPSHOT_MODEL, thread_id=_SNAPSHOT_ID, model_relay=relay, syncs_files=True,
            ))
            model = build_model(model=_SNAPSHOT_MODEL, relay=lambda: relay)
            asyncio.run(answer_once(model, _SNAPSHOT_ID))
        agentcore_memory_backend.prime_memory_client(AWS_REGION)
        aws_clients.prime(AWS_REGION)
        if AGENTCORE_MEMORY_ID:
            agentcore_memory_backend.prime_spare(AGENTCORE_MEMORY_ID, AWS_REGION)
    finally:
        _AGENTS.clear()
        _BACKENDS.clear()
        _BACKEND_BY_AGENT.clear()
        _MODEL_RELAYS.clear()
        gc.collect()
        log.info('Snapshot prime completed in %.3f seconds', perf_counter() - started)


def main() -> None:
    import uvicorn

    diagnostic_response.configured_gate()

    load_ca_bundle(deployed_config()['config'])
    importlib.import_module('openai.resources.responses')
    if AGENTCORE_MEMORY_ID:
        agentcore_memory_backend.sts_client(AWS_REGION)
    models_on_endpoint()
    if _bot is None:
        configure_harness_definition(*bot_from_env())
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
    process_observation.name_spans(trace.get_tracer_provider())
    process_observation.mark('serve_handoff')
    uvicorn.run(app, host='0.0.0.0', port=int(os.getenv('PORT', '8080')))


if __name__ == '__main__':
    main()
