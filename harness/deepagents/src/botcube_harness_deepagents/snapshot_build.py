"""Steps of the V2 snapshot build that need none of the serving state."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import zoneinfo
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import httpx
from langchain_core.messages import HumanMessage
from opentelemetry.instrumentation.langchain.langgraph_utils import (
    extract_graph_structure,
)


def _answer(_request: httpx.Request) -> httpx.Response:
    """A whole Responses stream that says "ok"."""
    response = {
        'id': 'resp_snapshot', 'object': 'response', 'created_at': 0, 'status': 'completed', 'model': 'snapshot',
        'output': [{'type': 'message', 'id': 'msg_snapshot', 'role': 'assistant', 'status': 'completed',
                    'content': [{'type': 'output_text', 'text': 'ok', 'annotations': []}]}],
        'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2,
                  'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}},
    }
    events = [
        {'type': 'response.created', 'sequence_number': 0, 'response': {**response, 'status': 'in_progress', 'output': []}},
        {'type': 'response.output_text.delta', 'sequence_number': 1, 'item_id': 'msg_snapshot', 'output_index': 0,
         'content_index': 0, 'delta': 'ok'},
        {'type': 'response.completed', 'sequence_number': 2, 'response': response},
    ]
    body = ''.join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=body.encode())


async def answer_once(model: Any, text: str) -> None:
    """Runs one request of `model` end to end, answered in-process: its lazy imports, the SDK's platform probe and
    the stream's parsing, with no network."""
    client = model.root_async_client._client
    answered = httpx.MockTransport(_answer)
    client._transport_for_url = lambda _url: answered
    try:
        async for _chunk in model.astream([HumanMessage(text)]):
            pass
    finally:
        del client._transport_for_url


@contextmanager
def workspace_at(root: str) -> Generator[None, None, None]:
    previous = os.environ.get('BOTCUBE_WORKSPACE')
    os.environ['BOTCUBE_WORKSPACE'] = root
    try:
        yield
    finally:
        if previous is None:
            del os.environ['BOTCUBE_WORKSPACE']
        else:
            os.environ['BOTCUBE_WORKSPACE'] = previous


# A Turn reads its user's time zone file; held from the snapshot on, a restored microVM reads none.
_ZONES: list[zoneinfo.ZoneInfo] = []


def _hold_time_zones() -> None:
    _ZONES.extend(zoneinfo.ZoneInfo(key) for key in sorted(zoneinfo.available_timezones()))


def _skip_absent_optional_imports() -> None:
    """deepagents tries `langchain_fireworks` on each agent build; absent, each try stats every sys.path entry."""
    if importlib.util.find_spec('langchain_fireworks') is None:
        sys.modules['langchain_fireworks'] = None  # type: ignore[assignment]  # import then fails at once


def prime_process() -> None:
    _skip_absent_optional_imports()
    _hold_time_zones()


def walk_graph(agent: Any) -> None:
    """The OpenTelemetry LangGraph instrumentation walks each Turn's graph for its span, and the first walk's
    imports read files a restored V2 microVM serves cold (~560 ms of a Turn's blocked event loop): walk it once."""
    extract_graph_structure(agent.graph)
