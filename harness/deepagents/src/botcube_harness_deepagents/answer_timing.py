from __future__ import annotations

import json
import logging
import math
import re
import time
import weakref
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)
_current: ContextVar[AnswerTiming | None] = ContextVar("answer_timing", default=None)
_step: ContextVar[str | None] = ContextVar("answer_model_step", default=None)


def _id(value: Any) -> str | None:
    return (
        value
        if isinstance(value, str)
        and 0 < len(value) <= 200
        and value.isascii()
        and all(c.isalnum() or c in "-_.:" for c in value)
        else None
    )


def _text_blocks(chunk: Any) -> Iterator[dict[str, Any]]:
    if isinstance(chunk.content, list):
        for block in chunk.content:
            if isinstance(block, dict) and block.get("type") == "text":
                yield block


def _has_text(block: dict[str, Any]) -> bool:
    return isinstance(block.get("text"), str) and bool(block["text"].strip())


def _offset(value: float | None, receipt: float) -> float | None:
    return (
        (value - receipt) * 1000 if value is not None and math.isfinite(value) else None
    )


@dataclass
class Step:
    id: str
    dispatched: float | None = None
    trace: str | None = None
    response: str | None = None
    answer: float | None = None
    answer_index: int | None = None
    items: dict[int, str] = field(default_factory=dict)
    item_conflict: bool = False

    def observe(self, block: dict[str, Any]) -> int | None:
        index = block.get("index")
        if not isinstance(index, int) or isinstance(index, bool):
            return None
        item = _id(block.get("id"))
        if item:
            if len(self.items) >= 1024 and index not in self.items:
                self.item_conflict = True
                return None
            prior = self.items.get(index)
            self.item_conflict |= prior is not None and prior != item
            self.items[index] = item
        if not _has_text(block):
            return None
        if self.answer is None:
            self.answer, self.answer_index = time.perf_counter(), index
        return index

    def valid_alias(self, index: int | None) -> bool:
        return bool(
            self.response
            and self.trace
            and not self.item_conflict
            and index == self.answer_index
            and self.answer_index in self.items
        )


class AnswerTiming:
    def __init__(
        self,
        run: str,
        session: str | None,
        model: str | None,
        receipt: float | None = None,
    ) -> None:
        self.receipt = receipt if receipt is not None else time.perf_counter()
        self.run, self.session, self.model = map(_id, (run, session, model))
        self.preparation: float | None = None
        self.steps: dict[str, Step] = {}
        self.chunks: dict[int, tuple[Any, Step, int | None]] = {}
        self.aliases: dict[str, tuple[Step, int | None]] = {}
        self.selected: Step | None = None
        self.selected_index: int | None = None
        self.public: str | None = None
        self.pending: int | None = None
        self.emission: float | None = None
        self.invalid: str | None = None
        self.logged = False

    def prepared(self) -> None:
        self.preparation = time.perf_counter()

    def begin(self, identifier: str) -> Step | None:
        safe = _id(identifier)
        if safe is None or len(self.steps) >= 64:
            self.invalid = "invalid_or_excess_steps"
            return None
        if safe in self.steps:
            self.invalid = "reused_model_step"
            return None
        result = Step(safe)
        self.steps[safe] = result
        return result

    def received(self, chunk: Any, step: Step) -> None:
        response = _id(chunk.response_metadata.get("id"))
        if response:
            step.response = response
        chunk_index: int | None = None
        for block in _text_blocks(chunk):
            index = step.observe(block)
            if index is not None:
                if chunk_index is not None and chunk_index != index:
                    step.item_conflict = True
                chunk_index = index
        if len(self.chunks) >= 1024:
            self.chunks = {
                key: value
                for key, value in self.chunks.items()
                if value[0]() is not None
            }
        if len(self.chunks) >= 1024:
            self.invalid = "excess_live_chunks"
            return
        self.chunks[id(chunk)] = (weakref.ref(chunk), step, chunk_index)

    def alias(self, chunk: Any, public: str) -> None:
        safe = _id(public)
        match = self.chunks.get(id(chunk))
        if safe is None or match is None or match[0]() is not chunk:
            self.invalid = "missing_native_alias"
            return
        visible_index = next(
            (block.get("index") for block in _text_blocks(chunk) if _has_text(block)),
            None,
        )
        if visible_index != match[2]:
            self.invalid = "changed_native_chunk"
            return
        prior = self.aliases.get(safe)
        if prior is not None and prior[0] is not match[1]:
            self.invalid = "conflicting_native_alias"
            return
        if len(self.aliases) >= 1024 and safe not in self.aliases:
            self.invalid = "excess_public_aliases"
            return
        self.aliases[safe] = (match[1], match[2])

    def frame(self, frame: str, public: str) -> None:
        if self.pending is not None or self.emission is not None:
            return
        self.public = _id(public)
        alias = self.aliases.get(public)
        if alias:
            self.selected, self.selected_index = alias
        self.pending = id(frame)

    def emitted(self, frame: str) -> None:
        if self.pending == id(frame) and self.emission is None:
            self.emission = time.perf_counter()

    def record(self) -> dict[str, Any]:
        selected = self.selected
        values = [
            self.receipt,
            self.preparation,
            selected.dispatched if selected else None,
            selected.answer if selected else None,
            self.emission,
        ]
        valid = (
            self.invalid is None
            and selected is not None
            and selected.valid_alias(self.selected_index)
            and all((self.run, self.session, self.model, self.public))
            and all(v is not None and math.isfinite(v) for v in values)
        )
        if valid:
            valid = values == sorted(values)
        return {
            "event": "harness_first_answer_boundary",
            "status": "complete" if valid else "invalid",
            "reason": None
            if valid
            else self.invalid or "missing_or_unordered_boundary",
            "runId": self.run,
            "sessionId": self.session,
            "modelId": self.model,
            "traceId": selected.trace if selected else None,
            "modelStepId": selected.id if selected else None,
            "providerResponseId": selected.response if selected else None,
            "providerItemId": selected.items.get(selected.answer_index)
            if selected and selected.answer_index is not None
            else None,
            "publicMessageId": self.public,
            "offsetsMs": dict(
                zip(
                    (
                        "receipt",
                        "preparationComplete",
                        "credentialDispatch",
                        "answerReceived",
                        "answerEmitted",
                    ),
                    (_offset(v, self.receipt) for v in values),
                    strict=True,
                )
            ),
        }

    def finish(self) -> None:
        if not self.logged:
            log.info(json.dumps(self.record(), separators=(",", ":")))
            self.logged = True


@contextmanager
def use(timing: AnswerTiming) -> Iterator[None]:
    token = _current.set(timing)
    try:
        yield
    finally:
        _current.reset(token)


def current() -> AnswerTiming | None:
    return _current.get()


async def dispatched(request: Any) -> None:
    timing, identifier = current(), _step.get()
    if (
        request.method == "POST"
        and request.url.path.endswith("/responses")
        and timing
        and identifier
        and request.headers.get("x-botcube-model-step-id") == identifier
    ):
        step = timing.steps.get(identifier)
        if step and step.dispatched is None:
            step.dispatched = time.perf_counter()
            step.trace = trace_id(request.headers.get("traceparent"))


def trace_id(header: str | None) -> str | None:
    match = re.fullmatch(r"00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}", header or "")
    return match[1] if match and match[1] != "0" * 32 and match[2] != "0" * 16 else None
