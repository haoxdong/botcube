from __future__ import annotations

import uuid
from collections.abc import Iterator, Mapping, Sequence
from typing import Any, Literal

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.checkpoint.base import (
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore

from ...memory_tools import MemoryToolResult
from ...messages_snapshot import MessagesSnapshot


class UserScopedMemorySaver(MemorySaver):
    """Keep the local volatile Session record under its filing user ID."""

    def __init__(self) -> None:
        super().__init__()
        self._savers: dict[str, MemorySaver] = {}
        self._messages: dict[tuple[str, str], MessagesSnapshot] = {}

    def _saver(self, config: RunnableConfig) -> MemorySaver:
        user_id = _user_id(config)
        if user_id not in self._savers:
            self._savers[user_id] = MemorySaver()
        return self._savers[user_id]

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        found = self._saver(config).get_tuple(config)
        return None if found is None else _tuple_with_user(found, _user_id(config))

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        if config is None:
            raise ValueError(
                "The in-memory Session record lists one user and Session at a time"
            )
        for item in self._saver(config).list(
            config, filter=filter, before=before, limit=limit
        ):
            yield _tuple_with_user(item, _user_id(config))

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        return _with_user(
            self._saver(config).put(config, checkpoint, metadata, new_versions),
            _user_id(config),
        )

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        self._saver(config).put_writes(config, writes, task_id, task_path)

    def get_delta_channel_history(
        self, *, config: RunnableConfig, channels: Sequence[str]
    ) -> Mapping[str, Any]:
        return self._saver(config).get_delta_channel_history(
            config=config, channels=channels
        )

    async def aread_messages_snapshot(
        self, user_id: str, session_id: str
    ) -> MessagesSnapshot | None:
        return self._messages.get((user_id, session_id))

    async def awrite_messages_snapshot(
        self, user_id: str, session_id: str, snapshot: MessagesSnapshot
    ) -> None:
        kept = self._messages.get((user_id, session_id))
        if kept is None or snapshot.supersedes(kept):
            self._messages[(user_id, session_id)] = snapshot

    def delete_thread(self, thread_id: str) -> None:
        raise ValueError(
            "The in-memory Session record needs a user ID to delete a Session"
        )


def _user_id(config: RunnableConfig) -> str:
    user_id = (config.get("configurable") or {}).get("actor_id")
    if not user_id:
        raise ValueError("The in-memory Session record needs configurable.actor_id")
    return str(user_id)


def _with_user(config: RunnableConfig | None, user_id: str) -> Any:
    if config is None:
        return None
    return {
        **config,
        "configurable": {**(config.get("configurable") or {}), "actor_id": user_id},
    }


def _tuple_with_user(found: CheckpointTuple, user_id: str) -> CheckpointTuple:
    return found._replace(
        config=_with_user(found.config, user_id),
        parent_config=_with_user(found.parent_config, user_id),
    )


def build_checkpointer() -> MemorySaver:
    return UserScopedMemorySaver()


def build_store() -> InMemoryStore:
    return InMemoryStore()


def build_memory_tools(
    *,
    store: InMemoryStore,
    actor_id: str,
    thread_id: str,
) -> tuple[list[Any], list[Any]]:
    del thread_id  # memories belong to the actor, across threads
    namespace = ('memory', actor_id)

    @tool
    def memory(action: str, content: str = '', query: str = '', memory_record_id: str = '') -> MemoryToolResult:
        """Long-term memory for this user, kept across conversations.

        Actions: `record` stores `content` (under `memory_record_id` when given,
        else a new id); `retrieve` and `list` return all memories; `get` and
        `delete` act on one memory by `memory_record_id`. An unknown action
        returns an error result.
        """
        del query  # the store has no search index: retrieve lists the actor's memories
        return _run_memory_action(
            store,
            namespace,
            action=action,
            content=content,
            memory_record_id=memory_record_id,
        )

    return [memory], []


def _run_memory_action(
    store: InMemoryStore,
    namespace: tuple[str, str],
    *,
    action: str,
    content: str,
    memory_record_id: str,
) -> MemoryToolResult:
    if action == 'record':
        record_id = memory_record_id or uuid.uuid4().hex
        store.put(namespace, record_id, {'content': content})
        return _result('success', f'Recorded memory {record_id}')
    if action in {'retrieve', 'list'}:
        text = '\n'.join(item.value['content'] for item in store.search(namespace))
        return _result('success', text or 'No memories found')
    if action == 'get':
        item = store.get(namespace, memory_record_id)
        return _result('success', item.value['content'] if item else 'Memory not found')
    if action == 'delete':
        store.delete(namespace, memory_record_id)
        return _result('success', f'Deleted memory {memory_record_id}')
    return _result('error', f'Unknown action: {action}')


def prewarm_ltm(
    store: InMemoryStore,
    actor_id: str,
    *,
    thread_id: str | None = None,
) -> str | None:
    del thread_id
    lines = [item.value['content'].strip() for item in store.search(('memory', actor_id))]
    rendered = '\n'.join(f'- {line}' for line in lines if line)
    return rendered or None


def _result(status: Literal['success', 'error'], text: str) -> MemoryToolResult:
    return {'status': status, 'content': [{'text': text}]}
