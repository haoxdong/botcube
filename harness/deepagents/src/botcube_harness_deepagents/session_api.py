"""The private Session API over Lambda Invoke or local HTTP (ADR 0067 §5)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from itertools import dropwhile, islice
from pathlib import Path
from time import perf_counter
from typing import Any

import boto3
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver, CheckpointTuple

from .agent import build_agent
from .conversation import SCHEDULED_RUN, conversation
from .llm import EchoChatModel
from .memory import agentcore as agentcore_memory_backend
from .memory import local as local_memory_backend
from .memory.agentcore.forget import forget_extracted_memory
from .memory.agentcore.purge import purge_session
from .memory_tools import AGENTCORE_MEMORY_ID, AWS_REGION
from .session_format import SessionFormatLegacyError, latest_checkpoint

log = logging.getLogger(__name__)
# Lambda's root logger defaults to WARNING; operation timings must also reach CloudWatch there.
log.setLevel(logging.INFO)


CONTRACT = json.loads(Path(__file__).with_name('session-api.json').read_text(encoding='utf-8'))
OPERATIONS = CONTRACT['operations']
ERRORS = CONTRACT['errors']


class SessionApiError(Exception):
    def __init__(self, detail: str, code: str = 'INVALID_REQUEST', *, details: str | None = None) -> None:
        super().__init__(detail)
        self.code = code
        self.details = details
        self.status_code = ERRORS[code]['status']


_GRAPH: Any | None = None


def _build_checkpointer() -> Any:
    if AGENTCORE_MEMORY_ID:
        return agentcore_memory_backend.build_checkpointer(
            AGENTCORE_MEMORY_ID, region_name=AWS_REGION
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
            checkpointer=_build_checkpointer(),
        )
    return _GRAPH


def _arguments(event: Mapping[str, Any], spec: Mapping[str, Any]) -> dict[str, Any]:
    arguments = {}
    for key, shape in spec['required'].items():
        arguments[key] = _argument(key, event.get(key), shape)
    for key, shape in spec['optional'].items():
        value = event.get(key)
        if value is not None:
            arguments[key] = _argument(key, value, shape)
    return arguments


def _argument(key: str, value: Any, shape: Any) -> Any:
    if isinstance(shape, dict):
        if not isinstance(value, dict):
            raise SessionApiError(f'{key} must be an object')
    elif not isinstance(value, str) or not value.strip():
        raise SessionApiError(f'{key} is required')
    return value


@contextmanager
def _phase(phases: dict[str, float], name: str) -> Generator[None, None, None]:
    start = perf_counter()
    try:
        yield
    finally:
        phases[name] = (perf_counter() - start) * 1000


async def _session_messages(user_id: str, session_id: str, phases: dict[str, float]) -> list[BaseMessage]:
    with _phase(phases, 'graph'):
        graph = _graph()
        reader = graph.copy(update={'checkpointer': _SessionRead(graph, phases)})
        config = _config(user_id, session_id)
    try:
        with _phase(phases, 'state'):
            messages = (await reader.aget_state(config)).values.get('messages')
    finally:
        # The official state read includes its checkpoint read; keep the phase durations disjoint.
        phases['state'] -= phases.get('checkpoint', 0)
    if not messages:
        raise SessionApiError(f'Session {session_id} has no record', 'SESSION_NOT_FOUND')
    return messages


REPLAY_PAGE_MESSAGES = 80
INLINE_MESSAGE_BYTES = 64_000  # 80 × 64 KB leaves room for the Lambda response envelope.


def _replay_message(message: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(message)) <= INLINE_MESSAGE_BYTES:
        return message
    placeholder = 'Large message content is stored in the Session record.'
    compact = {**message, 'content': placeholder}
    if card := (message.get('metadata') or {}).get('scheduledRun'):
        compact['metadata'] = {**message['metadata'], 'scheduledRun': {**card, 'text': placeholder}}
    if len(json.dumps(compact)) <= INLINE_MESSAGE_BYTES:
        return compact
    return {key: compact[key] for key in ('id', 'role', 'toolCallId', 'content') if key in compact}


async def _read_replay(
    user_id: str, session_id: str, before: str | None, phases: dict[str, float]
) -> dict[str, Any]:
    messages = await _session_messages(user_id, session_id, phases)
    with _phase(phases, 'conversation'):
        replay = (row for message in reversed(messages) for row in reversed(conversation([message])))
        if before is not None:
            replay = dropwhile(lambda row: row['id'] != before, replay)
            if next(replay, None) is None:
                raise SessionApiError('The replay changed. Reopen the chat to read its history.', 'STALE_REPLAY_CURSOR')
        page = [_replay_message(row) for row in islice(replay, REPLAY_PAGE_MESSAGES)]
        cursor = {'nextBefore': page[-1]['id']} if next(replay, None) is not None else {}
        return {'messages': page[::-1], **cursor}


class _SessionRead(BaseCheckpointSaver[str]):
    """Validate the checkpoint inside LangGraph's state read, before it can walk legacy ancestors."""

    def __init__(self, graph: Any, phases: dict[str, float]) -> None:
        super().__init__(serde=graph.checkpointer.serde)
        self.graph = graph
        self.phases = phases

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        with _phase(self.phases, 'checkpoint'):
            return await latest_checkpoint(self.graph, config)


def _config(user_id: str, session_id: str) -> RunnableConfig:
    return {'configurable': {'thread_id': session_id, 'actor_id': user_id}}


async def post_message(
    user_id: str, session_id: str, content: str, message_id: str | None = None, scheduled_run: dict[str, Any] | None = None
) -> None:
    config = _config(user_id, session_id)
    graph = _graph()
    saved = await latest_checkpoint(graph, config)
    if saved is not None and message_id and any(
        message.id == message_id for message in saved.checkpoint['channel_values'].get('messages', ())
    ):
        return
    if saved is None:
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


async def purge(user_id: str, session_id: str) -> None:
    checkpointer = _graph().checkpointer
    if AGENTCORE_MEMORY_ID:
        await asyncio.to_thread(purge_session, checkpointer, user_id, session_id)
    else:
        await checkpointer.adelete_session(user_id, session_id)


async def _forget(args: dict[str, Any], _phases: dict[str, float]) -> dict[str, Any]:
    if AGENTCORE_MEMORY_ID:
        client = boto3.client('bedrock-agentcore', region_name=AWS_REGION)
        await asyncio.to_thread(forget_extracted_memory, client, memory_id=AGENTCORE_MEMORY_ID, actor_id=args['userId'])
    return {}


async def _replay(args: dict[str, Any], phases: dict[str, float]) -> dict[str, Any]:
    return await _read_replay(args['userId'], args['sessionId'], args.get('before'), phases)


async def _post(args: dict[str, Any], _phases: dict[str, float]) -> dict[str, Any]:
    await post_message(args['userId'], args['sessionId'], args['content'], args.get('messageId'), args.get('scheduledRun'))
    return {}


async def _purge(args: dict[str, Any], _phases: dict[str, float]) -> dict[str, Any]:
    await purge(args['userId'], args['sessionId'])
    return {}


HANDLERS = {
    'get': _replay,
    'post': _post,
    'purge': _purge,
    'forget': _forget,
}


async def handle(event: Mapping[str, Any]) -> dict[str, Any]:
    start = perf_counter()
    phases: dict[str, float] = {}
    operation = event.get('operation')
    spec = OPERATIONS.get(operation) if isinstance(operation, str) else None
    record: dict[str, Any] = {
        'event': 'session_api_timing',
        'operation': operation if spec is not None else 'invalid',
        'statusCode': 500,
        'errorCode': 'INTERNAL_ERROR',
        'phasesMs': phases,
    }
    if isinstance(event.get('sessionId'), str):
        record['sessionId'] = event['sessionId']
    try:
        if not isinstance(operation, str) or spec is None:
            raise SessionApiError(f'Unknown session API operation: {operation!r}')
        result = await _dispatch(operation, spec, _arguments(event, spec), phases)
        record['responseBytes'] = len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode())
        record['statusCode'] = 200
        del record['errorCode']
        if operation == 'get':
            record['messageCount'] = len(result['messages'])
        return result
    except SessionApiError as exc:
        if exc.code != 'INVALID_REQUEST' and (spec is None or exc.code not in spec['errors']):
            raise RuntimeError(f'{operation!r} returned undeclared Session API error {exc.code}') from exc
        record.update(statusCode=exc.status_code, errorCode=exc.code, responseBytes=len(
            json.dumps(_err(exc)['body'], ensure_ascii=False, separators=(',', ':')).encode()
        ))
        raise
    finally:
        record['durationMs'] = (perf_counter() - start) * 1000
        log.info(json.dumps(record, separators=(',', ':')))


async def _dispatch(
    operation: str, spec: Mapping[str, Any], args: dict[str, Any], phases: dict[str, float]
) -> dict[str, Any]:
    seconds = CONTRACT['deadlines'][spec['deadline']]
    deadline = asyncio.timeout(seconds)
    try:
        async with deadline:
            return await HANDLERS[operation](args, phases)
    except TimeoutError as exc:
        if not deadline.expired() or 'SESSION_READ_TIMEOUT' not in spec['errors']:
            raise
        target = f"Session {args['sessionId']}" if 'sessionId' in args else 'Memory'
        raise SessionApiError(
            f'The session API gave up reading {target} after {seconds:g} s', 'SESSION_READ_TIMEOUT'
        ) from exc
    except SessionFormatLegacyError as exc:
        raise SessionApiError(str(exc), 'SESSION_FORMAT_LEGACY') from exc


# One loop for the life of the function's execution environment, made on its
# first invocation: the cached graph's checkpointer outlives each invocation.
_LOOP: asyncio.AbstractEventLoop | None = None


def _err(exc: SessionApiError) -> dict[str, Any]:
    body = {'error': str(exc), 'code': exc.code}
    if exc.details is not None:
        body['details'] = exc.details
    return {'statusCode': exc.status_code, 'body': body}


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
        raise SessionApiError('Invalid JSON', details=str(exc)) from exc
    if not isinstance(event, dict):
        raise SessionApiError('Expected a JSON object')
    return JSONResponse(await handle(event))


@app.exception_handler(SessionApiError)
async def session_api_error(_request: Request, exc: SessionApiError) -> JSONResponse:
    return JSONResponse(_err(exc)['body'], status_code=exc.status_code)


@app.get('/ping')
def ping() -> JSONResponse:
    return JSONResponse({'status': 'Healthy'})


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format='%(name)s %(message)s')
    uvicorn.run(app, host='0.0.0.0', port=int(os.getenv('PORT', '8081')))


if __name__ == '__main__':
    main()
