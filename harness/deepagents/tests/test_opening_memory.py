"""The Memory a Session opens with (ADR 0031): the actor's records and their Pending Memory.

It lists the actor's Memory records and reads back Pending Memory (explicit saves
from today's and yesterday's sessions) while AgentCore's strategy extraction catches up.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta, timezone
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

