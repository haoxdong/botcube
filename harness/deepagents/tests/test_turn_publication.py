from __future__ import annotations

import asyncio
import threading
from typing import Any, NoReturn

import boto3
import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint

from agentcore_fake import MEMORY_ID, FakeAgentCoreMemory
from botcube_harness_deepagents import serving
from botcube_harness_deepagents.memory import agentcore
from botcube_harness_deepagents.memory.agentcore.turn_saver import TurnCheckpointSaver


def _turn_saver(monkeypatch: pytest.MonkeyPatch) -> tuple[FakeAgentCoreMemory, Any]:
    memory = FakeAgentCoreMemory()
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: memory)
    return memory, agentcore.build_checkpointer(MEMORY_ID, region_name='us-east-1', wrapper=TurnCheckpointSaver)


def _turn_config() -> RunnableConfig:
    return {'configurable': {'thread_id': 'session-1', 'actor_id': 'user-1', 'checkpoint_ns': ''}}


def test_initial_and_final_publication_failures_are_both_retained_issue_3701(monkeypatch: pytest.MonkeyPatch) -> None:
    memory, stored = _turn_saver(monkeypatch)
    saver = serving._PublishingTurnSaver(stored._saver)
    calls = 0

    def unavailable(**_params: Any) -> NoReturn:
        nonlocal calls
        calls += 1
        raise RuntimeError('initial write failed' if calls == 1 else 'final write failed')

    monkeypatch.setattr(memory, 'create_event', unavailable)

    async def run() -> None:
        await saver.aput(_turn_config(), empty_checkpoint(), {'source': 'loop', 'step': 0, 'parents': {}}, {})
        with pytest.raises(RuntimeError, match='initial write failed'):
            await saver.await_initial_record(('user-1', 'session-1'))
        with pytest.raises(ExceptionGroup) as raised:
            await saver.aflush(('user-1', 'session-1'))
        assert [str(failure) for failure in raised.value.exceptions] == ['initial write failed', 'final write failed']
        monkeypatch.setattr(memory, 'create_event', lambda **_params: {'event': {'eventId': 'retry'}})
        await saver.aflush(('user-1', 'session-1'))

    asyncio.run(run())


def test_repeated_flush_cancellation_waits_for_initial_worker_issue_3701(monkeypatch: pytest.MonkeyPatch) -> None:
    memory, stored = _turn_saver(monkeypatch)
    saver = serving._PublishingTurnSaver(stored._saver)
    entered = threading.Event()
    release = threading.Event()
    settled = threading.Event()
    create_event = memory.create_event

    def held(**params: Any) -> dict[str, Any]:
        entered.set()
        assert release.wait(10), 'Initial worker was never released'
        result = create_event(**params)
        settled.set()
        return result

    monkeypatch.setattr(memory, 'create_event', held)

    async def run() -> None:
        await saver.aput(_turn_config(), empty_checkpoint(), {'source': 'loop', 'step': 0, 'parents': {}}, {})
        assert await asyncio.to_thread(entered.wait, 5)
        flush = asyncio.create_task(saver.aflush(('user-1', 'session-1')))
        await asyncio.sleep(0)
        try:
            for _ in range(3):
                flush.cancel()
                await asyncio.sleep(0.02)
                assert not flush.done()
                assert not settled.is_set()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await flush
        assert settled.is_set()
        await saver.aflush(('user-1', 'session-1'))
        assert saver.get_tuple(_turn_config()) is not None

    asyncio.run(run())


