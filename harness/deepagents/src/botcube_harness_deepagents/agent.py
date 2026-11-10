from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Annotated, Any, NotRequired

from deepagents import create_deep_agent
from deepagents._models import resolve_model
from deepagents.backends import CompositeBackend, StateBackend
from deepagents.graph import DeepAgentState
from deepagents.middleware._utils import append_to_system_message
from deepagents.middleware.filesystem import FilesystemMiddleware, FilesystemPermission
from deepagents.middleware.skills import (
    SKILLS_SYSTEM_PROMPT,
    SkillsMiddleware,
    SkillsState,
)
from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT
from deepagents.middleware.summarization import SummarizationMiddleware
from deepagents.profiles.harness.harness_profiles import _harness_profile_for_model
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
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

from .compaction import BackgroundCompaction
from .files import HARNESS_DIRECTORY
from .lazy_files import LazyFilesMiddleware
from .llm import build_model

DEFAULT_SYSTEM_PROMPT = ''

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


class _SkillsState(SkillsState):
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


def _tagged(tag: str, prompt: str, heading: str) -> str:
    """A middleware prompt as one XML block, its Markdown heading replaced by the tag."""
    if not prompt.startswith(heading):
        raise RuntimeError(f'{tag} prompt no longer starts with {heading!r}')
    return f'<{tag}>\n{prompt.removeprefix(heading)}\n</{tag}>'


SKILLS_PROMPT = _tagged('skills', SKILLS_SYSTEM_PROMPT, '## Skills System\n\n')


class _SchemaSkillsMiddleware(SkillsMiddleware):
    """Skills, then the Turn's per-user blocks: the innermost prompt middleware, so those blocks end the
    system prompt after every fixed one."""

    state_schema = _SkillsState

    def __init__(self, *, backend: Any, sources: Sequence[str], user_prompt: str = '') -> None:
        super().__init__(backend=backend, sources=sources, system_prompt=SKILLS_PROMPT)
        self.user_prompt = user_prompt

    @property
    def name(self) -> str:
        return 'SkillsMiddleware'

    def modify_request(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        skills = super().modify_request(request.override(system_message=None)).system_message
        assert skills is not None, 'Skills middleware must render its configured prompt'
        # Strip after rendering: upstream adds bold to source and skill labels, too.
        message = append_to_system_message(request.system_message, skills.text.replace('**', ''))
        if self.user_prompt:
            message = append_to_system_message(message, self.user_prompt)
        return request.override(system_message=message)


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
    subagents: Sequence[dict[str, Any]] | None = None,
    store: Any | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    user_prompt: str = '',
    middleware: Sequence[Any] | None = None,
    checkpointer: Any | None = None,
    permissions: list[FilesystemPermission] | None = None,
) -> Any:
    _restore_middleware_hook_dispatch()
    resolved_model = model or build_model()
    _reject_dropped_settings(resolved_model, permissions)
    for spec in subagents or []:
        _reject_dropped_settings(spec.get('model', resolved_model), spec.get('permissions'))
    files_backend = (
        CompositeBackend(default=backend, routes={}, artifacts_root=f'/{HARNESS_DIRECTORY}')
        if backend is not None else None
    )
    resolved_skills = list(skills)
    specs = list(subagents or [])
    if not any(spec['name'] == GENERAL_PURPOSE_SUBAGENT['name'] for spec in specs):
        specs.append({**GENERAL_PURPOSE_SUBAGENT, 'skills': resolved_skills})
    resolved_subagents = [_subagent_spec(spec, files_backend, resolved_skills) for spec in specs]
    kwargs: dict[str, Any] = {
        'model': resolved_model,
        'tools': list(tools or []),
        'skills': resolved_skills,
        'subagents': resolved_subagents,
        'backend': files_backend,
        'system_prompt': system_prompt,
        'state_schema': PlainState,
    }
    compaction = SummarizationMiddleware if backend is None else BackgroundCompaction
    kwargs['middleware'] = [
        compaction(
            model=resolved_model, backend=StateBackend() if backend is None else backend,
            trigger=('tokens', 64000), keep=('tokens', 16000),
            trim_tokens_to_summarize=None,
        ),
        _FilesMiddleware(backend=files_backend),
        _SchemaSkillsMiddleware(backend=files_backend, sources=resolved_skills, user_prompt=user_prompt),
        _UncheckpointedTasksMiddleware(),
        *(list(middleware) if middleware is not None else []),
    ]
    if store is not None:
        kwargs['store'] = store
    if checkpointer is not None:
        kwargs['checkpointer'] = checkpointer
    graph = create_deep_agent(**kwargs)
    _reject_exit_steps(graph)
    return graph


def _reject_exit_steps(graph: Any) -> None:
    exits = sorted(node for node in graph.nodes if node.endswith(('.after_model', '.after_agent')))
    if exits:
        raise ValueError(
            f'Harness middleware must act on the answer in its model call (turn_memory.AnswerMiddleware): {", ".join(exits)}',
        )


def _reject_dropped_settings(model: Any, permissions: list[FilesystemPermission] | None) -> None:
    if permissions is not None:
        raise ValueError('Harness would drop permissions; implement filesystem permission support before using them')
    profile = _harness_profile_for_model(resolve_model(model), model if isinstance(model, str) else None)
    dropped = profile.general_purpose_subagent.to_dict() if profile.general_purpose_subagent is not None else {}
    if dropped:
        raise ValueError(f'Harness would drop general_purpose_subagent settings: {", ".join(dropped)}')
    if profile.tool_description_overrides:
        raise ValueError('Harness would drop tool_description_overrides in its filesystem middleware')


def general_purpose_subagent(instructions: str, skills: Sequence[str]) -> dict[str, Any]:
    """deepagents' general-purpose subagent, with the Cartridge's instructions after its stock prompt.

    Like Claude Code's subagents, which load CLAUDE.md but not its system prompt, it gets the bot's
    instructions but not the Harness's voice: it reports to the main agent, not the user.
    """
    assert 'system_prompt' in GENERAL_PURPOSE_SUBAGENT
    return {
        **GENERAL_PURPOSE_SUBAGENT,
        'system_prompt': f"{GENERAL_PURPOSE_SUBAGENT['system_prompt']}\n\n{instructions}",
        'skills': list(skills),
    }


def _subagent_spec(spec: dict[str, Any], backend: Any, skills: list[str]) -> dict[str, Any]:
    middleware: list[Any] = [_FilesMiddleware(backend=backend)]
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
