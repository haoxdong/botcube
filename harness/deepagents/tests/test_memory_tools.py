"""Tests for memory_tools — agent_core_memory parity with Strands AgentCoreMemoryToolProvider.

Contract: contract/parity/agent-core-memory-tool.md
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.stub import Stubber
from langchain_core.messages import HumanMessage
from langchain_core.tools import StructuredTool
from langgraph_checkpoint_aws import AgentCoreMemoryStore

from botcube_harness_deepagents import memory_tools
from botcube_harness_deepagents.memory_tools import (
    VALID_ACTIONS,
    MemoryToolResult,
    _extract_text,
    agent_core_memory,
)

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore.type_defs import MemoryRecordSummaryTypeDef

# -- helpers ------------------------------------------------------------------

def _make_record_summary(
    content_text: str,
    record_id: str = 'rec-1',
    *,
    actor_id: str = 'botcube_harness_deepagents',
) -> dict[str, object]:
    """Build a memoryRecordSummary matching boto3 retrieve_memory_records response."""
    return {
        'memoryRecordId': record_id,
        'content': {'text': content_text},
        'namespace': f'/strategies/Semantic-1/actors/{actor_id}/',
    }


EPISODIC_XML = (
    '<summary>'
    '<situation>The user saved a deployment runbook.</situation>'
    '<intent>Recall the runbook later.</intent>'
    '<assessment>The memory was useful.</assessment>'
    '<justification>The user explicitly asked to remember it.</justification>'
    '<reflection>Retrieve the runbook before asking again.</reflection>'
    '</summary>'
)

EPISODIC_TEXT = (
    'Situation: The user saved a deployment runbook.\n'
    'Intent: Recall the runbook later.\n'
    'Assessment: The memory was useful.\n'
    'Justification: The user explicitly asked to remember it.\n'
    'Reflection: Retrieve the runbook before asking again.'
)


REFLECTION_XML = '''
<reflections>
  <reflection>
    <title>Deployment runbook memory</title>
    <use_cases>
      <use_case>Before deploying AgentCore, recall the saved runbook.</use_case>
      <use_case>When deployment fails, check the saved runbook.</use_case>
    </use_cases>
    <hints>
      <hint>Look up wiki/runbook-v2 before asking the user to repeat it.</hint>
    </hints>
  </reflection>
</reflections>
'''

REFLECTION_TEXT = (
    'Title: Deployment runbook memory\n'
    'Use Cases: Before deploying AgentCore, recall the saved runbook. '
    'When deployment fails, check the saved runbook.\n'
    'Hints: Look up wiki/runbook-v2 before asking the user to repeat it.'
)


SUMMARY_XML = '''
<existing_global_summary_word_count>
  12
</existing_global_summary_word_count>
<global_summary>
  AgentCore memory strategy work should preserve clean tool output.
</global_summary>
<delta_detailed_summary>
  <topic name="review feedback">
    The connector asked for SUMMARIZATION XML handling.
  </topic>
  <topic name="verification">
    Run focused memory tool tests before resolving the thread.
  </topic>
</delta_detailed_summary>
'''

SUMMARY_TEXT = (
    'Global Summary: AgentCore memory strategy work should preserve clean tool output.\n'
    'Review Feedback: The connector asked for SUMMARIZATION XML handling.\n'
    'Verification: Run focused memory tool tests before resolving the thread.'
)


def _invoke(action: str, *, store: Any = None, query: str = '', content: str = '',
            actor_id: str = 'botcube_harness_deepagents', thread_id: str = 'default',
            memory_record_id: str = '') -> MemoryToolResult:
    """Call agent_core_memory's underlying function directly with mocked config."""
    with patch('botcube_harness_deepagents.memory_tools.get_config', return_value={
        'configurable': {'actor_id': actor_id, 'thread_id': thread_id},
    }):
        kwargs: dict[str, Any] = {
            'action': action,
            'query': query,
            'content': content,
        }
        if store is not None:
            kwargs['store'] = store
        if memory_record_id:
            kwargs['memory_record_id'] = memory_record_id
        assert isinstance(agent_core_memory, StructuredTool) and agent_core_memory.func is not None
        return agent_core_memory.func(**kwargs)


# -- return envelope ----------------------------------------------------------

class TestReturnEnvelope:
    """All actions return {"status": "success"|"error", "content": [{"text": "..."}]}."""

    @pytest.mark.parametrize('action', list(VALID_ACTIONS))
    def test_success_envelope_shape(self, action: str) -> None:
        store = MagicMock()
        store.client.retrieve_memory_records.return_value = {'memoryRecordSummaries': []}
        store.client.list_memory_records.return_value = {'memoryRecordSummaries': []}
        store.client.get_memory_record.return_value = {'memoryRecord': {'content': {'text': 'x'}}}
        store.client.delete_memory_record.return_value = {}

        kwargs: dict[str, Any] = {'store': store}
        if action == 'record':
            kwargs['content'] = 'test'
        elif action == 'retrieve':
            kwargs['query'] = 'test'
        elif action in ('get', 'delete'):
            kwargs['memory_record_id'] = 'rec-1'

        result = _invoke(action, **kwargs)

        assert 'status' in result
        assert result['status'] in ('success', 'error')
        assert 'content' in result
        assert isinstance(result['content'], list)
        for item in result['content']:
            assert 'text' in item
            assert isinstance(item['text'], str)


def test_tool_description_warns_about_pii_extraction_limits() -> None:
    description = agent_core_memory.description or ''

    assert 'PII-like content' in description
    assert 'should not promise durable storage' in description


# -- _extract_text -----------------------------------------------------------

class TestExtractText:
    def test_plain_semantic_text(self) -> None:
        assert _extract_text('The user is based in New York.') == 'The user is based in New York.'

    def test_user_preference_json(self) -> None:
        raw = json.dumps({
            'context': 'The user asked for copper.',
            'preference': 'Prefers copper analysis',
            'categories': ['commodities'],
        })
        assert _extract_text(raw) == 'Prefers copper analysis'

    @pytest.mark.parametrize('key', ['fact', 'summary', 'episode', 'reflection'])
    def test_json_text_record_shapes(self, key: str) -> None:
        raw = json.dumps({
            key: 'The deploy runbook is at wiki/runbook-v2.',
            'source': 'agentcore',
        })
        assert _extract_text(raw) == 'The deploy runbook is at wiki/runbook-v2.'

    def test_nested_json_fact_shape(self) -> None:
        raw = json.dumps({
            'memory': {
                'fact': 'The deploy runbook is at wiki/runbook-v2.',
            },
        })
        assert _extract_text(raw) == 'The deploy runbook is at wiki/runbook-v2.'

    def test_episodic_xml_shape(self) -> None:
        assert _extract_text(EPISODIC_XML) == EPISODIC_TEXT

    def test_reflection_xml_shape(self) -> None:
        assert _extract_text(REFLECTION_XML) == REFLECTION_TEXT

    def test_summary_xml_shape(self) -> None:
        assert _extract_text(SUMMARY_XML) == SUMMARY_TEXT

    def test_json_without_preference_key(self) -> None:
        raw = json.dumps({'foo': 'bar'})
        assert _extract_text(raw) == raw

    def test_empty_string(self) -> None:
        assert _extract_text('') == ''


# -- record ------------------------------------------------------------------

class TestRecord:
    def test_success(self) -> None:
        store = MagicMock()
        with patch('botcube_harness_deepagents.memory_tools.pending_memory_session_id', return_value='pending-memory-20260702'):
            result = _invoke('record', store=store, content='User prefers dark mode')

        assert result == {'status': 'success', 'content': [{'text': 'Saved to memory.'}]}
        store.put.assert_called_once()
        call_args = store.put.call_args
        assert call_args[0][0] == ('botcube_harness_deepagents', 'pending-memory-20260702')
        assert isinstance(call_args[0][2]['message'], HumanMessage)
        assert call_args[0][2]['message'].content == 'User prefers dark mode'

    def test_record_writes_to_date_keyed_pending_memory_session(self) -> None:
        store = MagicMock()

        with patch('botcube_harness_deepagents.memory_tools.pending_memory_session_id', return_value='pending-memory-20260702'):
            _invoke(
                'record',
                store=store,
                content='Runbook URL is wiki/runbook-v2',
                thread_id='conversation-thread',
            )

        assert store.put.call_args[0][0] == ('botcube_harness_deepagents', 'pending-memory-20260702')
        assert isinstance(store.put.call_args[0][2]['message'], HumanMessage)
        assert store.put.call_args[0][2]['message'].content == 'Runbook URL is wiki/runbook-v2'

    def test_record_uses_real_pending_memory_session_formatter(self) -> None:
        store = MagicMock()

        _invoke('record', store=store, content='test')

        assert re.fullmatch(r'pending-memory-\d{8}', store.put.call_args[0][0][1])

    def test_error(self) -> None:
        store = MagicMock()
        store.put.side_effect = RuntimeError('network')
        result = _invoke('record', store=store, content='anything')

        assert result == {'status': 'error', 'content': [{'text': 'Failed to save memory.'}]}

    def test_custom_actor_id(self) -> None:
        store = MagicMock()
        with patch('botcube_harness_deepagents.memory_tools.pending_memory_session_id', return_value='pending-memory-20260702'):
            _invoke('record', store=store, content='test', actor_id='custom-actor')
        assert store.put.call_args[0][0] == ('custom-actor', 'pending-memory-20260702')

    def test_blank_actor_id_falls_back_to_anonymous(self) -> None:
        store = MagicMock()
        _invoke('record', store=store, content='test', actor_id='', thread_id='Thread 42')
        assert store.put.call_args[0][0][0] == 'anonymous'
        assert re.fullmatch(
            r'pending-memory-\d{8}-thread_42-[0-9a-f]{12}',
            store.put.call_args[0][0][1],
        )

    def test_anonymous_record_scopes_pending_memory_session_to_thread_id(self) -> None:
        store = MagicMock()

        _invoke(
            'record',
            store=store,
            content='Desk URL is wiki/private',
            actor_id='anonymous',
            thread_id='Thread 42',
        )

        assert re.fullmatch(
            r'pending-memory-\d{8}-thread_42-[0-9a-f]{12}',
            store.put.call_args[0][0][1],
        )

    def test_anonymous_record_bounds_long_thread_pending_memory_session_id(self) -> None:
        class BoundSessionStore:
            def __init__(self) -> None:
                self.namespaces: list[tuple[str, str]] = []

            def put(self, namespace: tuple[str, str], key: str, value: object) -> None:
                self.namespaces.append(namespace)
                if len(namespace[1]) > 100:
                    raise ValueError('sessionId must be at most 100 characters')

        store = BoundSessionStore()

        result = _invoke(
            'record',
            store=store,
            content='Desk URL is wiki/private',
            actor_id='anonymous',
            thread_id='Thread ' + 'A' * 160,
        )

        assert result == {'status': 'success', 'content': [{'text': 'Saved to memory.'}]}
        session_id = store.namespaces[0][1]
        assert len(session_id) <= 100
        assert re.fullmatch(r'pending-memory-\d{8}-thread_a+-[0-9a-f]{12}', session_id)

    def test_anonymous_record_uses_agentcore_session_id_charset(self) -> None:
        class AgentCoreSessionStore:
            def __init__(self) -> None:
                self.namespaces: list[tuple[str, str]] = []

            def put(self, namespace: tuple[str, str], key: str, value: object) -> None:
                self.namespaces.append(namespace)
                if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', namespace[1]):
                    raise ValueError('SessionId failed validation')

        store = AgentCoreSessionStore()

        result = _invoke(
            'record',
            store=store,
            content='Desk URL is wiki/private',
            actor_id='anonymous',
            thread_id='Thread:42',
        )

        assert result == {'status': 'success', 'content': [{'text': 'Saved to memory.'}]}
        session_id = store.namespaces[0][1]
        assert ':' not in session_id
        assert len(session_id) <= 100
        assert re.fullmatch(r'pending-memory-\d{8}-thread_42-[0-9a-f]{12}', session_id)

    def test_record_ignores_conversation_thread_id(self) -> None:
        store = MagicMock()

        with patch('botcube_harness_deepagents.memory_tools.pending_memory_session_id', return_value='pending-memory-20260702'):
            _invoke('record', store=store, content='test', thread_id='thread-42')

        assert store.put.call_args[0][0] == ('botcube_harness_deepagents', 'pending-memory-20260702')


# -- retrieve ----------------------------------------------------------------

class TestRetrieve:
    def test_success_with_results(self) -> None:
        store = MagicMock()
        store.client.list_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('The user is based in New York.', 'rec-1'),
            ],
        }
        store.client.retrieve_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('The user is based in New York.', 'rec-1'),
                _make_record_summary(json.dumps({
                    'context': '...',
                    'preference': 'Prefers copper analysis',
                    'categories': [],
                }), 'rec-2'),
            ],
        }

        result = _invoke('retrieve', store=store, query='user location')

        assert result == {
            'status': 'success',
            'content': [
                {'text': 'The user is based in New York.'},
                {'text': 'Prefers copper analysis'},
            ],
        }
        call_kwargs = store.client.retrieve_memory_records.call_args[1]
        assert call_kwargs['namespacePath'] == '/strategies/Semantic-1/actors/botcube_harness_deepagents/'

    def test_filters_results_to_current_actor(self) -> None:
        store = MagicMock()
        store.client.list_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('Jane prefers dark mode.', 'rec-1', actor_id='jane.doe_ny'),
                _make_record_summary('Other user prefers light mode.', 'rec-2', actor_id='other_user'),
            ],
        }
        store.client.retrieve_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('Jane prefers dark mode.', 'rec-1', actor_id='jane.doe_ny'),
                _make_record_summary('Other user prefers light mode.', 'rec-2', actor_id='other_user'),
            ],
        }

        result = _invoke('retrieve', store=store, query='mode', actor_id='jane.doe_ny')

        assert result == {
            'status': 'success',
            'content': [{'text': 'Jane prefers dark mode.'}],
        }

    def test_scopes_search_to_actor_namespaces_before_top_k(self) -> None:
        store = MagicMock()
        store.client.list_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('Jane prefers dark mode.', 'rec-1', actor_id='jane.doe_ny'),
                _make_record_summary('Other user prefers light mode.', 'rec-2', actor_id='other_user'),
            ],
        }
        store.client.retrieve_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('Jane prefers dark mode.', 'rec-1', actor_id='jane.doe_ny'),
            ],
        }

        result = _invoke('retrieve', store=store, query='mode', actor_id='jane.doe_ny')

        assert result == {
            'status': 'success',
            'content': [{'text': 'Jane prefers dark mode.'}],
        }
        call_kwargs = store.client.retrieve_memory_records.call_args.kwargs
        assert call_kwargs['namespacePath'] == '/strategies/Semantic-1/actors/jane.doe_ny/'
        assert call_kwargs['maxResults'] == 10

    def test_success_unwraps_strategy_record_shapes(self) -> None:
        store = MagicMock()
        store.client.list_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('The deploy runbook is at wiki/runbook-v2.', 'rec-fact'),
            ],
        }
        store.client.retrieve_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary(json.dumps({
                    'fact': 'The deploy runbook is at wiki/runbook-v2.',
                }), 'rec-fact'),
                _make_record_summary(json.dumps({
                    'context': '...',
                    'preference': 'Prefers copper analysis',
                    'categories': [],
                }), 'rec-pref'),
                _make_record_summary(EPISODIC_XML, 'rec-episode'),
                _make_record_summary(REFLECTION_XML, 'rec-reflection'),
                _make_record_summary(SUMMARY_XML, 'rec-summary'),
            ],
        }

        result = _invoke('retrieve', store=store, query='runbook')

        assert result == {
            'status': 'success',
            'content': [
                {'text': 'The deploy runbook is at wiki/runbook-v2.'},
                {'text': 'Prefers copper analysis'},
                {'text': EPISODIC_TEXT},
                {'text': REFLECTION_TEXT},
                {'text': SUMMARY_TEXT},
            ],
        }

    def test_success_no_results(self) -> None:
        store = MagicMock()
        store.client.list_memory_records.return_value = {'memoryRecordSummaries': []}
        store.client.retrieve_memory_records.return_value = {'memoryRecordSummaries': []}

        result = _invoke('retrieve', store=store, query='unknown')

        assert result == {'status': 'success', 'content': [{'text': 'No relevant memories found.'}]}

    def test_error(self) -> None:
        store = MagicMock()
        store.client.list_memory_records.return_value = {
            'memoryRecordSummaries': [
                _make_record_summary('The user is based in New York.', 'rec-1'),
            ],
        }
        store.client.retrieve_memory_records.side_effect = RuntimeError('boom')

        result = _invoke('retrieve', store=store, query='anything')

        assert result == {'status': 'error', 'content': [{'text': 'Memory search unavailable.'}]}


# -- list --------------------------------------------------------------------

class TestList:
    def test_success_with_records(self) -> None:
        store = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                'memoryRecordSummaries': [
                    _make_record_summary('The user is based in New York.', 'rec-1'),
                    _make_record_summary(json.dumps({
                        'context': '...',
                        'preference': 'Prefers copper analysis',
                        'categories': [],
                    }), 'rec-2'),
                ],
            }
        ]
        store.client.get_paginator.return_value = paginator

        result = _invoke('list', store=store)

        assert result == {
            'status': 'success',
            'content': [
                {'text': '[rec-1] The user is based in New York.'},
                {'text': '[rec-2] Prefers copper analysis'},
            ],
        }

    def test_filters_records_to_current_actor(self) -> None:
        store = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                'memoryRecordSummaries': [
                    _make_record_summary('Jane prefers dark mode.', 'rec-1', actor_id='jane.doe_ny'),
                    _make_record_summary('Other user prefers light mode.', 'rec-2', actor_id='other_user'),
                ],
            }
        ]
        store.client.get_paginator.return_value = paginator

        result = _invoke('list', store=store, actor_id='jane.doe_ny')

        assert result == {
            'status': 'success',
            'content': [{'text': '[rec-1] Jane prefers dark mode.'}],
        }

    def test_finds_current_actor_records_on_later_pages(self) -> None:
        store = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                'memoryRecordSummaries': [
                    _make_record_summary('Other user prefers light mode.', 'rec-1', actor_id='other_user'),
                ],
            },
            {
                'memoryRecordSummaries': [
                    _make_record_summary('Jane prefers dark mode.', 'rec-2', actor_id='jane.doe_ny'),
                ],
            },
        ]
        store.client.get_paginator.return_value = paginator

        result = _invoke('list', store=store, actor_id='jane.doe_ny')

        assert result == {
            'status': 'success',
            'content': [{'text': '[rec-2] Jane prefers dark mode.'}],
        }

    def test_success_unwraps_strategy_record_shapes(self) -> None:
        store = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                'memoryRecordSummaries': [
                    _make_record_summary(json.dumps({
                        'fact': 'The deploy runbook is at wiki/runbook-v2.',
                    }), 'rec-fact'),
                    _make_record_summary(EPISODIC_XML, 'rec-episode'),
                    _make_record_summary(SUMMARY_XML, 'rec-summary'),
                ],
            }
        ]
        store.client.get_paginator.return_value = paginator

        result = _invoke('list', store=store)

        assert result == {
            'status': 'success',
            'content': [
                {'text': '[rec-fact] The deploy runbook is at wiki/runbook-v2.'},
                {'text': f'[rec-episode] {EPISODIC_TEXT}'},
                {'text': f'[rec-summary] {SUMMARY_TEXT}'},
            ],
        }

    def test_success_empty(self) -> None:
        store = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [{'memoryRecordSummaries': []}]
        store.client.get_paginator.return_value = paginator

        result = _invoke('list', store=store)

        assert result == {'status': 'success', 'content': [{'text': 'No memories stored.'}]}

    def test_error(self) -> None:
        store = MagicMock()
        store.client.get_paginator.side_effect = RuntimeError('fail')

        result = _invoke('list', store=store)

        assert result == {'status': 'error', 'content': [{'text': 'Failed to list memories.'}]}

    def test_malformed_page_is_error(self) -> None:
        store = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [{'unexpected': []}]
        store.client.get_paginator.return_value = paginator

        result = _invoke('list', store=store)

        assert result == {'status': 'error', 'content': [{'text': 'Failed to list memories.'}]}


# -- get ---------------------------------------------------------------------

class TestGet:
    def test_success(self) -> None:
        store = MagicMock()
        store.client.get_memory_record.return_value = {
            'memoryRecord': {
                'memoryRecordId': 'rec-42',
                'content': {'text': 'The user is based in New York.'},
                'namespace': '/strategies/Semantic-1/actors/botcube_harness_deepagents/',
            },
        }

        result = _invoke('get', store=store, memory_record_id='rec-42')

        assert result == {'status': 'success', 'content': [{'text': 'The user is based in New York.'}]}

    def test_denies_cross_actor_record(self) -> None:
        store = MagicMock()
        store.client.get_memory_record.return_value = {
            'memoryRecord': {
                'memoryRecordId': 'rec-42',
                'content': {'text': 'Other user prefers light mode.'},
                'namespace': '/strategies/Semantic-1/actors/other_user/',
            },
        }

        result = _invoke('get', store=store, memory_record_id='rec-42')

        assert result == {'status': 'error', 'content': [{'text': 'Failed to get memory record rec-42.'}]}

    def test_success_unwraps_strategy_record_shape(self) -> None:
        store = MagicMock()
        store.client.get_memory_record.return_value = {
            'memoryRecord': {
                'memoryRecordId': 'rec-summary',
                'content': {'text': SUMMARY_XML},
                'namespace': '/strategies/Summary-1/actors/botcube_harness_deepagents/',
            },
        }

        result = _invoke('get', store=store, memory_record_id='rec-summary')

        assert result == {'status': 'success', 'content': [{'text': SUMMARY_TEXT}]}

    def test_error_missing_id(self) -> None:
        store = MagicMock()

        result = _invoke('get', store=store)

        assert result == {'status': 'error', 'content': [{'text': 'memory_record_id is required for get action.'}]}


# -- a record without text ----------------------------------------------------

def _textless_summary() -> dict[str, object]:
    return {'memoryRecordId': 'rec-9', 'content': {}, 'namespace': '/strategies/Semantic-1/actors/botcube_harness_deepagents/'}


class TestRecordWithoutText:
    """A record the tool reports but that carries no text fails loud, naming the record (ADR 0030)."""

    def test_retrieve(self) -> None:
        store = MagicMock()
        store.client.list_memory_records.return_value = {'memoryRecordSummaries': [_textless_summary()]}
        store.client.retrieve_memory_records.return_value = {'memoryRecordSummaries': [_textless_summary()]}
        with pytest.raises(ValueError, match='^Memory record rec-9 has no text content$'):
            _invoke('retrieve', store=store, query='anything')

    def test_list(self) -> None:
        store = MagicMock()
        store.client.get_paginator.return_value.paginate.return_value = [{'memoryRecordSummaries': [_textless_summary()]}]
        with pytest.raises(ValueError, match='^Memory record rec-9 has no text content$'):
            _invoke('list', store=store)

    def test_get(self) -> None:
        store = MagicMock()
        store.client.get_memory_record.return_value = {'memoryRecord': _textless_summary()}
        with pytest.raises(ValueError, match='^Memory record rec-9 has no text content$'):
            _invoke('get', store=store, memory_record_id='rec-9')


# -- delete ------------------------------------------------------------------

class TestDelete:
    def test_success(self) -> None:
        store = MagicMock()
        store.client.get_memory_record.return_value = {
            'memoryRecord': {
                'memoryRecordId': 'rec-42',
                'content': {'text': 'The user is based in New York.'},
                'namespace': '/strategies/Semantic-1/actors/botcube_harness_deepagents/',
            },
        }
        store.client.delete_memory_record.return_value = {}

        result = _invoke('delete', store=store, memory_record_id='rec-42')

        assert result == {'status': 'success', 'content': [{'text': 'Deleted memory record rec-42.'}]}

    def test_denies_cross_actor_record(self) -> None:
        store = MagicMock()
        store.client.get_memory_record.return_value = {
            'memoryRecord': {
                'memoryRecordId': 'rec-42',
                'content': {'text': 'Other user prefers light mode.'},
                'namespace': '/strategies/Semantic-1/actors/other_user/',
            },
        }

        result = _invoke('delete', store=store, memory_record_id='rec-42')

        assert result == {'status': 'error', 'content': [{'text': 'Failed to delete memory record rec-42.'}]}
        store.client.delete_memory_record.assert_not_called()

    def test_error_missing_id(self) -> None:
        store = MagicMock()

        result = _invoke('delete', store=store)

        assert result == {'status': 'error', 'content': [{'text': 'memory_record_id is required for delete action.'}]}


# -- unknown action ----------------------------------------------------------

class TestUnknownAction:
    def test_returns_error(self) -> None:
        store = MagicMock()

        result = _invoke('bogus', store=store)

        assert result == {
            'status': 'error',
            'content': [{'text': 'Unknown action: bogus. Valid: record, retrieve, list, get, delete'}],
        }


# -- actions set matches Strands ---------------------------------------------

class TestActionsParity:
    def test_valid_actions_match_strands(self) -> None:
        """Our VALID_ACTIONS must match the Strands MemoryAction enum values."""
        assert set(VALID_ACTIONS) == {'record', 'retrieve', 'list', 'get', 'delete'}


# -- the AgentCore Memory API behind each action --------------------------------
#
# These run the tool on a real AgentCoreMemoryStore whose client transport is a botocore
# Stubber: each request is validated against the bedrock-agentcore service model and must
# equal the expected request, and each canned response must match the service's shape.

MEMORY_ID = 'memory_1-0123456789'
RECORD_ID = 'mem-' + 'a' * 36
OTHER_RECORD_ID = 'mem-' + 'b' * 36
CREATED_AT = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)


def _api_record(
    text: str,
    record_id: str = RECORD_ID,
    *,
    actor_id: str = 'botcube_harness_deepagents',
    strategies: tuple[str, ...] = ('Semantic-1',),
) -> MemoryRecordSummaryTypeDef:
    return {
        'memoryRecordId': record_id,
        'content': {'text': text},
        'memoryStrategyId': strategies[0],
        'namespaces': [f'/strategies/{strategy}/actors/{actor_id}/' for strategy in strategies],
        'createdAt': CREATED_AT,
    }


@pytest.fixture
def agentcore(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[AgentCoreMemoryStore, Stubber]]:
    monkeypatch.setattr(memory_tools, 'AGENTCORE_MEMORY_ID', MEMORY_ID)
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    store = AgentCoreMemoryStore(memory_id=MEMORY_ID, region_name='us-east-1')
    with Stubber(store.client) as stubber:
        yield store, stubber
        stubber.assert_no_pending_responses()


class TestAgentCoreMemoryRequests:
    def test_list_pages_through_every_strategy_record(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        request = {'memoryId': MEMORY_ID, 'namespacePath': '/strategies/', 'maxResults': 100}
        stubber.add_response(
            'list_memory_records',
            {'memoryRecordSummaries': [_api_record('Lives in New York.')], 'nextToken': 'page-2'},
            request,
        )
        stubber.add_response(
            'list_memory_records',
            {'memoryRecordSummaries': [_api_record('Prefers copper.', OTHER_RECORD_ID)]},
            {**request, 'nextToken': 'page-2'},
        )

        result = _invoke('list', store=store)

        assert result == {
            'status': 'success',
            'content': [
                {'text': f'[{RECORD_ID}] Lives in New York.'},
                {'text': f'[{OTHER_RECORD_ID}] Prefers copper.'},
            ],
        }

    def test_retrieve_searches_each_actor_namespace_and_returns_each_record_once(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        listing = {'memoryId': MEMORY_ID, 'namespacePath': '/strategies/', 'maxResults': 100}
        shared = _api_record('Prefers copper.', strategies=('Semantic-1', 'UserPreference-1'))
        someone_else = _api_record('Someone else.', OTHER_RECORD_ID, actor_id='other_user')
        new_york = _api_record('Lives in New York.', 'mem-' + 'c' * 36)
        stubber.add_response(
            'list_memory_records',
            {'memoryRecordSummaries': [someone_else, new_york], 'nextToken': 'page-2'},
            listing,
        )
        stubber.add_response(
            'list_memory_records',
            {'memoryRecordSummaries': [shared]},
            {**listing, 'nextToken': 'page-2'},
        )
        search = {'memoryId': MEMORY_ID, 'searchCriteria': {'searchQuery': 'copper'}, 'maxResults': 10}
        stubber.add_response(
            'retrieve_memory_records',
            {'memoryRecordSummaries': [someone_else, shared, new_york]},
            {**search, 'namespacePath': '/strategies/Semantic-1/actors/botcube_harness_deepagents/'},
        )
        stubber.add_response(
            'retrieve_memory_records',
            {'memoryRecordSummaries': [shared, _api_record('Trades metals.', 'mem-' + 'd' * 36)]},
            {**search, 'namespacePath': '/strategies/UserPreference-1/actors/botcube_harness_deepagents/'},
        )

        result = _invoke('retrieve', store=store, query='copper')

        assert result == {
            'status': 'success',
            'content': [{'text': 'Prefers copper.'}, {'text': 'Lives in New York.'}, {'text': 'Trades metals.'}],
        }

    def test_get_reads_the_record_by_id(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        stubber.add_response(
            'get_memory_record',
            {'memoryRecord': _api_record('Lives in New York.')},
            {'memoryId': MEMORY_ID, 'memoryRecordId': RECORD_ID},
        )

        result = _invoke('get', store=store, memory_record_id=RECORD_ID)

        assert result == {'status': 'success', 'content': [{'text': 'Lives in New York.'}]}

    def test_delete_checks_ownership_then_deletes_the_record(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        request = {'memoryId': MEMORY_ID, 'memoryRecordId': RECORD_ID}
        stubber.add_response('get_memory_record', {'memoryRecord': _api_record('Lives in New York.')}, request)
        stubber.add_response('delete_memory_record', {'memoryRecordId': RECORD_ID}, request)

        result = _invoke('delete', store=store, memory_record_id=RECORD_ID)

        assert result == {'status': 'success', 'content': [{'text': f'Deleted memory record {RECORD_ID}.'}]}

    @pytest.mark.parametrize(
        ('action', 'operation', 'kwargs', 'message', 'text'),
        [
            ('record', 'create_event', {'content': 'Prefers copper.'}, 'agent_core_memory record failed',
             'Failed to save memory.'),
            ('retrieve', 'list_memory_records', {'query': 'copper'}, 'agent_core_memory retrieve failed',
             'Memory search unavailable.'),
            ('list', 'list_memory_records', {}, 'agent_core_memory list failed', 'Failed to list memories.'),
            ('get', 'get_memory_record', {'memory_record_id': RECORD_ID}, 'agent_core_memory get failed',
             f'Failed to get memory record {RECORD_ID}.'),
            ('delete', 'get_memory_record', {'memory_record_id': RECORD_ID}, 'agent_core_memory delete failed',
             f'Failed to delete memory record {RECORD_ID}.'),
        ],
    )
    def test_a_failed_call_returns_an_error_and_logs_the_cause(
        self, agentcore: tuple[AgentCoreMemoryStore, Stubber], caplog: pytest.LogCaptureFixture, action: str, operation: str, kwargs: dict[str, str], message: str, text: str
    ) -> None:
        store, stubber = agentcore
        stubber.add_client_error(operation, 'ThrottledException', 'Rate exceeded')

        with caplog.at_level('WARNING', logger='botcube_harness_deepagents.memory_tools'):
            result = _invoke(action, store=store, **kwargs)

        assert result == {'status': 'error', 'content': [{'text': text}]}
        [record] = [r for r in caplog.records if r.name == 'botcube_harness_deepagents.memory_tools']
        assert (record.levelname, record.getMessage()) == ('WARNING', message)
        assert record.exc_info is not None
        assert 'Rate exceeded' in str(record.exc_info[1])


class TestExtractTextFallbacks:
    def test_an_empty_text_key_falls_through_to_the_next(self) -> None:
        assert _extract_text(json.dumps({'preference': '', 'fact': 'Trades copper.'})) == 'Trades copper.'

    def test_episodic_xml_without_a_situation_keeps_the_later_tags(self) -> None:
        raw = '<summary><intent>Recall the runbook.</intent><reflection>Ask less.</reflection></summary>'
        assert _extract_text(raw) == 'Intent: Recall the runbook.\nReflection: Ask less.'
