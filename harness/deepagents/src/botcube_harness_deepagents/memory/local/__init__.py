from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

import aiosqlite
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from ...messages_snapshot import MessagesSnapshot
from ..inmem import build_memory_tools, build_store, prewarm_ltm


class UserScopedSqliteSaver(BaseCheckpointSaver[str]):
    """Local Session record addressed by (user ID, Session ID), as on AgentCore.

    Each user ID gets its own SQLite file beside ``path``, so two users with the
    same Session ID never share a record. The user ID is ``configurable.actor_id``,
    which every config handed back to LangGraph keeps, as AgentCore's saver does.
    """

    def __init__(self, path: Path) -> None:
        super().__init__()
        self._directory = path.with_name(f'{path.name}.users')
        self._savers: dict[str, AsyncSqliteSaver] = {}
        self._lock = asyncio.Lock()

    async def _saver(self, config: RunnableConfig) -> AsyncSqliteSaver:
        user_id = _user_id(config)
        async with self._lock:
            saver = self._savers.get(user_id)
            if saver is None:
                self._directory.mkdir(parents=True, exist_ok=True)
                connection = await aiosqlite.connect(self._directory / f'{user_id.encode().hex()}.sqlite3')
                saver = self._savers[user_id] = AsyncSqliteSaver(connection)
            return saver

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        found = await (await self._saver(config)).aget_tuple(config)
        return None if found is None else _tuple_with_user(found, _user_id(config))

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        if config is None:
            raise ValueError('The local Session record lists one user and Session at a time')
        saver = await self._saver(config)
        async for item in saver.alist(config, filter=filter, before=before, limit=limit):
            yield _tuple_with_user(item, _user_id(config))

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        saved = await (await self._saver(config)).aput(
            config,
            checkpoint,
            metadata,
            # The per-user AsyncSqliteSaver.aput never reads new_versions (it stores the checkpoint
            # and metadata only), so None stores the same row. Dropping the argument fails every
            # aput with a TypeError, so tests kill that Mutant.
            new_versions,  # pragma: no mutate: aput never reads new_versions
        )
        return _with_user(saved, _user_id(config))

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        # The per-user AsyncSqliteSaver never reads task_path (it neither stores nor orders writes
        # by it), so no test can tell any default apart.
        task_path: str = '',  # pragma: no mutate: the saver never reads task_path
    ) -> None:
        await (await self._saver(config)).aput_writes(
            config,
            writes,
            task_id,
            # aput_writes never reads task_path, so None or the default "" writes the same rows.
            task_path,  # pragma: no mutate: aput_writes never reads task_path
        )

    async def aget_delta_channel_history(self, *, config: RunnableConfig, channels: Sequence[str]) -> Any:
        return await (await self._saver(config)).aget_delta_channel_history(config=config, channels=channels)

    # The per-user savers' version scheme; it reads nothing from the saver.
    get_next_version = AsyncSqliteSaver.get_next_version

    async def adelete_session(self, user_id: str, session_id: str) -> None:
        """Delete every checkpoint of the user's Session, and its messages snapshot."""
        saver = await self._saver({'configurable': {'actor_id': user_id}})
        await saver.adelete_thread(session_id)
        self._messages_path(user_id, session_id).unlink(missing_ok=True)

    async def aread_messages_snapshot(self, user_id: str, session_id: str) -> MessagesSnapshot | None:
        path = self._messages_path(user_id, session_id)
        return MessagesSnapshot(**json.loads(path.read_text())) if path.exists() else None

    async def awrite_messages_snapshot(self, user_id: str, session_id: str, snapshot: MessagesSnapshot) -> None:
        """Keep the snapshot in its own file beside the user's record, unless it holds a newer checkpoint's."""
        async with self._lock:
            kept = await self.aread_messages_snapshot(user_id, session_id)
            if kept is not None and not snapshot.supersedes(kept):
                return
            path = self._messages_path(user_id, session_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            written = path.with_suffix('.tmp')
            written.write_text(json.dumps(asdict(snapshot)))
            written.replace(path)

    def _messages_path(self, user_id: str, session_id: str) -> Path:
        return self._directory / f'{user_id.encode().hex()}.messages' / f'{session_id.encode().hex()}.json'

    async def aclose(self) -> None:
        for saver in self._savers.values():
            await saver.conn.close()


def _user_id(config: RunnableConfig) -> str:
    user_id = (config.get('configurable') or {}).get('actor_id')
    if not user_id:
        raise ValueError('The local Session record needs configurable.actor_id')
    return str(user_id)


def _with_user(config: RunnableConfig | None, user_id: str) -> Any:
    if config is None:
        return None
    return {**config, 'configurable': {**(config.get('configurable') or {}), 'actor_id': user_id}}


def _tuple_with_user(found: CheckpointTuple, user_id: str) -> CheckpointTuple:
    return found._replace(
        config=_with_user(found.config, user_id),
        parent_config=_with_user(found.parent_config, user_id),
    )


def build_checkpointer(path: str | Path) -> UserScopedSqliteSaver:
    return UserScopedSqliteSaver(Path(path))


__all__ = [
    'build_checkpointer',
    'build_memory_tools',
    'build_store',
    'prewarm_ltm',
]
