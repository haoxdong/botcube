"""One `harness_turn_timing` line per /invocations call, splitting its Turn on this process's monotonic clock.

The line partitions the Turn, from receipt to its last token, into Inference Latency, Tool Latency and the
Harness's share of Orchestration Overhead (botcube/GLOSSARY.md). It carries only durations and offsets from
receipt; Insights joins it to the Chat Service's `chat_turn_timing` line on runId.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
from collections.abc import Callable, Generator, Iterable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Literal
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult
from langchain_core.tracers.context import register_configure_hook
from opentelemetry import trace

from . import process_observation

log = logging.getLogger(__name__)
_tracer = trace.get_tracer(__name__)
# Turns this process has served, warmups excluded: a Turn at 0 is the first on its microVM (cold).
_turns = 0
_current: ContextVar[TurnTiming | None] = ContextVar('turn_timing', default=None)
# LangChain adds the Turn's timing to every run configured while it is set, subagents' runs inside `task` included.
register_configure_hook(_current, inheritable=True)
# The model call this task last started. LangChain hands the model no run manager when it streams, so a plan model
# reads its run ID here to name its request (llm._plan_request_headers).
_model_run: ContextVar[str | None] = ContextVar('turn_timing_model_run', default=None)
# The loop-lag watch wakes this often; how late each wake is, is how long ready work waited for the loop.
_LAG_TICK = 0.005
# A stall longer than this gets the loop thread's stack, sampled this often.
_BLOCK_AFTER = 0.1
_BLOCK_SAMPLE = 0.025
_PHASES = frozenset({
    'invocation_auth',
    'memory_backends',
    'memory_credentials',
    'sts_exchange',
    'aws_credentials',
    'workspace',
    'personal_memory',
    'model_client',
    'graph_build',
    'stream_adapter',
    'state_preparation',
    'warmup_history',
    'checkpoint_read',
    'files_pull',
    'checkpoint_write',
})

Interval = tuple[float, float]


def _union(intervals: Iterable[Interval]) -> list[Interval]:
    merged: list[Interval] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _length(intervals: Iterable[Interval]) -> float:
    return sum(end - start for start, end in intervals)


def _overlap(a: list[Interval], b: list[Interval]) -> float:
    """The length both disjoint, sorted interval lists cover."""
    total, i, j = 0.0, 0, 0
    while i < len(a) and j < len(b):
        total += max(0.0, min(a[i][1], b[j][1]) - max(a[i][0], b[j][0]))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


@dataclass
class _Call:
    start: float
    # A plan model's HTTP request: its Inference Latency starts here rather than at `start`.
    dispatch: float | None = None
    end: float | None = None
    # The provider's input token usage, from the call's final message.
    input_tokens: int | None = None
    cached_input_tokens: int = 0

    @property
    def sent(self) -> float:
        return self.start if self.dispatch is None else self.dispatch


def _call_intervals(calls: list[_Call], receipt: float, last: float, end: float, *, inference: bool) -> list[Interval]:
    intervals = []
    for call in calls:
        start = max(call.sent if inference else call.start, receipt)
        stop = min(end if call.end is None else call.end, last)
        if stop > start:
            intervals.append((start, stop))
    return _union(intervals)


def _token_usage(calls: list[_Call]) -> dict[str, int | None]:
    reported = [call for call in calls if call.input_tokens is not None]
    return {
        'inputTokens': sum(call.input_tokens or 0 for call in reported) if reported else None,
        'cachedInputTokens': sum(call.cached_input_tokens for call in reported) if reported else None,
    }


class TurnTiming(BaseCallbackHandler):
    """Times one /invocations call: its phases, its model and tool calls, and its assistant text."""

    run_inline = True

    def __init__(self, run_id: str, session_id: str | None, model: str | None, *, warmup: bool, receipt: float) -> None:
        global _turns
        self.process_turn = _turns
        _turns += not warmup
        self.run_id, self.session_id, self.model, self.warmup, self.receipt = run_id, session_id, model, warmup, receipt
        # Each phase run as (name, start, end); checkpoint writes append from executor threads.
        self._phases: list[tuple[str, float, float]] = []
        self.history_messages: int | None = None
        self.prepared_at: float | None = None
        self.first_token: float | None = None
        self.last_token: float | None = None
        # Model and tool calls by LangChain run ID.
        self._models: dict[str, _Call] = {}
        self._tools: dict[str, _Call] = {}
        self._logged = False
        # Event-loop lag before the first model call starts, while `use` watches it from inside a loop.
        self._lag: list[float] | None = None
        self._beat = 0.0
        # The longest stall the sampler saw: (seconds, the loop thread's stack, innermost frame last).
        self._block: tuple[float, list[str]] | None = None

    @property
    def ignore_chain(self) -> bool:
        return True

    @property
    def ignore_retriever(self) -> bool:
        return True

    @property
    def ignore_retry(self) -> bool:
        return True

    @property
    def ignore_custom_event(self) -> bool:
        return True

    def on_chat_model_start(self, serialized: Any, messages: Any, *, run_id: UUID, **kwargs: Any) -> None:
        # Callbacks run inline in the model call's task, so the value reaches its HTTP request.
        _model_run.set(str(run_id))
        self._models.setdefault(str(run_id), _Call(perf_counter()))

    def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(self._models, run_id)
        call = self._models.get(str(run_id))
        generation = response.generations[0][0] if response.generations and response.generations[0] else None
        usage = getattr(getattr(generation, 'message', None), 'usage_metadata', None)
        if call is not None and usage:
            call.input_tokens = usage['input_tokens']
            # OpenAI's `cached_tokens` and Bedrock's cache reads; a priority or flex tier prefixes the key.
            details = usage.get('input_token_details') or {}
            call.cached_input_tokens = sum(v or 0 for k, v in details.items() if k.endswith('cache_read'))

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(self._models, run_id)

    def on_tool_start(self, serialized: Any, input_str: str, *, run_id: UUID, **kwargs: Any) -> None:
        self._tools.setdefault(str(run_id), _Call(perf_counter()))

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(self._tools, run_id)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(self._tools, run_id)

    @staticmethod
    def _end(calls: dict[str, _Call], run_id: UUID) -> None:
        call = calls.get(str(run_id))
        if call is not None and call.end is None:
            call.end = perf_counter()

    def dispatch(self, run_id: str) -> None:
        """The model call `run_id` sent its HTTP request: its Inference Latency starts here."""
        call = self._models.get(run_id)
        if call is not None and call.dispatch is None:
            call.dispatch = perf_counter()

    async def _watch_loop(self) -> None:
        """How late a short sleep wakes, tick by tick, until the first model call starts."""
        lag = self._lag = []
        self._beat = perf_counter()
        done = threading.Event()
        threading.Thread(target=self._sample_blocks, args=(threading.get_ident(), done), daemon=True).start()
        try:
            while not self._models:
                before = perf_counter()
                await asyncio.sleep(_LAG_TICK)
                self._beat = perf_counter()
                if not self._models:
                    lag.append(max(0.0, self._beat - before - _LAG_TICK))
        finally:
            done.set()

    def _sample_blocks(self, loop_thread: int, done: threading.Event) -> None:
        """From a thread of its own: the loop thread's stack while the loop has not ticked for a while."""
        while not done.wait(_BLOCK_SAMPLE):
            stalled = perf_counter() - self._beat
            frame = sys._current_frames().get(loop_thread) if stalled > _BLOCK_AFTER else None
            if frame is not None and (self._block is None or stalled > self._block[0]):
                # Code objects only: reading source lines would be file access on the very path being timed.
                stack: list[str] = []
                while frame is not None and len(stack) < 16:
                    stack.append(f'{frame.f_code.co_filename.rsplit("site-packages/", 1)[-1]}:{frame.f_lineno} {frame.f_code.co_name}')
                    frame = frame.f_back
                self._block = stalled, stack[::-1]

    def prepared(self) -> None:
        self.prepared_at = perf_counter()

    def text(self) -> None:
        """The Turn streamed an assistant text frame."""
        self.last_token = perf_counter()
        if self.first_token is None:
            self.first_token = self.last_token

    def record(self, end: float, status: Literal['finished', 'failed']) -> dict[str, Any]:
        last = self.last_token if self.last_token is not None else end

        def ms(seconds: float) -> float:
            return round(seconds * 1000, 3)

        models, tools = list(self._models.values()), list(self._tools.values())
        inference = _call_intervals(models, self.receipt, last, end, inference=True)
        tool_union = _call_intervals(tools, self.receipt, last, end, inference=False)
        inference_s = _length(inference)
        tool_s = _length(tool_union) - _overlap(tool_union, inference)
        # Like model_payload, a phase run counts, in full, only if it started before the last token.
        runs = [(name, stopped - began) for name, began, stopped in self._phases if began < last]
        runs += [('model_payload', call.dispatch - call.start) for call in models
                 if call.dispatch is not None and call.start < last]
        phases: dict[str, float] = {}
        counts: dict[str, int] = {}
        for name, seconds in runs:
            phases[name] = phases.get(name, 0.0) + seconds * 1000
            counts[name] = counts.get(name, 0) + 1
        marks = {
            'prepared': self.prepared_at,
            'firstModelStart': min((call.start for call in models), default=None),
            'firstDispatch': min((call.sent for call in models), default=None),
            'firstToken': self.first_token,
            'lastToken': self.last_token,
            'end': end,
        }
        return {
            'event': 'harness_turn_timing',
            'runId': self.run_id,
            'sessionId': self.session_id,
            'model': self.model,
            'warmup': self.warmup,
            'status': status,
            'processTurn': self.process_turn,
            'processAgeMs': ms(self.receipt - (process_observation.serving_since() or self.receipt)),
            'historyMessages': self.history_messages,
            'modelCalls': sum(call.start < last for call in models),
            'toolCalls': sum(call.start < last for call in tools),
            'inferenceMs': ms(inference_s),
            'toolMs': ms(tool_s),
            'overheadMs': ms(last - self.receipt - inference_s - tool_s),
            **_token_usage(models),
            'harnessMs': {name: ms(at - self.receipt) for name, at in marks.items() if at is not None},
            'phasesMs': {name: round(value, 3) for name, value in phases.items()},
            'phaseCounts': counts,
            **self._loop_fields(ms),
        }

    def _loop_fields(self, ms: Callable[[float], float]) -> dict[str, Any]:
        """The event loop's lag and longest block before the first model call, when `use` watched it."""
        fields: dict[str, Any] = {}
        if self._lag is not None:
            fields['loopLagMs'] = {'total': ms(sum(self._lag)), 'max': ms(max(self._lag, default=0.0))}
        if self._block is not None:
            fields['loopBlock'] = {'ms': ms(self._block[0]), 'stack': self._block[1]}
        return fields

    def finish(self, status: Literal['finished', 'failed']) -> None:
        """Log the Turn's line, once."""
        if not self._logged:
            self._logged = True
            log.info(json.dumps(self.record(perf_counter(), status), separators=(',', ':')))


@contextmanager
def use(timing: TurnTiming) -> Generator[TurnTiming, None, None]:
    token = _current.set(timing)
    loop = asyncio._get_running_loop()  # None outside a loop, where there is no lag to watch
    watcher = None if loop is None else loop.create_task(timing._watch_loop())
    try:
        yield timing
    finally:
        if watcher is not None:
            watcher.cancel()
        _current.reset(token)


def current() -> TurnTiming | None:
    return _current.get()


def model_run() -> str | None:
    """The run ID of the Turn's model call this task has in flight, if any."""
    timing, run_id = current(), _model_run.get()
    call = None if timing is None or run_id is None else timing._models.get(run_id)
    return run_id if call is not None and call.end is None else None


@contextmanager
def phase(name: str) -> Generator[None, None, None]:
    """Add the block's wall time to the current Turn's `name` phase."""
    if name not in _PHASES:
        raise ValueError(f'Unknown Turn timing phase {name!r}')
    timing = current()
    if timing is None:
        yield
        return
    started = perf_counter()
    try:
        with _tracer.start_as_current_span(
            f'harness.phase.{name}', record_exception=False, set_status_on_exception=False,
        ):
            yield
    finally:
        timing._phases.append((name, started, perf_counter()))


async def dispatched(request: Any) -> None:
    """An httpx request hook: a plan model's request carries its LangChain run ID (llm._plan_request_headers)."""
    timing, run_id = current(), request.headers.get('x-botcube-model-step-id')
    if timing is not None and run_id is not None:
        timing.dispatch(run_id)
