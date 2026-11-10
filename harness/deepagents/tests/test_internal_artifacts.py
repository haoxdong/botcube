import asyncio
import shlex
import sys
from pathlib import Path

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool

from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.files import excluded_paths, is_files_path
from conftest import ToolBindableFakeMessagesModel


@pytest.mark.parametrize('asynchronous', [False, True])
def test_large_tool_results_stay_readable_but_out_of_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, asynchronous: bool, configured_shell: LocalShellBackend,
) -> None:
    @tool
    def large_result() -> str:
        """Return a large result."""
        return 'result data\n' * 15000

    (tmp_path / 'calculation.py').write_text(
        "from pathlib import Path\nPath('report.txt').write_text('user report')\n"
    )
    model = ToolBindableFakeMessagesModel(responses=[
        AIMessage(content='', tool_calls=[{
            'id': 'call_python', 'name': 'execute',
            'args': {'command': f'{shlex.quote(sys.executable)} -c "import calculation"'},
        }]),
        AIMessage(content='', tool_calls=[{'id': 'call_large', 'name': 'large_result', 'args': {}}]),
        AIMessage(content='', tool_calls=[{
            'id': 'call_read', 'name': 'read_file',
            'args': {'file_path': '/botcube-harness-deepagents/large_tool_results/call_large', 'limit': 1},
        }]),
        AIMessage(content='Done.'),
    ])
    graph = build_agent(model=model, backend=configured_shell, skills=[], tools=[large_result])
    inputs = {'messages': 'Fetch the large result and read its first line.'}
    result = asyncio.run(graph.ainvoke(inputs)) if asynchronous else graph.invoke(inputs)
    messages = [message for message in result['messages'] if isinstance(message, ToolMessage)]

    keys = sorted(path.relative_to(tmp_path).as_posix() for path in tmp_path.rglob('*')
                  if path.is_file() and is_files_path(path.relative_to(tmp_path).as_posix(), excluded_paths(())))
    assert keys == ['calculation.py', 'report.txt']
    assert (tmp_path / 'report.txt').read_bytes() == b'user report'

    assert '/botcube-harness-deepagents/large_tool_results/call_large' in messages[1].content
    assert 'result data' in messages[2].content
    assert (tmp_path / 'botcube-harness-deepagents/large_tool_results/call_large').read_text() == 'result data\n' * 15000


@pytest.fixture
def configured_shell(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> LocalShellBackend:
    from botcube_cartridge import HarnessDefinition

    from botcube_harness_deepagents import serving

    monkeypatch.delenv('PYTHONDONTWRITEBYTECODE', raising=False)
    monkeypatch.setattr(serving, '_cartridge', None)
    monkeypatch.setattr(serving, '_workspace', lambda: tmp_path)
    serving.configure_harness_definition(HarnessDefinition(
        skills=(), agent_name='artifacts', prepare_invocation=lambda invocation: invocation,
        prepare_root=lambda root: None, session_id_env_var='TEST_SESSION_ID',
        environment_cache_key=lambda environment: (),
    ))
    return serving._require_cartridge().build_backend({})


@pytest.mark.integration
def test_configured_shell_imports_python_without_leaving_bytecode(
    tmp_path: Path, configured_shell: LocalShellBackend,
) -> None:
    backend = configured_shell
    (tmp_path / 'calculation.py').write_text('value = 42\n')
    command = f'{shlex.quote(sys.executable)} -c "import calculation; print(calculation.value)"'

    response = backend.execute(command)

    assert response.exit_code == 0
    assert response.output == '42\n'
    assert sorted(path.relative_to(tmp_path).as_posix() for path in tmp_path.rglob('*') if path.is_file()) == ['calculation.py']
    failure = backend.execute(f'{shlex.quote(sys.executable)} -c "import missing_calculation"')
    assert failure.exit_code != 0
    assert 'ModuleNotFoundError' in failure.output
