from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from botcube_cartridge import ModelRelay
from langchain_core.messages import HumanMessage
from langchain_core.outputs import LLMResult
from langchain_core.tools import tool

from botcube_harness_deepagents import turn_timing
from botcube_harness_deepagents.llm import build_model
from conftest import ToolBindableFakeModel
from relay_fake import RECORDED_STREAM, RelayReply, serving_relay


class Clock:
    now = 0.0


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(turn_timing, 'perf_counter', lambda: fake.now)
    return fake


def _timing(warmup: bool = False) -> turn_timing.TurnTiming:
    return turn_timing.TurnTiming('run', 'session', 'model', warmup=warmup, receipt=0.0)


class Script:
    """Drives a TurnTiming's callbacks on the fake clock."""

    def __init__(self, clock: Clock, timing: turn_timing.TurnTiming) -> None:
        self.clock, self.timing = clock, timing

    def model(self, start: float, end: float | None, dispatch: float | None = None) -> None:
        run_id = uuid4()
        self.clock.now = start
        self.timing.on_chat_model_start({}, [[]], run_id=run_id)
        if dispatch is not None:
            self.clock.now = dispatch
            self.timing.dispatch(str(run_id))
        if end is not None:
            self.clock.now = end
            self.timing.on_llm_end(LLMResult(generations=[]), run_id=run_id)

    def tool(self, start: float, end: float | None) -> None:
        run_id = uuid4()
        self.clock.now = start
        self.timing.on_tool_start({}, '', run_id=run_id)
        if end is not None:
            self.clock.now = end
            self.timing.on_tool_end(None, run_id=run_id)

    def text(self, at: float) -> None:
        self.clock.now = at
        self.timing.text()


def _partition(record: dict[str, Any]) -> float:
    return record['inferenceMs'] + record['toolMs'] + record['overheadMs']


def test_parallel_model_calls_count_their_union_once(clock: Clock) -> None:
    timing = _timing()
    script = Script(clock, timing)
    script.model(1, 4)
    script.model(2, 6)
    script.text(5)
    script.text(7)
    record = timing.record(8, 'finished')
    assert record['inferenceMs'] == 5000
    assert record['toolMs'] == 0
    assert record['overheadMs'] == 2000
    assert record['modelCalls'] == 2
    assert record['harnessMs'] == {'firstDispatch': 1000, 'firstToken': 5000, 'lastToken': 7000, 'end': 8000}


def test_a_subagent_model_call_inside_a_tool_is_inference(clock: Clock) -> None:
    timing = _timing()
    script = Script(clock, timing)
    script.model(0.25, 1, dispatch=0.5)
    script.tool(1, 5)
    script.model(2, 3, dispatch=2.5)
    script.text(6)
    record = timing.record(6, 'finished')
    assert record['inferenceMs'] == 1000
    assert record['toolMs'] == 3500
    assert record['overheadMs'] == 1500
    assert record['phasesMs'] == {'model_payload': 750}
    assert record['harnessMs']['firstDispatch'] == 500
    assert (record['modelCalls'], record['toolCalls']) == (2, 1)


def test_calls_are_clipped_to_the_last_token(clock: Clock) -> None:
    timing = _timing()
    script = Script(clock, timing)
    script.model(1, 10)
    script.tool(2, None)
    script.text(3)
    script.model(11, 11.5)
    record = timing.record(12, 'finished')
    assert record['inferenceMs'] == 2000
    assert record['toolMs'] == 0
    assert record['overheadMs'] == 1000
    assert (record['modelCalls'], record['toolCalls']) == (1, 1)


def test_a_turn_without_text_ends_at_its_end(clock: Clock) -> None:
    timing = _timing()
    script = Script(clock, timing)
    script.model(1, 2)
    script.tool(2, 4)
    script.model(4.5, None)
    record = timing.record(5, 'failed')
    assert record['inferenceMs'] == 1500
    assert record['toolMs'] == 2000
    assert record['overheadMs'] == 1500
    assert 'firstToken' not in record['harnessMs'] and 'lastToken' not in record['harnessMs']
    assert record['harnessMs']['end'] == 5000
    assert record['status'] == 'failed'


def test_phases_accumulate_into_the_turn(clock: Clock) -> None:
    timing = _timing()
    with turn_timing.use(timing):
        for duration in (0.25, 0.5):
            with turn_timing.phase('graph_build'):
                clock.now += duration
        with turn_timing.phase('invocation_auth'):
            clock.now += 0.125
        assert turn_timing.current() is timing
    assert turn_timing.current() is None
    assert timing.record(clock.now, 'finished')['phasesMs'] == {'graph_build': 750, 'invocation_auth': 125}
    with pytest.raises(ValueError, match='Unknown Turn timing phase'), turn_timing.phase('unknown'):
        pass


def test_phases_count_their_runs_until_the_last_token(clock: Clock) -> None:
    timing = _timing()
    script = Script(clock, timing)
    script.model(0.5, 1, dispatch=0.75)
    with turn_timing.use(timing):
        for start in (1, 2):
            clock.now = start
            with turn_timing.phase('checkpoint_write'):
                clock.now += 0.125
        script.text(3)
        clock.now = 4
        with turn_timing.phase('checkpoint_write'):
            clock.now += 0.5
    record = timing.record(clock.now, 'finished')
    assert record['phasesMs'] == {'checkpoint_write': 250, 'model_payload': 250}
    assert record['phaseCounts'] == {'checkpoint_write': 2, 'model_payload': 1}


def test_phase_outside_a_turn_reads_no_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected() -> float:
        raise AssertionError('A phase outside a Turn read the clock')

    monkeypatch.setattr(turn_timing, 'perf_counter', unexpected)
    with turn_timing.phase('graph_build'):
        pass


def test_stray_callbacks_never_raise_and_the_line_logs_once(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=turn_timing.__name__)
    timing = _timing()
    unknown = uuid4()
    timing.on_llm_end(LLMResult(generations=[[]]), run_id=unknown)
    timing.on_llm_error(RuntimeError(), run_id=unknown)
    timing.on_tool_end(None, run_id=unknown)
    timing.on_tool_error(RuntimeError(), run_id=unknown)
    timing.dispatch('not-a-call')
    timing.finish('finished')
    timing.finish('failed')
    lines = [json.loads(r.message) for r in caplog.records]
    assert [line['status'] for line in lines] == ['finished']
    assert (lines[0]['modelCalls'], lines[0]['toolCalls']) == (0, 0)


def test_langchain_reports_nested_and_parallel_calls_to_the_turn() -> None:
    model = ToolBindableFakeModel(responses=['a', 'b', 'c'])

    @tool
    async def delegate(question: str) -> str:
        """Ask a subagent."""
        return (await model.ainvoke([HumanMessage(question)])).text

    async def turn() -> dict[str, Any]:
        timing = turn_timing.TurnTiming('run', 'session', 'model', warmup=False, receipt=turn_timing.perf_counter())
        with turn_timing.use(timing):
            await asyncio.gather(model.ainvoke('one'), model.ainvoke('two'))
            await delegate.ainvoke({'question': 'three'})
            timing.text()
        return timing.record(turn_timing.perf_counter(), 'finished')

    record = asyncio.run(turn())
    assert (record['modelCalls'], record['toolCalls']) == (3, 1)
    assert _partition(record) == pytest.approx(record['harnessMs']['lastToken'], abs=0.01)


def test_plan_model_inference_starts_at_its_http_request_and_reports_cache_hits() -> None:
    usage = b'"input_tokens":26,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":0}'
    assert usage in RECORDED_STREAM
    with serving_relay() as relay:
        relay.reply = RelayReply(body=RECORDED_STREAM.replace(
            usage, b'"input_tokens":26,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":20}'
        ))
        model = build_model(
            model='openai-plan:gpt-6-astra',
            relay=lambda: ModelRelay(relay.url, 'synthetic', {}, 'session'),
        )

        async def turn() -> dict[str, Any]:
            timing = turn_timing.TurnTiming('run', 'session', 'model', warmup=False, receipt=turn_timing.perf_counter())
            with turn_timing.use(timing):
                await model.ainvoke([HumanMessage('Say hello')])
            # The request names the LangChain run, so the Turn sees when it left.
            assert list(timing._models) == [relay.calls[0]['headers']['x-botcube-model-step-id']]
            return timing.record(turn_timing.perf_counter(), 'finished')

        record = asyncio.run(turn())
    assert record['modelCalls'] == 1
    assert record['phasesMs']['model_payload'] > 0
    assert record['inferenceMs'] > 0
    assert (record['inputTokens'], record['cachedInputTokens']) == (26, 20)
    assert 'Say hello' not in json.dumps(record)


def test_invocations_log_one_line_each_that_partitions_the_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import httpx

    from agentcore_fake import FakeAgentCoreMemory, turn_identity
    from botcube_harness_deepagents import serving
    from test_session_resume import _serve_session

    caplog.set_level(logging.INFO, logger=turn_timing.__name__)
    _serve_session(tmp_path, monkeypatch, FakeAgentCoreMemory())

    def body(run_id: str, forwarded: dict[str, Any]) -> dict[str, Any]:
        return {
            'thread_id': 'session-1',
            'run_id': run_id,
            'messages': [{'id': 'user-1', 'role': 'user', 'content': 'List the files'}],
            'tools': [],
            'context': [],
            'state': {},
            'forwarded_props': {
                'sessionUserId': 'user-1', 'turnIdentity': turn_identity('user-1', 'user-1', 'session-1'), **forwarded,
            },
        }

    async def ask() -> list[httpx.Response]:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=serving.app), base_url='http://fixture') as client:
            return [
                await client.post('/invocations', json=body('warmup-1', {'warmup': True, 'preparationScope': 'startup'})),
                await client.post('/invocations', json=body('run-1', {})),
            ]

    responses = asyncio.run(ask())
    assert [response.status_code for response in responses] == [200, 200]
    assert '"RUN_FINISHED"' in responses[1].text
    lines = [json.loads(r.message) for r in caplog.records if r.message.startswith('{"event":"harness_turn_timing"')]
    warmup, turn = lines
    assert (warmup['runId'], warmup['warmup'], warmup['status']) == ('warmup-1', True, 'finished')
    assert 'graph_build' in warmup['phasesMs']
    assert (turn['runId'], turn['sessionId'], turn['warmup'], turn['status']) == ('run-1', 'session-1', False, 'finished')
    # A warmup is not a Turn: the Turn after it is still its microVM's first (cold) one.
    assert turn['processTurn'] == warmup['processTurn']
    assert turn['processAgeMs'] > warmup['processAgeMs']
    assert (turn['modelCalls'], turn['toolCalls'], turn['historyMessages']) == (2, 1, 0)
    assert {'invocation_auth', 'memory_credentials', 'checkpoint_read', 'state_preparation'} <= set(turn['phasesMs'])
    marks = turn['harnessMs']
    assert list(marks) == ['prepared', 'firstDispatch', 'firstToken', 'lastToken', 'end']
    assert list(marks.values()) == sorted(marks.values())
    assert _partition(turn) == pytest.approx(marks['lastToken'], abs=0.01)
    assert min(turn['inferenceMs'], turn['toolMs'], turn['overheadMs']) > 0
