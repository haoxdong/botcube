from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
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
from langgraph.graph.state import CompiledStateGraph
from pydantic import Field

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.session_agent import SessionAgent
from botcube_harness_deepagents.turn_memory import TurnFeeds, collecting_turn_feeds
from conftest import ToolBindableFakeMessagesModel


class CompactionModel(ToolBindableFakeMessagesModel):
    profile: ModelProfile | None = {'max_input_tokens': 160_000}
    calls: list[list[BaseMessage]] = Field(default_factory=list)
    summary_calls: int = 0
    summary_started: Any = None
    release_summary: Any = None
    fail_summary: bool = False

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None, **kwargs: Any,
    ) -> ChatResult:
        if run_manager is not None and run_manager.metadata.get('lc_source') == 'summarization':
            self.summary_calls += 1
            self.summary_started.set()
            await self.release_summary.wait()
            if self.fail_summary:
                raise RuntimeError('Summary model unavailable')
            answer = 'The earlier request concerned copper futures. Preserve the recent questions.'
        else:
            self.calls.append(messages)
            answer = 'OK'
        return ChatResult(generations=[ChatGeneration(message=AIMessage(answer))])


class StreamingCompactionModel(CompactionModel):
    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        self.calls.append(messages)
        yield ChatGenerationChunk(message=AIMessageChunk(content='OK'))


def _history() -> list[BaseMessage]:
    return [message for index in range(20) for message in (
        HumanMessage('Earlier copper question. ' * 600, id=f'q-{index}'),
        AIMessage('Earlier copper answer. ' * 600, id=f'a-{index}'),
    )]


async def _checkpoint(graph: CompiledStateGraph, config: RunnableConfig, feeds: TurnFeeds) -> None:
    assert feeds.compaction is not None
    update = await feeds.compaction()
    assert update is not None
    await graph.aupdate_state(config, update, as_node='model')


@pytest.mark.parametrize('edit_prefix', [False, True])
def test_a_staged_candidate_survives_append_but_never_replaces_an_edit(tmp_path: Path, edit_prefix: bool) -> None:
    async def exercise() -> None:
        model = CompactionModel(responses=[], summary_started=asyncio.Event(), release_summary=asyncio.Event())
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'edited-summary'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        with collecting_turn_feeds() as feeds:
            await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        await _checkpoint(graph, config, feeds)
        if edit_prefix:
            await graph.aupdate_state(config, {'messages': [HumanMessage('Edited question', id='q-0')]}, as_node='model')
        else:
            await graph.aupdate_state(config, {'messages': [HumanMessage('A new appended request', id='appended')]}, as_node='model')
        with collecting_turn_feeds():
            result = await graph.ainvoke({'messages': [HumanMessage('Reply OK again.')]}, config)
        state = (await graph.aget_state(config)).values
        assert bool(state.get('_summarization_event')) is not edit_prefix
        assert result['messages'][0].content == ('Edited question' if edit_prefix else _history()[0].content)
        assert any(message.content == ('Edited question' if edit_prefix else 'A new appended request') for message in result['messages'])
        assert model.summary_calls == 1

    asyncio.run(exercise())


@pytest.mark.parametrize('publication_fails', [False, True])
def test_history_files_are_published_in_isolation_before_a_candidate_is_exposed(
    tmp_path: Path, publication_fails: bool, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from botcube_harness_deepagents.files import install_staged_files
    from botcube_harness_deepagents.lazy_files import TurnFiles, turn_files

    published: list[list[str]] = []

    class Files(TurnFiles):
        def publish_staged(self, root: Path) -> None:
            assert root != tmp_path
            names = [p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()]
            assert names and all(name.startswith('conversation_history/') for name in names)
            published.append(names)
            if publication_fails:
                raise RuntimeError('Files publication unavailable')
            install_staged_files(root, tmp_path, ())

    monkeypatch.setattr(TurnFiles, 'publish_staged', Files.publish_staged)

    async def exercise() -> None:
        (tmp_path / 'interactive.txt').write_text('An active tool owns this file')
        model = CompactionModel(responses=[], summary_started=asyncio.Event(), release_summary=asyncio.Event())
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'published-history'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        with turn_files(None, tmp_path, ()), collecting_turn_feeds() as feeds:
            result = await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        assert result['messages'][-1].content == 'OK'
        if publication_fails:
            with pytest.raises(RuntimeError, match='Files publication unavailable'):
                await _checkpoint(graph, config, feeds)
        else:
            await _checkpoint(graph, config, feeds)
        assert len(published) == 1
        with collecting_turn_feeds():
            await graph.ainvoke({'messages': [HumanMessage('Reply OK again.')]}, config)
        state = (await graph.aget_state(config)).values
        assert bool(state.get('_summarization_event')) is not publication_fails
        assert (tmp_path / 'interactive.txt').read_text() == 'An active tool owns this file'
        if not publication_fails:
            assert (tmp_path / state['_summarization_event']['file_path'].lstrip('/')).is_file()

    asyncio.run(exercise())


def test_the_serving_lifecycle_surfaces_a_failed_compaction_on_the_next_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    from ag_ui.core import RunAgentInput, UserMessage

    from botcube_harness_deepagents import serving
    from conftest import prepared

    monkeypatch.setattr(serving, '_require_bot', lambda: SimpleNamespace(skills=()))

    async def exercise() -> None:
        model = StreamingCompactionModel(responses=[], summary_started=asyncio.Event(), release_summary=asyncio.Event(), fail_summary=True)
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'serving-compaction', 'actor_id': 'member'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        agent = SessionAgent(name='background-regression', graph=graph)
        turns = serving._SessionTurns()
        session = ('member', 'serving-compaction')

        first: dict[str, Any] = {}

        async def turn(number: int, events: dict[str, Any]) -> None:
            request = RunAgentInput(
                thread_id=session[1], run_id=f'run-{number}', state={}, tools=[], context=[], forwarded_props={},
                messages=[UserMessage(id=f'question-{number}', content='Reply OK.')],
            )
            async for event in turns.stream(
                session, prepared(agent, tmp_path), request, None, serving._RequestContext(None),
            ):
                events[event.type] = event

        answer = asyncio.create_task(turn(1, first))
        started = asyncio.create_task(model.summary_started.wait())
        try:
            done, _ = await asyncio.wait([answer, started], return_when=asyncio.FIRST_COMPLETED)
            assert done == {started}
            assert first['TEXT_MESSAGE_CONTENT'].delta == 'OK'
        finally:
            started.cancel()
            model.release_summary.set()
            await answer
        assert 'RUN_FINISHED' in first
        await asyncio.sleep(0)
        with pytest.raises(RuntimeError, match='Summary model unavailable'):
            await turn(2, {})
        state = (await graph.aget_state(config)).values
        assert len(state['messages']) == 42
        assert state['messages'][0].content == _history()[0].content
        assert not state.get('_pending_summary')
        assert not state.get('_summarization_event')

    asyncio.run(exercise())


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


def test_an_inherited_subagent_never_consumes_the_parent_compaction_candidate(tmp_path: Path) -> None:
    async def exercise() -> None:
        model = DelegatingCompactionModel(responses=[], summary_started=asyncio.Event(), release_summary=asyncio.Event())
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'parent-summary'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        model.release_summary.set()
        with collecting_turn_feeds() as feeds:
            await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        await _checkpoint(graph, config, feeds)
        model.delegate = True
        with collecting_turn_feeds():
            result = await graph.ainvoke({'messages': [HumanMessage('Use a helper, then reply OK.')]}, config)
        assert result['messages'][-1].content == 'OK'
        assert model.child_calls > 0
        with collecting_turn_feeds():
            result = await graph.ainvoke({'messages': [HumanMessage('Reply OK once more.')]}, config)
        assert result['messages'][-1].content == 'OK'
        assert count_tokens_approximately(model.calls[-1]) < 30000
        assert model.summary_calls == 1
        assert result['messages'][0].content == _history()[0].content

    asyncio.run(exercise())


def test_native_budget_recovery_preserves_raw_tool_output(tmp_path: Path) -> None:
    async def exercise() -> None:
        model = CompactionModel(
            responses=[], profile={'max_input_tokens': 30000},
            summary_started=asyncio.Event(), release_summary=asyncio.Event(),
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
        with collecting_turn_feeds():
            result = await graph.ainvoke({'messages': messages}, config)
        assert count_tokens_approximately(model.calls[-1]) < 30000
        assert result['messages'][2].content == original
        assert (await graph.aget_state(config)).values['messages'][2].content == original
        assert model.summary_calls == 0
        assert list(tmp_path.rglob('large-result'))

    asyncio.run(exercise())


def test_repeated_compaction_keeps_earlier_archives_reachable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import agent as agent_module
    from botcube_harness_deepagents.compaction import BackgroundCompaction

    monkeypatch.setattr(agent_module, 'BackgroundCompaction', lambda *, model, backend, **_settings: BackgroundCompaction(
        model=model, backend=backend, trigger=('messages', 4), keep=('messages', 2), trim_tokens_to_summarize=None,
    ))

    async def exercise() -> None:
        model = CompactionModel(responses=[], summary_started=asyncio.Event(), release_summary=asyncio.Event())
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'repeated-archives'}}
        early_fact = 'Original delivery reference: AMBER-ARCHIVE-73.'
        history = [HumanMessage(early_fact), AIMessage('Recorded.'), HumanMessage('Next question.'), AIMessage('Answered.')]
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        first_event = None
        for turn in range(2):
            with collecting_turn_feeds() as feeds:
                await graph.ainvoke({'messages': [HumanMessage(f'Continue {turn}.')]}, config)
            await _checkpoint(graph, config, feeds)
            if turn == 1:
                first_event = (await graph.aget_state(config)).values['_summarization_event']
        with collecting_turn_feeds():
            result = await graph.ainvoke({'messages': [HumanMessage('Recover the original reference.')]}, config)
        latest = (await graph.aget_state(config)).values['_summarization_event']
        assert first_event is not None
        first_path = first_event['file_path']
        latest_path = latest['file_path']
        assert latest_path != first_path
        assert early_fact in (tmp_path / first_path.lstrip('/')).read_text()
        latest_archive = (tmp_path / latest_path.lstrip('/')).read_text()
        assert first_path in latest_archive, 'The current archive must link to the earlier archive'
        assert first_path in latest_archive.splitlines()[0]
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


@pytest.mark.parametrize('native_control', [False, True])
@pytest.mark.parametrize('failure', ['budget', 'provider'])
def test_oversized_history_can_answer_without_a_ready_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, native_control: bool, failure: str,
) -> None:
    if native_control:
        from deepagents.middleware.summarization import SummarizationMiddleware

        from botcube_harness_deepagents import agent as agent_module

        monkeypatch.setattr(agent_module, 'BackgroundCompaction', SummarizationMiddleware)

    async def exercise() -> None:
        profile: ModelProfile = {'max_input_tokens': 60000 if failure == 'budget' else 200000 if native_control else 2000000}
        model_class = CompactionModel if failure == 'budget' else RejectOversizedAnswer
        model = model_class(
            responses=[], profile=profile, summary_started=asyncio.Event(), release_summary=asyncio.Event(),
        )
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'oversized-resume'}}
        history = _history() if failure == 'budget' else _history()[:12]
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        with collecting_turn_feeds():
            result = await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        assert result['messages'][-1].content == 'OK'
        assert model.summary_calls == 1
        assert len(result['messages']) == len(history) + 2
        assert result['messages'][0].content == history[0].content
        event = (await graph.aget_state(config)).values['_summarization_event']
        assert (tmp_path / event['file_path'].lstrip('/')).is_file()
        with collecting_turn_feeds():
            following = await graph.ainvoke({'messages': [HumanMessage('Continue normally.')]}, config)
        assert following['messages'][-1].content == 'OK'
        assert len(following['messages']) == len(history) + 4
        assert model.summary_calls == 1

    asyncio.run(exercise())


def test_synchronous_oversized_history_uses_native_recovery(tmp_path: Path) -> None:
    model = ToolBindableFakeMessagesModel(
        responses=[AIMessage('Earlier copper requests.'), AIMessage('OK')], profile={'max_input_tokens': 60000},
    )
    graph = build_agent(
        model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[], checkpointer=InMemorySaver(),
    )
    config = {'configurable': {'thread_id': 'sync-recovery'}}
    graph.update_state(config, {'messages': _history()}, as_node='model')
    with collecting_turn_feeds():
        result = graph.invoke({'messages': [HumanMessage('Reply OK.')]}, config)
    assert result['messages'][-1].content == 'OK'
    assert len(result['messages']) == 42
    event = graph.get_state(config).values['_summarization_event']
    assert (tmp_path / event['file_path'].lstrip('/')).is_file()


@pytest.mark.parametrize('failure', ['summary', 'publication'])
def test_emergency_recovery_failure_preserves_raw_history(tmp_path: Path, failure: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents.lazy_files import TurnFiles, turn_files

    class Files(TurnFiles):
        def publish_staged(self, root: Path) -> None:
            assert root != tmp_path
            raise RuntimeError('Files publication unavailable')

    monkeypatch.setattr(TurnFiles, 'publish_staged', Files.publish_staged)

    async def exercise() -> None:
        model = CompactionModel(
            responses=[], profile={'max_input_tokens': 60000}, fail_summary=failure == 'summary',
            summary_started=asyncio.Event(), release_summary=asyncio.Event(),
        )
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'failed-recovery'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        error = 'Summary model unavailable' if failure == 'summary' else 'Files publication unavailable'
        with (
            turn_files(None, tmp_path, ()),
            collecting_turn_feeds(),
            pytest.raises(RuntimeError, match=error),
        ):
            await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        state = (await graph.aget_state(config)).values
        assert len(state['messages']) == 41
        assert state['messages'][0].content == _history()[0].content
        assert not state.get('_summarization_event')

    asyncio.run(exercise())


@pytest.mark.parametrize('ready_candidate', [False, True])
def test_emergency_recovery_after_prior_compaction_keeps_the_latest_request(
    tmp_path: Path, ready_candidate: bool,
) -> None:
    async def exercise() -> None:
        model = CompactionModel(
            responses=[], profile={'max_input_tokens': 160000 if ready_candidate else 60000},
            summary_started=asyncio.Event(), release_summary=asyncio.Event(),
        )
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'repeat-emergency'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        with collecting_turn_feeds() as feeds:
            await graph.ainvoke({'messages': [HumanMessage('First request.')]}, config)
        if ready_candidate:
            await _checkpoint(graph, config, feeds)
        [first_archive] = list((tmp_path / 'conversation_history').glob('*.md'))
        model.profile = {'max_input_tokens': 60000}
        more_history = [message.model_copy(update={'id': f'new-{message.id}'}) for message in _history()]
        await graph.aupdate_state(config, {'messages': more_history}, as_node='model')
        question = 'Recover details for this latest request.'
        with collecting_turn_feeds():
            result = await graph.ainvoke({'messages': [HumanMessage(question)]}, config)
        assert result['messages'][-1].content == 'OK'
        assert any(message.content == question for message in model.calls[-1])
        assert len(result['messages']) == 84
        assert result['messages'][0].content == _history()[0].content
        latest = (await graph.aget_state(config)).values['_summarization_event']
        archive = tmp_path / latest['file_path'].lstrip('/')
        assert archive != first_archive
        assert first_archive.name in archive.read_text().splitlines()[0]
        assert model.summary_calls == 2

    asyncio.run(exercise())


def test_cancelled_emergency_waits_for_archive_publication_to_settle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import threading

    from botcube_harness_deepagents.lazy_files import TurnFiles, turn_files

    async def exercise() -> None:
        publishing = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()

        class Files(TurnFiles):
            def publish_staged(self, root: Path) -> None:
                loop.call_soon_threadsafe(publishing.set)
                assert release.wait(5), 'Publication was not released'
                assert list(root.rglob('*.md')), 'Cancellation deleted the in-flight archive'

        monkeypatch.setattr(TurnFiles, 'publish_staged', Files.publish_staged)
        model = CompactionModel(
            responses=[], profile={'max_input_tokens': 60000},
            summary_started=asyncio.Event(), release_summary=asyncio.Event(),
        )
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'cancelled-emergency'}}
        await graph.aupdate_state(config, {'messages': _history()}, as_node='model')
        with turn_files(None, tmp_path, ()), collecting_turn_feeds():
            turn = asyncio.create_task(graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config))
            try:
                await asyncio.wait_for(publishing.wait(), timeout=3)
                turn.cancel()
                done, _ = await asyncio.wait([turn], timeout=0.05)
                assert not done, 'The Turn settled before its archive publication'
            finally:
                release.set()
            with pytest.raises(asyncio.CancelledError):
                await turn
        state = (await graph.aget_state(config)).values
        assert not state.get('_summarization_event')
        assert state['messages'][0].content == _history()[0].content

    asyncio.run(exercise())


def test_native_emergency_overflow_still_propagates_when_recovery_cannot_fit(tmp_path: Path) -> None:
    from langchain_core.exceptions import ContextOverflowError

    async def exercise() -> None:
        model = RejectOversizedAnswer(
            responses=[], reject_above=1, profile={'max_input_tokens': 2000000},
            summary_started=asyncio.Event(), release_summary=asyncio.Event(),
        )
        model.release_summary.set()
        graph = build_agent(
            model=model, backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
            skills=[], checkpointer=InMemorySaver(),
        )
        config: RunnableConfig = {'configurable': {'thread_id': 'irreducible-recovery'}}
        history = _history()[:12]
        await graph.aupdate_state(config, {'messages': history}, as_node='model')
        with collecting_turn_feeds(), pytest.raises(ContextOverflowError):
            await graph.ainvoke({'messages': [HumanMessage('Reply OK.')]}, config)
        state = (await graph.aget_state(config)).values
        assert model.summary_calls == 1
        assert len(state['messages']) == len(history) + 1
        assert not state.get('_summarization_event')
        assert state['messages'][0].content == history[0].content

    asyncio.run(exercise())
