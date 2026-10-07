from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta, timezone

import pytest

from botcube_harness_deepagents.actor_identity import ANONYMOUS_ACTOR_ID
from botcube_harness_deepagents.pending_memory import (
    AGENTCORE_SESSION_ID_MAX_LENGTH,
    pending_memory_session_id,
    pending_memory_session_ids,
    pending_memory_texts,
    utc_now,
)


def test_anonymous_pending_memory_session_ids_preserve_distinct_normalized_thread_ids() -> None:
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    raw_thread_ids = ['desk:1', 'desk_1', 'Desk-1', 'desk/1']

    session_ids = [
        pending_memory_session_id(now, actor_id=ANONYMOUS_ACTOR_ID, thread_id=thread_id)
        for thread_id in raw_thread_ids
    ]

    assert len(set(session_ids)) == len(raw_thread_ids)
    assert session_ids == [
        pending_memory_session_id(now, actor_id=ANONYMOUS_ACTOR_ID, thread_id=thread_id)
        for thread_id in raw_thread_ids
    ]
    assert all(
        len(session_id) <= AGENTCORE_SESSION_ID_MAX_LENGTH
        for session_id in session_ids
    )
    assert all(
        re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', session_id)
        for session_id in session_ids
    )
    assert session_ids[1] == 'pending-memory-20260702-desk_1'
    assert re.fullmatch(
        r'pending-memory-20260702-desk_1-[0-9a-f]{12}',
        session_ids[0],
    )
    assert re.fullmatch(
        r'pending-memory-20260702-desk_1-[0-9a-f]{12}',
        session_ids[2],
    )
    assert re.fullmatch(
        r'pending-memory-20260702-desk_1-[0-9a-f]{12}',
        session_ids[3],
    )


NOON = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)


def test_the_clock_reads_utc() -> None:
    assert utc_now().utcoffset() == timedelta(0)


def test_a_signed_in_actors_pending_memory_is_one_session_per_day() -> None:
    assert pending_memory_session_id(NOON, actor_id='user-1', thread_id='desk') == 'pending-memory-20260702'


@pytest.mark.parametrize(
    ('thread_id', 'suffix'),
    [
        # A thread id that fits the 100-character session id is used as is.
        ('t' * 76, 't' * 76),
        ('t' * 77, 't' * 63 + '-06fcf23bdb41'),
        ('t' * 62 + '_' + 'u' * 20, 't' * 62 + '-b74a5b4f49a8'),
        ('!!!', 'anonymous-e84c538e7fe2'),
        ('_desk_', 'desk-cb5c313a4dc8'),
    ],
)
def test_an_anonymous_actors_session_is_bounded_per_thread(thread_id: str, suffix: str) -> None:
    assert (
        pending_memory_session_id(NOON, actor_id=ANONYMOUS_ACTOR_ID, thread_id=thread_id)
        == f'pending-memory-20260702-{suffix}'
    )


@pytest.mark.parametrize(
    ('now', 'days'),
    [
        (datetime(2026, 7, 2, 0, 5, tzinfo=UTC), ['20260702', '20260701']),
        # A save from a clock running up to the window ahead lands in tomorrow's session.
        (datetime(2026, 7, 2, 23, 50, tzinfo=UTC), ['20260702', '20260701', '20260703']),
    ],
)
def test_pending_memory_is_read_from_every_session_its_window_touches(now: datetime, days: list[str]) -> None:
    assert pending_memory_session_ids(now, actor_id=ANONYMOUS_ACTOR_ID, thread_id='desk') == [
        f'pending-memory-{day}-desk' for day in days
    ]


def _save(text: str, *, at: datetime) -> dict[str, object]:
    return {
        'eventTimestamp': at,
        'payload': [
            {'blob': 'not a conversational save'},
            {'conversational': {'content': {'text': text}, 'role': 'USER'}},
        ],
    }


def test_pending_memory_is_the_saves_within_the_window_either_side_of_now() -> None:
    tokyo = timezone(timedelta(hours=9))
    events = [
        _save('Too old', at=NOON - timedelta(minutes=15, seconds=1)),
        _save('Oldest kept', at=NOON - timedelta(minutes=15)),
        _save('Kept, in Tokyo time', at=(NOON - timedelta(minutes=1)).astimezone(tokyo)),
        _save('Newest kept', at=NOON + timedelta(minutes=15)),
        _save('Too new', at=NOON + timedelta(minutes=15, seconds=1)),
    ]

    assert pending_memory_texts(events, now=NOON) == ['Oldest kept', 'Kept, in Tokyo time', 'Newest kept']
