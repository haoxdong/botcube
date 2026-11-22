from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MemoryIndexEntry:
    record_id: str
    text: str


def memory_reference(record_id: str) -> str:
    return record_id.removeprefix('mem-')[:8]


def memory_index_line(entry: MemoryIndexEntry) -> str:
    reference = f'{memory_reference(entry.record_id)} ' if entry.record_id else ''
    line = f'- {reference}{" ".join(entry.text.split())}'
    return line if len(line) <= 100 else line[:99] + '…'
