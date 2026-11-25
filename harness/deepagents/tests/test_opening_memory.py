"""The Memory a Session opens with (ADR 0031): the actor's extracted preferences and facts."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, NoReturn, cast

import pytest

from agentcore_fake import (
    EXCEPTIONS,
    MEMORY_ID,
    FakeAgentCoreMemory,
)
from botcube_harness_deepagents.memory.agentcore.opening import opening_memory

NOW = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
ACTOR = 'jane.doe_ny'


@pytest.fixture
def memory() -> FakeAgentCoreMemory:
    return FakeAgentCoreMemory()


def _open(memory: FakeAgentCoreMemory, actor_id: str = ACTOR) -> str:
    return opening_memory(cast(Any, memory), memory_id=MEMORY_ID, actor_id=actor_id)


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
        '- record-{ User prefers dark mode\n'
        '- record-{ User likes copper futures\n'
        '\n'
        'semantic facts:\n'
        '- record-C Copper is an industrial metal'
    )


def test_facts_are_newest_first_and_same_instant_facts_keep_their_listing_order(memory: FakeAgentCoreMemory) -> None:
    memory.records += [
        _fact('Oldest', created_at=NOW - timedelta(days=3)),
        _fact('Newest', created_at=NOW - timedelta(hours=1)),
        _fact('Tied first', created_at=NOW - timedelta(days=2)),
        # The same instant written in another zone.
        _fact('Tied second', created_at=(NOW - timedelta(days=2)).astimezone(timezone(timedelta(hours=9)))),
    ]

    assert _open(memory) == 'semantic facts:\n- record-N Newest\n- record-T Tied first\n- record-T Tied second\n- record-O Oldest'


def test_the_block_caps_each_section_at_one_hundred_and_points_at_the_rest(memory: FakeAgentCoreMemory) -> None:
    memory.records += [_preference(f'Preference {i:02d}') for i in range(101)]
    memory.records += [_fact(f'Fact {i:02d}', created_at=NOW - timedelta(minutes=160 - i)) for i in range(102)]

    assert _open(memory) == '\n'.join([
        'user preferences:',
        *[f'- record-{{ Preference {i:02d}' for i in range(100)],
        '',
        'semantic facts:',
        *[f'- record-F Fact {i:02d}' for i in range(101, 1, -1)],
        '',
        '(1 more preferences; 2 more facts; use memory list or retrieve)',
    ])


@pytest.mark.parametrize(('preferences', 'facts'), [(101, 1), (1, 101)])
def test_either_section_over_its_cap_points_at_the_rest(memory: FakeAgentCoreMemory, preferences: int, facts: int) -> None:
    memory.records += [_preference(f'Preference {i:02d}') for i in range(preferences)]
    memory.records += [_fact(f'Fact {i:02d}') for i in range(facts)]

    block = _open(memory)

    assert block.endswith('\n\n(1 more ' + ('preferences' if preferences > 100 else 'facts')
                          + '; use memory list or retrieve)')


def test_sections_exactly_at_their_caps_do_not_point_at_more(memory: FakeAgentCoreMemory) -> None:
    memory.records += [_preference(f'Preference {i:02d}') for i in range(100)]
    memory.records += [_fact(f'Fact {i:02d}') for i in range(100)]

    block = _open(memory)

    assert block.count('\n- ') == 200
    assert 'more ' not in block


class _SlowMemory:
    """The fake Memory with a round trip of LATENCY on every read."""

    LATENCY = 0.1

    def __init__(self, memory: FakeAgentCoreMemory) -> None:
        self._memory = memory
        self.reads = 0

    def _read(self) -> None:
        self.reads += 1
        time.sleep(self.LATENCY)

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
    block = opening_memory(cast(Any, slow), memory_id=MEMORY_ID, actor_id=ACTOR)
    elapsed = time.perf_counter() - started

    assert block == 'user preferences:\n- record-{ User prefers dark mode\n\nsemantic facts:\n- record-C Copper is an industrial metal'
    assert slow.reads == 2
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


def test_when_both_listings_fail_the_preferences_listing_fails_the_load(
    memory: FakeAgentCoreMemory, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The facts listing fails sooner but must not win the race."""
    errors = {
        kind: EXCEPTIONS.ThrottledException({'Error': {'Code': 'ThrottledException', 'Message': kind}}, 'ListMemoryRecords')
        for kind in ('preferences', 'facts')
    }

    def paginate(*, namespace: str, **_params: Any) -> NoReturn:
        if namespace.endswith('/preferences/'):
            time.sleep(0.1)
            raise errors['preferences']
        raise errors['facts']

    monkeypatch.setattr(memory, 'get_paginator', lambda _operation: SimpleNamespace(paginate=paginate))

    with pytest.raises(EXCEPTIONS.ThrottledException) as raised:
        _open(memory)
    assert raised.value is errors['preferences']


def test_large_memory_opens_as_a_bounded_index_newest_first(memory: FakeAgentCoreMemory) -> None:
    for index in range(150):
        for kind in ('preferences', 'facts'):
            record = _record('x' * 500, kind, created_at=NOW - timedelta(seconds=150 - index))
            record['memoryRecordId'] = f'mem-{index:08d}' + 'a' * 28
            memory.records.append(record)
    block = _open(memory)
    preferences, facts, closing = block.split('\n\n')
    assert preferences.splitlines()[0] == 'user preferences:'
    assert facts.splitlines()[0] == 'semantic facts:'
    for section in (preferences, facts):
        lines = section.splitlines()[1:]
        assert len(lines) == 100
        assert all(len(line) == 100 and line.endswith('…') for line in lines)
        assert lines[0] == '- 00000149 ' + 'x' * 88 + '…'
        assert lines[-1] == '- 00000050 ' + 'x' * 88 + '…'
    assert closing == '(50 more preferences; 50 more facts; use memory list or retrieve)'
