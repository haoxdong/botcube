from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from botcube_harness_deepagents.pending_memory import (
    pending_memory_session_id,
    pending_memory_session_ids,
    pending_memory_texts,
    utc_now,
)

NOON = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)


def test_the_clock_reads_utc() -> None:
    assert utc_now().utcoffset() == timedelta(0)


def test_an_actors_pending_memory_is_one_session_per_day() -> None:
    assert pending_memory_session_id(NOON) == 'pending-memory-20260702'


@pytest.mark.parametrize(
    ('now', 'days'),
    [
        (datetime(2026, 7, 2, 0, 5, tzinfo=UTC), ['20260702', '20260701']),
        # A save from a clock running up to the window ahead lands in tomorrow's session.
        (datetime(2026, 7, 2, 23, 50, tzinfo=UTC), ['20260702', '20260701', '20260703']),
    ],
)
def test_pending_memory_is_read_from_every_session_its_window_touches(now: datetime, days: list[str]) -> None:
    assert pending_memory_session_ids(now) == [f'pending-memory-{day}' for day in days]


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
