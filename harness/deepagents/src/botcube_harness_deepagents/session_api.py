"""Session API: reads and deletes a Session in its one record without waking a Sandbox (ADR 0067 §5).

`handle` is the transport-neutral entrypoint: it takes one operation event and
returns its JSON result. In AWS it runs as its own function beside the Agent
Service container, invoked only by the Chat Service's role; locally
`POST /invocations` serves the same event over plain HTTP, mirroring the Agent
Service's local mode.

Operations:
- ``{"operation": "get", "sessionId", "userId"}`` -> ``{"messages": [...]}``,
  the Session's conversation in AG-UI message shape, read from its latest
  checkpoint through LangGraph's state API. Each agent, reasoning and tool
  message the Harness timed carries ``metadata`` ``{"started_at", "ended_at"}``,
  in epoch milliseconds (message_times.py). A Session with no record is
  ``SESSION_NOT_FOUND`` (HTTP 404).
- ``{"operation": "post", "sessionId", "userId", "content", "messageId"?, "scheduledRun"?}`` -> ``{}``,
  after adding ``content`` to the Session as the agent's message, under
  ``messageId`` when given, without running the agent: a scheduled run's summary
  reaches the Main Chat this way, with the run card it shows as, which history
  replays as the message's ``metadata``.
- A ``get`` or ``post`` on a Session in the legacy checkpoint format is
  ``SESSION_FORMAT_LEGACY`` (HTTP 410), read without walking its checkpoints; one
  that runs past ``SESSION_READ_SECONDS`` is ``SESSION_READ_TIMEOUT`` (HTTP 504).
- ``{"operation": "purge", "sessionId", "userId"}`` -> ``{}``, after deleting
  every event of the Session and of its checkpoints' writes sessions.
  Idempotent: purging a purged Session succeeds.
- ``{"operation": "memory", "userId"}`` -> ``{"lines": [{"id", "text"}]}``, the
  user's Memory document: one line per memory record the agent opens a conversation with.
- ``{"operation": "memory-edit", "userId", "recordId", "text"}`` -> ``{}``, after
  rewriting that line's record; ``{"operation": "memory-delete", "userId", "recordId"}``
  -> ``{}``, after deleting it. A record that is no line of the user's Memory is
  ``MEMORY_LINE_NOT_FOUND`` (HTTP 404).
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import Awaitable, Mapping
from typing import Any

import boto3
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig

from .agent import build_agent
from .conversation import SCHEDULED_RUN, conversation
from .llm import EchoChatModel
from .memory import agentcore as agentcore_memory_backend
from .memory import local as local_memory_backend
from .memory.agentcore.purge import purge_session
from .memory_document import (
    MemoryLineNotFoundError,
    delete_memory_line,
    edit_memory_line,
    memory_lines,
)
from .memory_tools import AGENTCORE_MEMORY_ID, AGENTCORE_REGION
from .session_format import SessionFormatLegacyError, latest_checkpoint

log = logging.getLogger(__name__)


class SessionApiError(Exception):
    status_code = 400
    code = 'INVALID_REQUEST'


class SessionNotFoundError(SessionApiError):
    status_code = 404
    code = 'SESSION_NOT_FOUND'


class MemoryLineNotFound(SessionApiError):
    status_code = 404
    code = 'MEMORY_LINE_NOT_FOUND'


class MemoryNotConfiguredError(SessionApiError):
    status_code = 503
    code = 'MEMORY_NOT_CONFIGURED'


class SessionFormatLegacy(SessionApiError):
    status_code = 410
    code = 'SESSION_FORMAT_LEGACY'


class SessionReadTimeout(SessionApiError):
    status_code = 504
    code = 'SESSION_READ_TIMEOUT'


# A get or post ends before the Chat Service stops waiting for it (60 s, botcube/chat's session-api.ts);
# the function's own timeout stays long enough for a purge.
SESSION_READ_SECONDS = 50.0


_GRAPH: Any | None = None


def _build_checkpointer() -> Any:
    if AGENTCORE_MEMORY_ID:
        return agentcore_memory_backend.build_checkpointer(
            AGENTCORE_MEMORY_ID, region_name=AGENTCORE_REGION
        )
    checkpoint_path = os.getenv('BOTCUBE_CHECKPOINT_PATH', '').strip()
    if checkpoint_path:
        return local_memory_backend.build_checkpointer(checkpoint_path)
    # An in-memory checkpointer lives only inside the Harness process.
    raise RuntimeError(
        'The session API needs the Session record: set AGENTCORE_MEMORY_ID '
        'or BOTCUBE_CHECKPOINT_PATH'
    )


def _graph() -> Any:
    """The Harness Library graph, compiled only to read Session state; it never runs."""
    global _GRAPH
    if _GRAPH is None:
        # A graph that never runs needs no backend, and must carry no memory source.
        _GRAPH = build_agent(
            model=EchoChatModel(),
            backend=None,
            skills=[],
            memory=[],
            checkpointer=_build_checkpointer(),
        )
    return _GRAPH


def _required(event: Mapping[str, Any], name: str) -> str:
    value = event.get(name)
    if not isinstance(value, str) or not value.strip():
        raise SessionApiError(f'{name} is required')
    return value


def _optional(event: Mapping[str, Any], name: str) -> str | None:
    return None if event.get(name) is None else _required(event, name)


def _scheduled_run(event: Mapping[str, Any]) -> dict[str, Any] | None:
    card = event.get('scheduledRun')
    if card is not None and not isinstance(card, dict):
        raise SessionApiError('scheduledRun must be an object')
    return card


async def get_session(user_id: str, session_id: str) -> list[dict[str, Any]]:
    """The Session's conversation as its latest checkpoint holds it."""
    graph, config = _graph(), _config(user_id, session_id)
    if await latest_checkpoint(graph, config) is None:
        raise SessionNotFoundError(f'Session {session_id} has no record')
    messages = (await graph.aget_state(config)).values.get('messages')
    if not messages:
        raise SessionNotFoundError(f'Session {session_id} has no record')
    return conversation(messages)


def _config(user_id: str, session_id: str) -> RunnableConfig:
    return {'configurable': {'thread_id': session_id, 'actor_id': user_id}}


async def post_message(
    user_id: str, session_id: str, content: str, message_id: str | None = None, scheduled_run: dict[str, Any] | None = None
) -> None:
    config = _config(user_id, session_id)
    graph = _graph()
    if await latest_checkpoint(graph, config) is None:
        # LangGraph drops the values of a Session's first update; this one starts the record.
        await graph.aupdate_state(config, {'messages': []}, as_node='model')  # pragma: no mutate: LangGraph drops this update's values, so any values or node name that it accepts starts the same record
    # As the model's answer: the Session's next Turn starts from a finished one. Its own ID,
    # as the web keys a Session's messages by ID.
    message = AIMessage(
        content,
        id=message_id or str(uuid.uuid4()),
        additional_kwargs={} if scheduled_run is None else {SCHEDULED_RUN: scheduled_run},
    )
    await graph.aupdate_state(config, {'messages': [message]}, as_node='model')


async def _read(session_id: str, work: Awaitable[Any]) -> Any:
    """A get or post, within SESSION_READ_SECONDS, with the Session's format failure classified."""
    deadline = asyncio.timeout(SESSION_READ_SECONDS)
    try:
        async with deadline:
            return await work
    except TimeoutError as exc:
        if not deadline.expired():
            raise
        raise SessionReadTimeout(
            f'The session API gave up reading Session {session_id} after {SESSION_READ_SECONDS:g} s'
        ) from exc
    except SessionFormatLegacyError as exc:
        raise SessionFormatLegacy(str(exc)) from exc


async def purge(user_id: str, session_id: str) -> None:
    checkpointer = _graph().checkpointer
    if AGENTCORE_MEMORY_ID:
        await asyncio.to_thread(purge_session, checkpointer, user_id, session_id)
    else:
        await checkpointer.adelete_session(user_id, session_id)


MEMORY_OPERATIONS = ('memory', 'memory-edit', 'memory-delete')


def _memory_operation(operation: str, event: Mapping[str, Any]) -> dict[str, Any]:
    """Read or edit the user's Memory document, whose lines are AgentCore Memory records."""
    user_id = _required(event, 'userId')
    if not AGENTCORE_MEMORY_ID:
        raise MemoryNotConfiguredError('Memory needs AgentCore Memory: set AGENTCORE_MEMORY_ID')
    client = boto3.client('bedrock-agentcore', region_name=AGENTCORE_REGION)
    if operation == 'memory':
        return {'lines': memory_lines(client, memory_id=AGENTCORE_MEMORY_ID, actor_id=user_id)}
    record_id = _required(event, 'recordId')
    try:
        if operation == 'memory-edit':
            text = _required(event, 'text')
            edit_memory_line(client, memory_id=AGENTCORE_MEMORY_ID, actor_id=user_id, record_id=record_id, text=text)
        else:
            delete_memory_line(client, memory_id=AGENTCORE_MEMORY_ID, actor_id=user_id, record_id=record_id)
    except MemoryLineNotFoundError as exc:
        raise MemoryLineNotFound(str(exc)) from exc
    return {}


async def handle(event: Mapping[str, Any]) -> dict[str, Any]:
    operation = event.get('operation')
    if operation == 'get':
        user_id, session_id = _required(event, 'userId'), _required(event, 'sessionId')
        return {'messages': await _read(session_id, get_session(user_id, session_id))}
    if operation == 'post':
        user_id, session_id = _required(event, 'userId'), _required(event, 'sessionId')
        content, message_id = _required(event, 'content'), _optional(event, 'messageId')
        await _read(session_id, post_message(user_id, session_id, content, message_id, _scheduled_run(event)))
        return {}
    if operation in MEMORY_OPERATIONS:
        return _memory_operation(operation, event)
    if operation == 'purge':
        await purge(_required(event, 'userId'), _required(event, 'sessionId'))
        return {}
    raise SessionApiError(f'Unknown session API operation: {operation!r}')


# One loop for the life of the function's execution environment, made on its
# first invocation: the cached graph's checkpointer outlives each invocation.
_LOOP: asyncio.AbstractEventLoop | None = None


def _err(exc: SessionApiError) -> dict[str, Any]:
    return {'statusCode': exc.status_code, 'body': {'error': str(exc), 'code': exc.code}}


def lambda_handler(event: Mapping[str, Any], _context: Any) -> dict[str, Any]:
    """The deployed function's entrypoint: the local mode's HTTP status and JSON body.

    Anything but a SessionApiError propagates, so Lambda reports a function error.
    """
    global _LOOP
    if _LOOP is None:
        _LOOP = asyncio.new_event_loop()
    try:
        body = _LOOP.run_until_complete(handle(event))
    except SessionApiError as exc:
        return _err(exc)
    return {'statusCode': 200, 'body': body}


app = FastAPI(title='BotCube Session API')


@app.post('/invocations')
async def invocations(request: Request) -> JSONResponse:
    try:
        event = await request.json()
    except ValueError as exc:
        return JSONResponse({'error': 'Invalid JSON', 'code': 'INVALID_REQUEST', 'details': str(exc)}, status_code=400)
    if not isinstance(event, dict):
        return JSONResponse({'error': 'Expected a JSON object', 'code': 'INVALID_REQUEST'}, status_code=400)
    return JSONResponse(await handle(event))


@app.exception_handler(SessionApiError)
async def session_api_error(_request: Request, exc: SessionApiError) -> JSONResponse:
    return JSONResponse({'error': str(exc), 'code': exc.code}, status_code=exc.status_code)


@app.get('/ping')
def ping() -> JSONResponse:
    return JSONResponse({'status': 'Healthy'})


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format='%(name)s %(message)s')
    uvicorn.run(app, host=os.getenv('BOTCUBE_SESSION_API_HOST', '0.0.0.0'), port=int(os.getenv('PORT', '8081')))


if __name__ == '__main__':
    main()
