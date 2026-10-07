"""Tests for LangSmith usage_metadata propagation through streaming.

The LangGraph agent uses astream_events, which forces the LLM into the
streaming code path.  In that path, BaseChatModel._agenerate_with_cache
converts streaming chunks back to a ChatResult via generate_from_stream,
which calls message_chunk_to_message.  The assembled AIMessage SHOULD
preserve usage_metadata — and it does in isolation — but the LangSmith
tracer serialises outputs via LLMResult.model_dump() which drops it.
The tracer then overwrites with dumpd(generation.message), which restores
it, but only if the generation.message still carries usage_metadata at
that point.

These tests lock the expected behaviour at each layer so we detect
upstream regressions and know when the fix lands.
"""

from langchain_core.load import dumpd
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, LLMResult

# ---------------------------------------------------------------------------
# Layer 1: AIMessageChunk aggregation preserves usage_metadata
# ---------------------------------------------------------------------------

def test_chunk_aggregation_preserves_usage_metadata():
    """AIMessageChunk.__add__ must merge usage_metadata from the final chunk."""
    c1 = AIMessageChunk(content="hello ", id="t1")
    c2 = AIMessageChunk(
        content="world",
        id="t1",
        usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
    )
    agg = c1 + c2
    assert agg.usage_metadata is not None
    assert agg.usage_metadata["input_tokens"] == 100
    assert agg.usage_metadata["output_tokens"] == 20
    assert agg.usage_metadata["total_tokens"] == 120


# ---------------------------------------------------------------------------
# Layer 2: message_chunk_to_message preserves usage_metadata
# ---------------------------------------------------------------------------

def test_message_chunk_to_message_preserves_usage_metadata():
    """Converting AIMessageChunk → AIMessage must keep usage_metadata."""
    from langchain_core.messages.utils import message_chunk_to_message

    chunk = AIMessageChunk(
        content="hi",
        id="t2",
        usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60},
    )
    msg = message_chunk_to_message(chunk)
    assert isinstance(msg, AIMessage)
    assert msg.usage_metadata is not None
    assert msg.usage_metadata["total_tokens"] == 60


# ---------------------------------------------------------------------------
# Layer 3: dumpd serialisation preserves usage_metadata
# ---------------------------------------------------------------------------

def test_dumpd_preserves_usage_metadata_on_ai_message():
    """dumpd(AIMessage) must include usage_metadata in kwargs."""
    msg = AIMessage(
        content="hi",
        id="t3",
        usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60},
    )
    d = dumpd(msg)
    kwargs = d.get("kwargs", {})
    assert "usage_metadata" in kwargs
    assert kwargs["usage_metadata"]["total_tokens"] == 60


def test_dumpd_preserves_usage_metadata_on_chat_generation():
    """dumpd(ChatGeneration(message=AIMessage)) must include usage_metadata."""
    msg = AIMessage(
        content="hi",
        id="t4",
        usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60},
    )
    gen = ChatGeneration(message=msg)
    d = dumpd(gen)
    msg_kwargs = d.get("kwargs", {}).get("message", {}).get("kwargs", {})
    assert "usage_metadata" in msg_kwargs
    assert msg_kwargs["usage_metadata"]["total_tokens"] == 60


def test_dumpd_preserves_usage_metadata_on_chat_generation_chunk():
    """dumpd(ChatGenerationChunk(message=AIMessageChunk)) must include usage_metadata."""
    chunk = AIMessageChunk(
        content="hi",
        id="t5",
        usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60},
    )
    gen = ChatGenerationChunk(message=chunk)
    d = dumpd(gen)
    msg_kwargs = d.get("kwargs", {}).get("message", {}).get("kwargs", {})
    assert "usage_metadata" in msg_kwargs
    assert msg_kwargs["usage_metadata"]["total_tokens"] == 60


# ---------------------------------------------------------------------------
# Layer 4: LLMResult.model_dump() — the broken layer
# ---------------------------------------------------------------------------

def test_llm_result_model_dump_preserves_usage_metadata():
    """LLMResult.model_dump() should preserve usage_metadata in generation message.

    KNOWN BUG: model_dump() uses Pydantic serialisation which drops
    usage_metadata from the message dict.  The tracer works around this
    by re-serialising via dumpd(), but if this test starts passing it
    means the upstream Pydantic schema was fixed and the workaround in
    _complete_llm_run may no longer be needed.
    """
    msg = AIMessage(
        content="hi",
        id="t6",
        usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60},
    )
    gen = ChatGeneration(message=msg)
    result = LLMResult(generations=[[gen]])
    dumped = result.model_dump()
    msg_dict = dumped["generations"][0][0].get("message", {})
    assert "usage_metadata" not in msg_dict, (
        "LLMResult.model_dump() now preserves usage_metadata; reassess the dumpd workaround"
    )


# ---------------------------------------------------------------------------
# Layer 5: generate_from_stream end-to-end
# ---------------------------------------------------------------------------

def test_generate_from_stream_preserves_usage_metadata():
    """generate_from_stream (used when ainvoke falls back to streaming) must
    produce a ChatResult whose generation.message has usage_metadata."""
    from langchain_core.language_models.chat_models import generate_from_stream

    chunks = iter([
        ChatGenerationChunk(message=AIMessageChunk(content="hi", id="t7")),
        ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                id="t7",
                usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60},
            )
        ),
    ])
    result = generate_from_stream(chunks)
    message = result.generations[0].message
    assert isinstance(message, AIMessage)
    assert message.usage_metadata is not None
    assert message.usage_metadata["total_tokens"] == 60


# ---------------------------------------------------------------------------
# Layer 6: _get_usage_metadata_from_generations (tracer extraction)
# ---------------------------------------------------------------------------

def test_tracer_extracts_usage_from_dumpd_generations():
    """The LangSmith tracer must find usage_metadata in dumpd-serialised generations."""
    from langchain_core.tracers.langchain import _get_usage_metadata_from_generations

    msg = AIMessage(
        content="hi",
        id="t8",
        usage_metadata={"input_tokens": 50, "output_tokens": 10, "total_tokens": 60},
    )
    gen = ChatGeneration(message=msg)
    # Simulate what _complete_llm_run does: model_dump then dumpd overwrite
    result = LLMResult(generations=[[gen]])
    outputs = result.model_dump()
    output_gen = outputs["generations"][0][0]
    if "message" in output_gen:
        output_gen["message"] = dumpd(gen.message)

    usage = _get_usage_metadata_from_generations(outputs["generations"])
    assert usage is not None, (
        "Tracer failed to extract usage_metadata from serialised generations"
    )
    assert usage["total_tokens"] == 60


# ---------------------------------------------------------------------------
# Integration: full streaming pipeline simulation
# ---------------------------------------------------------------------------

def test_streaming_pipeline_preserves_usage_in_langsmith_output():
    """End-to-end: simulate what happens when LangGraph astream_events
    forces the LLM into streaming mode and the tracer serialises the result.

    When this test passes, it means the full pipeline from streaming chunks
    through tracer serialisation preserves usage_metadata.  If it fails,
    an upstream change broke the chain.
    """
    from langchain_core.language_models.chat_models import generate_from_stream
    from langchain_core.tracers.langchain import _get_usage_metadata_from_generations

    # Step 1: streaming chunks (simulating ChatBedrockConverse._stream)
    chunks = iter([
        ChatGenerationChunk(message=AIMessageChunk(content="hello", id="t9")),
        ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                id="t9",
                usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
            )
        ),
    ])

    # Step 2: generate_from_stream (what _agenerate_with_cache does)
    chat_result = generate_from_stream(chunks)
    gen = chat_result.generations[0]

    # Step 3: wrap in LLMResult (what on_llm_end receives)
    llm_result = LLMResult(generations=[[gen]])

    # Step 4: _complete_llm_run serialisation
    outputs = llm_result.model_dump()
    output_gen = outputs["generations"][0][0]
    if "message" in output_gen:
        output_gen["message"] = dumpd(gen.message)

    # Step 5: tracer extraction
    usage = _get_usage_metadata_from_generations(outputs["generations"])
    assert usage is not None, (
        "Tracer failed to extract usage_metadata from streaming pipeline output"
    )
    assert usage["total_tokens"] == 120
