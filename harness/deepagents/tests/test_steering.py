import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from botcube_harness_deepagents.invocation import Invocation
from botcube_harness_deepagents.steering import (
    PendingSteering,
    SteeringMiddleware,
    active_steering,
)
from test_session_resume import (
    _FakeAgentCoreMemory,
    _serve_session,
    _stop,
    _ToolCallingModel,
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

    from botcube_harness_deepagents.files_mount import FilesMount
    from botcube_harness_deepagents.lazy_files import current_turn_files, turn_files
    from mounted_files import MountedFiles, binding

    async def run(mount: FilesMount, mounted: MountedFiles) -> None:
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
            with turn_files(mount, tmp_path, ()):
                work = asyncio.create_task(graph.ainvoke({'messages': [HumanMessage('start work')]}))
                await asyncio.wait_for(entered.wait(), 5)
                mounted.write('report.csv', b'date,close\n2026-10-31,42')
                pending.add('attached', 'Read this\n\nAttached files:\n- /report.csv')
                if refresh_fails:
                    def fail_pull(*args: Any, **kwargs: Any) -> None:
                        raise RuntimeError('Files refresh failed')
                    monkeypatch.setattr(FilesMount, 'pull', fail_pull)
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

    mounted = MountedFiles(tmp_path)
    mounted.write('notes.txt', b'old notes')
    monkeypatch.setattr(FilesMount, 'pull', lambda mount, root, excluded=(): mounted.mount(mount, root, excluded))
    asyncio.run(run(FilesMount.from_binding(binding()), mounted))


async def _steer_during_tool(steer: Any, after_tool: Any = None) -> tuple[SteeringModel, list[Any], PendingSteering]:
    entered, release = asyncio.Event(), asyncio.Event()

    @tool
    async def slow_tool() -> str:
        """Read the tool result."""
        entered.set()
        await release.wait()
        return 'tool work kept'

    model = SteeringModel(responses=[
        AIMessage('', tool_calls=[{'name': 'slow_tool', 'args': {}, 'id': 'call'}]),
        AIMessage('answer'),
    ])
    graph = create_agent(model, tools=[slow_tool], middleware=[SteeringMiddleware()])
    pending = PendingSteering()
    events: list[Any] = []
    token = active_steering.set((pending, events.append))
    try:
        work = asyncio.create_task(graph.ainvoke({'messages': [HumanMessage('start')]}))
        await asyncio.wait_for(entered.wait(), 5)
        steer(pending)
        release.set()
        if after_tool is not None:
            await after_tool(pending)
        await asyncio.wait_for(work, 5)
    finally:
        active_steering.reset(token)
    return model, events, pending


def _withdraw_after_add(pending: PendingSteering) -> None:
    pending.add('steer-1', 'Use the other date')
    assert pending.withdraw('steer-1') is True


def _add_after_withdraw(pending: PendingSteering) -> None:
    assert pending.withdraw('steer-1') is True
    pending.add('steer-1', 'Use the other date')


@pytest.mark.parametrize('steer', [_withdraw_after_add, _add_after_withdraw])
def test_withdrawn_steering_never_reaches_the_model(steer: Any) -> None:
    model, events, _ = asyncio.run(_steer_during_tool(steer))

    assert len(model.inputs) == 2
    assert [(type(message), message.content) for message in model.inputs[1][-1:]] == [(ToolMessage, 'tool work kept')]
    assert events == []


def test_withdraw_during_the_files_refresh_wins_over_the_model_step(monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import steering

    refreshing, resume = asyncio.Event(), asyncio.Event()

    class HeldFiles:
        async def arefresh(self) -> None:
            refreshing.set()
            await resume.wait()

    monkeypatch.setattr(steering, 'current_turn_files', HeldFiles)

    async def withdraw_while_refreshing(pending: PendingSteering) -> None:
        await asyncio.wait_for(refreshing.wait(), 5)
        assert pending.withdraw('steer-1') is True
        resume.set()

    model, events, _ = asyncio.run(_steer_during_tool(
        lambda pending: pending.add('steer-1', 'Use the other date'), withdraw_while_refreshing,
    ))

    assert len(model.inputs) == 2
    assert [(type(message), message.content) for message in model.inputs[1][-1:]] == [(ToolMessage, 'tool work kept')]
    assert events == []


def test_steering_taken_by_a_model_step_cannot_be_withdrawn() -> None:
    model, events, pending = asyncio.run(_steer_during_tool(lambda pending: pending.add('steer-1', 'Use the other date')))

    assert pending.withdraw('steer-1') is False
    assert [(type(message), message.content) for message in model.inputs[1][-2:]] == [
        (ToolMessage, 'tool work kept'), (HumanMessage, 'Use the other date'),
    ]
    assert [event.type for event in events] == ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']
    pending.add('steer-1', 'Use the other date')
    assert pending.messages == {}


def test_taking_steering_logs_how_long_each_message_waited(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = iter([10.0, 12.5])
    monkeypatch.setattr('botcube_harness_deepagents.steering.monotonic', lambda: next(clock))
    pending = PendingSteering()
    pending.add('m1', 'Use the close')
    with caplog.at_level('INFO', logger='botcube_harness_deepagents.steering'):
        pending.take(lambda _event: None)
    records = [json.loads(record.message) for record in caplog.records]
    assert records == [{'event': 'harness_steering_wait', 'messageId': 'm1', 'waitMs': 2500}]


def test_steering_resent_after_stop_reaches_the_model_once() -> None:
    from langgraph.checkpoint.memory import InMemorySaver

    async def run() -> tuple[list[list[BaseMessage]], PendingSteering]:
        entered, release, thinking = asyncio.Event(), asyncio.Event(), asyncio.Event()

        @tool
        async def slow_tool() -> str:
            """Read the tool result."""
            entered.set()
            await release.wait()
            return 'tool work kept'

        class StoppedModel(SteeringModel):
            async def _agenerate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> Any:
                if len(self.inputs) == 1:
                    self.inputs.append(messages)
                    thinking.set()
                    await asyncio.Event().wait()
                return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)

        model = StoppedModel(inputs=[], responses=[
            AIMessage('', tool_calls=[{'name': 'slow_tool', 'args': {}, 'id': 'call'}]),
            AIMessage('answer to send now'),
        ])
        graph = create_agent(model, tools=[slow_tool], middleware=[SteeringMiddleware()], checkpointer=InMemorySaver())
        config: RunnableConfig = {'configurable': {'thread_id': 'thread'}}
        stopped = PendingSteering()
        token = active_steering.set((stopped, lambda _event: None))
        try:
            work = asyncio.create_task(graph.ainvoke({'messages': [HumanMessage('start', id='start')]}, config))
            await asyncio.wait_for(entered.wait(), 5)
            stopped.add('steer-x', 'Use the other date')
            release.set()
            await asyncio.wait_for(thinking.wait(), 5)
            work.cancel()
            with pytest.raises(asyncio.CancelledError):
                await work
        finally:
            active_steering.reset(token)
        resent = PendingSteering()
        resent.add('steer-x', 'Use the other date')
        token = active_steering.set((resent, lambda _event: None))
        try:
            await asyncio.wait_for(graph.ainvoke({'messages': [HumanMessage('Send now', id='send-now')]}, config), 5)
        finally:
            active_steering.reset(token)
        return model.inputs, resent

    inputs, resent = asyncio.run(run())

    assert resent.consumed == {'steer-x'}

    assert inputs[1][-1].id == 'steer-x'
    assert [message.id for message in inputs[-1] if isinstance(message, HumanMessage)] == ['start', 'steer-x', 'send-now']



_STEER_ID = 'steer-x'
_STEERING_TEXT = 'Use the other date'


class _StoppedWhileStreamingModel(_ToolCallingModel):
    """Streams text on the step that takes the steering, then holds until Stop; holds any other step given a hold."""

    inputs: Any = None
    holds: Any = None

    async def _astream(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Any:
        self.inputs.append(messages)
        hold = self.holds.pop(0) if self.holds else None
        if messages[-1].id == _STEER_ID and len(self.inputs) == 2:
            yield ChatGenerationChunk(message=AIMessageChunk(content='Duration measures '))
            yield ChatGenerationChunk(message=AIMessageChunk(content='rate risk.'))
        if hold is not None:
            hold[0].set()
            await hold[1].wait()
        for chunk in self._stream(messages, *args, **kwargs):
            yield chunk


async def _steer(run_id: str) -> list[Any]:
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving

    control = RunAgentInput.model_validate({
        'thread_id': 'session-1', 'run_id': run_id, 'messages': [{'id': _STEER_ID, 'role': 'user', 'content': _STEERING_TEXT}],
        'tools': [], 'context': [], 'state': {}, 'forwarded_props': {'steering': True, 'sessionUserId': 'user-1'},
    })
    return [event async for event in serving.invoke(Invocation.parse(control), serving._RequestContext('agentcore-session-1'))]


async def _steer_while_held(hold: tuple[asyncio.Event, asyncio.Event], run_id: str) -> None:
    await asyncio.wait_for(hold[0].wait(), 5)
    assert [event.value for event in await _steer(run_id)] == [{'accepted': True}]
    hold[1].set()


async def _stop_mid_text_then_resteer(session: Any, model: _StoppedWhileStreamingModel) -> None:
    first_step, text_streamed, resent_step = [(asyncio.Event(), asyncio.Event()) for _ in range(3)]
    model.holds.extend([first_step, text_streamed])
    running = asyncio.create_task(session.events([{'id': 'user-message-1', 'role': 'user', 'content': 'Explain duration'}]))
    await _steer_while_held(first_step, 'steer-1')
    await asyncio.wait_for(text_streamed[0].wait(), 5)
    assert model.inputs[1][-1].id == _STEER_ID
    await _stop('run-1')
    events = await running
    assert (events[-1].type, events[-1].code) == ('RUN_ERROR', 'TURN_STOPPED')

    replayed = await session.replay()
    assert [message['id'] for message in replayed if message['role'] == 'user'] == ['user-message-1', _STEER_ID]
    resent = [{key: value for key, value in message.items() if key != 'metadata'} for message in replayed]
    model.holds.append(resent_step)
    again = asyncio.create_task(session.events([*resent, {'id': 'user-message-2', 'role': 'user', 'content': 'Again'}]))
    await _steer_while_held(resent_step, 'steer-2')
    assert (await again)[-1].type == 'RUN_FINISHED'


def _assert_steering_once_in_place(stopped: list[BaseMessage], step: list[BaseMessage]) -> None:
    assert [message.id for message in step if message.id == _STEER_ID] == [_STEER_ID]
    assert [message.content for message in step if message.content == _STEERING_TEXT] == [_STEERING_TEXT]
    assert [(type(message), message.content) for message in step[:len(stopped)]] == [(type(message), message.content) for message in stopped]
    assert [message.text for message in step if isinstance(message, AIMessage) and message.text] == ['Duration measures rate risk.']
    ids = [message.id for message in step if message.id]
    assert len(ids) == len(set(ids))


def test_steering_resent_after_stop_mid_text_reaches_the_model_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import serving

    session = _serve_session(tmp_path, monkeypatch, _FakeAgentCoreMemory())
    model = _StoppedWhileStreamingModel(inputs=[], holds=[])
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)

    asyncio.run(asyncio.wait_for(_stop_mid_text_then_resteer(session, model), 10))

    assert len(model.inputs) > 2
    for step in model.inputs[2:]:
        _assert_steering_once_in_place(model.inputs[1], step)
