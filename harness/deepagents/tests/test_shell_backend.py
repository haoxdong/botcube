from __future__ import annotations

from pathlib import Path

from deepagents.backends.protocol import ExecuteResponse

from botcube_harness_deepagents.shell_backend import PolicyShellBackend


def _only_echo(command: str) -> str | None:
    return None if command.startswith('echo ') else f'{command.split()[0]} is not allowed'


def _backend(tmp_path: Path) -> PolicyShellBackend:
    return PolicyShellBackend(
        root_dir=tmp_path,
        virtual_mode=True,
        timeout=60,
        inherit_env=False,
        command_validator=_only_echo,
    )


def test_a_command_the_cartridge_rejects_never_runs(tmp_path: Path) -> None:
    result = _backend(tmp_path).execute('touch ran')

    assert result == ExecuteResponse(output='Error: touch is not allowed', exit_code=126)
    assert not (tmp_path / 'ran').exists()


def test_a_command_the_cartridge_allows_runs_in_the_backend_root(tmp_path: Path) -> None:
    assert _backend(tmp_path).execute('echo hello') == ExecuteResponse(output='hello\n', exit_code=0)


def test_an_allowed_command_keeps_its_own_timeout(tmp_path: Path) -> None:
    result = _backend(tmp_path).execute('echo slow && sleep 5', timeout=1)

    assert result.exit_code == 124
    assert result.output.startswith('Error: Command timed out after 1 seconds')
