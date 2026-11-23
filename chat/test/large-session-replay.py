import asyncio
import json
import os

import uvicorn
from fastapi import Request
from fastapi.responses import Response
from langchain_core.messages import HumanMessage, ToolMessage

from botcube_harness_deepagents import session_api
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.llm import EchoChatModel
from botcube_harness_deepagents.memory.local import build_checkpointer

app = session_api.app
graph = build_agent(model=EchoChatModel(), backend=None, skills=[],
                    checkpointer=build_checkpointer(os.environ['BOTCUBE_CHECKPOINT_PATH']))


@app.post('/2015-03-31/functions/session-replay/invocations')
async def invoke(request: Request) -> Response:
    event = await request.json()
    if 'before' not in event:
        config = {'configurable': {'actor_id': event['userId'], 'thread_id': event['sessionId']}}
        await graph.aupdate_state(config, {'messages': []}, as_node='model')
        await graph.aupdate_state(config, {'messages': [
            *(HumanMessage("x" * 60_000, id=f'm{i}') for i in range(100)),
            ToolMessage('x' * 6_100_000, id='result', tool_call_id='call'),
        ]}, as_node='model')
    result = await asyncio.to_thread(session_api.lambda_handler, event, None)
    body = json.dumps(result).encode()
    return Response(body) if len(body) <= 6_000_000 else Response('Lambda response exceeds 6 MB', 413)


uvicorn.run(app, host='0.0.0.0', port=int(os.environ['PORT']))
