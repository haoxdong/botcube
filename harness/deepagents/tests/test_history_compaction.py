from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
from langchain_core.exceptions import ModelInvalidRequestError
from langchain_core.language_models import ModelProfile
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.messages.utils import count_tokens_approximately
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import Field

from botcube_harness_deepagents import turn_lifecycle
from botcube_harness_deepagents.agent import build_agent
from conftest import ToolBindableFakeMessagesModel

_SUMMARY = 'The earlier request concerned copper futures. Preserve the recent questions.'


class CompactionModel(ToolBindableFakeMessagesModel):
    profile: ModelProfile | None = {'max_input_tokens': 60_000}
    calls: list[list[BaseMessage]] = Field(default_factory=list)
    summary_calls: int = 0
    fail_summary: bool = False

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None, **kwargs: Any,
    ) -> ChatResult:
        if run_manager is not None and run_manager.metadata.get('lc_source') == 'summarization':
            self.summary_calls += 1
            if self.fail_summary:
                raise ModelInvalidRequestError('Summary model unavailable')
            answer = _SUMMARY
        else:
            self.calls.append(messages)
            answer = 'OK'
        return ChatResult(generations=[ChatGeneration(message=AIMessage(answer))])


class StreamingCompactionModel(CompactionModel):
    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        if len(messages) == 1 and '\n<messages>\n' in messages[0].text:
            self.summary_calls += 1
            yield ChatGenerationChunk(message=AIMessageChunk(content=_SUMMARY))
            return
        self.calls.append(messages)
        yield ChatGenerationChunk(message=AIMessageChunk(content='OK'))


def _history() -> list[BaseMessage]:
    return [message for index in range(20) for message in (
        HumanMessage('Earlier copper question. ' * 600, id=f'q-{index}'),
        AIMessage('Earlier copper answer. ' * 600, id=f'a-{index}'),
    )]


class DelegatingCompactionModel(CompactionModel):
    delegate: bool = False
    child_calls: int = 0

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None, **kwargs: Any,
    ) -> ChatResult:
        metadata = run_manager.metadata if run_manager is not None else {}
        if '|' in metadata.get('langgraph_checkpoint_ns', ''):
            self.child_calls += 1
        if self.delegate and metadata.get('lc_source') != 'summarization':
            self.delegate = False
            return ChatResult(generations=[ChatGeneration(message=AIMessage('', tool_calls=[{
                'name': 'task', 'args': {'subagent_type': 'general-purpose', 'description': 'Reply OK'}, 'id': 'delegate-call',
            }]))])
        return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)


def test_subagent_does_not_consume_the_parent_summary(tmp_path: Path) -> None:
    async def exercise() -> None:
        model = DelegatingCompactionModel(responses=[])
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'parent-summary'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        model.delegate = True
        result = await graph.ainvoke({'messages': [HumanMessage('Use a helper, then reply OK.')]}, config)
        assert result['messages'][-1].content == 'OK'
        assert model.child_calls > 0
        result = await graph.ainvoke({'messages': [HumanMessage('Reply OK once more.')]}, config)
        assert result['messages'][-1].content == 'OK'
        assert count_tokens_approximately(model.calls[-1]) < 30000
        assert model.summary_calls == 1
        assert result['messages'][0].content == _history()[0].content

    asyncio.run(exercise())


def test_native_budget_recovery_keeps_full_tool_output_in_files(tmp_path: Path) -> None:
    async def exercise() -> None:
        model = CompactionModel(
            responses=[], profile={'max_input_tokens': 30000},
        )
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'oversized-result'}}
        original = 'oversized result ' * 12000
        messages = [HumanMessage('Inspect the result.'), AIMessage('', tool_calls=[
            {'name': 'check_result', 'args': {}, 'id': 'large-result'},
        ]), ToolMessage(original, tool_call_id='large-result', id='raw-result')]
        result = await graph.ainvoke({'messages': messages}, config)
        assert count_tokens_approximately(model.calls[-1]) < 30000
        [archive] = tmp_path.rglob('large-result')
        assert archive.read_text() == original
        tool_result = (await graph.aget_state(config)).values['messages'][2]
        assert tool_result == result['messages'][2]
        assert f'/{archive.relative_to(tmp_path)}' in tool_result.text

    asyncio.run(exercise())


def test_repeated_compaction_keeps_earlier_archives_reachable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import agent as agent_module
    monkeypatch.setattr(agent_module, 'compute_summarization_defaults', lambda _model: {
        'trigger': ('messages', 4), 'keep': ('messages', 2),
    })

    async def exercise() -> None:
        model = CompactionModel(responses=[])
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'repeated-archives'}}
        early_fact = 'Original delivery reference: AMBER-ARCHIVE-73.'
        history = [HumanMessage(early_fact), AIMessage('Recorded.'), HumanMessage('Next question.'), AIMessage('Answered.')]
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        await graph.ainvoke({'messages': [HumanMessage('Continue.')]}, config)
        first_path = (await graph.aget_state(config)).values['_summarization_event']['file_path']
        result = await graph.ainvoke({'messages': [HumanMessage('Recover the original reference.')]}, config)
        latest_path = (await graph.aget_state(config)).values['_summarization_event']['file_path']
        assert latest_path == first_path
        assert early_fact in (tmp_path / latest_path.lstrip('/')).read_text()
        assert latest_path in model.calls[-1][1].text
        assert result['messages'][0].content == early_fact
        assert model.summary_calls == 2

    asyncio.run(exercise())


class RejectOversizedAnswer(CompactionModel):
    reject_above: int = 35000

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None, **kwargs: Any,
    ) -> ChatResult:
        from langchain_core.exceptions import ContextOverflowError

        summary = run_manager is not None and run_manager.metadata.get('lc_source') == 'summarization'
        if not summary and count_tokens_approximately(messages) > self.reject_above:
            raise ContextOverflowError('Provider context limit exceeded')
        return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)


@pytest.mark.parametrize('failure', ['budget', 'provider'])
def test_oversized_history_can_answer(tmp_path: Path, failure: str) -> None:
    async def exercise() -> None:
        profile: ModelProfile = {'max_input_tokens': 60000 if failure == 'budget' else 200000}
        model_class = CompactionModel if failure == 'budget' else RejectOversizedAnswer
        model = model_class(
            responses=[], profile=profile,
        )
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'oversized-resume'}}
        history = _history() if failure == 'budget' else _history()[:12]
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        result = await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        assert result['messages'][-1].content == 'OK'
        assert model.summary_calls == 1
        assert len(result['messages']) == len(history) + 2
        assert result['messages'][0].content == history[0].content
        event = (await graph.aget_state(config)).values['_summarization_event']
        assert (tmp_path / event['file_path'].lstrip('/')).is_file()
        following = await graph.ainvoke({'messages': [HumanMessage('Continue normally.')]}, config)
        assert following['messages'][-1].content == 'OK'
        assert len(following['messages']) == len(history) + 4
        assert model.summary_calls == 1

    asyncio.run(exercise())


@pytest.mark.parametrize('asynchronous', [False, True], ids=['sync', 'async'])
def test_model_call_uses_the_inline_summary(tmp_path: Path, asynchronous: bool) -> None:
    model = ToolBindableFakeMessagesModel(
        responses=[AIMessage('Earlier copper requests.'), AIMessage('OK')], profile={'max_input_tokens': 60000},
    )
    graph = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], checkpointer=InMemorySaver(),
    )
    config = {'configurable': {'thread_id': 'sync-recovery'}}
    graph.update_state(config, {'messages': _history()}, as_node='model')
    inputs = {'messages': [HumanMessage('Reply OK.')]}
    result = asyncio.run(graph.ainvoke(inputs, config)) if asynchronous else graph.invoke(inputs, config)
    assert result['messages'][-1].content == 'OK'
    assert len(result['messages']) == 42
    event = graph.get_state(config).values['_summarization_event']
    assert 'Earlier copper requests.' in event['summary_message'].text
    assert (tmp_path / event['file_path'].lstrip('/')).is_file()


def test_summary_failure_preserves_raw_history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    from types import SimpleNamespace

    from ag_ui.core import RunAgentInput, UserMessage

    from botcube_harness_deepagents import serving
    from botcube_harness_deepagents.session_agent import SessionAgent
    from conftest import prepared

    async def exercise() -> None:
        archive_started = asyncio.Event()
        release_archive = threading.Event()
        loop = asyncio.get_running_loop()
        download = LocalShellBackend.download_files

        def blocked_download(backend: LocalShellBackend, paths: list[str]) -> Any:
            loop.call_soon_threadsafe(archive_started.set)
            assert release_archive.wait(5)
            return download(backend, paths)

        monkeypatch.setattr(LocalShellBackend, 'download_files', blocked_download)
        monkeypatch.setattr(serving, '_require_bot', lambda: SimpleNamespace(skills=()))
        model = CompactionModel(responses=[], fail_summary=True)
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'failed-recovery', 'actor_id': 'member'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        agent = SessionAgent(name='summary-failure', graph=graph)
        request = RunAgentInput(
            thread_id='failed-recovery', run_id='run', state={}, tools=[], context=[], forwarded_props={},
            messages=[UserMessage(id='question', content='Reply OK.')],
        )

        async def run() -> list[Any]:
            turns = turn_lifecycle.SessionTurns()
            return [event async for event in turns.stream(
                ('member', 'failed-recovery'), prepared(agent, tmp_path), request, None, serving._RequestContext(None),
            )]

        turn = asyncio.create_task(run())
        try:
            await asyncio.wait_for(archive_started.wait(), 3)
            done, _ = await asyncio.wait([turn], timeout=0.05)
            assert not done, 'The failed Turn released its writer while the archive was in flight'
        finally:
            release_archive.set()
            events = await turn
        assert events[-1].type == 'RUN_ERROR'
        assert events[-1].message == 'Summary model unavailable'
        assert all(event.type != 'TEXT_MESSAGE_CONTENT' for event in events)
        state = (await graph.aget_state(config)).values
        assert len(state['messages']) == 41
        assert state['messages'][0].content == _history()[0].content
        assert not state.get('_summarization_event')

    asyncio.run(exercise())


def test_emergency_recovery_after_prior_compaction_keeps_the_latest_request(
    tmp_path: Path,
) -> None:
    async def exercise() -> None:
        model = CompactionModel(
            responses=[], profile={'max_input_tokens': 60000},
        )
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'repeat-emergency'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        await graph.ainvoke({'messages': [HumanMessage('First request.')]}, config)
        [first_archive] = list((tmp_path / 'conversation_history').glob('*.md'))
        more_history = [message.model_copy(update={'id': f'new-{message.id}'}) for message in _history()]
        await graph.aupdate_state(config, {'messages': more_history}, as_node='model')
        question = 'Recover details for this latest request.'
        result = await graph.ainvoke({'messages': [HumanMessage(question)]}, config)
        assert result['messages'][-1].content == 'OK'
        assert any(message.content == question for message in model.calls[-1])
        assert len(result['messages']) == 84
        assert result['messages'][0].content == _history()[0].content
        latest = (await graph.aget_state(config)).values['_summarization_event']
        archive = tmp_path / latest['file_path'].lstrip('/')
        assert archive == first_archive
        assert archive.read_text().count("## Summarized at") == 2
        assert model.summary_calls == 2

    asyncio.run(exercise())


def test_cancelled_emergency_waits_for_archive_publication_to_settle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    from types import SimpleNamespace

    from ag_ui.core import RunAgentInput, UserMessage

    from botcube_harness_deepagents import serving
    from botcube_harness_deepagents.session_agent import SessionAgent
    from conftest import prepared

    async def exercise() -> None:
        publishing = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()

        write = LocalShellBackend.write

        def blocked_write(backend: LocalShellBackend, path: str, content: str) -> Any:
            loop.call_soon_threadsafe(publishing.set)
            assert release.wait(5), 'Publication was not released'
            return write(backend, path, content)

        monkeypatch.setattr(LocalShellBackend, 'write', blocked_write)
        model = CompactionModel(
            responses=[], profile={'max_input_tokens': 60000},
        )
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'cancelled-emergency'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        monkeypatch.setattr(serving, '_require_bot', lambda: SimpleNamespace(skills=()))
        turns = turn_lifecycle.SessionTurns()
        session = ('member', 'cancelled-emergency')
        agent = SessionAgent(name='summary-stop', graph=graph)
        request = RunAgentInput(
            thread_id='cancelled-emergency', run_id='run', state={}, tools=[], context=[], forwarded_props={},
            messages=[UserMessage(id='question', content='Reply OK.')],
        )

        async def run() -> list[Any]:
            return [event async for event in turns.stream(
                session, prepared(agent, tmp_path), request, None, serving._RequestContext(None),
            )]

        turn = asyncio.create_task(run())
        try:
            await asyncio.wait_for(publishing.wait(), timeout=3)
            turns.stop(session, request.run_id)
            done, _ = await asyncio.wait([turn], timeout=0.05)
            assert not done, 'The Turn settled before its archive publication'
        finally:
            release.set()
        events = await turn
        assert events[-1].code == 'TURN_STOPPED'
        state = (await graph.aget_state(config)).values
        assert not state.get('_summarization_event')
        assert state['messages'][0].content == _history()[0].content

    asyncio.run(exercise())


def test_native_emergency_overflow_still_propagates_when_recovery_cannot_fit(tmp_path: Path) -> None:
    from langchain_core.exceptions import ContextOverflowError

    async def exercise() -> None:
        model = RejectOversizedAnswer(
            responses=[], reject_above=1, profile={'max_input_tokens': 200000},
        )
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'irreducible-recovery'}}
        history = _history()[:12]
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        with pytest.raises(ContextOverflowError):
            await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        state = (await graph.aget_state(config)).values
        assert model.summary_calls == 1
        assert len(state['messages']) == len(history) + 1
        assert not state.get('_summarization_event')
        assert state['messages'][0].content == history[0].content

    asyncio.run(exercise())
