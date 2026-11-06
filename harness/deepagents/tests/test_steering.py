import asyncio
from pathlib import Path
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from botcube_harness_deepagents.steering import (
    PendingSteering,
    SteeringMiddleware,
    active_steering,
)


class SteeringModel(FakeMessagesListChatModel):
    inputs: list[list[BaseMessage]] = []

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self

    async def _agenerate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> Any:
        self.inputs.append(messages)
        return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)


def test_steering_reaches_next_model_after_inflight_tool_result() -> None:
    async def run() -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        @tool
        async def slow_tool() -> str:
            """Read the tool result."""
            entered.set()
            await release.wait()
            return 'tool work kept'

        model = SteeringModel(responses=[
            AIMessage('', tool_calls=[{'name': 'slow_tool', 'args': {}, 'id': 'call'}]),
            AIMessage('steered answer'),
        ])
        graph = create_agent(model, tools=[slow_tool], middleware=[SteeringMiddleware()])
        pending = PendingSteering()
        events: list[Any] = []
        token = active_steering.set((pending, events.append))
        try:
            work = asyncio.create_task(graph.ainvoke({'messages': [HumanMessage('start')]}))
            await asyncio.wait_for(entered.wait(), 5)
            pending.add('steer-1', 'Use the other date')
            release.set()
            result = await asyncio.wait_for(work, 5)
        finally:
            active_steering.reset(token)
        assert len(model.inputs) == 2
        assert [(type(message), message.content) for message in model.inputs[1][-2:]] == [
            (ToolMessage, 'tool work kept'), (HumanMessage, 'Use the other date'),
        ]
        assert result['messages'][-2].id == 'steer-1'
        assert [(event.type, getattr(event, 'role', None)) for event in events] == [
            ('TEXT_MESSAGE_START', 'user'), ('TEXT_MESSAGE_CONTENT', None), ('TEXT_MESSAGE_END', None),
        ]
    asyncio.run(run())


@pytest.mark.parametrize('refresh_fails', [False, True])
def test_mid_turn_attachment_is_readable_without_losing_workspace_edits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, refresh_fails: bool,
) -> None:
    import boto3
    from moto import mock_aws

    from botcube_harness_deepagents.files_sync import FilesSync
    from botcube_harness_deepagents.lazy_files import current_turn_files, turn_files

    async def run(files: FilesSync, s3: Any) -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        @tool
        async def working_tool() -> str:
            """Finish the work already running."""
            readiness = current_turn_files()
            assert readiness is not None
            await readiness.aensure()
            (tmp_path / 'notes.txt').write_text('local work kept')
            entered.set()
            await release.wait()
            return 'first tool result kept'

        @tool
        def read_attachment() -> str:
            """Read the file the user attached while the first tool ran."""
            return (tmp_path / 'report.csv').read_text()

        model = SteeringModel(responses=[
            AIMessage('', tool_calls=[{'name': 'working_tool', 'args': {}, 'id': 'first'}]),
            AIMessage('', tool_calls=[{'name': 'read_attachment', 'args': {}, 'id': 'read'}]),
            AIMessage('read the new attachment'),
        ])
        graph = create_agent(model, tools=[working_tool, read_attachment], middleware=[SteeringMiddleware()])
        pending = PendingSteering()

        def published(event: Any) -> None:
            assert (tmp_path / 'report.csv').read_text() == 'date,close\n2026-10-31,42'
            assert (tmp_path / 'notes.txt').read_text() == 'local work kept'

        token = active_steering.set((pending, published))
        try:
            with turn_files(files, tmp_path, ()):
                work = asyncio.create_task(graph.ainvoke({'messages': [HumanMessage('start work')]}))
                await asyncio.wait_for(entered.wait(), 5)
                s3.put_object(Bucket='steering-files', Key='owner/report.csv', Body=b'date,close\n2026-10-31,42')
                pending.add('attached', 'Read this\n\nAttached files:\n- /report.csv')
                if refresh_fails:
                    def fail_pull(*args: Any, **kwargs: Any) -> None:
                        raise RuntimeError('Files refresh failed')
                    monkeypatch.setattr(FilesSync, 'pull', fail_pull)
                release.set()
                if refresh_fails:
                    with pytest.raises(RuntimeError, match='Files refresh failed'):
                        await asyncio.wait_for(work, 5)
                    assert list(pending.messages) == ['attached']
                    assert (tmp_path / 'notes.txt').read_text() == 'local work kept'
                    return
                await asyncio.wait_for(work, 5)
        finally:
            active_steering.reset(token)
        assert model.inputs[1][-2].content == 'first tool result kept'
        assert model.inputs[1][-1].id == 'attached'
        assert model.inputs[2][-1].content == 'date,close\n2026-10-31,42'

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='steering-files')
        s3.put_object(Bucket='steering-files', Key='owner/notes.txt', Body=b'old notes')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        asyncio.run(run(FilesSync('steering-files', 'owner/', 'us-east-1', {}), s3))
