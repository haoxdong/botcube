from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any

import pytest
from deepagents.backends import LocalShellBackend

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.prompt_cache_observability import (
    PromptCacheUsageMiddleware,
    prompt_cache_turn,
)
from prompt_cache_fake import DelegatingBedrockClient, fake_bedrock_model


def _graph(tmp_path: Path, client: DelegatingBedrockClient, model_id: str = 'us.anthropic.claude-sonnet-4-6') -> Any:
    return build_agent(
        model=fake_bedrock_model(client, model_id),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], memory=[],
        subagents=[] if client.helper == 'general-purpose' else [
            {'name': client.helper, 'description': 'Checks the result.', 'system_prompt': 'Check.'},
        ],
        middleware=[PromptCacheUsageMiddleware(thread_id=client.helper, model=model_id, effort='medium')],
    )


def _counters(caplog: pytest.LogCaptureFixture) -> list[list[int]]:
    payloads = [json.loads(record.message) for record in caplog.records
                if record.name == 'botcube_harness_deepagents.prompt_cache']
    return [[payload[key] for key in ('input_tokens', 'output_tokens', 'total_tokens',
                                     'cache_read_input_tokens', 'cache_creation_input_tokens')]
            for payload in payloads]


@pytest.mark.parametrize('helper', ['general-purpose', 'helper'])
@pytest.mark.parametrize('model_id', ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-opus-4-6-v1'])
def test_graph_turn_includes_helper_usage(tmp_path: Path, caplog: pytest.LogCaptureFixture, helper: str, model_id: str) -> None:
    client = DelegatingBedrockClient(helper=helper)
    graph = _graph(tmp_path, client, model_id)
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn():
        result = graph.invoke({'messages': 'Check the result.'})
    assert result['messages'][-1].text == 'The helper checked the result.'
    assert _counters(caplog) == [[300, 30, 330, 120, 60]]
    assert len(client.requests) == 3
    for request in client.requests:
        assert sum('cachePoint' in block for block in request['system']) == 1
        assert sum('cachePoint' in block for block in request['toolConfig']['tools']) == 1
        assert sum('cachePoint' in block for message in request['messages'] for block in message['content']) == (2 if len(request['messages']) >= 2 else 1)


def test_successive_graph_turns_do_not_reuse_usage(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    client = DelegatingBedrockClient()
    graph = _graph(tmp_path, client)
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'):
        for multiplier in (1, 2):
            client.multiplier = multiplier
            with prompt_cache_turn():
                assert graph.invoke({'messages': 'Check the result.'})['messages'][-1].text == 'The helper checked the result.'
    assert _counters(caplog) == [[300, 30, 330, 120, 60], [600, 60, 660, 240, 120]]


def test_concurrent_graph_turns_keep_helper_usage_separate(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    graphs = [_graph(tmp_path, DelegatingBedrockClient(helper=helper, multiplier=multiplier))
              for helper, multiplier in [('general-purpose', 1), ('helper', 2)]]

    async def run(graph: Any) -> None:
        with prompt_cache_turn():
            result = await graph.ainvoke({'messages': 'Check the result.'})
            assert result['messages'][-1].text == 'The helper checked the result.'

    async def both() -> None:
        await asyncio.gather(*(run(graph) for graph in graphs))

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'):
        asyncio.run(both())
    assert sorted(_counters(caplog)) == [[300, 30, 330, 120, 60], [600, 60, 660, 240, 120]]


def test_failed_turn_restores_the_enclosing_turn(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    graph = _graph(tmp_path, DelegatingBedrockClient())
    failing_client = DelegatingBedrockClient()
    failing_client.fail_at = 2
    failing_client.failure = RuntimeError('failed Turn')
    failing_graph = _graph(tmp_path, failing_client)
    middleware = PromptCacheUsageMiddleware(thread_id='outer', model='fake', effort='medium')
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'), prompt_cache_turn('outer-session'):
        state = graph.invoke({'messages': 'Check the result.'})
        with pytest.raises(RuntimeError, match='failed Turn'), prompt_cache_turn('inner-session'):
            failing_graph.invoke({'messages': 'Check the result.'})
        middleware.after_agent(state, None)
    assert _counters(caplog) == [[300, 30, 330, 120, 60]] * 2
    assert json.loads(caplog.records[-1].message)['agentcore_session_id'] == 'outer-session'


def test_cancelled_graph_task_restores_the_enclosing_turn(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    started = threading.Event()
    release = threading.Event()

    class BlockingClient(DelegatingBedrockClient):
        def converse(self, **kwargs: Any) -> dict[str, Any]:
            started.set()
            assert release.wait(timeout=5)
            return super().converse(**kwargs)

    graph = _graph(tmp_path, DelegatingBedrockClient())
    blocked = _graph(tmp_path, BlockingClient())
    middleware = PromptCacheUsageMiddleware(thread_id='outer', model='fake', effort='medium')

    async def cancelled() -> None:
        with prompt_cache_turn('cancelled-session'):
            await blocked.ainvoke({'messages': 'Check the result.'})

    async def run() -> None:
        with prompt_cache_turn('outer-session'):
            state = await graph.ainvoke({'messages': 'Check the result.'})
            task = asyncio.create_task(cancelled())
            try:
                assert await asyncio.to_thread(started.wait, 5)
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
            middleware.after_agent(state, None)

    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.prompt_cache'):
        asyncio.run(run())
    assert _counters(caplog) == [[300, 30, 330, 120, 60]] * 2
    assert json.loads(caplog.records[-1].message)['agentcore_session_id'] == 'outer-session'
