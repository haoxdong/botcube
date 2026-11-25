"""The Memory block a Session opens with (ADR 0031): the actor's preferences, then their facts newest first."""

from __future__ import annotations

from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

from ...actor_identity import actor_namespace
from ...memory_index import MemoryIndexEntry
from ...memory_tools import extract_text, list_memory_record_summaries
from ...session_memory import render_memory

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore import BedrockAgentCoreClient
    from types_boto3_bedrock_agentcore.type_defs import MemoryRecordSummaryTypeDef


def opening_memory(client: BedrockAgentCoreClient, *, memory_id: str, actor_id: str) -> str:
    with ThreadPoolExecutor(max_workers=2) as pool:
        reads = [
            pool.submit(list_memory_record_summaries, client, memory_id=memory_id, namespace=actor_namespace(actor_id, kind))
            for kind in ('preferences', 'facts')
        ]
    preferences, facts = (read.result() for read in reads)
    return render_memory(_index_entries(_newest_first(preferences)), _index_entries(_newest_first(facts)))


def _newest_first(records: Sequence[MemoryRecordSummaryTypeDef]) -> list[MemoryRecordSummaryTypeDef]:
    return sorted(records, key=lambda record: record['createdAt'], reverse=True)


def _index_entries(records: Sequence[MemoryRecordSummaryTypeDef]) -> list[MemoryIndexEntry]:
    return [
        MemoryIndexEntry(record['memoryRecordId'], text)
        for record in records
        if (text := extract_text(record['content']['text']))
    ]
