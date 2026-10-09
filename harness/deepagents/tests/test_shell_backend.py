from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
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


def test_an_unrestricted_bash_command_keeps_the_output_cap(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, max_output_bytes=16, inherit_env=False)

    result = backend.execute('printf "%050d" 0')

    assert result.exit_code == 0
    assert result.truncated is True
    assert result.output.startswith('0000000000000000')


def test_timeout_terminates_pipeline_descendants(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute('(sleep 2; touch survived) | cat', timeout=1)

    assert result.exit_code == 124
    time.sleep(1.5)
    assert not (tmp_path / 'survived').exists()


def test_nonzero_command_keeps_stderr_and_status(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute('printf "failure\\n" >&2; exit 7')

    assert result == ExecuteResponse(output='[stderr] failure\n\nExit code: 7', exit_code=7)


def test_command_without_output_keeps_the_upstream_result(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)

    assert backend.execute('true') == ExecuteResponse(output='<no output>', exit_code=0)


def test_invalid_command_and_timeout_keep_the_upstream_errors(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)

    assert backend.execute('') == ExecuteResponse(output='Error: Command must be a non-empty string.', exit_code=1)
    with pytest.raises(ValueError, match='timeout must be positive, got 0'):
        backend.execute('true', timeout=0)


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux runtime process ownership')
def test_timeout_terminates_detached_descendants(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute("setsid sh -c 'sleep 2; touch survived' >/dev/null 2>&1 & wait", timeout=1)

    assert result.exit_code == 124
    time.sleep(1.5)
    assert not (tmp_path / 'survived').exists()


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux runtime process ownership')
def test_timeout_does_not_wait_for_detached_output_pipes(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)
    started = time.monotonic()

    result = backend.execute("setsid sh -c 'sleep 4' & wait", timeout=1)

    assert result.exit_code == 124
    assert time.monotonic() - started < 2.5


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux peak memory units')
def test_large_output_is_bounded_while_the_command_runs(tmp_path: Path) -> None:
    import subprocess
    import sys

    probe = '''
import os
import resource
from pathlib import Path
from threading import Event, Thread
from botcube_harness_deepagents.shell_backend import PolicyShellBackend
stop = Event()
worker_samples = []
monitor_errors = []
def monitor():
    try:
        while not stop.is_set():
            for entry in Path('/proc').iterdir():
                if not entry.name.isdecimal():
                    continue
                try:
                    args = (entry / 'cmdline').read_bytes().split(b'\\0')
                    if len(args) != 4 or args[1] != b'-I' or not args[2].endswith(b'/_shell_process.py'):
                        continue
                    status = (entry / 'status').read_text()
                except (FileNotFoundError, ProcessLookupError):
                    continue
                if f'PPid:\\t{os.getpid()}\\n' not in status:
                    continue
                for line in status.splitlines():
                    if line.startswith('VmRSS:'):
                        worker_samples.append(int(line.split()[1]))
            stop.wait(0.005)
    except Exception as error:
        monitor_errors.append(repr(error))
thread = Thread(target=monitor)
thread.start()
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
try:
    result = PolicyShellBackend(root_dir='.', max_output_bytes=100000).execute('head -c 67108864 /dev/zero; sleep 0.2')
    assert result.exit_code == 0 and result.truncated
    endless = PolicyShellBackend(root_dir='.', max_output_bytes=100000).execute('yes', timeout=1)
    assert endless.exit_code == 124
finally:
    stop.set()
    thread.join()
assert resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before < 32768
assert not monitor_errors, monitor_errors
assert worker_samples, 'No post-exec worker RSS samples'
assert max(worker_samples) < 32768, max(worker_samples)
'''
    result = subprocess.run([sys.executable, '-c', probe], cwd=tmp_path, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr


def test_success_preserves_detached_background_work(tmp_path: Path) -> None:
    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute("(sleep 0.2; touch completed) >/dev/null 2>&1 &", timeout=1)

    assert result.exit_code == 0
    deadline = time.monotonic() + 2
    while not (tmp_path / 'completed').exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert (tmp_path / 'completed').exists()


def test_timeout_does_not_kill_a_concurrent_invocation(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor

    backend = PolicyShellBackend(root_dir=tmp_path, inherit_env=False)
    with ThreadPoolExecutor(max_workers=2) as executor:
        surviving = executor.submit(backend.execute, 'sleep 1.5; echo completed', timeout=3)
        timed_out = executor.submit(backend.execute, 'sleep 5', timeout=1)

    assert timed_out.result().exit_code == 124
    assert surviving.result() == ExecuteResponse(output='completed\n', exit_code=0)


def test_missing_working_directory_reports_execution_failure(tmp_path: Path) -> None:
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    backend = PolicyShellBackend(root_dir=workspace, inherit_env=False)
    workspace.rmdir()

    result = backend.execute('true')

    assert result.exit_code == 1
    assert 'FileNotFoundError' in result.output
    assert '<no output>' not in result.output
