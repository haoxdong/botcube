"""Checkpoint fakes shared by the serving and Session API tests, in a plain module: the Cartridge suite imports
`test_serving` under its own conftest."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.memory import InMemorySaver


class ReadCountingSaver(InMemorySaver):
    """An in-memory saver that records each checkpoint read: `get_tuple`, `list` and ancestor walks."""

    def __init__(self) -> None:
        super().__init__()
        self.reads: list[str] = []

    def get_tuple(self, config: Any) -> Any:
        self.reads.append('get_tuple')
        return super().get_tuple(config)

    def list(self, *args: Any, **kwargs: Any) -> Any:
        self.reads.append('list')
        return super().list(*args, **kwargs)

    def get_delta_channel_history(self, *, config: Any, channels: Sequence[str]) -> Any:
        self.reads.append('delta_channel_history')
        return super().get_delta_channel_history(config=config, channels=channels)


def legacy_session(saver: InMemorySaver, thread_id: str) -> None:
    """File a Session as the legacy checkpoint format left it: `messages` and `files` versioned, never stored."""
    config: Any = {'configurable': {'thread_id': thread_id, 'checkpoint_ns': ''}}
    for step, version in enumerate(('1', '2')):
        checkpoint = empty_checkpoint()
        checkpoint['channel_versions'] = {'messages': version, 'files': version}
        config = saver.put(config, checkpoint, {'source': 'loop', 'step': step, 'parents': {}},
                           {'messages': version, 'files': version})
