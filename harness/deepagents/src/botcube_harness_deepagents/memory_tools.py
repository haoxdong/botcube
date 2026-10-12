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

import json
import logging
import os
import uuid
from typing import TYPE_CHECKING, Annotated, Any, Literal, TypedDict
from xml.etree import ElementTree

from langchain_core.messages import HumanMessage
from langchain_core.tools import BaseTool, tool
from langgraph.prebuilt import InjectedStore
from langgraph_checkpoint_aws import AgentCoreMemoryStore

from .actor_identity import actor_namespace
from .pending_memory import pending_memory_session_id

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore.type_defs import (
        MemoryRecordSummaryTypeDef,
        MemoryRecordTypeDef,
    )

log = logging.getLogger(__name__)

AGENTCORE_MEMORY_ID = os.getenv('AGENTCORE_MEMORY_ID', '')
AGENTCORE_REGION = os.getenv('AGENTCORE_REGION', 'us-east-1')

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
    parts: list[str] = []
    for tag in tags:
        child = element.find(tag)
        if child is None:
            continue
        value = _xml_text(child)
        if value:
            parts.append(f'{_xml_label(tag)}: {value}')
    return parts


def _parse_xml_record(raw: str) -> ElementTree.Element | None:
    try:
        return ElementTree.fromstring(raw)
    except ElementTree.ParseError:
        try:
            return ElementTree.fromstring(f'<{SUMMARY_XML_FRAGMENT_ROOT}>{raw}</{SUMMARY_XML_FRAGMENT_ROOT}>')
        except ElementTree.ParseError:
            return None


def _extract_reflection_xml_text(root: ElementTree.Element) -> str | None:
    parts: list[str] = []
    for reflection in root.findall('reflection'):
        parts.extend(_xml_parts(reflection, REFLECTION_XML_TAGS))

    if parts:
        return '\n'.join(parts)

    return None


def _extract_summary_xml_text(root: ElementTree.Element) -> str | None:
    global_summary = root.find('global_summary')
    delta_summary = root.find('delta_detailed_summary')

    parts: list[str] = []
    if global_summary is not None:
        value = _xml_text(global_summary)
        if value:
            parts.append(f'Global Summary: {value}')

    if delta_summary is not None:
        for topic in delta_summary.findall('topic'):
            value = _xml_text(topic)
            if value:
                parts.append(f'{_xml_label(topic.attrib["name"])}: {value}')

    if parts:
        return '\n'.join(parts)

    return None


def _extract_xml_text(raw: str) -> str | None:
    root = _parse_xml_record(raw)
    if root is None:
        return None

    reflection_text = _extract_reflection_xml_text(root)
    if reflection_text:
        return reflection_text

    summary_text = _extract_summary_xml_text(root)
    if summary_text:
        return summary_text

    parts = _xml_parts(root, EPISODIC_XML_TAGS)

    if parts:
        return '\n'.join(parts)

    return None


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
) -> list[MemoryRecordSummaryTypeDef]:
    """Every record under the namespace prefix."""
    paginator = client.get_paginator('list_memory_records')
    summaries: list[MemoryRecordSummaryTypeDef] = []
    for page in paginator.paginate(
        memoryId=memory_id,
        namespace=namespace,
        PaginationConfig={'PageSize': MEMORY_RECORD_PAGE_SIZE},
    ):
        summaries.extend(page['memoryRecordSummaries'])
    return summaries


def memory_tool(actor_id: str) -> BaseTool:
    """The actor's `memory` tool: Strands' AgentCoreMemoryToolProvider tool under ADR 0031's name."""

    @tool
    def memory(
        action: str,
        content: str = '',
        query: str = '',
        memory_record_id: str = '',
        store: Annotated[AgentCoreMemoryStore | None, InjectedStore()] = None,
    ) -> MemoryToolResult:
        """Work with agent memories - create, search, retrieve, list, and manage memory records.

        This tool helps agents store and access memories, allowing them to remember important
        information across conversations and interactions.

        Extraction skips PII-like content such as account numbers, so agents should not promise durable storage for that content.

        Key Capabilities:
        - Store new memories (text conversations or structured data)
        - Search for memories using semantic search
        - Browse and list all stored memories
        - Retrieve specific memories by ID
        - Delete unwanted memories

        Supported Actions:
        -----------------
        Memory Management:
        - record: Store a new memory (conversation or data)
          Use this when you need to save information for later recall.

        - retrieve: Find relevant memories using semantic search
          Use this when searching for specific information in memories.
          This is the best action for queries like "find memories about X" or "search for memories related to Y".

        - list: Browse all stored memories
          Use this to see all available memories without filtering.
          This is useful for getting an overview of what's been stored.

        - get: Fetch a specific memory by ID
          Use this when you already know the exact memory ID.

        - delete: Remove a specific memory
          Use this to delete memories that are no longer needed.

        Args:
            action: The memory operation to perform (one of: "record", "retrieve", "list", "get", "delete")
            content: For record action: Simple text string to store as a memory
                     Example: "User prefers vegetarian pizza with extra cheese"
            query: Search terms for finding relevant memories (required for retrieve action)
            memory_record_id: ID of a specific memory (required for get and delete actions)
        """
        if store is None:
            raise RuntimeError('The memory tool needs the graph store to be injected')
        return run_memory_action(store, actor_id, action, content=content, query=query, memory_record_id=memory_record_id)

    return memory


def run_memory_action(
    store: AgentCoreMemoryStore, actor_id: str, action: str, *, content: str, query: str, memory_record_id: str,
) -> MemoryToolResult:
    """One `memory` tool call for the actor."""
    if action == 'record':
        return _handle_record(store, actor_id, content)
    if action == 'retrieve':
        return _handle_retrieve(store, actor_id, query)
    if action == 'list':
        return _handle_list(store, actor_id)
    if action == 'get':
        return _handle_get(store, memory_record_id)
    if action == 'delete':
        return _handle_delete(store, memory_record_id)
    return _err(f'Unknown action: {action}. Valid: {", ".join(VALID_ACTIONS)}')


def _handle_record(store: AgentCoreMemoryStore, actor_id: str, content: str) -> MemoryToolResult:
    try:
        store.put(*_pending_memory_item(actor_id, content))
    except Exception:
        log.warning('memory record failed', exc_info=True)
        return _err('Failed to save memory.')
    return _ok(RECORD_REPLY)


def _pending_memory_item(actor_id: str, content: str) -> tuple[tuple[str, str], str, dict[str, Any]]:
    """The store item for one saved memory: namespace, key, and value.

    AgentCoreMemoryStore writes the value as a Pending Memory event and never reads the key.
    """
    return (
        (actor_id, pending_memory_session_id()),
        uuid.uuid4().hex,
        {'message': HumanMessage(content=content)},
    )


def _handle_retrieve(store: AgentCoreMemoryStore, actor_id: str, query: str) -> MemoryToolResult:
    try:
        summaries = store.client.retrieve_memory_records(
            memoryId=store.memory_id,
            namespace=actor_namespace(actor_id),
            searchCriteria={'searchQuery': query},
            maxResults=10,
        )['memoryRecordSummaries']
    except Exception:
        log.warning('memory retrieve failed', exc_info=True)
        return _err('Memory search unavailable.')

    if not summaries:
        return _ok('No relevant memories found.')

    return {'status': 'success', 'content': [{'text': extract_text(_record_text(s))} for s in summaries]}


def _record_text(record: MemoryRecordSummaryTypeDef | MemoryRecordTypeDef) -> str:
    content = record['content']
    if 'text' not in content:
        raise ValueError(f"Memory record {record['memoryRecordId']} has no text content")
    return content['text']


def _handle_list(store: AgentCoreMemoryStore, actor_id: str) -> MemoryToolResult:
    try:
        summaries = list_memory_record_summaries(
            store.client, memory_id=store.memory_id, namespace=actor_namespace(actor_id),
        )
    except Exception:
        log.warning('memory list failed', exc_info=True)
        return _err('Failed to list memories.')

    if not summaries:
        return _ok('No memories stored.')

    return {
        'status': 'success',
        'content': [{'text': f'[{s["memoryRecordId"]}] {extract_text(_record_text(s))}'} for s in summaries],
    }


def _handle_get(store: AgentCoreMemoryStore, memory_record_id: str) -> MemoryToolResult:
    if not memory_record_id:
        return _err('memory_record_id is required for get action.')

    try:
        response = store.client.get_memory_record(
            memoryId=store.memory_id,
            memoryRecordId=memory_record_id,
        )
    except Exception:
        log.warning('memory get failed', exc_info=True)
        return _err(f'Failed to get memory record {memory_record_id}.')

    return _ok(extract_text(_record_text(response['memoryRecord'])))


def _handle_delete(store: AgentCoreMemoryStore, memory_record_id: str) -> MemoryToolResult:
    if not memory_record_id:
        return _err('memory_record_id is required for delete action.')

    try:
        store.client.delete_memory_record(
            memoryId=store.memory_id,
            memoryRecordId=memory_record_id,
        )
    except Exception:
        log.warning('memory delete failed', exc_info=True)
        return _err(f'Failed to delete memory record {memory_record_id}.')

    return _ok(f'Deleted memory record {memory_record_id}.')
