"""Tests for memory_tools — the `memory` tool's parity with Strands AgentCoreMemoryToolProvider.

Contract: contract/parity/agent-core-memory-tool.md
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, cast
from unittest.mock import MagicMock, patch

import pytest
from botocore.stub import Stubber
from langchain_core.tools import StructuredTool
from langgraph_checkpoint_aws import AgentCoreMemoryStore

from agentcore_fake import MEMORY_ID as FAKE_MEMORY_ID
from agentcore_fake import FakeAgentCoreMemory
from botcube_harness_deepagents import memory_document
from botcube_harness_deepagents.memory_tools import (
    RECORD_REPLY,
    VALID_ACTIONS,
    MemoryToolResult,
    extract_text,
    memory_tool,
)

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore.type_defs import MemoryRecordSummaryTypeDef

# -- helpers ------------------------------------------------------------------

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
            actor_id: str = 'botcube_harness_deepagents', memory_record_id: str = '') -> MemoryToolResult:
    """Call the actor's memory tool function directly."""
    kwargs: dict[str, Any] = {
        'action': action,
        'query': query,
        'content': content,
    }
    if store is not None:
        kwargs['store'] = store
    if memory_record_id:
        kwargs['memory_record_id'] = memory_record_id
    tool = memory_tool(actor_id)
    assert isinstance(tool, StructuredTool) and tool.func is not None
    return tool.func(**kwargs)


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
    description = memory_tool('actor').description or ''

    assert 'PII-like content' in description
    assert 'should not promise durable storage' in description


# -- extract_text -----------------------------------------------------------

class TestExtractText:
    def test_plain_semantic_text(self) -> None:
        assert extract_text('The user is based in New York.') == 'The user is based in New York.'

    def test_user_preference_json(self) -> None:
        raw = json.dumps({
            'context': 'The user asked for copper.',
            'preference': 'Prefers copper analysis',
            'categories': ['commodities'],
        })
        assert extract_text(raw) == 'Prefers copper analysis'

    @pytest.mark.parametrize('key', ['fact', 'summary', 'episode', 'reflection'])
    def test_json_text_record_shapes(self, key: str) -> None:
        raw = json.dumps({
            key: 'The deploy runbook is at wiki/runbook-v2.',
            'source': 'agentcore',
        })
        assert extract_text(raw) == 'The deploy runbook is at wiki/runbook-v2.'

    def test_nested_json_fact_shape(self) -> None:
        raw = json.dumps({
            'memory': {
                'fact': 'The deploy runbook is at wiki/runbook-v2.',
            },
        })
        assert extract_text(raw) == 'The deploy runbook is at wiki/runbook-v2.'

    def test_episodic_xml_shape(self) -> None:
        assert extract_text(EPISODIC_XML) == EPISODIC_TEXT

    def test_reflection_xml_shape(self) -> None:
        assert extract_text(REFLECTION_XML) == REFLECTION_TEXT

    def test_summary_xml_shape(self) -> None:
        assert extract_text(SUMMARY_XML) == SUMMARY_TEXT

    def test_json_without_preference_key(self) -> None:
        raw = json.dumps({'foo': 'bar'})
        assert extract_text(raw) == raw

    def test_empty_string(self) -> None:
        assert extract_text('') == ''


# -- record ------------------------------------------------------------------

class TestRecord:
    def test_success(self) -> None:
        store = MagicMock()
        with patch('botcube_harness_deepagents.pending_memory.utc_now', return_value=datetime(2026, 7, 2, tzinfo=UTC)):
            result = _invoke('record', store=store, content='User prefers dark mode')

        assert result == {'status': 'success', 'content': [{'text': RECORD_REPLY}]}
        store.client.create_event.assert_called_once()
        call_args = store.client.create_event.call_args
        assert call_args.kwargs == {
            'memoryId': store.memory_id,
            'actorId': 'botcube_harness_deepagents',
            'sessionId': 'pending-memory-20260702',
            'eventTimestamp': datetime(2026, 7, 2, tzinfo=UTC),
            'payload': [{'conversational': {'content': {'text': 'User prefers dark mode'}, 'role': 'USER'}}],
        }

    def test_record_writes_to_date_keyed_pending_memory_session(self) -> None:
        store = MagicMock()

        with patch('botcube_harness_deepagents.pending_memory.utc_now', return_value=datetime(2026, 7, 2, tzinfo=UTC)):
            _invoke(
                'record',
                store=store,
                content='Runbook URL is wiki/runbook-v2',
            )

        assert store.client.create_event.call_args.kwargs['sessionId'] == 'pending-memory-20260702'
        assert store.client.create_event.call_args.kwargs['payload'] == [
            {'conversational': {'content': {'text': 'Runbook URL is wiki/runbook-v2'}, 'role': 'USER'}},
        ]

    def test_error(self) -> None:
        store = MagicMock()
        store.client.create_event.side_effect = RuntimeError('network')
        result = _invoke('record', store=store, content='anything')

        assert result == {'status': 'error', 'content': [{'text': 'Failed to save memory.'}]}

    def test_custom_actor_id(self) -> None:
        store = MagicMock()
        with patch('botcube_harness_deepagents.pending_memory.utc_now', return_value=datetime(2026, 7, 2, tzinfo=UTC)):
            _invoke('record', store=store, content='test', actor_id='custom-actor')
        assert store.client.create_event.call_args.kwargs['actorId'] == 'custom-actor'
        assert store.client.create_event.call_args.kwargs['sessionId'] == 'pending-memory-20260702'


# -- retrieve, list, get and delete against AgentCore ----------------------------
#
# A user's records live under `/actors/<actor>/` (ADR 0033); the tool reads only that prefix
# and does no client-side actor filtering (ADR 0032 §3).

ACTOR = 'member_ab'
# An actor whose ID starts with ACTOR's: the trailing slash keeps their records apart.
LONGER_ACTOR = 'member_abc'
SUMMARY_ID = 'mem-' + 's' * 36
SAVED_ID = 'mem-' + '4' * 36
TEXTLESS_ID = 'mem-' + '9' * 36


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    return FakeAgentCoreMemory()


def _store(memory: FakeAgentCoreMemory) -> AgentCoreMemoryStore:
    store = AgentCoreMemoryStore(memory_id=FAKE_MEMORY_ID, region_name='us-east-1')
    # The fake stands in for the boto3 client the store builds.
    store.client = cast(Any, memory)
    return store


def _saved(memory: FakeAgentCoreMemory, text: str, record_id: str, *, actor_id: str = ACTOR, kind: str = 'facts') -> None:
    memory.records.append({
        'memoryRecordId': record_id,
        'content': {'text': text},
        'memoryStrategyId': 'SemanticFacts-1',
        'namespaces': [f'/actors/{actor_id}/{kind}/'],
        'createdAt': datetime(2026, 7, 2, 12, 0, tzinfo=UTC),
    })


class TestRetrieve:
    def test_finds_only_the_actors_own_records(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, 'Prefers copper analysis.', 'rec-own', kind='preferences')
        _saved(memory, 'Trades copper futures.', 'rec-fact')
        _saved(memory, 'Prefers copper too.', 'rec-longer', actor_id=LONGER_ACTOR)
        _saved(memory, 'Copper desk lead.', 'rec-other', actor_id='member_zz')

        result = _invoke('retrieve', store=_store(memory), query='copper', actor_id=ACTOR)

        assert result == {
            'status': 'success',
            'content': [{'text': 'Prefers copper analysis.'}, {'text': 'Trades copper futures.'}],
        }

    def test_unwraps_strategy_record_shapes(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, json.dumps({'fact': 'The deploy runbook is at wiki/runbook-v2.'}), 'rec-fact')
        _saved(memory, json.dumps({'context': 'runbook', 'preference': 'Prefers the runbook', 'categories': []}), 'rec-pref',
               kind='preferences')
        _saved(memory, EPISODIC_XML, 'rec-episode', kind='episodes/s-1')
        _saved(memory, REFLECTION_XML, 'rec-reflection', kind='episodes')
        _saved(memory, SUMMARY_XML.replace('memory strategy', 'runbook'), 'rec-summary', kind='summaries/s-1')

        result = _invoke('retrieve', store=_store(memory), query='runbook', actor_id=ACTOR)

        assert result == {
            'status': 'success',
            'content': [
                {'text': 'The deploy runbook is at wiki/runbook-v2.'},
                {'text': 'Prefers the runbook'},
                {'text': EPISODIC_TEXT},
                {'text': REFLECTION_TEXT},
                {'text': SUMMARY_TEXT.replace('memory strategy', 'runbook')},
            ],
        }

    def test_no_results(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, 'Unknown to this actor.', 'rec-other', actor_id=LONGER_ACTOR)

        result = _invoke('retrieve', store=_store(memory), query='unknown', actor_id=ACTOR)

        assert result == {'status': 'success', 'content': [{'text': 'No relevant memories found.'}]}


class TestList:
    def test_lists_only_the_actors_own_records(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, 'Lives in New York.', 'rec-1')
        _saved(memory, json.dumps({'context': '...', 'preference': 'Prefers copper analysis', 'categories': []}), 'rec-2',
               kind='preferences')
        _saved(memory, 'Lives in Paris.', 'rec-longer', actor_id=LONGER_ACTOR)
        _saved(memory, 'Lives in Tokyo.', 'rec-other', actor_id='member_zz')

        result = _invoke('list', store=_store(memory), actor_id=ACTOR)

        assert result == {
            'status': 'success',
            'content': [
                {'text': '[rec-1] Lives in New York.'},
                {'text': '[rec-2] Prefers copper analysis'},
            ],
        }

    def test_the_longer_actor_does_not_see_the_shorter_ones_records(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, 'Lives in New York.', 'rec-1')

        result = _invoke('list', store=_store(memory), actor_id=LONGER_ACTOR)

        assert result == {'status': 'success', 'content': [{'text': 'No memories stored.'}]}

    def test_unwraps_strategy_record_shapes(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, json.dumps({'fact': 'The deploy runbook is at wiki/runbook-v2.'}), 'rec-fact')
        _saved(memory, EPISODIC_XML, 'rec-episode', kind='episodes/s-1')
        _saved(memory, SUMMARY_XML, 'rec-summary', kind='summaries/s-1')

        result = _invoke('list', store=_store(memory), actor_id=ACTOR)

        assert result == {
            'status': 'success',
            'content': [
                {'text': '[rec-fact] The deploy runbook is at wiki/runbook-v2.'},
                {'text': f'[rec-episode] {EPISODIC_TEXT}'},
                {'text': f'[rec-summary] {SUMMARY_TEXT}'},
            ],
        }


class TestGet:
    def test_reads_the_record_by_id(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, SUMMARY_XML, SUMMARY_ID, kind='summaries/s-1')

        result = _invoke('get', store=_store(memory), memory_record_id=SUMMARY_ID, actor_id=ACTOR)

        assert result == {'status': 'success', 'content': [{'text': SUMMARY_TEXT}]}

    def test_error_missing_id(self, memory: FakeAgentCoreMemory) -> None:
        result = _invoke('get', store=_store(memory))

        assert result == {'status': 'error', 'content': [{'text': 'memory_record_id is required for get action.'}]}


class TestDelete:
    def test_deletes_the_record_by_id(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, 'Lives in New York.', SAVED_ID)

        result = _invoke('delete', store=_store(memory), memory_record_id=SAVED_ID, actor_id=ACTOR)

        assert result == {'status': 'success', 'content': [{'text': f'Deleted memory record {SAVED_ID}.'}]}
        assert memory.records == []

    def test_error_missing_id(self, memory: FakeAgentCoreMemory) -> None:
        result = _invoke('delete', store=_store(memory))

        assert result == {'status': 'error', 'content': [{'text': 'memory_record_id is required for delete action.'}]}


class TestRecordWithoutText:
    """A record the tool reports but that carries no text fails loud, naming the record (ADR 0030)."""

    @pytest.fixture(autouse=True)
    def textless(self, memory: FakeAgentCoreMemory) -> None:
        _saved(memory, '', TEXTLESS_ID)
        memory.records[0]['content'] = {}

    def test_list(self, memory: FakeAgentCoreMemory) -> None:
        with pytest.raises(ValueError, match=f'^Memory record {TEXTLESS_ID} has no text content$'):
            _invoke('list', store=_store(memory), actor_id=ACTOR)

    def test_get(self, memory: FakeAgentCoreMemory) -> None:
        with pytest.raises(ValueError, match=f'^Memory record {TEXTLESS_ID} has no text content$'):
            _invoke('get', store=_store(memory), memory_record_id=TEXTLESS_ID, actor_id=ACTOR)

    def test_retrieve(self) -> None:
        store = MagicMock()
        store.client.retrieve_memory_records.return_value = {'memoryRecordSummaries': [{'memoryRecordId': TEXTLESS_ID, 'content': {}}]}
        with pytest.raises(ValueError, match=f'^Memory record {TEXTLESS_ID} has no text content$'):
            _invoke('retrieve', store=store, query='anything')


# -- unknown action ----------------------------------------------------------

class TestToolName:
    def test_the_tool_is_named_memory(self) -> None:
        assert memory_tool('actor').name == 'memory'


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
    kinds: tuple[str, ...] = ('facts',),
) -> MemoryRecordSummaryTypeDef:
    return {
        'memoryRecordId': record_id,
        'content': {'text': text},
        'memoryStrategyId': 'SemanticFacts-1',
        'namespaces': [f'/actors/{actor_id}/{kind}/' for kind in kinds],
        'createdAt': CREATED_AT,
    }


@pytest.fixture
def agentcore(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[AgentCoreMemoryStore, Stubber]]:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    store = AgentCoreMemoryStore(memory_id=MEMORY_ID, region_name='us-east-1')
    with Stubber(store.client) as stubber:
        yield store, stubber
        stubber.assert_no_pending_responses()


class TestAgentCoreMemoryRequests:
    def test_list_pages_through_the_actors_records(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        request = {'memoryId': MEMORY_ID, 'namespace': '/actors/botcube_harness_deepagents/', 'maxResults': 100}
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

    def test_retrieve_searches_under_the_actor_prefix(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        stubber.add_response(
            'retrieve_memory_records',
            {'memoryRecordSummaries': [_api_record('Prefers copper.'), _api_record('Trades metals.', OTHER_RECORD_ID)]},
            {'memoryId': MEMORY_ID, 'namespace': '/actors/botcube_harness_deepagents/',
             'searchCriteria': {'searchQuery': 'copper'}, 'maxResults': 10},
        )

        result = _invoke('retrieve', store=store, query='copper')

        assert result == {'status': 'success', 'content': [{'text': 'Prefers copper.'}, {'text': 'Trades metals.'}]}

    def test_get_reads_the_record_by_id(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        stubber.add_response(
            'get_memory_record',
            {'memoryRecord': _api_record('Lives in New York.')},
            {'memoryId': MEMORY_ID, 'memoryRecordId': RECORD_ID},
        )

        result = _invoke('get', store=store, memory_record_id=RECORD_ID)

        assert result == {'status': 'success', 'content': [{'text': 'Lives in New York.'}]}

    def test_delete_deletes_the_record_by_id(self, agentcore: tuple[AgentCoreMemoryStore, Stubber]) -> None:
        store, stubber = agentcore
        request = {'memoryId': MEMORY_ID, 'memoryRecordId': RECORD_ID}
        stubber.add_response('delete_memory_record', {'memoryRecordId': RECORD_ID}, request)

        result = _invoke('delete', store=store, memory_record_id=RECORD_ID)

        assert result == {'status': 'success', 'content': [{'text': f'Deleted memory record {RECORD_ID}.'}]}

    @pytest.mark.parametrize(
        ('action', 'operation', 'kwargs', 'message', 'text'),
        [
            ('record', 'create_event', {'content': 'Prefers copper.'}, 'memory record failed',
             'Failed to save memory.'),
            ('retrieve', 'retrieve_memory_records', {'query': 'copper'}, 'memory retrieve failed',
             'Memory search unavailable.'),
            ('list', 'list_memory_records', {}, 'memory list failed', 'Failed to list memories.'),
            ('get', 'get_memory_record', {'memory_record_id': RECORD_ID}, 'memory get failed',
             f'Failed to get memory record {RECORD_ID}.'),
            ('delete', 'delete_memory_record', {'memory_record_id': RECORD_ID}, 'memory delete failed',
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
        assert extract_text(json.dumps({'preference': '', 'fact': 'Trades copper.'})) == 'Trades copper.'

    def test_episodic_xml_without_a_situation_keeps_the_later_tags(self) -> None:
        raw = '<summary><intent>Recall the runbook.</intent><reflection>Ask less.</reflection></summary>'
        assert extract_text(raw) == 'Intent: Recall the runbook.\nReflection: Ask less.'


def test_record_uses_one_clock_across_midnight_and_stays_visible_for_its_full_window(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = datetime(2026, 7, 2, 23, 59, 59, 999999, tzinfo=UTC)
    sdk_time = captured + timedelta(microseconds=1)
    with patch('botcube_harness_deepagents.pending_memory.utc_now', return_value=captured), \
         patch('langgraph_checkpoint_aws.store.agentcore.store.datetime') as sdk_clock:
        sdk_clock.now.return_value = sdk_time
        result = _invoke('record', store=_store(memory), content='Keep midnight save', actor_id=ACTOR)
    assert result['status'] == 'success'
    [event] = memory.events[(ACTOR, 'pending-memory-20260702')]
    assert event['eventTimestamp'] == captured
    monkeypatch.setattr(memory_document, 'utc_now', lambda: event['eventTimestamp'] + timedelta(minutes=15))
    assert memory_document.opening_memory(cast(Any, memory), memory_id=FAKE_MEMORY_ID, actor_id=ACTOR) == (
        'semantic facts:\n- Keep midnight save'
    )
