"""The Memory a Session opens with (ADR 0031): the actor's records and their Pending Memory.

It lists the actor's Memory records and reads back Pending Memory (explicit saves
from today's and yesterday's sessions) while AgentCore's strategy extraction catches up.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, NoReturn, cast

import pytest

from agentcore_fake import EXCEPTIONS, MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents import memory_document
from botcube_harness_deepagents.session_memory import SPILLOVER_NOTE as SPILLOVER

NOW = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
ACTOR = 'jane.doe_ny'


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch) -> FakeAgentCoreMemory:
    monkeypatch.setattr(memory_document, 'utc_now', lambda: NOW)
    return FakeAgentCoreMemory()


def _open(memory: FakeAgentCoreMemory, actor_id: str = ACTOR) -> str:
    return memory_document.opening_memory(cast(Any, memory), memory_id=MEMORY_ID, actor_id=actor_id)


def _record(
    text: str,
    kind: str,
    *,
    actor_id: str = ACTOR,
    created_at: datetime = NOW - timedelta(days=1),
) -> dict[str, Any]:
    return {
        'memoryRecordId': f'record-{text}',
        'content': {'text': text},
        'namespaces': [f'/actors/{actor_id}/{kind}/'],
        'createdAt': created_at,
    }


def _preference(text: str, **kwargs: Any) -> dict[str, Any]:
    return _record(json.dumps({'preference': text}), 'preferences', **kwargs)


def _fact(text: str, **kwargs: Any) -> dict[str, Any]:
    return _record(text, 'facts', **kwargs)


def _save(memory: FakeAgentCoreMemory, session_id: str, text: str, *, at: datetime, actor_id: str = ACTOR) -> None:
    """A Pending Memory save, as the memory tool writes it."""
    memory.create_event(
        memoryId=MEMORY_ID,
        actorId=actor_id,
        sessionId=session_id,
        eventTimestamp=at,
        payload=[{'conversational': {'content': {'text': text}, 'role': 'USER'}}],
    )


def test_an_actor_with_no_memory_starts_with_no_memory_block(memory: FakeAgentCoreMemory) -> None:
    assert _open(memory) == ''


def test_the_block_lists_the_actors_preferences_then_facts(memory: FakeAgentCoreMemory) -> None:
    memory.records += [
        _preference('User prefers dark mode'),
        _fact('Copper is an industrial metal'),
        _preference('User likes copper futures'),
        _record('Session summary stays tool-only', 'summaries/session-1'),
        _record('Episode stays tool-only', 'episodes/session-1'),
        _record('Reflection stays tool-only', 'episodes'),
        _preference('Another user prefers light mode', actor_id=f'{ACTOR}2'),
        _fact('Another user trades gold', actor_id=f'{ACTOR}2'),
    ]

    assert _open(memory) == (
        'user preferences:\n'
        '- User prefers dark mode\n'
        '- User likes copper futures\n'
        '\n'
        'semantic facts:\n'
        '- Copper is an industrial metal'
    )


def test_facts_are_newest_first_and_same_instant_facts_keep_their_listing_order(memory: FakeAgentCoreMemory) -> None:
    memory.records += [
        _fact('Oldest', created_at=NOW - timedelta(days=3)),
        _fact('Newest', created_at=NOW - timedelta(hours=1)),
        _fact('Tied first', created_at=NOW - timedelta(days=2)),
        # The same instant written in another zone.
        _fact('Tied second', created_at=(NOW - timedelta(days=2)).astimezone(timezone(timedelta(hours=9)))),
    ]

    assert _open(memory) == 'semantic facts:\n- Newest\n- Tied first\n- Tied second\n- Oldest'


def test_the_block_caps_each_section_at_fifty_and_points_at_the_rest(memory: FakeAgentCoreMemory) -> None:
    memory.records += [_preference(f'Preference {i:02d}') for i in range(51)]
    memory.records += [_fact(f'Fact {i:02d}', created_at=NOW - timedelta(minutes=60 - i)) for i in range(52)]

    assert _open(memory) == '\n'.join([
        'user preferences:',
        *[f'- Preference {i:02d}' for i in range(50)],
        '',
        'semantic facts:',
        *[f'- Fact {i:02d}' for i in range(51, 1, -1)],
        '',
        SPILLOVER,
    ])


@pytest.mark.parametrize(('preferences', 'facts'), [(51, 1), (1, 51)])
def test_either_section_over_its_cap_points_at_the_rest(memory: FakeAgentCoreMemory, preferences: int, facts: int) -> None:
    memory.records += [_preference(f'Preference {i:02d}') for i in range(preferences)]
    memory.records += [_fact(f'Fact {i:02d}') for i in range(facts)]

    block = _open(memory)

    assert block.endswith(f'\n\n{SPILLOVER}')


def test_sections_exactly_at_their_caps_do_not_point_at_more(memory: FakeAgentCoreMemory) -> None:
    memory.records += [_preference(f'Preference {i:02d}') for i in range(50)]
    memory.records += [_fact(f'Fact {i:02d}') for i in range(50)]

    block = _open(memory)

    assert block.count('\n- ') == 100
    assert SPILLOVER not in block


def test_todays_and_yesterdays_pending_memory_lead_the_facts(memory: FakeAgentCoreMemory) -> None:
    memory.records += [_preference('User prefers dark mode'), _fact('Copper is an industrial metal')]
    _save(memory, 'pending-memory-20260702', 'Runbook URL is wiki/runbook-v2', at=NOW - timedelta(minutes=2))
    # Saved at 11:55 by a writer whose clock still read yesterday's date.
    _save(memory, 'pending-memory-20260701', 'Tokyo meeting is next week', at=NOW - timedelta(minutes=5))

    assert _open(memory) == (
        'user preferences:\n'
        '- User prefers dark mode\n'
        '\n'
        'semantic facts:\n'
        '- Runbook URL is wiki/runbook-v2\n'
        '- Tokyo meeting is next week\n'
        '- Copper is an industrial metal'
    )


def test_pending_memory_ages_out_after_fifteen_minutes(memory: FakeAgentCoreMemory) -> None:
    _save(memory, 'pending-memory-20260702', 'Old save', at=NOW - timedelta(minutes=16))
    _save(memory, 'pending-memory-20260702', 'Save from a clock running ahead', at=NOW + timedelta(minutes=2))

    assert _open(memory) == 'semantic facts:\n- Save from a clock running ahead'


@pytest.mark.parametrize('delete', [False, True])
def test_fresh_session_respects_correction_after_pending_save_extraction(
    memory: FakeAgentCoreMemory, delete: bool,
) -> None:
    _save(memory, 'pending-memory-20260702', 'QA telescope colour is copper', at=NOW - timedelta(minutes=2))
    _save(memory, 'pending-memory-20260702', 'QA observatory is Cedar', at=NOW - timedelta(minutes=1))
    first = _fact('QA telescope colour is copper')
    second = _fact('QA telescope colour is copper')
    first['memoryRecordId'] = '1' * 40
    second['memoryRecordId'] = '2' * 40
    memory.records += [first, second]
    record_ids = [record['memoryRecordId'] for record in memory.records]
    for record_id in record_ids:
        if delete:
            memory_document.delete_memory_line(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR, record_id=record_id)
        else:
            memory_document.edit_memory_line(
                cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR,
                record_id=record_id, text='QA telescope colour is amber',
            )

    expected = 'semantic facts:\n- QA observatory is Cedar\n- QA telescope colour is copper'
    if not delete:
        expected += '\n- QA telescope colour is amber\n- QA telescope colour is amber'
    block = _open(memory)
    facts, corrections = block.split('\n\nMemory page corrections (authoritative):\n')
    assert facts == expected
    assert 'override conflicting memories above, including paraphrases and parts of compound saves' in corrections
    assert 'null means forgotten and must not be used' in corrections
    replacement = None if delete else 'QA telescope colour is amber'
    assert corrections.splitlines()[1:] == [
        json.dumps({'previousText': 'QA telescope colour is copper', 'text': replacement}),
        json.dumps({'previousText': 'QA telescope colour is copper', 'text': replacement}),
    ]


def test_pending_memory_reads_every_page_of_a_session(memory: FakeAgentCoreMemory) -> None:
    _save(memory, 'pending-memory-20260702', 'First save', at=NOW - timedelta(minutes=10))
    for minute in range(100):
        memory.create_event(
            memoryId=MEMORY_ID,
            actorId=ACTOR,
            sessionId='pending-memory-20260702',
            eventTimestamp=NOW - timedelta(minutes=9, seconds=-minute),
            payload=[{'blob': 'not a conversational save'}],
        )

    assert _open(memory) == 'semantic facts:\n- First save'


def test_a_failing_pending_memory_lookup_fails_the_load(memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch) -> None:
    error = EXCEPTIONS.ThrottledException({'Error': {'Code': 'ThrottledException', 'Message': 'slow down'}}, 'ListEvents')

    def list_events(**_params: Any) -> NoReturn:
        raise error

    monkeypatch.setattr(memory, 'list_events', list_events)

    with pytest.raises(EXCEPTIONS.ThrottledException):
        _open(memory)



@pytest.mark.parametrize('minutes', [5, 7, 10, 15, 16])
def test_corrections_span_pending_window_but_page_overlay_stays_five_minutes(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, minutes: int,
) -> None:
    memory.records.append(_fact('Copper telescope'))
    memory.records[0]['memoryRecordId'] = '1' * 40
    memory.lag_listing()
    monkeypatch.setattr(memory_document, 'utc_now', lambda: NOW - timedelta(minutes=minutes))
    memory_document.edit_memory_line(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR,
                                     record_id='1' * 40, text='Amber telescope')
    monkeypatch.setattr(memory_document, 'utc_now', lambda: NOW)
    assert memory_document.memory_lines(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR) == [
        {'id': '1' * 40, 'text': 'Amber telescope' if minutes <= 5 else 'Copper telescope'},
    ]
    block = _open(memory)
    if minutes <= 15:
        assert block.startswith('semantic facts:\n- Amber telescope\n\nMemory page corrections (authoritative):')
        assert json.dumps({'previousText': 'Copper telescope', 'text': 'Amber telescope'}) in block
    else:
        assert block == 'semantic facts:\n- Copper telescope'


@pytest.mark.parametrize('delete', [False, True])
def test_repeated_corrections_keep_original_and_intermediate_text(
    memory: FakeAgentCoreMemory, delete: bool,
) -> None:
    memory.records.append(_fact('Copper telescope'))
    memory.records[0]['memoryRecordId'] = '1' * 40
    memory.lag_listing()
    _save(memory, 'pending-memory-20260702', 'My telescope is copper and my observatory is Cedar', at=NOW)
    for text in ['Amber telescope', 'Silver telescope']:
        memory_document.edit_memory_line(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR,
                                         record_id='1' * 40, text=text)
    if delete:
        memory_document.delete_memory_line(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR, record_id='1' * 40)
    block = _open(memory)
    assert 'My telescope is copper and my observatory is Cedar' in block
    final = None if delete else 'Silver telescope'
    for previous in ['Copper telescope', 'Amber telescope', *(['Silver telescope'] if delete else [])]:
        assert json.dumps({'previousText': previous, 'text': final}) in block
    assert 'Keep unrelated facts from those saves.' in block
    assert _open(memory, actor_id='other') == ''


def test_legacy_journal_overlays_without_inventing_previous_text(memory: FakeAgentCoreMemory) -> None:
    memory.records.append(_fact('Copper telescope'))
    memory.create_event(memoryId=MEMORY_ID, actorId=ACTOR, sessionId=memory_document._saves_session_id(NOW),
                        eventTimestamp=NOW, payload=[{'blob': json.dumps({
                            'recordId': 'record-Copper telescope', 'text': 'Amber telescope',
                        })}], extractionMode='SKIP')
    assert _open(memory) == 'semantic facts:\n- Amber telescope'


def test_journal_write_failure_is_not_reported_as_a_success(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory.records.append(_fact('Copper telescope'))
    memory.records[0]['memoryRecordId'] = '1' * 40
    def fail(**_params: Any) -> NoReturn:
        raise RuntimeError('journal unavailable')
    monkeypatch.setattr(memory, 'create_event', fail)
    with pytest.raises(RuntimeError, match='journal unavailable'):
        memory_document.edit_memory_line(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR,
                                         record_id='1' * 40, text='Amber telescope')


@pytest.mark.parametrize('seconds', [299, 300, 301, 419])
def test_startup_reads_every_bucket_intersecting_pending_window(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch, seconds: int,
) -> None:
    monkeypatch.setattr(memory_document, 'MEMORY_SAVE_WINDOW', timedelta(seconds=seconds))
    later = NOW + timedelta(seconds=37)
    memory.records.append(_fact('Copper telescope'))
    memory.records[0]['memoryRecordId'] = '1' * 40
    memory.lag_listing()
    monkeypatch.setattr(memory_document, 'utc_now', lambda: later - timedelta(minutes=15))
    memory_document.edit_memory_line(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR,
                                     record_id='1' * 40, text='Amber telescope')
    monkeypatch.setattr(memory_document, 'utc_now', lambda: later)
    block = _open(memory)
    assert block.startswith('semantic facts:\n- Amber telescope\n\nMemory page corrections (authoritative):')
    assert json.dumps({'previousText': 'Copper telescope', 'text': 'Amber telescope'}) in block


def test_correction_authority_is_not_lost_when_fact_section_is_capped(memory: FakeAgentCoreMemory) -> None:
    memory.records.append(_fact('Copper telescope'))
    memory.records[0]['memoryRecordId'] = '1' * 40
    memory_document.edit_memory_line(cast(Any, memory), memory_id=MEMORY_ID, actor_id=ACTOR,
                                     record_id='1' * 40, text='Amber telescope')
    for index in range(51):
        _save(memory, 'pending-memory-20260702', f'Unrelated fact {index}', at=NOW)
    block = _open(memory)
    assert SPILLOVER in block
    assert 'semantic facts:\n- Unrelated fact 50' in block
    assert '\n- Amber telescope' not in block
    assert json.dumps({'previousText': 'Copper telescope', 'text': 'Amber telescope'}) in block


class _SlowMemory:
    """The fake Memory with a round trip of LATENCY on every read."""

    LATENCY = 0.1

    def __init__(self, memory: FakeAgentCoreMemory) -> None:
        self._memory = memory
        self.reads = 0

    def _read(self) -> None:
        self.reads += 1
        time.sleep(self.LATENCY)

    def list_events(self, **params: Any) -> dict[str, Any]:
        self._read()
        return self._memory.list_events(**params)

    def get_paginator(self, operation: str) -> Any:
        paginate = self._memory.get_paginator(operation).paginate

        def slow(**params: Any) -> Any:
            self._read()
            return paginate(**params)

        return SimpleNamespace(paginate=slow)


def test_the_opening_reads_memory_concurrently(memory: FakeAgentCoreMemory) -> None:
    memory.records += [_preference('User prefers dark mode'), _fact('Copper is an industrial metal')]
    slow = _SlowMemory(memory)

    started = time.perf_counter()
    block = memory_document.opening_memory(cast(Any, slow), memory_id=MEMORY_ID, actor_id=ACTOR)
    elapsed = time.perf_counter() - started

    assert block == 'user preferences:\n- User prefers dark mode\n\nsemantic facts:\n- Copper is an industrial metal'
    assert slow.reads == 8
    # One round trip, not eight.
    assert elapsed < 2 * _SlowMemory.LATENCY, f'{slow.reads} reads took {elapsed:.3f}s'


def test_a_failing_record_listing_fails_the_load(memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch) -> None:
    error = EXCEPTIONS.ThrottledException(
        {'Error': {'Code': 'ThrottledException', 'Message': 'slow down'}}, 'ListMemoryRecords',
    )

    def paginate(**_params: Any) -> NoReturn:
        raise error

    monkeypatch.setattr(memory, 'get_paginator', lambda _operation: SimpleNamespace(paginate=paginate))

    with pytest.raises(EXCEPTIONS.ThrottledException):
        _open(memory)


def test_when_several_reads_fail_the_first_in_read_order_fails_the_load(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The event reads come first; the record listings fail sooner but must not win the race."""
    first = EXCEPTIONS.ThrottledException({'Error': {'Code': 'ThrottledException', 'Message': 'events'}}, 'ListEvents')
    later = EXCEPTIONS.ThrottledException(
        {'Error': {'Code': 'ThrottledException', 'Message': 'records'}}, 'ListMemoryRecords',
    )

    def slow_list_events(**_params: Any) -> NoReturn:
        time.sleep(0.1)
        raise first

    def paginate(**_params: Any) -> NoReturn:
        raise later

    monkeypatch.setattr(memory, 'list_events', slow_list_events)
    monkeypatch.setattr(memory, 'get_paginator', lambda _operation: SimpleNamespace(paginate=paginate))

    with pytest.raises(EXCEPTIONS.ThrottledException) as raised:
        _open(memory)
    assert raised.value is first
