import asyncio
from pathlib import Path
from typing import Any, ClassVar

from deepagents.backends import LocalShellBackend
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.messages import AIMessage, BaseMessage

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.session_memory import SessionMemoryMiddleware
from conftest import ToolBindableFakeMessagesModel


def _ask_async(agent: Any, query: str) -> str:
    """One Turn on the async path serving runs, which Session memory needs."""
    return asyncio.run(agent.ainvoke({'messages': query}))['messages'][-1].text


class RecordingFakeMessagesModel(ToolBindableFakeMessagesModel):
    seen_batches: ClassVar[list[list[BaseMessage]]] = []

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: object,
    ):
        self.seen_batches.append(messages)
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def test_the_session_memory_block_reaches_the_prompt_without_file_memory_guidance(tmp_path: Path) -> None:
    """ADR 0031: the memory tool is the write path, so no edit_file guidance rides with the block."""
    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(responses=[AIMessage(content='hi')]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[],
        subagents=[],
        middleware=[SessionMemoryMiddleware(lambda _store: '- User prefers copper futures')],
    )

    assert _ask_async(agent, 'hello') == 'hi'
    [[system, *_]] = RecordingFakeMessagesModel.seen_batches
    assert '<agent_memory>\n- User prefers copper futures\n</agent_memory>' in system.text
    assert '<memory_guidelines>' not in system.text


def test_an_empty_session_memory_adds_no_block(tmp_path: Path) -> None:
    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(responses=[AIMessage(content='hi')]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[],
        subagents=[],
        middleware=[SessionMemoryMiddleware(lambda _store: '')],
    )

    assert _ask_async(agent, 'hello') == 'hi'
    [[system, *_]] = RecordingFakeMessagesModel.seen_batches
    assert '<agent_memory>' not in system.text


def test_a_fork_receives_read_only_memory_after_its_skills(tmp_path: Path) -> None:
    RecordingFakeMessagesModel.seen_batches = []
    model = RecordingFakeMessagesModel(responses=[
        AIMessage(content='I will ask a helper.', tool_calls=[{
            'id': 'delegate-1', 'name': 'task',
            'args': {'description': 'Verify the remembered preference.', 'subagent_type': 'helper'},
        }]),
        AIMessage(content='The preference is copper.'),
        AIMessage(content='The helper verified copper.'),
    ])
    agent = build_agent(
        model=model,
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        skills=[],
        middleware=[SessionMemoryMiddleware(lambda _store: '- User prefers copper futures')],
        system_prompt='Write text alongside tool calls.',
        subagents=[{'name': 'helper', 'description': 'Verifies a preference.', 'mode': 'fork'}],
    )

    assert _ask_async(agent, 'Check my preference.') == 'The helper verified copper.'
    assert len(RecordingFakeMessagesModel.seen_batches) == 3
    for messages in RecordingFakeMessagesModel.seen_batches:
        prompt = messages[0].text
        assert 'Write text alongside tool calls.' in prompt
        assert 'User prefers copper futures' in prompt
        assert '<memory_guidelines>' not in prompt
