"""Run and coordinate Harness Turns for a Session."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import AbstractContextManager, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from weakref import WeakValueDictionary

from ag_ui.core import RunAgentInput
from ag_ui_langgraph import LangGraphAgent
from langgraph.checkpoint.base import CheckpointTuple
from opentelemetry import baggage
from opentelemetry import context as otel_context

from .. import session_memory, turn_timing
from ..definition import InvocationContext
from ..files_mount import FilesMount, FilesMountError
from ..lazy_files import turn_files
from ..llm import PlanUsageError
from ..memory import agentcore as agentcore_memory_backend
from ..memory.agentcore import SnapshotEpoch, TurnIdentity
from ..memory.agentcore.warm_session import WarmSessionSaver
from ..prompt_cache_observability import prompt_cache_turn
from ..steering import active_steering
from ..turn_lifetime import wait_for_turn
from ..turn_memory import TurnFeed, TurnFeedError, collecting_turn_feeds
from ._turn import (
    CheckpointWriteError as CheckpointWriteError,
)
from ._turn import (
    _Session,
    _stopped,
    _Turn,
)
from ._turn import (
    observe_reply_model as observe_reply_model,
)
from ._turn import (
    session_config as session_config,
)

log = logging.getLogger('botcube_harness_deepagents.serving')
_END = object()


class SessionOpeningError(RuntimeError):
    code = 'SESSION_OPENING_ALREADY_STARTED'


def error_code(error: Exception) -> str:
    if isinstance(error, (PlanUsageError, FilesMountError, CheckpointWriteError)):
        return error.code
    if agentcore_memory_backend.is_access_denied(error):
        return 'MEMORY_ACCESS_DENIED'
    return 'INTERNAL_ERROR'


@dataclass
class _Publication:
    saver: WarmSessionSaver
    task: asyncio.Task[None]
    followed: bool = False


PreparedTurn = tuple[LangGraphAgent, Path, AbstractContextManager[None]]


class SessionTurns:
    def __init__(self) -> None:
        self._turns: dict[_Session, _Turn] = {}
        self._locks: WeakValueDictionary[_Session, asyncio.Lock] = WeakValueDictionary()
        self._flush_failures: dict[_Session, Exception] = {}
        self._publications: dict[_Session, _Publication] = {}
        self._feeds: dict[_Session, asyncio.Task[None]] = {}

    async def read_checkpoint(
        self, saver: Any, input_data: RunAgentInput, *, session: tuple[str, str], opening: bool,
        actor_id: str, epoch: SnapshotEpoch | None, turn_identity: TurnIdentity | None,
    ) -> CheckpointTuple | None:
        async with self._locks.setdefault(session, asyncio.Lock()):
            turn = self._turns.get(session)
            if turn is None or turn.input_data is not input_data or turn.stopped:
                return None
            if isinstance(saver, WarmSessionSaver):
                await self._admit_checkpoint(
                    session, saver, actor_id, input_data.run_id,
                    agentcore_memory_backend.finished_snapshot_epoch(turn_identity, epoch),
                )
            with turn_timing.phase('checkpoint_read'):
                saved = await saver.aget_tuple(session_config(session))
                if opening and saved is not None:
                    raise SessionOpeningError('This Session already has a Turn')
                return saved

    async def wait_for_checkpoint(self, session: tuple[str, str]) -> None:
        if (lock := self._locks.get(session)) is not None:
            async with lock:
                pass

    async def wait_for_feeds(self) -> None:
        """Wait for the currently scheduled Memory feeds."""
        if self._feeds:
            await asyncio.wait(list(self._feeds.values()))

    async def _admit_checkpoint(
        self, session: _Session, saver: WarmSessionSaver, actor_id: str,
        run_id: str, epoch: str | None,
    ) -> None:
        previous = self._publications.get(session)
        snapshot = previous.saver.pending_snapshot(actor_id, epoch) if previous is not None else None
        if previous is not None and snapshot is None:
            await asyncio.wait([previous.task])
            previous = None
        saver.admit_snapshot_reuse(session_config(session), actor_id, run_id, epoch)
        if previous is not None:
            previous.followed = True
        saver.stage_writes(snapshot, previous.task if previous is not None else None)

    def _publish_checkpoint(
        self, session: _Session, saver: WarmSessionSaver, snapshot: CheckpointTuple,
        turn: _Turn, feeds: list[TurnFeed],
    ) -> asyncio.Task[None]:
        async def publish() -> None:
            try:
                await saver.settle_writes()
                saver.finish_run()
                self._feed(session, turn, feeds)
            except Exception as failure:
                saver.abandon_run(drop_snapshot=True)
                if isinstance(failure, CheckpointWriteError):
                    raise
                error = CheckpointWriteError(str(failure))
                if not publication.followed:
                    self._flush_failures[session] = error
                raise error from failure
            finally:
                saver.discard_handoff(snapshot)
                if self._publications.get(session) is publication:
                    del self._publications[session]

        task = asyncio.create_task(publish())
        self._publications[session] = publication = _Publication(saver, task)
        return task

    @asynccontextmanager
    async def preparation(self, session: _Session) -> AsyncGenerator[bool, None]:
        lock = self._locks.setdefault(session, asyncio.Lock())
        turn = self._turns.get(session)
        if lock.locked() or session in self._publications or (turn is not None and not turn.finished):
            yield False
            return
        async with lock:
            yield True

    def steer(self, session: _Session, input_data: RunAgentInput) -> bool:
        turn = self._turns.get(session)
        if turn is None or turn.stopped or turn.finished:
            return False
        for message in input_data.messages:
            if message.role != 'user' or not isinstance(message.content, str) or not message.content:
                raise ValueError('Steering requires user text messages')
            turn.steering.add(message.id, message.content)
        return True

    def withdraw(self, session: _Session, message_id: object) -> bool:
        if not isinstance(message_id, str) or not message_id:
            raise ValueError('Withdrawing steering requires a message ID')
        turn = self._turns.get(session)
        if turn is None or turn.stopped or turn.finished:
            return True
        return turn.steering.withdraw(message_id)

    def stop(self, session: _Session, run_id: str) -> None:
        turn = self._turns.get(session)
        if turn is not None and turn.input_data.run_id == run_id:
            turn.stop()

    def _feed(self, session: _Session, turn: _Turn, feeds: list[TurnFeed]) -> None:
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
                log.error('Harness Turn feed failed run_id=%s code=%s', turn.input_data.run_id, getattr(failure, 'code', 'INTERNAL_ERROR'),
                          exc_info=(type(failure), failure, failure.__traceback__))
                if not isinstance(failure, TurnFeedError):
                    self._flush_failures[session] = failure

        self._feeds[session] = task = asyncio.create_task(feed())
        task.add_done_callback(fed)

    async def stream(
        self,
        session: _Session,
        prepare: Callable[[], Awaitable[PreparedTurn]],
        input_data: RunAgentInput,
        files: FilesMount | None,
        context: InvocationContext,
        deadline: float | None = None,
        *,
        excluded: tuple[str, ...] = (),
    ) -> AsyncGenerator[Any, None]:
        previous = self._turns.get(session)
        if previous is not None and not previous.finished:
            previous.stop()
        self._turns[session] = turn = _Turn(input_data)
        queue: asyncio.Queue[Any] = asyncio.Queue()
        run = asyncio.create_task(self._run(session, turn, prepare, files, context.session_id, queue.put_nowait, deadline, excluded))
        def completed(work: asyncio.Task[None]) -> None:
            if not work.cancelled() and (failure := work.exception()) is not None:
                log.error(
                    'Harness Turn failed run_id=%s code=%s', turn.input_data.run_id,
                    getattr(failure, 'code', 'INTERNAL_ERROR'),
                    exc_info=(type(failure), failure, failure.__traceback__),
                )

        run.add_done_callback(completed)
        try:
            while (event := await queue.get()) is not _END:
                yield event
            run.result()
        finally:
            turn.stop()

    async def _run(
        self,
        session: _Session,
        turn: _Turn,
        prepare: Callable[[], Awaitable[PreparedTurn]],
        files: FilesMount | None,
        session_id: str | None,
        put: Callable[[Any], None],
        deadline: float | None,
        excluded: tuple[str, ...],
    ) -> None:
        parent = baggage.set_baggage('session.id', session_id) if session_id else None
        trace_token = otel_context.attach(baggage.set_baggage('run.id', turn.input_data.run_id, context=parent))
        steering_token = active_steering.set((turn.steering, put))
        completed = False
        try:
            await self._execute(session, turn, prepare, files, session_id, put, deadline, excluded)
            completed = turn.finished and not turn.stopped
        finally:
            active_steering.reset(steering_token)
            await session_memory.settle_prefetch(wait=not completed)
            otel_context.detach(trace_token)
            if self._turns.get(session) is turn:
                del self._turns[session]
            put(_END)

    async def _execute(
        self, session: _Session, turn: _Turn,
        prepare: Callable[[], Awaitable[PreparedTurn]],
        files: FilesMount | None, session_id: str | None, put: Callable[[Any], None],
        deadline: float | None, excluded: tuple[str, ...],
    ) -> None:
        lock = self._locks.setdefault(session, asyncio.Lock())
        agent, root, shell_binding = await prepare()
        saver = getattr(getattr(agent, 'graph', None), 'checkpointer', None)
        try:
            async with lock:
                if turn.stopped:
                    put(_stopped())
                    return
                if (failure := self._flush_failures.pop(session, None)) is not None:
                    raise failure
                with shell_binding:
                    feeds, snapshot = await _run_graph(
                        turn, agent, saver, root, files, session, session_id, put, deadline, excluded,
                    )
                if snapshot is None:
                    _settle_finished_reuse(saver, turn.finished_without_interruption(agent))
                    if turn.completion is not None:
                        turn.release(put)
                        self._feed(session, turn, feeds)
                    return
                assert isinstance(saver, WarmSessionSaver)
                publication = self._publish_checkpoint(session, saver, snapshot, turn, feeds)
        except Exception as failure:
            _settle_finished_reuse(saver, False)
            if not isinstance(failure, CheckpointWriteError) and (deferred := turn.failure_after_answer(failure)) is not None:
                self._flush_failures[session] = deferred
            raise
        if saver.predecessor is not None:
            await asyncio.wait([saver.predecessor])
        if _publication_succeeded(saver.predecessor):
            turn.release(put)
        await publication


def _publication_succeeded(task: asyncio.Task[None] | None) -> bool:
    return task is None or (task.done() and not task.cancelled() and task.exception() is None)


async def _run_graph(
    turn: _Turn, agent: LangGraphAgent, saver: Any, root: Path, files: FilesMount | None,
    session: _Session, session_id: str | None, put: Callable[[Any], None], deadline: float | None,
    excluded: tuple[str, ...],
) -> tuple[list[TurnFeed], CheckpointTuple | None]:
    predecessor = saver.predecessor if isinstance(saver, WarmSessionSaver) else None
    with turn_files(files, root, excluded) as readiness:
        readiness.prefetch()
        with prompt_cache_turn(session_id), collecting_turn_feeds() as feeds:
            turn.work = work = asyncio.create_task(turn.run(agent, put, readiness, early=predecessor is None))
        limited = await wait_for_turn(work, deadline, finished=lambda: turn.finished)
        snapshot = None
        try:
            try:
                snapshot = await _finish_graph_checkpoint(
                    saver, work, session, turn.finished_without_interruption(agent) and not readiness.used,
                )
                await readiness.settle_prefetch()
                if not work.cancelled():
                    readiness.raise_if_failed()
            finally:
                await readiness.settle_archives()
                if work.cancelled() and _publication_succeeded(predecessor):
                    await turn.keep(agent, session)
                    await turn.answer_cut_calls(agent, session)
                    await turn.keep_clock(agent, session, put)
        except Exception:
            if snapshot is not None:
                assert isinstance(saver, WarmSessionSaver)
                saver.discard_handoff(snapshot)
                await _settle_turn_writes(saver, work)
            raise
    if work.cancelled():
        await turn.finish_cancelled(agent, session, put, limited=limited and not turn.stopped)
    else:
        await turn.keep_failed(agent, session, put)
    return feeds, snapshot


async def _finish_graph_checkpoint(
    saver: Any, work: asyncio.Task[None], session: _Session, finished: bool,
) -> CheckpointTuple | None:
    if isinstance(saver, WarmSessionSaver):
        try:
            if (finished and not work.cancelled() and work.exception() is None
                    and (snapshot := saver.handoff(session_config(session))) is not None):
                return snapshot
        except Exception:
            await _settle_turn_writes(saver, work)
            raise
        finally:
            saver.discard_staged()
    await _settle_turn_writes(saver, work)
    return None


async def _settle_turn_writes(saver: Any, work: asyncio.Task[None]) -> None:
    failure = None if work.cancelled() else work.exception()
    if isinstance(saver, WarmSessionSaver):
        await saver.settle_writes()
    if failure is not None:
        raise failure


def _settle_finished_reuse(saver: Any, finished: bool) -> None:
    if isinstance(saver, WarmSessionSaver):
        if finished:
            saver.finish_run()
        else:
            saver.abandon_run()
