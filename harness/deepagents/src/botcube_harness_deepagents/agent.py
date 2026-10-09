from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, NotRequired

from deepagents import create_deep_agent
from deepagents.middleware.filesystem import FilesystemMiddleware, FsToolName
from deepagents.middleware.memory import MemoryMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from deepagents.profiles import HarnessProfile, register_harness_profile
from langchain.agents.middleware import TodoListMiddleware
from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    OmitFromOutput,
    PrivateStateAttr,
)
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command
from opentelemetry.instrumentation.utils import unwrap
from typing_extensions import TypedDict

from .lazy_files import LazyFilesMiddleware
from .llm import build_model
from .memory_files import build_memory_sources, write_ltm_source

if TYPE_CHECKING:
    # LangGraph injects the config only into a parameter annotated by this name.
    from langchain_core.runnables import RunnableConfig

DEFAULT_SYSTEM_PROMPT = ''
_FILESYSTEM_TOOLS: list[FsToolName] = ['ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute']

# Memory injection template: the <agent_memory> block only, no
# <memory_guidelines>. The framework default steers the
# agent to persist memories via edit_file, but ltm.md is a per-VM render
# cache of AgentCore LTM — the agent_core_memory tool is the write path.
LTM_MEMORY_SYSTEM_PROMPT = """<agent_memory>
{agent_memory}

</agent_memory>"""

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


class FreshMemoryMiddleware(MemoryMiddleware):
    """Memory read afresh at the start of every Turn.

    deepagents keeps what it loaded in the conversation's checkpointed state and
    never reads its sources again, so an edit to the member's Memory would never
    reach a conversation already under way.
    """

    @property
    def name(self) -> str:
        return 'MemoryMiddleware'

    def before_agent(self, state: Any, runtime: Any, config: RunnableConfig) -> Any:  # type: ignore[override]
        return super().before_agent(_without_memory(state), runtime, config)  # pragma: no mutate: an instance backend reads no runtime or config

    async def abefore_agent(self, state: Any, runtime: Any, config: RunnableConfig) -> Any:  # type: ignore[override]
        return await super().abefore_agent(_without_memory(state), runtime, config)  # pragma: no mutate: an instance backend reads no runtime or config


def _without_memory(state: Any) -> Any:
    return {key: value for key, value in state.items() if key != 'memory_contents'}


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
    ltm_context: str | None = None,
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
    if ltm_context:
        memory_sources.append(
            write_ltm_source(
                ltm_context,
                backend=resolved_backend,
                memory_path=memory_path,
                repo_root=repo_root,
            )
        )
    kwargs: dict[str, Any] = {
        'model': resolved_model,
        'tools': list(tools or []),
        'skills': resolved_skills,
        'subagents': resolved_subagents,
        'backend': resolved_backend,
        'system_prompt': resolved_system_prompt,
    }
    kwargs['middleware'] = [
        _FilesMiddleware(
            backend=resolved_backend,
            tools=_FILESYSTEM_TOOLS,
        ),
        TodoListMiddleware(),
        _SchemaSkillsMiddleware(backend=resolved_backend, sources=resolved_skills),
        *(list(middleware) if middleware is not None else []),
    ]
    # Replace the default memory slot by name so LTM stays after skills and
    # caching without the filesystem-write guidance forbidden by ADR 0031.
    if memory_sources:
        kwargs['memory'] = memory_sources
        kwargs['middleware'].append(
            FreshMemoryMiddleware(
                backend=resolved_backend,
                sources=memory_sources,
                system_prompt=LTM_MEMORY_SYSTEM_PROMPT,
            )
        )
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
