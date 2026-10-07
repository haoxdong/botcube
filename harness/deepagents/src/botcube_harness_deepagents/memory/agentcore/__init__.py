from __future__ import annotations

from collections.abc import Callable
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph_checkpoint_aws import AgentCoreMemoryStore
from langgraph_checkpoint_aws.checkpoint.agentcore.helpers import (
    AgentCoreEventClient,
    BedrockAgentCoreClientWithRetry,
    EventProcessor,
    EventSerializer,
)

from ...memory_broker import MemoryBrokerClient
from ...memory_tools import agent_core_memory
from ...turn_memory import TurnMemoryMiddleware
from .snapshot_saver import SnapshotAgentCoreMemorySaver

__all__ = ['build_checkpointer', 'build_memory_tools', 'build_store', 'prewarm_ltm']


def build_checkpointer(
    memory_id: str,
    *,
    region_name: str,
    wrapper: Callable[[Any], Any] | None = None,
    broker: bool = False,
) -> Any:
    saver = BrokerMemorySaver(memory_id) if broker else SnapshotAgentCoreMemorySaver(memory_id, region_name=region_name)
    return wrapper(saver) if wrapper is not None else saver


class BrokerMemorySaver(SnapshotAgentCoreMemorySaver):
    def __init__(self, memory_id: str) -> None:
        # Upstream constructors unconditionally create boto clients. Keep their
        # serializer and event methods, installing the transport before any I/O.
        BaseCheckpointSaver.__init__(self)
        self.memory_id = memory_id
        self.limit = None
        self.max_results = 100
        self.serializer = EventSerializer(self.serde)
        self.checkpoint_event_client = AgentCoreEventClient.__new__(AgentCoreEventClient)
        self.checkpoint_event_client.memory_id = memory_id
        self.checkpoint_event_client.serializer = self.serializer
        self.checkpoint_event_client.client = BedrockAgentCoreClientWithRetry(MemoryBrokerClient())
        self.processor = EventProcessor()


class BrokerMemoryStore(AgentCoreMemoryStore):
    def __init__(self, memory_id: str) -> None:
        self.memory_id = memory_id
        self.hierarchical_search = True
        self.client = MemoryBrokerClient()


def build_store(memory_id: str, *, region_name: str, broker: bool = False) -> AgentCoreMemoryStore:
    return BrokerMemoryStore(memory_id) if broker else AgentCoreMemoryStore(memory_id=memory_id, region_name=region_name)


def build_memory_tools(
    *,
    store: AgentCoreMemoryStore,
    actor_id: str,
    thread_id: str,
    memory_id: str,
) -> tuple[list[Any], list[Any]]:
    del store
    return [agent_core_memory], [
        TurnMemoryMiddleware(
            memory_id=memory_id,
            actor_id=actor_id,
            session_id=thread_id,
        )
    ]


def prewarm_ltm(
    store: AgentCoreMemoryStore,
    actor_id: str,
    *,
    thread_id: str | None = None,
) -> str | None:
    from ...serving import _prewarm_ltm

    return _prewarm_ltm(store, actor_id, thread_id=thread_id)
