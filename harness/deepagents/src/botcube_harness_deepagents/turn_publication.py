from __future__ import annotations

import asyncio
from typing import Any

from langchain_core.runnables import RunnableConfig, run_in_executor
from langgraph.checkpoint.base import ChannelVersions, Checkpoint, CheckpointMetadata

from .memory.agentcore.session_record import _configurable, _session_key
from .memory.agentcore.turn_saver import TurnCheckpointSaver


async def _await_owned(task: asyncio.Task[None]) -> None:
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


class _PublishingTurnSaver(TurnCheckpointSaver):
    def __init__(self, saver: Any) -> None:
        super().__init__(saver)
        self._initial_publications: dict[tuple[str, str], asyncio.Task[None]] = {}

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        result = self.put(config, checkpoint, metadata, new_versions)
        if not _configurable(config).get('checkpoint_ns') and metadata.get('source') == 'loop' and metadata.get('step') == 0:
            session = _session_key(config)
            if session not in self._initial_publications:
                self._initial_publications[session] = asyncio.create_task(self._apublish_initial(session))
        return result

    async def _apublish_initial(self, session: tuple[str, str]) -> None:
        await _await_owned(asyncio.create_task(run_in_executor(None, self._publish_initial, session)))

    async def await_initial_record(self, session: tuple[str, str]) -> None:
        if (publication := self._initial_publications.get(session)) is not None:
            await asyncio.shield(publication)

    async def aflush(self, session: tuple[str, str] | None = None) -> None:
        await _await_owned(asyncio.create_task(self._aflush(session)))

    async def _aflush(self, session: tuple[str, str] | None) -> None:
        publications = {key: task for key, task in self._initial_publications.items()
                        if session is None or key == session}
        failures: list[Exception] = []
        for result in await asyncio.gather(*publications.values(), return_exceptions=True):
            if isinstance(result, asyncio.CancelledError):
                failure = RuntimeError('Initial record publication was cancelled')
                failure.__cause__ = result
                failures.append(failure)
            elif isinstance(result, Exception):
                failures.append(result)
        try:
            await run_in_executor(None, self.flush, session)
        except Exception as failure:
            failures.append(failure)
        finally:
            for key, task in publications.items():
                if self._initial_publications.get(key) is task:
                    del self._initial_publications[key]
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise ExceptionGroup('Initial publication and final flush failed', failures)

