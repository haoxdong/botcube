from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import pytest
from botcube_cartridge import InvocationAuth, ModelRelay
from langchain_core.messages import HumanMessage

from botcube_harness_deepagents import answer_timing
from botcube_harness_deepagents.llm import build_model
from relay_fake import RECORDED_STREAM, RelayReply, serving_relay


def test_startup_phases_measure_nested_wall_and_thread_cpu_time(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=answer_timing.__name__)
    clock = {"wall": 10.0, "cpu": 1.0}
    monkeypatch.setattr(answer_timing.time, "perf_counter", lambda: clock["wall"])
    monkeypatch.setattr(answer_timing.time, "thread_time", lambda: clock["cpu"])
    timing = answer_timing.AnswerTiming("run", "session", "model", receipt=0)
    with answer_timing.use(timing), answer_timing.phase("memory_backends"):
        clock.update(wall=11.0, cpu=1.25)
        with answer_timing.phase("workspace"):
            clock.update(wall=13.0, cpu=1.5)
        clock.update(wall=15.0, cpu=2.0)
    assert [json.loads(record.message) for record in caplog.records] == [
        {
            "event": "harness_startup_phase",
            "phase": "workspace",
            "wallMs": 2000.0,
            "threadCpuMs": 250.0,
            "runId": "run",
            "sessionId": "session",
        },
        {
            "event": "harness_startup_phase",
            "phase": "memory_backends",
            "wallMs": 5000.0,
            "threadCpuMs": 1000.0,
            "runId": "run",
            "sessionId": "session",
        },
    ]


def test_startup_phase_records_failure_without_logging_its_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=answer_timing.__name__)
    failure = RuntimeError("private invocation payload")
    timing = answer_timing.AnswerTiming("__warmup__", "session", None)
    with (
        pytest.raises(RuntimeError) as caught,
        answer_timing.use(timing),
        answer_timing.phase("invocation_auth"),
    ):
        raise failure
    assert caught.value is failure
    record = json.loads(caplog.records[0].message)
    assert record["runId"] == "__warmup__"
    assert record["phase"] == "invocation_auth"
    assert record["wallMs"] >= 0
    assert record["threadCpuMs"] >= 0
    assert "private" not in caplog.text


def test_startup_phase_without_a_turn_does_not_read_clocks_or_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def unexpected_clock() -> float:
        raise AssertionError("No timing context")

    monkeypatch.setattr(answer_timing.time, "perf_counter", unexpected_clock)
    monkeypatch.setattr(answer_timing.time, "thread_time", unexpected_clock)
    with answer_timing.phase("graph_build"):
        pass
    assert caplog.records == []


@pytest.mark.parametrize("name", ["", "private prompt", "workspace\nsecret"])
def test_startup_phase_rejects_names_outside_the_fixed_stages(
    name: str, caplog: pytest.LogCaptureFixture
) -> None:
    with (
        pytest.raises(ValueError, match="Unknown startup timing phase"),
        answer_timing.phase(name),
    ):
        pytest.fail("Unknown phase must not enter")
    assert caplog.records == []


def test_native_sdk_response_alias_and_actual_dispatch(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    with serving_relay() as relay:
        model = build_model(
            model="openai-plan:gpt-6-astra",
            relay=lambda: ModelRelay(
                relay.url,
                "public-fixture",
                {"X-Account-Id": "synthetic"},
                "synthetic-session",
            ),
        )
        timing = answer_timing.AnswerTiming(
            "run-fixture", "session-fixture", "openai-plan:gpt-6-astra"
        )

        async def ask():
            with answer_timing.use(timing):
                timing.prepared()
                async for chunk in model.astream([HumanMessage("Say hello")]):
                    if chunk.text.strip():
                        timing.alias(chunk, "public-fixture-id")
                        frame = "encoded synthetic answer"
                        timing.frame(frame, "public-fixture-id")
                        timing.emitted(frame)

        from opentelemetry import context, trace

        token = context.attach(
            trace.set_span_in_context(
                trace.NonRecordingSpan(
                    trace.SpanContext(
                        trace_id=int("1" * 32, 16),
                        span_id=int("2" * 16, 16),
                        is_remote=False,
                        trace_flags=trace.TraceFlags(1),
                    )
                )
            )
        )
        try:
            asyncio.run(ask())
        finally:
            context.detach(token)
    record = timing.record()
    assert record["status"] == "complete"
    assert record["providerResponseId"].startswith("resp_")
    assert record["publicMessageId"] == "public-fixture-id"
    assert record["modelStepId"] == relay.calls[0]["headers"]["x-botcube-model-step-id"]
    offsets = record["offsetsMs"]
    assert list(offsets) == [
        "receipt",
        "preparationComplete",
        "credentialDispatch",
        "answerReceived",
        "answerEmitted",
    ]
    assert list(offsets.values()) == sorted(offsets.values())


def _long_answer_stream(count: int) -> bytes:
    import json

    frames = [
        json.loads(frame.split(b"data: ", 1)[1])
        for frame in RECORDED_STREAM.split(b"\n\n")
        if frame.strip()
    ]
    expanded = []
    for frame in frames:
        if frame["type"] == "response.output_text.delta":
            expanded.extend(dict(frame) for _ in range(count))
        else:
            if frame["type"] == "response.output_text.done":
                frame["text"] = "hello" * count
            expanded.append(frame)
    return b"".join(
        (
            "event: "
            + frame["type"]
            + "\ndata: "
            + json.dumps(dict(frame, sequence_number=index))
            + "\n\n"
        ).encode()
        for index, frame in enumerate(expanded)
    )


@pytest.mark.parametrize(
    "multi_output,delta_count", [(False, 1), (True, 1), (False, 1100)]
)
def test_serving_aliases_native_sdk_chunk_to_actual_public_message(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    multi_output: bool,
    delta_count: int,
) -> None:
    import dataclasses
    import json

    import httpx

    from agentcore_fake import FakeAgentCoreMemory, memory_capability_props
    from botcube_harness_deepagents import serving
    from test_session_resume import _serve_session

    caplog.set_level(logging.INFO)
    _serve_session(tmp_path, monkeypatch, FakeAgentCoreMemory())
    with serving_relay() as relay:
        if delta_count > 1:
            relay.reply = RelayReply(body=_long_answer_stream(delta_count))
        if multi_output:
            frames = [
                json.loads(f.split(b"data: ", 1)[1])
                for f in RECORDED_STREAM.split(b"\n\n")
                if f.strip()
            ]
            extra = []
            for original in frames[2:8]:
                frame = json.loads(
                    json.dumps(original)
                    .replace(
                        "msg_0a0035e46d4cb8be016abff84697c087d1a00e1fcf5b15f174",
                        "msg_second_fixture",
                    )
                    .replace("hello", "second")
                )
                frame["output_index"] = 1
                frame["sequence_number"] += 6
                extra.append(frame)
            frames[-1]["sequence_number"] += 6
            relay.reply = RelayReply(
                body=b"".join(
                    (
                        "event: " + f["type"] + "\ndata: " + json.dumps(f) + "\n\n"
                    ).encode()
                    for f in frames[:-1] + extra + frames[-1:]
                )
            )
        monkeypatch.setattr(serving, "build_model", build_model)
        assert serving._cartridge is not None
        monkeypatch.setattr(
            serving,
            "_cartridge",
            dataclasses.replace(
                serving._cartridge,
                prepare_invocation=lambda _: InvocationAuth(
                    "user-1",
                    False,
                    None,
                    model_relay=ModelRelay(
                        relay.url, "synthetic", {}, "session-fixture"
                    ),
                ),
            ),
        )

        async def ask():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=serving.app),
                base_url="http://fixture",
            ) as client:
                return await client.post(
                    "/invocations",
                    headers={
                        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "session-fixture",
                    },
                    json={
                        "thread_id": "session-fixture",
                        "run_id": "run-fixture",
                        "messages": [
                            {
                                "id": "user-fixture",
                                "role": "user",
                                "content": "Say hello",
                            }
                        ],
                        "tools": [],
                        "context": [],
                        "state": {},
                        "forwarded_props": {
                            "sessionUserId": "user-1",
                            "turnMemory": memory_capability_props(),
                            "model": "openai-plan:gpt-6-astra",
                        },
                    },
                )

        from opentelemetry import context, trace

        token = context.attach(
            trace.set_span_in_context(
                trace.NonRecordingSpan(
                    trace.SpanContext(
                        trace_id=int("1" * 32, 16),
                        span_id=int("2" * 16, 16),
                        is_remote=False,
                        trace_flags=trace.TraceFlags(1),
                    )
                )
            )
        )
        try:
            response = asyncio.run(ask())
        finally:
            context.detach(token)
    records = [
        json.loads(r.message)
        for r in caplog.records
        if r.message.startswith('{"event":"harness_first_answer_boundary"')
    ]
    assert len(records) == 1
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    content = [
        e for e in events if e["type"] == "TEXT_MESSAGE_CONTENT" and e["delta"].strip()
    ]
    assert content and "".join(e["delta"] for e in content) == (
        "hellosecond" if multi_output else "hello" * delta_count
    )
    assert response.status_code == 200
    assert events[-1]["type"] == "RUN_FINISHED"
    assert records[0]["status"] == "complete", records
    assert records[0]["publicMessageId"] == content[0]["messageId"]
    assert (
        records[0]["providerItemId"]
        == "msg_0a0035e46d4cb8be016abff84697c087d1a00e1fcf5b15f174"
    )
    assert records[0]["traceId"] == "1" * 32


def test_missing_or_wrong_alias_never_becomes_complete() -> None:
    from langchain_core.messages import AIMessageChunk

    timing = answer_timing.AnswerTiming("run", "session", "model")
    timing.prepared()
    step = timing.begin("step")
    assert step is not None
    step.dispatched = answer_timing.time.perf_counter()
    step.trace = "1" * 32
    native = AIMessageChunk(
        content=[{"type": "text", "text": "answer", "index": 0, "id": "msg_fixture"}],
        response_metadata={"id": "resp_fixture"},
    )
    timing.received(native, step)
    timing.alias(AIMessageChunk(content="answer"), "public")
    frame = "synthetic frame"
    timing.frame(frame, "public")
    timing.emitted(frame)
    assert timing.record()["status"] == "invalid"
    assert timing.record()["reason"] == "missing_native_alias"


def test_whitespace_and_queue_delay_and_context_isolation() -> None:
    from langchain_core.messages import AIMessageChunk

    async def turn(identifier: str) -> dict[str, Any]:
        timing = answer_timing.AnswerTiming(identifier, "session", "model")
        with answer_timing.use(timing):
            timing.prepared()
            step = timing.begin(identifier)
            assert step is not None
            step.dispatched = answer_timing.time.perf_counter()
            step.trace = "1" * 32
            blank = AIMessageChunk(
                content=[{"type": "text", "text": " \n", "index": 0}],
                response_metadata={"id": "resp_" + identifier},
            )
            timing.received(blank, step)
            assert step.answer is None
            await asyncio.sleep(0)
            assert answer_timing.current() is timing
            chunk = AIMessageChunk(
                content=[
                    {
                        "type": "text",
                        "text": "first fragment",
                        "index": 0,
                        "id": "msg_" + identifier,
                    }
                ]
            )
            timing.received(chunk, step)
            timing.alias(chunk, "public_" + identifier)
            frame = "encoded " + identifier
            timing.frame(frame, "public_" + identifier)
            await asyncio.sleep(0.01)
            timing.emitted(frame)
        assert answer_timing.current() is None
        result = timing.record()
        assert result["status"] == "complete"
        assert (
            result["offsetsMs"]["answerEmitted"] - result["offsetsMs"]["answerReceived"]
            >= 9
        )
        return result

    async def run():
        return await asyncio.gather(turn("one"), turn("two"))

    records = asyncio.run(run())
    assert [r["modelStepId"] for r in records] == ["one", "two"]
    assert [r["providerResponseId"] for r in records] == ["resp_one", "resp_two"]


def test_actual_keepalive_queue_counts_delay_and_cleans_up() -> None:
    from langchain_core.messages import AIMessageChunk

    from botcube_harness_deepagents.serving import _kept_alive

    timing = answer_timing.AnswerTiming("run", "session", "model")
    timing.prepared()
    step = timing.begin("step")
    assert step is not None
    step.trace = "1" * 32
    step.dispatched = answer_timing.time.perf_counter()
    chunk = AIMessageChunk(
        content=[{"type": "text", "text": "answer", "index": 0, "id": "msg_fixture"}],
        response_metadata={"id": "resp_fixture"},
    )
    timing.received(chunk, step)
    timing.alias(chunk, "public")
    frame = "encoded answer fixture"
    timing.frame(frame, "public")

    async def frames():
        yield "preceding event"
        yield frame

    async def read():
        stream = _kept_alive(frames(), timing)
        assert await anext(stream) == "preceding event"
        await asyncio.sleep(0.02)
        assert await anext(stream) == frame
        assert [item async for item in stream] == []

    asyncio.run(read())
    record = timing.record()
    assert record["status"] == "complete"
    assert (
        record["offsetsMs"]["answerEmitted"] - record["offsetsMs"]["answerReceived"]
        >= 19
    )
    assert timing.logged


async def _prepare_sdk_alias_control(mode: str, model: Any, relay: Any) -> None:
    from botcube_harness_deepagents.serving import _SessionAgent

    if mode == "hidden_prior":
        hidden = object.__new__(_SessionAgent)
        async for chunk in model.astream([HumanMessage("Synthetic hidden call")]):
            assert [
                item
                async for item in hidden._handle_model_event(
                    {
                        "event": "on_chat_model_stream",
                        "metadata": {"lc_source": "summarization"},
                        "data": {"chunk": chunk},
                    },
                    None,
                )
            ] == []
        relay.reply = RelayReply(
            body=RECORDED_STREAM.replace(
                b"resp_0a0035e46d4cb8be016abff84517a887d19e23fd46c36fc69a",
                b"resp_visible_fixture",
            )
        )
    elif mode == "missing_done":
        relay.reply = RelayReply(
            body=b"\n\n".join(
                f
                for f in RECORDED_STREAM.split(b"\n\n")
                if b"event: response.output_text.done\n" not in f
            )
        )


def _alter_sdk_output_control(mode: str, chunk: Any) -> None:
    if mode == "wrong_output":
        for block in chunk.content:
            if isinstance(block, dict) and block.get("type") == "text":
                block["index"] = 9


@pytest.mark.parametrize(
    "mode", ["hidden_prior", "missing_done", "wrong_output", "unordered"]
)
def test_actual_sdk_hidden_prior_and_invalid_alias_controls(mode: str) -> None:
    import json

    from opentelemetry import context, trace

    with serving_relay() as relay:
        model = build_model(
            model="openai-plan:gpt-6-astra",
            relay=lambda: ModelRelay(relay.url, "synthetic", {}, "session"),
        )
        timing = answer_timing.AnswerTiming("run", "session", "model")

        async def ask():
            with answer_timing.use(timing):
                timing.prepared()
                await _prepare_sdk_alias_control(mode, model, relay)
                async for chunk in model.astream(
                    [HumanMessage("Synthetic visible call")]
                ):
                    if chunk.text.strip():
                        _alter_sdk_output_control(mode, chunk)
                        timing.alias(chunk, "public")
                        frame = "encoded fixture"
                        timing.frame(frame, "public")
                        timing.emitted(frame)
                if mode == "unordered":
                    timing.preparation = timing.receipt - 1

        token = context.attach(
            trace.set_span_in_context(
                trace.NonRecordingSpan(
                    trace.SpanContext(
                        trace_id=int("1" * 32, 16),
                        span_id=int("2" * 16, 16),
                        is_remote=False,
                        trace_flags=trace.TraceFlags(1),
                    )
                )
            )
        )
        try:
            asyncio.run(ask())
        finally:
            context.detach(token)
    record = timing.record()
    assert record["status"] == ("complete" if mode == "hidden_prior" else "invalid")
    if mode == "hidden_prior":
        assert record["providerResponseId"] == "resp_visible_fixture"
        assert (
            record["modelStepId"]
            == relay.calls[-1]["headers"]["x-botcube-model-step-id"]
        )
    assert "Synthetic" not in json.dumps(record)
