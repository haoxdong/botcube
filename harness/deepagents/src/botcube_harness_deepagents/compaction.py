"""Native compaction computed after a response and applied by a later normal graph run."""

from __future__ import annotations

import copy
import json
import logging
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Any
from uuid import uuid4

from deepagents.backends import LocalShellBackend
from deepagents.middleware.summarization import (
    SummarizationMiddleware,
    SummarizationState,
)
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain_core.exceptions import ContextOverflowError
from langchain_core.messages import AnyMessage
from langgraph.runtime import Runtime
from langgraph.types import Command

from . import turn_timing
from .lazy_files import TurnFiles, current_turn_files, finish_in_thread
from .prompt_cache_observability import prompt_cache_turn
from .turn_memory import answered_state, defer_turn_work

log = logging.getLogger(__name__)
_EVENT = '_summarization_event'


@dataclass
class _Candidate:
    messages: list[AnyMessage]
    previous_event: Any
    update: dict[str, Any]


def _root(runtime: Runtime[Any]) -> bool:
    assert runtime.execution_info is not None
    # DeepAgents shares this middleware with children; only the Session root owns a candidate.
    return '|' not in runtime.execution_info.checkpoint_ns


async def _no_answer(_request: ModelRequest[Any]) -> ModelResponse[Any]:
    return ModelResponse(result=[])


class BackgroundCompaction(SummarizationMiddleware):
    def __init__(self, *, model: Any, backend: Any, **settings: Any) -> None:
        super().__init__(model=model, backend=backend, **settings)
        self._workspace = Path(backend.cwd) if isinstance(backend, LocalShellBackend) else None
        self._settings = settings
        self._request: ModelRequest[Any] | None = None
        self._ready: _Candidate | None = None
        self._running = False

    @property
    def name(self) -> str:
        return 'SummarizationMiddleware'

    def _remember(self, request: ModelRequest[Any]) -> tuple[ModelRequest[Any], dict[str, Any] | None]:
        update = None
        if _root(request.runtime):
            candidate, self._ready = self._ready, None
            if (candidate is not None and request.state.get(_EVENT) == candidate.previous_event
                    and request.state['messages'][:len(candidate.messages)] == candidate.messages):
                update = candidate.update
                state: SummarizationState = {
                    **request.state,
                    '_summarization_event': update[_EVENT],
                    '_summarization_session_id': update['_summarization_session_id'],
                }
                request = request.override(state=state)
            self._request = request
        effective = self._get_effective_messages(request)
        truncated, _ = self._truncate_args(
            effective, self._count_tokens(effective, request.system_message, request.tools),
        )
        return request.override(messages=truncated), update

    @staticmethod
    def _response(response: ModelResponse[Any], update: dict[str, Any] | None) -> ModelResponse[Any] | ExtendedModelResponse[Any]:
        if update is None:
            return response
        return ExtendedModelResponse(model_response=response, command=Command(update=update))

    def wrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any] | ExtendedModelResponse[Any]:
        # Budget recovery only changes model input; the full tool output remains replayable.
        request, update = self._remember(request)
        for emergency in (False, True):
            try:
                if emergency:
                    with self._engine(request, emergency=True) as (native, raw, root):
                        response = native.wrap_model_call(raw, handler)
                        recovery = self._publish(response, raw, self._files(), root, emergency=True)
                        answer = response.model_response if isinstance(response, ExtendedModelResponse) else response
                        return self._answered(request, answer, recovery or update)
                response, _ = self._call_with_budget(request, handler)
                return self._answered(request, response, update)
            except ContextOverflowError:
                if emergency:
                    raise
        else:
            raise ContextOverflowError('Native emergency compaction could not reduce the request')

    async def awrap_model_call(
        self, request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any] | ExtendedModelResponse[Any]:
        request, update = self._remember(request)
        for emergency in (False, True):
            try:
                if emergency:
                    with self._engine(request, emergency=True) as (native, raw, root):
                        response = await native.awrap_model_call(raw, handler)
                        recovery = await finish_in_thread(self._publish, response, raw, self._files(), root, emergency=True)
                        answer = response.model_response if isinstance(response, ExtendedModelResponse) else response
                        return self._answered(request, answer, recovery or update)
                response, _ = await self._acall_with_budget(request, handler)
                return self._answered(request, response, update)
            except ContextOverflowError:
                if emergency:
                    raise
        else:
            raise ContextOverflowError('Native emergency compaction could not reduce the request')

    def _answered(
        self, request: ModelRequest[Any], response: ModelResponse[Any], update: dict[str, Any] | None,
    ) -> ModelResponse[Any] | ExtendedModelResponse[Any]:
        if _root(request.runtime) and (state := answered_state(request, response)) is not None:
            self._stage_compaction({**state, **(update or {})})
        return self._response(response, update)

    def _stage_compaction(self, state: Any) -> None:
        if self._request is None or self._running:
            return
        request = self._request.override(state=state, messages=state['messages'])
        effective = self._get_effective_messages(request)
        if not self._should_summarize(effective, self._count_tokens(effective, request.system_message, request.tools)):
            return
        snapshot = copy.deepcopy(state)
        request = request.override(state=snapshot, messages=snapshot['messages'])
        files = self._files()
        timing = turn_timing.current()
        defer_turn_work(partial(self._compact, request, files, timing.run_id if timing else None))

    async def _compact(self, request: ModelRequest[Any], files: TurnFiles, parent_run: str | None) -> None:
        if self._running or self._ready is not None:
            return
        if self._request is None or self._request.state.get(_EVENT) != request.state.get(_EVENT):
            return
        self._running = True
        timing = turn_timing.TurnTiming(str(uuid4()), None, None, warmup=False, receipt=perf_counter())
        status = 'failed'
        try:
            with turn_timing.use(timing), prompt_cache_turn():
                await self._stage(request, files)
            status = 'finished'
        finally:
            self._running = False
            record = timing.record(perf_counter(), status)
            log.info(json.dumps({**record, 'event': 'harness_compaction_timing', 'parentRunId': parent_run}))

    def _files(self) -> TurnFiles:
        files = current_turn_files()
        if files is None:
            assert self._workspace is not None, 'Compaction requires a disk-backed workspace'
            files = TurnFiles(None, self._workspace, ())
        return files

    @contextmanager
    def _engine(
        self, request: ModelRequest[Any], *, emergency: bool = False,
    ) -> Iterator[tuple[SummarizationMiddleware, ModelRequest[Any], Path]]:
        with TemporaryDirectory(prefix='botcube-compaction-') as directory:
            root = Path(directory)
            settings = {**self._settings, **({'trigger': ('tokens', 1)} if emergency else {})}
            native = SummarizationMiddleware(
                model=request.model,
                backend=LocalShellBackend(root_dir=root, virtual_mode=True, inherit_env=False),
                **settings,
            )
            # A unique native offload file never appends into the active workspace's files.
            state: SummarizationState = {**request.state, '_summarization_session_id': str(uuid4())}
            yield native, request.override(state=state, messages=state['messages']), root

    @staticmethod
    def _publish(
        response: ModelResponse[Any] | ExtendedModelResponse[Any], request: ModelRequest[Any],
        files: TurnFiles, root: Path, *, emergency: bool = False,
    ) -> dict[str, Any] | None:
        if not isinstance(response, ExtendedModelResponse):
            return None
        assert response.command is not None and isinstance(response.command.update, dict)
        update = dict(response.command.update)
        if update.pop('messages', None) and not emergency:
            raise RuntimeError('Background compaction cannot replace the raw Session messages')
        if update[_EVENT]['file_path'] is None:
            raise RuntimeError('Native compaction could not offload its conversation history')
        previous = request.state.get(_EVENT)
        if previous is not None and previous['file_path'] is not None:
            archive = root / update[_EVENT]['file_path'].lstrip('/')
            link = f"Earlier archived history: {previous['file_path']}\n\n"
            archive.write_text(link + archive.read_text())
        files.publish_staged(root)
        return update

    async def _stage(self, request: ModelRequest[Any], files: TurnFiles) -> None:
        with self._engine(request) as (native, raw, root):
            response = await native.awrap_model_call(raw, _no_answer)
            update = await finish_in_thread(self._publish, response, raw, files, root)
            if update is not None:
                self._ready = _Candidate(request.messages, request.state.get(_EVENT), update)
