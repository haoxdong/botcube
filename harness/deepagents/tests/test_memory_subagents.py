import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, ClassVar

import pytest
from deepagents.backends import LocalShellBackend
from deepagents.middleware.memory import MemoryMiddleware
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.tools import tool

from botcube_harness_deepagents import agent as agent_module
from botcube_harness_deepagents import memory_files
from botcube_harness_deepagents.agent import ask, build_agent
from botcube_harness_deepagents.memory_files import (
    build_memory_sources,
    default_memory_path,
    ensure_memory_file,
    write_ltm_source,
)
from conftest import KwargsRecorder, ToolBindableFakeMessagesModel


def _middleware_memory_sources(kwargs: dict[str, Any]) -> list[str]:
    """Extract memory sources from the captured create_deep_agent kwargs."""
    return next(
        (list(mw.sources) for mw in kwargs['middleware'] if isinstance(mw, MemoryMiddleware)),
        [],
    )


def _real_filesystem(root: Path) -> LocalShellBackend:
    return LocalShellBackend(root_dir=root, virtual_mode=False, inherit_env=False)


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


def test_memory_sources_create_default_file_under_repo_root(tmp_path: Path) -> None:
    memory_sources = build_memory_sources(repo_root=tmp_path)

    expected = tmp_path / '.tmp' / 'botcube-harness-deepagents' / 'memory.md'
    assert memory_sources == ['/.tmp/botcube-harness-deepagents/memory.md']
    assert default_memory_path(repo_root=tmp_path) == expected
    assert expected.exists()
    assert expected.read_text() == ''


def test_ensure_memory_file_preserves_existing_content(tmp_path: Path) -> None:
    memory_path = tmp_path / 'mounted' / 'memory.md'
    memory_path.parent.mkdir()
    memory_path.write_text('remember this\n')

    ensured = ensure_memory_file(memory_path)

    assert ensured == memory_path
    assert memory_path.read_text() == 'remember this\n'


def test_build_agent_forwards_configurable_memory_path(
    monkeypatch: pytest.MonkeyPatch,
    kwargs_recorder: type[KwargsRecorder],
    tmp_path: Path,
) -> None:
    calls = kwargs_recorder.calls
    memory_path = tmp_path / 'sandbox' / 'memory.md'
    backend = _real_filesystem(tmp_path)
    model = object()

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(model=model, backend=backend, skills=[], memory_path=memory_path)

    assert calls[0]['model'] is model
    assert calls[0]['backend'] is backend
    assert _middleware_memory_sources(calls[0]) == [str(memory_path)]
    assert memory_path.exists()


def test_write_ltm_source_under_repo_root(tmp_path: Path) -> None:
    source = write_ltm_source('Known facts:\n- likes copper', repo_root=tmp_path)

    expected = tmp_path / '.tmp' / 'botcube-harness-deepagents' / 'ltm.md'
    assert source == '/.tmp/botcube-harness-deepagents/ltm.md'
    assert expected.read_text() == 'Known facts:\n- likes copper'


def test_write_ltm_source_next_to_configured_memory_path(tmp_path: Path) -> None:
    memory_path = tmp_path / 'sandbox' / 'memory.md'

    source = write_ltm_source('- fact', memory_path=memory_path)

    expected = tmp_path / 'sandbox' / 'ltm.md'
    assert source == str(expected)
    assert expected.read_text() == '- fact'


def test_a_memory_path_outside_the_virtual_backend_root_is_rejected(tmp_path: Path) -> None:
    backend = LocalShellBackend(root_dir=tmp_path / 'sandbox', virtual_mode=True, inherit_env=False)
    outside = tmp_path / 'elsewhere' / 'memory.md'
    error = f'memory_path {outside.with_name("ltm.md")} must be under virtual backend root {tmp_path.resolve() / "sandbox"}'

    with pytest.raises(ValueError, match=f'^{re.escape(error)}$'):
        write_ltm_source('- fact', backend=backend, memory_path=outside)


@pytest.fixture
def installed_at(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Callable[[Path], None]:
    """Place the memory_files module at a path, as if the package were installed there."""
    exists = Path.exists
    is_file = Path.is_file
    ambient_roots = set(tmp_path.parents)

    def isolated_exists(path: Path) -> bool:
        return False if path.name == '.git' and path.parent in ambient_roots else exists(path)

    def isolated_is_file(path: Path) -> bool:
        return False if path.name == 'package.json' and path.parent in ambient_roots else is_file(path)

    # Only the installation fixture determines its workspace, not the host's ancestors.
    monkeypatch.setattr(Path, 'exists', isolated_exists)
    monkeypatch.setattr(Path, 'is_file', isolated_is_file)

    def install(package_dir: Path) -> None:
        package_dir.mkdir(parents=True, exist_ok=True)
        module_file = package_dir / 'memory_files.py'
        module_file.touch()
        monkeypatch.setattr(memory_files, '__file__', str(module_file))

    return install


def test_a_checkout_keeps_memory_under_its_root(tmp_path: Path, installed_at: Callable[[Path], None]) -> None:
    (tmp_path / 'checkout' / '.git').mkdir(parents=True)
    installed_at(tmp_path / 'checkout' / 'botcube' / 'src')

    assert default_memory_path() == tmp_path / 'checkout' / '.tmp' / 'botcube-harness-deepagents' / 'memory.md'


def test_a_workspace_without_git_is_its_package_json_beside_botcube(tmp_path: Path, installed_at: Callable[[Path], None]) -> None:
    workspace = tmp_path / 'workspace'
    (workspace / 'botcube').mkdir(parents=True)
    (workspace / 'package.json').write_text('{}')
    # A package.json alone does not make a workspace.
    (workspace / 'botcube' / 'package.json').write_text('{}')
    installed_at(workspace / 'botcube' / 'src')

    assert default_memory_path() == workspace / '.tmp' / 'botcube-harness-deepagents' / 'memory.md'


def test_a_package_outside_any_workspace_keeps_memory_under_home(tmp_path: Path, installed_at: Callable[[Path], None], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('HOME', str(tmp_path / 'home'))
    installed_at(tmp_path / 'site-packages' / 'botcube_harness_deepagents')

    assert build_memory_sources() == ['/tmp/botcube-harness-deepagents/memory.md']
    assert (tmp_path / 'home' / 'tmp' / 'botcube-harness-deepagents' / 'memory.md').exists()


def test_a_virtual_backend_rooted_at_a_checkout_keeps_memory_under_it(tmp_path: Path) -> None:
    (tmp_path / '.git').mkdir()
    backend = LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False)

    assert build_memory_sources(backend=backend) == ['/.tmp/botcube-harness-deepagents/memory.md']
    assert (tmp_path / '.tmp' / 'botcube-harness-deepagents' / 'memory.md').exists()


def test_write_ltm_source_with_virtual_backend_returns_virtual_source(tmp_path: Path) -> None:
    memory_path = tmp_path / 'botcube-harness-deepagents' / 'threads' / 'thread-1' / 'memory.md'

    class FakeBackend:
        virtual_mode = True
        cwd = tmp_path

    source = write_ltm_source('- fact', backend=FakeBackend(), memory_path=memory_path)

    expected = tmp_path / 'botcube-harness-deepagents' / 'threads' / 'thread-1' / 'ltm.md'
    assert source == '/botcube-harness-deepagents/threads/thread-1/ltm.md'
    assert expected.read_text() == '- fact'


def test_build_agent_writes_ltm_context_to_file_source(
    monkeypatch: pytest.MonkeyPatch,
    kwargs_recorder: type[KwargsRecorder],
    tmp_path: Path,
) -> None:
    """ltm_context must become a file-backed source."""
    calls = kwargs_recorder.calls

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(
        model=object(),
        backend=_real_filesystem(tmp_path),
        repo_root=tmp_path,
        skills=[],
        subagents=[],
        ltm_context='- User prefers copper',
    )

    assert _middleware_memory_sources(calls[0]) == [
        '/.tmp/botcube-harness-deepagents/memory.md',
        '/.tmp/botcube-harness-deepagents/ltm.md',
    ]
    content = (tmp_path / '.tmp' / 'botcube-harness-deepagents' / 'ltm.md').read_text()
    assert 'User prefers copper' in content
    assert content == '- User prefers copper'


def test_build_agent_preserves_configured_memory_filename(
    monkeypatch: pytest.MonkeyPatch,
    kwargs_recorder: type[KwargsRecorder],
    tmp_path: Path,
) -> None:
    calls = kwargs_recorder.calls
    memory_path = tmp_path / 'sandbox' / 'user-memory.md'

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(model=object(), backend=_real_filesystem(tmp_path), skills=[], memory_path=memory_path)

    assert _middleware_memory_sources(calls[0]) == [str(memory_path)]
    assert memory_path.exists()
    assert not (tmp_path / 'sandbox' / 'memory.md').exists()


def test_build_agent_maps_configurable_memory_path_for_virtual_backend(
    monkeypatch: pytest.MonkeyPatch,
    kwargs_recorder: type[KwargsRecorder],
    tmp_path: Path,
) -> None:
    calls = kwargs_recorder.calls
    backend_root = tmp_path / 'sandbox'
    backend_root.mkdir()
    memory_path = backend_root / 'mem' / 'memory.md'

    class FakeBackend:
        cwd = backend_root
        virtual_mode = True

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(
        model=object(),
        backend=FakeBackend(),
        memory_path=memory_path,
        skills=[],
        subagents=[],
        ltm_context='- User prefers copper',
    )

    assert _middleware_memory_sources(calls[0]) == [
        '/mem/memory.md',
        '/mem/ltm.md',
    ]
    assert memory_path.exists()
    assert (backend_root / 'mem' / 'ltm.md').read_text() == '- User prefers copper'


def test_build_agent_uses_repo_memory_for_repo_rooted_virtual_backend(
    monkeypatch: pytest.MonkeyPatch,
    kwargs_recorder: type[KwargsRecorder],
    tmp_path: Path,
) -> None:
    calls = kwargs_recorder.calls

    class FakeBackend:
        cwd = tmp_path
        virtual_mode = True

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(
        model=object(),
        backend=FakeBackend(),
        repo_root=tmp_path,
        skills=[],
        subagents=[],
        ltm_context='- User prefers copper',
    )

    assert _middleware_memory_sources(calls[0]) == [
        '/.tmp/botcube-harness-deepagents/memory.md',
        '/.tmp/botcube-harness-deepagents/ltm.md',
    ]
    assert (tmp_path / '.tmp' / 'botcube-harness-deepagents' / 'memory.md').exists()
    assert (tmp_path / '.tmp' / 'botcube-harness-deepagents' / 'ltm.md').read_text() == '- User prefers copper'


def test_ltm_context_reaches_model_prompt(tmp_path: Path) -> None:
    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(responses=[AIMessage(content='hi')]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=[],
        skills=[],
        subagents=[],
        repo_root=tmp_path,
        ltm_context='- User prefers copper futures',
    )

    assert ask(agent, 'hello') == 'hi'
    assert any(
        'User prefers copper futures' in str(message.content)
        for batch in RecordingFakeMessagesModel.seen_batches
        for message in batch
    )


def test_ltm_context_reaches_model_prompt_with_ordered_memory_sections(tmp_path: Path) -> None:
    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(responses=[AIMessage(content='hi')]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=[],
        skills=[],
        subagents=[],
        repo_root=tmp_path,
        ltm_context=(
            'user preferences:\n'
            '- User prefers copper futures\n'
            '\n'
            'semantic facts:\n'
            '- Runbook URL is wiki/runbook-v2\n'
            '\n'
            'More memories are available. '
            'Use agent_core_memory retrieve to search beyond the startup memory block.'
        ),
    )

    assert ask(agent, 'hello') == 'hi'
    joined = '\n'.join(
        str(message.content)
        for batch in RecordingFakeMessagesModel.seen_batches
        for message in batch
    )
    assert '<agent_memory>' in joined
    assert joined.index('user preferences:') < joined.index('semantic facts:')
    assert 'Runbook URL is wiki/runbook-v2' in joined
    assert 'agent_core_memory retrieve' in joined
    assert '<memory_guidelines>' not in joined


def test_known_fact_question_answers_from_context_without_retrieve_tool(tmp_path: Path) -> None:
    tool_calls: list[dict[str, str]] = []

    @tool
    def agent_core_memory(action: str, query: str = '') -> str:
        """Retrieve memory records."""
        tool_calls.append({'action': action, 'query': query})
        return 'unexpected retrieve'

    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(responses=[AIMessage(content='wiki/runbook-v2')]),
        tools=[agent_core_memory],
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=[],
        skills=[],
        subagents=[],
        repo_root=tmp_path,
        ltm_context=(
            'user preferences:\n'
            '- User prefers concise answers\n'
            '\n'
            'semantic facts:\n'
            '- Runbook URL is wiki/runbook-v2'
        ),
    )

    assert ask(agent, 'What is my runbook URL?') == 'wiki/runbook-v2'
    assert tool_calls == []


def test_spilled_fact_question_uses_memory_retrieve_tool(tmp_path: Path) -> None:
    tool_calls: list[dict[str, str]] = []

    @tool
    def agent_core_memory(action: str, query: str = '') -> str:
        """Retrieve memory records."""
        tool_calls.append({'action': action, 'query': query})
        return 'Spilled fact: Fact 99'

    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(
            responses=[
                AIMessage(
                    content='',
                    tool_calls=[
                        {
                            'name': 'agent_core_memory',
                            'args': {'action': 'retrieve', 'query': 'Fact 99'},
                            'id': 'call_retrieve_memory',
                            'type': 'tool_call',
                        }
                    ],
                ),
                AIMessage(content='Fact 99'),
            ]
        ),
        tools=[agent_core_memory],
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=[],
        skills=[],
        subagents=[],
        repo_root=tmp_path,
        ltm_context=(
            'user preferences:\n'
            '- User prefers concise answers\n'
            '\n'
            'semantic facts:\n'
            + '\n'.join(f'- Fact {i:02d}' for i in range(50))
            + '\n\n'
            'More memories are available. '
            'Use agent_core_memory retrieve to search beyond the startup memory block.'
        ),
    )

    assert ask(agent, 'What is Fact 99?') == 'Fact 99'
    assert tool_calls == [{'action': 'retrieve', 'query': 'Fact 99'}]


def test_ltm_context_prompt_block_is_stable_across_turns(tmp_path: Path) -> None:
    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(
            responses=[AIMessage(content='first'), AIMessage(content='second')]
        ),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=[],
        skills=[],
        subagents=[],
        repo_root=tmp_path,
        ltm_context=(
            'user preferences:\n'
            '- User prefers copper futures\n'
            '\n'
            'semantic facts:\n'
            '- Runbook URL is wiki/runbook-v2'
        ),
    )

    assert ask(agent, 'hello') == 'first'
    assert ask(agent, 'again') == 'second'
    blocks = []
    for batch in RecordingFakeMessagesModel.seen_batches:
        joined = '\n'.join(str(message.content) for message in batch)
        start = joined.find('<agent_memory>')
        end = joined.find('</agent_memory>')
        if start >= 0 and end >= 0:
            blocks.append(joined[start:end + len('</agent_memory>')])

    assert len(blocks) >= 2
    assert blocks[0] == blocks[1]


def test_ltm_file_anchors_to_virtual_backend_root(tmp_path: Path) -> None:
    """A false repo root outside the backend must not receive the LTM file."""
    home = tmp_path / 'home'
    home.mkdir()
    false_root = tmp_path / 'false-root'
    false_root.mkdir()

    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(responses=[AIMessage(content='hi')]),
        backend=LocalShellBackend(root_dir=home, virtual_mode=True, inherit_env=False),
        memory=[],
        skills=[],
        subagents=[],
        repo_root=false_root,
        ltm_context='- User prefers copper futures',
    )

    assert ask(agent, 'hello') == 'hi'
    assert (home / 'tmp' / 'botcube-harness-deepagents' / 'ltm.md').exists()
    assert any(
        'User prefers copper futures' in str(message.content)
        for batch in RecordingFakeMessagesModel.seen_batches
        for message in batch
    )


def test_memory_guidelines_not_injected(tmp_path: Path) -> None:
    """Inject the memory block without framework persistence instructions."""
    RecordingFakeMessagesModel.seen_batches = []
    agent = build_agent(
        model=RecordingFakeMessagesModel(responses=[AIMessage(content='hi')]),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=[],
        skills=[],
        subagents=[],
        repo_root=tmp_path,
        ltm_context='- User prefers copper futures',
    )

    assert ask(agent, 'hello') == 'hi'
    joined = '\n'.join(
        str(message.content)
        for batch in RecordingFakeMessagesModel.seen_batches
        for message in batch
    )
    assert '<agent_memory>' in joined
    assert 'User prefers copper futures' in joined
    assert '<memory_guidelines>' not in joined
    assert 'save new knowledge by calling the `edit_file` tool' not in joined


def test_build_agent_keeps_agentcore_ltm_context_in_read_only_memory_slot(
    monkeypatch: pytest.MonkeyPatch,
    kwargs_recorder: type[KwargsRecorder],
    tmp_path: Path,
) -> None:
    calls = kwargs_recorder.calls
    model = object()
    store = object()

    class FakeBackend:
        virtual_mode = True
        cwd = tmp_path

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(
        model=model,
        backend=FakeBackend(),
        store=store,
        ltm_context='User prefers copper.',
        skills=[],
        subagents=[],
        middleware=[],
    )

    memory_middlewares = [
        mw for mw in calls[0]['middleware'] if isinstance(mw, MemoryMiddleware)
    ]
    assert calls[0]['memory'] == ['/tmp/botcube-harness-deepagents/ltm.md']
    assert [list(mw.sources) for mw in memory_middlewares] == [
        ['/tmp/botcube-harness-deepagents/ltm.md']
    ]
    assert memory_middlewares[0].system_prompt == agent_module.LTM_MEMORY_SYSTEM_PROMPT
    assert calls[0]['system_prompt'] == ''
    content = (tmp_path / 'tmp' / 'botcube-harness-deepagents' / 'ltm.md').read_text()
    assert 'User prefers copper.' in content
    assert not (tmp_path / 'tmp' / 'botcube-harness-deepagents' / 'memory.md').exists()


def test_build_agent_preserves_explicit_memory_with_store(monkeypatch: pytest.MonkeyPatch, kwargs_recorder: type[KwargsRecorder]) -> None:
    calls = kwargs_recorder.calls
    store = object()

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(
        model=object(),
        backend=object(),
        store=store,
        memory=['/memory.md'],
        skills=[],
        subagents=[],
    )

    assert calls[0]['store'] is store
    assert _middleware_memory_sources(calls[0]) == ['/memory.md']


def test_build_agent_preserves_explicit_memory_path_with_store(
    monkeypatch: pytest.MonkeyPatch,
    kwargs_recorder: type[KwargsRecorder],
    tmp_path: Path,
) -> None:
    calls = kwargs_recorder.calls
    store = object()
    memory_path = tmp_path / 'memory.md'

    monkeypatch.setattr(agent_module, 'create_deep_agent', kwargs_recorder)

    build_agent(
        model=object(),
        backend=_real_filesystem(tmp_path),
        store=store,
        memory_path=memory_path,
        skills=[],
        subagents=[],
    )

    assert calls[0]['store'] is store
    assert _middleware_memory_sources(calls[0]) == [str(memory_path)]
    assert memory_path.exists()


def test_deep_agent_memory_file_is_written_and_loaded_with_fake_model(tmp_path: Path) -> None:
    memory_path = tmp_path / 'memory.md'
    memory_path.write_text('# Memory\n')
    first_backend = LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False)
    first_agent = build_agent(
        model=RecordingFakeMessagesModel(
            responses=[
                AIMessage(
                    content='',
                    tool_calls=[
                        {
                            'name': 'edit_file',
                            'args': {
                                'file_path': '/memory.md',
                                'old_string': '# Memory\n',
                                'new_string': (
                                    '# Memory\n'
                                    'User is interested in FX carry trades.\n'
                                ),
                            },
                            'id': 'call_write_memory',
                            'type': 'tool_call',
                        }
                    ],
                ),
                AIMessage(content='remembered'),
            ]
        ),
        backend=first_backend,
        memory=['/memory.md'],
        skills=[],
        subagents=[],
    )

    assert ask(first_agent, 'Remember that I care about FX carry trades.') == 'remembered'
    assert memory_path.read_text() == '# Memory\nUser is interested in FX carry trades.\n'

    RecordingFakeMessagesModel.seen_batches = []
    second_agent = build_agent(
        model=RecordingFakeMessagesModel(
            responses=[AIMessage(content='You care about FX carry trades.')]
        ),
        backend=LocalShellBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=False),
        memory=['/memory.md'],
        skills=[],
        subagents=[],
    )

    answer = ask(second_agent, 'What topic did I ask you to remember?')

    assert 'FX carry trades' in answer
    assert any(
        'User is interested in FX carry trades.' in str(message.content)
        for batch in RecordingFakeMessagesModel.seen_batches
        for message in batch
    )


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
        memory=[], skills=[], ltm_context='- User prefers copper futures',
        system_prompt='Write text alongside tool calls.',
        subagents=[{'name': 'helper', 'description': 'Verifies a preference.', 'mode': 'fork'}],
    )

    assert ask(agent, 'Check my preference.') == 'The helper verified copper.'
    assert len(RecordingFakeMessagesModel.seen_batches) == 3
    for messages in RecordingFakeMessagesModel.seen_batches:
        prompt = messages[0].text
        assert 'Write text alongside tool calls.' in prompt
        assert 'User prefers copper futures' in prompt
        assert '<memory_guidelines>' not in prompt
        assert prompt.endswith('</agent_memory>')
