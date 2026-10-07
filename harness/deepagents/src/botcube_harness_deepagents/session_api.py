"""Session API: reads and deletes a Session in its one record without waking a Sandbox (ADR 0067 §5).

`handle` is the transport-neutral entrypoint: it takes one operation event and
returns its JSON result. In AWS it runs as its own function beside the Agent
Service container, invoked only by the Chat Service's role; locally
`POST /invocations` serves the same event over plain HTTP, mirroring the Agent
Service's local mode.

Operations:
- ``{"operation": "get", "sessionId", "userId", "contains"?}`` -> ``{"messages": [...]}``,
  the Session's conversation in AG-UI message shape, from its messages snapshot.
  A Session without one, or whose snapshot lacks the message ID
  ``contains`` names, has it rebuilt from its state, read through LangGraph's
  state API. A Session with no record is ``SESSION_NOT_FOUND`` (HTTP 404).
- ``{"operation": "activity", "sessions": [{"sessionId", "userId"}]}`` -> ``{"tasks":
  [{"sessionId", "messageId", "summary", "completedAt"}]}``, one per answered Turn of
  each Session, in the order given, each Session's oldest first: the ID and first line
  of the user message that started it, timed from the Session's checkpoints. A Session
  with no record has no tasks; one that cannot be read fails the operation, naming it.
- ``{"operation": "post", "sessionId", "userId", "content", "messageId"?}`` -> ``{}``,
  after adding ``content`` to the Session as the agent's message, under
  ``messageId`` when given, without running the agent, and snapshotting its
  messages: a scheduled run's summary reaches the Main Chat this way.
- ``{"operation": "purge", "sessionId", "userId"}`` -> ``{}``, after deleting
  every event of the Session. Idempotent: purging a purged Session succeeds.
- ``{"operation": "memory", "userId"}`` -> ``{"lines": [{"id", "text"}]}``, the
  user's Memory document: one line per memory record the agent opens a conversation with.
- ``{"operation": "memory-edit", "userId", "recordId", "text"}`` -> ``{}``, after
  rewriting that line's record; ``{"operation": "memory-delete", "userId", "recordId"}``
  -> ``{}``, after deleting it. A record that is no line of the user's Memory is
  ``MEMORY_LINE_NOT_FOUND`` (HTTP 404).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import uuid
from collections.abc import Mapping
from itertools import accumulate
from typing import Any

import boto3
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from ._env import positive_int
from .agent import build_agent
from .llm import EchoChatModel
from .memory import agentcore as agentcore_memory_backend
from .memory import local as local_memory_backend
from .memory.agentcore.snapshot_saver import reading_once
from .memory_document import (
    MemoryLineNotFoundError,
    delete_memory_line,
    edit_memory_line,
    memory_lines,
)
from .memory_tools import AGENTCORE_MEMORY_ID, AGENTCORE_REGION
from .messages_snapshot import MessagesSnapshot, state_snapshot

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


async def get_session(user_id: str, session_id: str, contains: str | None = None) -> list[dict[str, Any]]:
    """The Session's snapshot, rebuilt from its state when it has none or lacks the message the caller expects.

    A rebuilt snapshot records what it was checked against, so a message the state never got, as a Turn's that
    failed before it was saved, rebuilds it once, not on every read.
    """
    checkpointer = _graph().checkpointer
    snapshot = await checkpointer.aread_messages_snapshot(user_id, session_id)
    if snapshot is None or not _holds(snapshot, contains):
        with reading_once():
            snapshot = await state_snapshot(_graph(), _config(user_id, session_id), contains)
        if snapshot is None:
            raise SessionNotFoundError(f'Session {session_id} has no record')
        await checkpointer.awrite_messages_snapshot(user_id, session_id, snapshot)
    return snapshot.messages


def _holds(snapshot: MessagesSnapshot, message_id: str | None) -> bool:
    return message_id in (None, snapshot.checked) or any(message['id'] == message_id for message in snapshot.messages)


def _config(user_id: str, session_id: str) -> RunnableConfig:
    return {'configurable': {'thread_id': session_id, 'actor_id': user_id}}


def _current_branch(checkpoints: dict[str, Any]) -> list[Any]:
    """The Session's current branch, oldest first: the latest checkpoint and its ancestors."""
    branch = []
    checkpoint_id: str | None = max(checkpoints)
    while checkpoint_id is not None:
        item = checkpoints[checkpoint_id]
        branch.append(item)
        checkpoint_id = (item.parent_config or {}).get('configurable', {}).get('checkpoint_id')
    branch.reverse()
    return branch


def _turns(branch: list[Any]) -> list[tuple[int, list[str]]]:
    """Each Turn's user message count and checkpoint timestamps; a Turn starts at a checkpoint saved from run input."""
    turns: list[tuple[int, list[str]]] = []
    for item in branch:
        # A post is no part of any Turn.
        if item.metadata.get('source') == 'update':
            continue
        if item.metadata.get('source') == 'input':
            run_input = item.checkpoint['channel_values']['__start__']['messages']
            turns.append((sum(isinstance(message, HumanMessage) for message in run_input), []))
        turns[-1][1].append(item.checkpoint['ts'])
    return turns


async def session_activity(user_id: str, session_id: str) -> list[dict[str, str]]:
    """Each answered Turn: its last user message's ID and first line, and when its last checkpoint was saved.

    A Turn starts at a checkpoint LangGraph saved from run input, which holds
    one or more user messages.
    """
    config = {'configurable': {'thread_id': session_id, 'actor_id': user_id}}
    graph = _graph()
    checkpoints = {
        item.config['configurable']['checkpoint_id']: item async for item in graph.checkpointer.alist(config)
    }
    if not checkpoints:
        return []
    turns = _turns(_current_branch(checkpoints))
    if not turns:
        return []
    messages = (await graph.aget_state(config)).values['messages']
    starts = [index for index, message in enumerate(messages) if isinstance(message, HumanMessage)]
    requests = [count for count, _ in turns]
    if 0 in requests or sum(requests) != len(starts):
        raise RuntimeError(f'Session {session_id} has {len(turns)} Turns but {len(starts)} user messages')
    tasks = []
    # Each Turn's user messages, as positions in starts, end before the next Turn's.
    bounds = list(accumulate(requests, initial=0))
    ends = [*(starts[bound] for bound in bounds[1:-1]), len(messages)]
    for bound, end, (_, timestamps) in zip(bounds[1:], ends, turns, strict=True):  # pragma: no mutate: lengths checked above
        answer = messages[end - 1]
        if isinstance(answer, AIMessage) and not answer.tool_calls:
            request = messages[starts[bound - 1]]
            summary = request.text.strip().partition('\n')[0]
            tasks.append({'messageId': request.id, 'summary': summary, 'completedAt': timestamps[-1]})
    return tasks


# Sessions one activity operation reads at once: each read waits mostly on AgentCore
# Memory, and the checkpointer's boto3 client pools 10 connections.
ACTIVITY_SESSIONS_AT_ONCE = positive_int('BOTCUBE_ACTIVITY_SESSIONS_AT_ONCE', 10)


async def sessions_activity(sessions: object) -> list[dict[str, str]]:
    """Each Session's answered Turns, read ACTIVITY_SESSIONS_AT_ONCE at a time."""
    if not isinstance(sessions, list) or not all(isinstance(session, dict) for session in sessions):
        raise SessionApiError('sessions must list each Session as {sessionId, userId}')
    ids = [(_required(session, 'sessionId'), _required(session, 'userId')) for session in sessions]
    semaphore = asyncio.Semaphore(ACTIVITY_SESSIONS_AT_ONCE)

    async def read(session_id: str, user_id: str) -> list[dict[str, str]]:
        async with semaphore:
            try:
                return await session_activity(user_id, session_id)
            except Exception as exc:
                raise RuntimeError(f'Session {session_id} activity could not be read: {exc}') from exc

    reads = [asyncio.create_task(read(*session)) for session in ids]
    try:
        results = await asyncio.gather(*reads)
    finally:
        # Stop queued reads and acknowledge coroutine cancellation before the next operation.
        # Already running read-only boto3 calls cannot be interrupted; they share the bounded executor.
        for reading in reads:
            reading.cancel()
        await asyncio.gather(*reads, return_exceptions=True)
    return [
        {'sessionId': session_id, **task}
        for (session_id, _user_id), result in zip(ids, results, strict=True)
        for task in result
    ]


async def post_message(user_id: str, session_id: str, content: str, message_id: str | None = None) -> None:
    config = _config(user_id, session_id)
    graph = _graph()
    if await graph.checkpointer.aget_tuple(config) is None:
        # LangGraph drops the values of a Session's first update; this one starts the record.
        await graph.aupdate_state(config, {'messages': []}, as_node='model')  # pragma: no mutate: LangGraph drops this update's values, so any values or node name that it accepts starts the same record
    # As the model's answer: the Session's next Turn starts from a finished one. Its own ID,
    # as the web keys a Session's messages by ID.
    message = AIMessage(content, id=message_id or str(uuid.uuid4()))
    await graph.aupdate_state(config, {'messages': [message]}, as_node='model')
    with reading_once():
        snapshot = await state_snapshot(graph, config)
    if snapshot is None:
        raise RuntimeError(f'Session {session_id} has no messages after a post')
    await graph.checkpointer.awrite_messages_snapshot(user_id, session_id, snapshot)


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
        return {
            'messages': await get_session(
                _required(event, 'userId'), _required(event, 'sessionId'), _optional(event, 'contains')
            )
        }
    if operation == 'activity':
        return {'tasks': await sessions_activity(event.get('sessions'))}
    if operation == 'post':
        await post_message(
            _required(event, 'userId'),
            _required(event, 'sessionId'),
            _required(event, 'content'),
            _optional(event, 'messageId'),
        )
        return {}
    if operation in MEMORY_OPERATIONS:
        return _memory_operation(operation, event)
    if operation == 'purge':
        await _graph().checkpointer.adelete_session(
            _required(event, 'userId'), _required(event, 'sessionId')
        )
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
        # The checkpointer reads in the default executor, which sizes itself by the
        # environment's CPUs; an activity operation's reads need a thread each.
        _LOOP.set_default_executor(concurrent.futures.ThreadPoolExecutor(ACTIVITY_SESSIONS_AT_ONCE))
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
