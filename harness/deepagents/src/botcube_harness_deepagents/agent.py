from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Annotated, Any, NotRequired

from deepagents import create_deep_agent
from deepagents.graph import DeepAgentState
from deepagents.middleware.filesystem import FilesystemMiddleware, FsToolName
from deepagents.middleware.skills import SkillsMiddleware
from deepagents.profiles import HarnessProfile, register_harness_profile
from langchain.agents.middleware import TodoListMiddleware
from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    OmitFromOutput,
    PrivateStateAttr,
)
from langchain_core.messages import AnyMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.constants import CONFIG_KEY_CHECKPOINTER
from langgraph.graph.message import add_messages
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command
from opentelemetry.instrumentation.utils import unwrap
from typing_extensions import TypedDict

from .lazy_files import LazyFilesMiddleware
from .llm import build_model
from .memory_files import build_memory_sources

DEFAULT_SYSTEM_PROMPT = ''
_FILESYSTEM_TOOLS: list[FsToolName] = ['ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute']

# deepagents 0.7's stdlib SkillMetadata cannot generate JSON schema on Python 3.11.
# Preserve its complete shape with https://errors.pydantic.dev/2.13/u/typed-dict-version.
class _SkillMetadata(TypedDict):
    path: str
    name: str
    description: str
    license: str | None
    compatibility: str | None
    metadata: dict[str, str]
    allowed_tools: list[str]


class PlainState(DeepAgentState):
    """deepagents' state with `messages` as a plain list: each checkpoint holds every message,
    so no read walks ancestor checkpoints (ADR 0067 decision 9)."""

    messages: Annotated[list[AnyMessage], add_messages]  # type: ignore[assignment]
    # The Session's Memory block (`session_memory.SessionMemoryMiddleware`). Every graph on the
    # Session record carries it, so a session API post keeps it in the next checkpoint.
    session_memory: NotRequired[Annotated[str, PrivateStateAttr]]
    last_model_call_at: NotRequired[Annotated[float, PrivateStateAttr]]


class _SkillsState(AgentState):
    skills_metadata: NotRequired[Annotated[list[_SkillMetadata] | None, OmitFromOutput]]
    skills_load_errors: NotRequired[Annotated[list[str], PrivateStateAttr]]
    _skill_tools_disclosed: NotRequired[Annotated[dict[str, str], PrivateStateAttr]]


class _FilesMiddleware(FilesystemMiddleware):
    @property
    def name(self) -> str:
        return 'FilesystemMiddleware'

    def wrap_tool_call(
        self, request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        return super().wrap_tool_call(request, lambda call: LazyFilesMiddleware().wrap_tool_call(call, handler))

    async def awrap_tool_call(
        self, request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        return await super().awrap_tool_call(request, lambda call: LazyFilesMiddleware().awrap_tool_call(call, handler))


class _SchemaSkillsMiddleware(SkillsMiddleware):
    state_schema = _SkillsState

    @property
    def name(self) -> str:
        return 'SkillsMiddleware'


class _UncheckpointedTasksMiddleware(AgentMiddleware):
    """Runs `task` subagents without checkpoints.

    A subagent inherits the Session's saver, which would file its checkpoints in an
    AgentCore session of their own, outside the Session and its writes sessions: past
    the Turn's Memory access and the purge. Nothing resumes a subagent part-way: the
    Harness never interrupts a graph.
    """

    def wrap_tool_call(
        self, request: ToolCallRequest, handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        return handler(_uncheckpointed_task(request))

    async def awrap_tool_call(
        self, request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        return await handler(_uncheckpointed_task(request))


def _uncheckpointed_task(request: ToolCallRequest) -> ToolCallRequest:
    if request.tool is None or request.tool.name != 'task':
        return request
    return request.override(tool=_UncheckpointedTask(task=request.tool))


class _UncheckpointedTask(BaseTool):
    """The `task` tool, run without the saver the Session lends its subgraphs."""

    task: BaseTool
    name: str = 'task'
    description: str = ''

    def _run(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError('invoke() and ainvoke() delegate to the task tool')

    def invoke(self, input: Any, config: RunnableConfig | None = None, **kwargs: Any) -> Any:
        return self.task.invoke(input, _without_checkpointer(config), **kwargs)

    async def ainvoke(self, input: Any, config: RunnableConfig | None = None, **kwargs: Any) -> Any:
        return await self.task.ainvoke(input, _without_checkpointer(config), **kwargs)


def _without_checkpointer(config: RunnableConfig | None) -> RunnableConfig:
    config = config or {}
    configurable = {key: value for key, value in config.get('configurable', {}).items() if key != CONFIG_KEY_CHECKPOINTER}
    return {**config, 'configurable': configurable}


def _prompt_cache_usage_middleware() -> Sequence[AgentMiddleware[Any, Any, Any]]:
    from .prompt_cache_observability import PromptCacheUsageCollectorMiddleware

    return [PromptCacheUsageCollectorMiddleware()]


register_harness_profile(
    'amazon_bedrock', HarnessProfile(extra_middleware=_prompt_cache_usage_middleware)
)


class AgentResponseError(RuntimeError):
    """Raised when the agent invocation does not produce usable text."""


def _restore_middleware_hook_dispatch() -> None:
    # Wrapped base hooks break LangChain's identity checks and select inherited async no-ops.
    for hook in (
        'before_agent',
        'abefore_agent',
        'before_model',
        'abefore_model',
        'after_agent',
        'aafter_agent',
        'after_model',
        'aafter_model',
    ):
        unwrap(AgentMiddleware, hook)


def build_agent(
    *,
    backend: Any,
    skills: Sequence[str],
    model: Any | None = None,
    tools: Sequence[Any] | None = None,
    memory: Sequence[str] | None = None,
    memory_path: Path | str | None = None,
    subagents: Sequence[dict[str, Any]] | None = None,
    store: Any | None = None,
    repo_root: Path | str | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    middleware: Sequence[Any] | None = None,
    checkpointer: Any | None = None,
) -> Any:
    _restore_middleware_hook_dispatch()
    resolved_model = model or build_model()
    resolved_backend = backend
    resolved_skills = list(skills)
    resolved_subagents = [_subagent_spec(spec, resolved_backend, resolved_skills) for spec in (subagents or [])]
    if memory is not None:
        memory_sources = list(memory)
    elif store is not None and memory_path is None:
        memory_sources = []
    else:
        memory_sources = build_memory_sources(
            memory_path=memory_path,
            repo_root=repo_root,
            backend=resolved_backend,
        )
    resolved_system_prompt = system_prompt
    kwargs: dict[str, Any] = {
        'model': resolved_model,
        'tools': list(tools or []),
        'skills': resolved_skills,
        'subagents': resolved_subagents,
        'backend': resolved_backend,
        'system_prompt': resolved_system_prompt,
        'state_schema': PlainState,
    }
    kwargs['middleware'] = [
        _FilesMiddleware(
            backend=resolved_backend,
            tools=_FILESYSTEM_TOOLS,
        ),
        TodoListMiddleware(),
        _SchemaSkillsMiddleware(backend=resolved_backend, sources=resolved_skills),
        _UncheckpointedTasksMiddleware(),
        *(list(middleware) if middleware is not None else []),
    ]
    if memory_sources:
        kwargs['memory'] = memory_sources
    if store is not None:
        kwargs['store'] = store
    if checkpointer is not None:
        kwargs['checkpointer'] = checkpointer
    return create_deep_agent(**kwargs)


def _subagent_spec(spec: dict[str, Any], backend: Any, skills: list[str]) -> dict[str, Any]:
    if 'runnable' in spec:
        return spec
    middleware: list[Any] = [_FilesMiddleware(backend=backend, tools=_FILESYSTEM_TOOLS)]
    sources = skills if spec.get('mode') == 'fork' else spec.get('skills')
    if sources is not None and (sources or spec.get('mode') == 'fork'):
        middleware.append(_SchemaSkillsMiddleware(backend=backend, sources=sources))
    return {**spec, 'middleware': [*middleware, *spec.get('middleware', [])]}


def ask(agent: Any, query: str) -> str:
    result = agent.invoke({'messages': query})
    text = _last_text(result).strip()
    if not text:
        raise AgentResponseError('Agent returned an empty response')
    return text


def _last_text(result: dict[str, Any]) -> str:
    messages = result['messages']
    if not messages:
        raise AgentResponseError('Agent returned an empty response')
    content = messages[-1].content
    if isinstance(content, str):
        return content
    # A content-block list: its text blocks, without reasoning or tool blocks.
    return '\n'.join(item['text'] for item in content if isinstance(item.get('text'), str))
