from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict, Unpack, cast

from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import ExecuteResponse

from botcube_harness_deepagents._shell_process import Request, Result


def _err(error: Exception) -> ExecuteResponse:
    return ExecuteResponse(output=f'Error executing command ({type(error).__name__}): {error}', exit_code=1)


def _run_worker(request: Request) -> Result:
    with subprocess.Popen(
        [sys.executable, '-I', str(Path(__file__).with_name('_shell_process.py'))],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    ) as worker:
        try:
            stdout, _ = worker.communicate(json.dumps(request), timeout=request['timeout'] + 3)
        except subprocess.TimeoutExpired as error:
            worker.kill()
            worker.wait(timeout=1)
            raise RuntimeError('Shell worker did not finish bounded timeout cleanup') from error
        if worker.returncode is not None and worker.returncode < 0:
            raise RuntimeError(f'Shell worker exited with status {worker.returncode}')
        response = json.loads(stdout)
        if worker.returncode != 0:
            raise RuntimeError(response['error'])
        return cast(Result, response)


class LocalShellOptions(TypedDict, total=False):
    """The keyword options ``LocalShellBackend.__init__`` accepts."""

    root_dir: str | Path | None
    virtual_mode: bool
    timeout: int
    max_output_bytes: int
    env: dict[str, str] | None
    inherit_env: bool


class PolicyShellBackend(LocalShellBackend):
    """Shell backend whose command policy is supplied by a Cartridge."""

    def __init__(self, *, command_validator: Callable[[str], str | None] | None = None, **kwargs: Unpack[LocalShellOptions]) -> None:
        super().__init__(**kwargs)
        self._command_validator = command_validator

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if self._command_validator is not None:
            error = self._command_validator(command)
            if error is not None:
                return ExecuteResponse(output=f'Error: {error}', exit_code=126)
        if not command or not isinstance(command, str):
            return ExecuteResponse(output='Error: Command must be a non-empty string.', exit_code=1)
        effective_timeout = timeout if timeout is not None else self._default_timeout
        if effective_timeout <= 0:
            raise ValueError(f'timeout must be positive, got {effective_timeout}')

        try:
            # Linux orphan adoption must belong to this invocation, not the shared Harness process.
            result = _run_worker(
                Request(command=command, cwd=str(self.cwd), env=self._env, timeout=effective_timeout, max_output_bytes=self._max_output_bytes)
            )
            if result['timed_out']:
                if timeout is not None:
                    message = f'Error: Command timed out after {effective_timeout} seconds (custom timeout). The command may be stuck or require more time.'
                else:
                    message = f'Error: Command timed out after {effective_timeout} seconds. For long-running commands, re-run using the timeout parameter.'
                return ExecuteResponse(output=message, exit_code=124)
            return self._execution_response(result['stdout'], result['stderr'], result['exit_code'], overflow=result['overflow'])
        except Exception as error:
            return _err(error)

    def _execution_response(self, stdout: str, stderr: str, exit_code: int, *, overflow: bool = False) -> ExecuteResponse:
        output_parts = [stdout] if stdout else []
        if stderr:
            output_parts.extend(f'[stderr] {line}' for line in stderr.strip().split('\n'))
        output = '\n'.join(output_parts) if output_parts else '<no output>'
        truncated = overflow or len(output.encode()) > self._max_output_bytes
        if truncated:
            output = output.encode()[: self._max_output_bytes].decode('utf-8', errors='ignore') + f'\n\n... Output truncated at {self._max_output_bytes} bytes.'
        if exit_code != 0:
            output = f'{output.rstrip()}\n\nExit code: {exit_code}'
        return ExecuteResponse(output=output, exit_code=exit_code, truncated=truncated)

    def set_environment_variable(self, key: str, value: str | None) -> None:
        """Update one process environment value without exposing backend internals."""
        if value is None:
            self._env.pop(key, None)
        else:
            self._env[key] = value
