"""The `memory` tool for the deep agent (ADR 0031).

One tool per actor with action dispatch matching the Strands
``AgentCoreMemoryToolProvider`` convention: record, retrieve, list, get, delete.
Strands names its tool ``agent_core_memory``; ADR 0031 names ours ``memory``.

Uses ``InjectedStore`` so LangGraph's ``ToolNode`` injects the
``AgentCoreMemoryStore`` automatically.  Reads go through ``store.client``
under the actor's ``/actors/<actor>/`` prefix (ADR 0033), as Strands' do
under its ``namespace``; ``record`` writes today's Pending Memory session (ADR 0032).

Returns the same ``{"status", "content"}`` envelope as the Strands tool.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import TYPE_CHECKING, Annotated, Any, Literal, NotRequired, TypedDict
from xml.etree import ElementTree

from langchain_core.tools import BaseTool, tool
from langgraph.prebuilt import InjectedStore
from langgraph_checkpoint_aws import AgentCoreMemoryStore

from . import pending_memory
from .actor_identity import actor_namespace
from .memory_index import MemoryIndexEntry, memory_index_line, memory_reference

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore.type_defs import (
        ListMemoryRecordsInputTypeDef,
        MemoryRecordSummaryTypeDef,
        MemoryRecordTypeDef,
        RetrieveMemoryRecordsInputTypeDef,
    )

log = logging.getLogger(__name__)

AGENTCORE_MEMORY_ID = os.getenv('AGENTCORE_MEMORY_ID', '')
AWS_REGION = os.getenv('AWS_REGION', 'us-east-1')

VALID_ACTIONS = ('record', 'retrieve', 'list', 'get', 'delete')
# A new Session reads Pending Memory at once; extraction takes 20-90 s and the record listing ~25 s more (ADR 0032 §6).
RECORD_REPLY = (
    'Saved to memory. A new conversation sees it right away, and it reaches long-term memory within about two minutes.'
)
MEMORY_RECORD_PAGE_SIZE = 100
TEXT_KEYS = ('preference', 'fact', 'summary', 'episode', 'reflection')
EPISODIC_XML_TAGS = ('situation', 'intent', 'assessment', 'justification', 'reflection')
REFLECTION_XML_TAGS = ('title', 'use_cases', 'hints')
SUMMARY_XML_FRAGMENT_ROOT = 'memory_record'


class MemoryToolText(TypedDict):
    text: str


class MemoryToolResult(TypedDict):
    status: Literal['success', 'error']
    content: list[MemoryToolText]
    next_token: NotRequired[str]


def _ok(text: str) -> MemoryToolResult:
    return {'status': 'success', 'content': [{'text': text}]}


def _err(text: str) -> MemoryToolResult:
    return {'status': 'error', 'content': [{'text': text}]}


def _text_value(parsed: dict[str, Any]) -> str | None:
    for key in TEXT_KEYS:
        value = parsed.get(key)
        if isinstance(value, str) and value:
            return value

    memory = parsed.get('memory')
    if isinstance(memory, dict):
        return _text_value(memory)

    return None


def _xml_text(element: ElementTree.Element) -> str | None:
    text = ' '.join(piece.strip() for piece in element.itertext() if piece.strip())
    return text or None


def _xml_label(raw: str) -> str:
    return raw.replace('_', ' ').title()


def _xml_parts(element: ElementTree.Element, tags: tuple[str, ...]) -> list[str]:
    return [f'{_xml_label(tag)}: {value}' for tag in tags
            if (child := element.find(tag)) is not None and (value := _xml_text(child))]


def _parse_xml_record(raw: str) -> ElementTree.Element | None:
    try:
        return ElementTree.fromstring(raw)
    except ElementTree.ParseError:
        try:
            return ElementTree.fromstring(f'<{SUMMARY_XML_FRAGMENT_ROOT}>{raw}</{SUMMARY_XML_FRAGMENT_ROOT}>')
        except ElementTree.ParseError:
            return None


def _summary_parts(root: ElementTree.Element) -> list[str]:
    delta = root.find('delta_detailed_summary')
    topics = [] if delta is None else delta.findall('topic')
    return [*_xml_parts(root, ('global_summary',)),
            *(f'{_xml_label(topic.attrib["name"])}: {value}' for topic in topics if (value := _xml_text(topic)))]


def _extract_xml_text(raw: str) -> str | None:
    root = _parse_xml_record(raw)
    if root is None:
        return None
    reflection = [part for element in root.findall('reflection') for part in _xml_parts(element, REFLECTION_XML_TAGS)]
    return '\n'.join(reflection or _summary_parts(root) or _xml_parts(root, EPISODIC_XML_TAGS)) or None


def extract_text(raw: str) -> str:
    """Extract clean text from a memory record's content string.

    Semantic items are plain text.  UserPreference items are JSON with
    a ``preference`` or ``fact`` key — return just that value.
    """
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            text = _text_value(parsed)
            if text:
                return text
    except (json.JSONDecodeError, TypeError):
        pass
    if raw.lstrip().startswith('<'):
        text = _extract_xml_text(raw)
        if text:
            return text
    return raw


def list_memory_record_summaries(
    client: Any,
    *,
    memory_id: str,
    namespace: str,
    selector: Literal['namespace', 'namespacePath'] = 'namespace',
) -> list[MemoryRecordSummaryTypeDef]:
    """Every record in an exact namespace, or its hierarchy with ``namespacePath``."""
    paginator = client.get_paginator('list_memory_records')
    summaries: list[MemoryRecordSummaryTypeDef] = []
    for page in paginator.paginate(
        memoryId=memory_id,
        **{selector: namespace},
        PaginationConfig={'PageSize': MEMORY_RECORD_PAGE_SIZE},
    ):
        summaries.extend(page['memoryRecordSummaries'])
    return summaries


def record_namespace(client: Any, *, memory_id: str, actor_id: str, record_id: str) -> str | None:
    """The namespace of one of the actor's records, or None when the actor has no such record.

    A get or delete by ID names it: the `assume-role` session policy scopes both by the request's namespace.
    """
    for summary in list_memory_record_summaries(
        client, memory_id=memory_id, namespace=actor_namespace(actor_id), selector='namespacePath',
    ):
        if summary['memoryRecordId'] == record_id:
            return summary['namespaces'][0]
    return None


def memory_tool(actor_id: str) -> BaseTool:
    """The actor's `memory` tool: Strands' AgentCoreMemoryToolProvider tool under ADR 0031's name."""

    @tool
    def memory(
        action: str,
        content: str = '',
        query: str = '',
        memory_record_id: str = '',
        max_results: int = 10,
        next_token: str = '',
        store: Annotated[AgentCoreMemoryStore | None, InjectedStore()] = None,
    ) -> MemoryToolResult:
        """Store, search, list, open, or delete the actor's memories.

        record saves content for future conversations. Extraction skips PII-like content such as
        account numbers, so do not promise durable storage for it.
        list browses one page. retrieve searches one page using query. Both return one-line indexes
        of at most 100 characters per record, with stable 8-character references and … for cut text.
        Pass the returned next_token into the same action and query to continue, using max_results
        from 1 to 100. The opening block shows at most 100 preferences and 100 facts, newest first.
        Its closing count names omitted records. Use list or retrieve to find them.
        get opens full text. delete removes a record. Both accept memory_record_id as the
        8-character reference or full id, only within this actor's namespace. An ambiguous reference
        returns the matching full ids. There is no update action.

        Args:
            action: record, retrieve, list, get, or delete.
            content: Text to save with record.
            query: Semantic search terms for retrieve.
            memory_record_id: Reference or full id for get and delete.
            max_results: Page size for list and retrieve, from 1 to 100.
            next_token: Continuation from the previous page of the same action and query.
        """
        if store is None:
            raise RuntimeError('The memory tool needs the graph store to be injected')
        if action == 'record':
            return _handle_record(store, actor_id, content)
        if action in ('retrieve', 'list') and not 1 <= max_results <= 100:
            return _err('max_results must be between 1 and 100.')
        if action == 'retrieve':
            return _handle_retrieve(store, actor_id, query, max_results, next_token)
        if action == 'list':
            return _handle_list(store, actor_id, max_results, next_token)
        if action == 'get':
            return _handle_get(store, actor_id, memory_record_id)
        if action == 'delete':
            return _handle_delete(store, actor_id, memory_record_id)
        return _err(f'Unknown action: {action}. Valid: {", ".join(VALID_ACTIONS)}')

    return memory


def _handle_record(store: AgentCoreMemoryStore, actor_id: str, content: str) -> MemoryToolResult:
    try:
        pending_memory.record_pending_memory(store.client, memory_id=store.memory_id, actor_id=actor_id, text=content)
    except Exception:
        log.warning('memory record failed', exc_info=True)
        return _err('Failed to save memory.')
    return _ok(RECORD_REPLY)


def _handle_retrieve(store: AgentCoreMemoryStore, actor_id: str, query: str, max_results: int, next_token: str) -> MemoryToolResult:
    try:
        upstream_token, offset = _retrieve_cursor(next_token)
        request: RetrieveMemoryRecordsInputTypeDef = {
            'memoryId': store.memory_id, 'namespacePath': actor_namespace(actor_id),
            'searchCriteria': {'searchQuery': query}, 'maxResults': max_results,
        }
        if upstream_token:
            request['nextToken'] = upstream_token
        response = store.client.retrieve_memory_records(**request)
    except Exception:
        log.warning('memory retrieve failed', exc_info=True)
        return _err('Memory search unavailable.')

    summaries = response['memoryRecordSummaries']
    end = offset + max_results
    continuation = (
        'index:' + base64.urlsafe_b64encode(json.dumps([upstream_token, end]).encode()).decode()
        if len(summaries) > end else response.get('nextToken')
    )
    return _index_page(summaries[offset:end], continuation, 'No relevant memories found.')


def _retrieve_cursor(token: str) -> tuple[str, int]:
    if not token.startswith('index:'):
        return token, 0
    upstream, offset = json.loads(base64.urlsafe_b64decode(token.removeprefix('index:')))
    if not isinstance(upstream, str) or not isinstance(offset, int) or offset < 0:
        raise ValueError('Invalid memory page token')
    return upstream, offset


def _record_text(record: MemoryRecordSummaryTypeDef | MemoryRecordTypeDef) -> str:
    content = record['content']
    if 'text' not in content:
        raise ValueError(f"Memory record {record['memoryRecordId']} has no text content")
    return content['text']


def _index_page(
    summaries: list[MemoryRecordSummaryTypeDef], next_token: str | None, empty: str,
) -> MemoryToolResult:
    result: MemoryToolResult = {
        'status': 'success',
        'content': [{'text': memory_index_line(MemoryIndexEntry(s['memoryRecordId'], extract_text(_record_text(s))))}
                    for s in summaries] or [{'text': 'No memories on this page. Continue with next_token.' if next_token else empty}],
    }
    if next_token:
        result['next_token'] = next_token
    return result


def _handle_list(store: AgentCoreMemoryStore, actor_id: str, max_results: int, next_token: str) -> MemoryToolResult:
    try:
        request: ListMemoryRecordsInputTypeDef = {
            'memoryId': store.memory_id, 'namespacePath': actor_namespace(actor_id), 'maxResults': max_results,
        }
        if next_token:
            request['nextToken'] = next_token
        response = store.client.list_memory_records(**request)
    except Exception:
        log.warning('memory list failed', exc_info=True)
        return _err('Failed to list memories.')
    return _index_page(response['memoryRecordSummaries'], response.get('nextToken'), 'No memories stored.')


class AmbiguousMemoryReference(ValueError):
    pass


def _resolve_record(store: AgentCoreMemoryStore, actor_id: str, reference: str) -> tuple[str, str] | None:
    records = list_memory_record_summaries(
        store.client, memory_id=store.memory_id, namespace=actor_namespace(actor_id), selector='namespacePath',
    )
    matches = [record for record in records if record['memoryRecordId'] == reference or (
        len(reference) == 8 and memory_reference(record['memoryRecordId']) == reference
    )]
    if len(matches) > 1:
        ids = ', '.join(record['memoryRecordId'] for record in matches)
        raise AmbiguousMemoryReference(f'Ambiguous memory reference {reference}. Use a full id: {ids}')
    return (matches[0]['memoryRecordId'], matches[0]['namespaces'][0]) if matches else None


def _handle_get(store: AgentCoreMemoryStore, actor_id: str, memory_record_id: str) -> MemoryToolResult:
    if not memory_record_id:
        return _err('memory_record_id is required for get action.')

    try:
        resolved = _resolve_record(store, actor_id, memory_record_id)
        if resolved is None:
            return _err(f'Failed to get memory record {memory_record_id}.')
        memory_record_id, namespace = resolved
        response = store.client.get_memory_record(
            memoryId=store.memory_id,
            memoryRecordId=memory_record_id,
            namespace=namespace,
        )
    except AmbiguousMemoryReference as error:
        return _err(str(error))
    except Exception:
        log.warning('memory get failed', exc_info=True)
        return _err(f'Failed to get memory record {memory_record_id}.')

    return _ok(extract_text(_record_text(response['memoryRecord'])))


def _handle_delete(store: AgentCoreMemoryStore, actor_id: str, memory_record_id: str) -> MemoryToolResult:
    if not memory_record_id:
        return _err('memory_record_id is required for delete action.')

    try:
        resolved = _resolve_record(store, actor_id, memory_record_id)
        if resolved is None:
            return _err(f'Failed to delete memory record {memory_record_id}.')
        memory_record_id, namespace = resolved
        store.client.delete_memory_record(
            memoryId=store.memory_id,
            memoryRecordId=memory_record_id,
            namespace=namespace,
        )
    except AmbiguousMemoryReference as error:
        return _err(str(error))
    except Exception:
        log.warning('memory delete failed', exc_info=True)
        return _err(f'Failed to delete memory record {memory_record_id}.')

    return _ok(f'Deleted memory record {memory_record_id}.')
