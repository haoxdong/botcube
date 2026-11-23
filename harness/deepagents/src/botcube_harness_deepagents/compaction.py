"""Checkpoint native compaction after an answer for the next Turn."""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager, suppress
from functools import partial
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Any, TypedDict
from uuid import uuid4

from deepagents.backends import LocalShellBackend
from deepagents.middleware.summarization import (
    SummarizationEvent,
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
from .turn_memory import answered_state, stage_turn_compaction

log = logging.getLogger(__name__)
_EVENT = '_summarization_event'


class PendingSummary(TypedDict):
    event: SummarizationEvent
    session_id: str
    prefix_hash: str


def _prefix_hash(messages: list[AnyMessage], cutoff: int) -> str:
    digest = sha256()
    for message in messages[:cutoff]:
        digest.update(json.dumps(message.model_dump(mode='json'), sort_keys=True).encode())
    return digest.hexdigest()


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

    @property
    def name(self) -> str:
        return 'SummarizationMiddleware'

    def _prepare_request(self, request: ModelRequest[Any]) -> tuple[ModelRequest[Any], dict[str, Any] | None]:
        update = None
        pending = request.state.get('_pending_summary')
        if _root(request.runtime) and pending is not None:
            update = {'_pending_summary': None}
            event = pending['event']
            if pending['prefix_hash'] == _prefix_hash(request.state['messages'], event['cutoff_index']):
                update.update({_EVENT: event, '_summarization_session_id': pending['session_id']})
                request = request.override(state={**request.state, **update})
        effective = self._get_effective_messages(request)
        truncated, _ = self._truncate_args(
            effective, self._count_tokens(effective, request.system_message, request.tools),
        )
        return request.override(messages=truncated), update

    @staticmethod
    def _response(response: ModelResponse[Any] | ExtendedModelResponse[Any], update: dict[str, Any] | None) -> ModelResponse[Any] | ExtendedModelResponse[Any]:
        answer = response.model_response if isinstance(response, ExtendedModelResponse) else response
        return ExtendedModelResponse(model_response=answer, command=Command(update=update)) if update else answer

    def wrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any] | ExtendedModelResponse[Any]:
        request, update = self._prepare_request(request)
        with suppress(ContextOverflowError):
            response, _ = self._call_with_budget(request, handler)
            return self._response(response, update)
        with self._engine(request, emergency=True) as (native, raw, root):
            response = native.wrap_model_call(raw, handler)
            recovery = self._publish(response, raw, self._files(), root, emergency=True)
            return self._response(response, {**(update or {}), **(recovery or {})})

    async def awrap_model_call(
        self, request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any] | ExtendedModelResponse[Any]:
        request, update = self._prepare_request(request)
        with suppress(ContextOverflowError):
            response, _ = await self._acall_with_budget(request, handler)
            self._stage_compaction(request, response)
            return self._response(response, update)
        with self._engine(request, emergency=True) as (native, raw, root):
            response = await native.awrap_model_call(raw, handler)
            recovery = await finish_in_thread(self._publish, response, raw, self._files(), root, emergency=True)
            return self._response(response, {**(update or {}), **(recovery or {})})

    def _stage_compaction(self, request: ModelRequest[Any], response: ModelResponse[Any]) -> None:
        if not _root(request.runtime) or (state := answered_state(request, response)) is None:
            return
        request = request.override(state={**request.state, 'messages': state['messages']}, messages=state['messages'])
        effective = self._get_effective_messages(request)
        if self._should_summarize(effective, self._count_tokens(effective, request.system_message, request.tools)):
            stage_turn_compaction(partial(self._compact, request, self._files()))

    async def _compact(self, request: ModelRequest[Any], files: TurnFiles) -> dict[str, Any] | None:
        parent = turn_timing.current()
        timing = turn_timing.TurnTiming(str(uuid4()), None, None, warmup=False, receipt=perf_counter())
        status = 'failed'
        try:
            with turn_timing.use(timing), prompt_cache_turn(), self._engine(request) as (native, raw, root):
                response = await native.awrap_model_call(raw, _no_answer)
                update = await finish_in_thread(self._publish, response, raw, files, root)
            status = 'finished'
        finally:
            record = timing.record(perf_counter(), status)
            log.info(json.dumps({**record, 'event': 'harness_compaction_timing',
                                 'parentRunId': parent.run_id if parent else None}))
        if update is None:
            return None
        event = update[_EVENT]
        pending: PendingSummary = {
            'event': event, 'session_id': update['_summarization_session_id'],
            'prefix_hash': _prefix_hash(request.messages, event['cutoff_index']),
        }
        return {'_pending_summary': pending}

    def _files(self) -> TurnFiles:
        files = current_turn_files()
        if files is None:
            assert self._workspace is not None, 'Compaction requires a disk-backed workspace'
            files = TurnFiles(None, self._workspace, ())
        return files

    @contextmanager
    def _engine(
        self, request: ModelRequest[Any], *, emergency: bool = False,
    ) -> Generator[tuple[SummarizationMiddleware, ModelRequest[Any], Path], None, None]:
        with TemporaryDirectory(prefix='botcube-compaction-') as directory:
            root = Path(directory)
            settings = self._settings.copy()
            if emergency:
                settings.update(trigger=('tokens', 1), keep=('messages', 2))
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
