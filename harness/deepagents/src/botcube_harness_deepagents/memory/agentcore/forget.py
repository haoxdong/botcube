"""Forget: delete every long-term record AgentCore extracted under an actor (ADR 0095 decision 2).

ListMemoryRecords lags deletes by about a minute, so a retry soon after a failed run can list a record that run
deleted; its delete then fails, and a later retry, once the listing catches up, finishes.
"""

from __future__ import annotations

import logging
from typing import Any

from ...actor_identity import actor_namespace
from ...memory_tools import list_memory_record_summaries

log = logging.getLogger(__name__)
# Lambda's root logger defaults to WARNING; the count deleted must reach CloudWatch.
log.setLevel(logging.INFO)


def forget_extracted_memory(client: Any, *, memory_id: str, actor_id: str) -> None:
    """Delete every record in the actor's namespaces, nested ones included."""
    summaries = list_memory_record_summaries(
        client, memory_id=memory_id, namespace=actor_namespace(actor_id), selector='namespacePath',
    )
    for summary in summaries:
        client.delete_memory_record(
            memoryId=memory_id, memoryRecordId=summary['memoryRecordId'], namespace=summary['namespaces'][0],
        )
    log.info('Forgot Extracted Memory: deleted %d records.', len(summaries))
