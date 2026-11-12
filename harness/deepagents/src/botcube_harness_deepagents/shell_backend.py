from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, cast

from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import ExecuteResponse
from opentelemetry import trace
from opentelemetry.instrumentation import auto_instrumentation
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from botcube_harness_deepagents._shell_process import Request, Result
from botcube_harness_deepagents.trace_relay import count_failures_under
from botcube_harness_deepagents.trace_secrets import (
    cookie_secrets,
    environment_secrets,
    strip_secrets,
)

log = logging.getLogger(__name__)
_SHELL_WORD = r"""(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\|;&()<>])+"""
_SHELL_TOKEN = re.compile(rf'{_SHELL_WORD}|[|;&()<>]+|\n')
_SHELL_BOUNDARIES = {'|', '||', '&', '&&', ';', ';;', '(', ')', '<', '>', '>>', '<<', '\n'}


def _word(token: re.Match[str]) -> str:
    return shlex.split(token.group())[0]


def _password_producer(tokens: list[re.Match[str]], pipe: int, login_prefixes: list[list[str]]) -> list[re.Match[str]]:
    start, end = pipe, pipe + 1
    while start > 0 and tokens[start - 1].group() not in _SHELL_BOUNDARIES:
        start -= 1
    while end < len(tokens) and tokens[end].group() == '\n':
        end += 1
    consumer_start = end
    while end < len(tokens) and tokens[end].group() not in _SHELL_BOUNDARIES:
        end += 1
    producer = tokens[start:pipe]
    consumer = [_word(word) for word in tokens[consumer_start:end]]
    if not producer or _word(producer[0]) not in ('printf', 'echo'):
        return []
    return producer if any(consumer[:len(prefix)] == prefix and '--password-stdin' in consumer[len(prefix):] for prefix in login_prefixes) else []


def _strip_password_input(command: str, login_prefixes: list[list[str]]) -> tuple[str, list[str]]:
    tokens = list(_SHELL_TOKEN.finditer(command))
    redactions: list[re.Match[str]] = []
    for index, token in enumerate(tokens):
        producer = _password_producer(tokens, index, login_prefixes) if token.group() == '|' else []
        if not producer:
            continue
        program, inputs = _word(producer[0]), producer[1:]
        if program == 'printf' and inputs and _word(inputs[0]) in ('%s', '%s\\n', '%b'):
            inputs = inputs[1:]
        if program == 'echo':
            while inputs and re.fullmatch(r'-[neE]+', _word(inputs[0])):
                inputs = inputs[1:]
        redactions.extend(inputs)
    passwords: list[str] = []
    for word in reversed(redactions):
        passwords.extend(filter(None, shlex.split(word.group())))
        command = command[:word.start()] + "'[redacted]'" + command[word.end():]
    return command, passwords


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


class WorkerShellBackend(LocalShellBackend):
    """deepagents' local shell, run in a per-command worker process."""

    def __init__(self, *, command_prefixes: tuple[str, ...] = (), trace_relay_endpoint: str | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._command_prefixes = command_prefixes
        self._trace_relay_endpoint = trace_relay_endpoint

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        response = self._execute(command, timeout=timeout)
        if command and isinstance(command, str):
            self._keep_output(command, response)
        return response

    def _keep_output(self, command: str, response: ExecuteResponse) -> None:
        """Keeps the command and its full output in the Turn's log stream, joined to the tool span, secrets stripped (ADR 0085)."""
        context = trace.get_current_span().get_span_context()
        login_prefixes = [words for prefix in self._command_prefixes if (words := shlex.split(prefix))[-2:] == ['auth', 'login']]
        kept_command, passwords = _strip_password_input(command, login_prefixes)
        literals = sorted(environment_secrets(self._env) + cookie_secrets(command) + passwords, key=len, reverse=True)
        log.info(json.dumps({
            'event': 'harness_shell_output',
            'command': strip_secrets(kept_command, literals),
            'exitCode': response.exit_code,
            'truncated': response.truncated,
            'output': strip_secrets(response.output, literals),
            'traceId': format(context.trace_id, '032x') if context.is_valid else None,
            'spanId': format(context.span_id, '016x') if context.is_valid else None,
        }, separators=(',', ':')))

    def _execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if not command or not isinstance(command, str):
            return ExecuteResponse(output='Error: Command must be a non-empty string.', exit_code=1)
        name = self._command_name(command)
        if name is not None:
            trace.get_current_span().set_attribute('botcube.command.name', name)
        effective_timeout = timeout if timeout is not None else self._default_timeout
        if effective_timeout <= 0:
            raise ValueError(f'timeout must be positive, got {effective_timeout}')

        try:
            # Linux orphan adoption must belong to this invocation, not the shared Harness process.
            result = _run_worker(
                Request(command=command, cwd=str(self.cwd), env=self._command_env(), timeout=effective_timeout, max_output_bytes=self._max_output_bytes)
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

    def _command_env(self) -> dict[str, str]:
        env = dict(self._env)
        if python_path := env.get('PYTHONPATH'):
            instrumentation = str(Path(auto_instrumentation.__file__).parent)
            env['PYTHONPATH'] = os.pathsep.join(part for part in python_path.split(os.pathsep) if part != instrumentation)
        span_context = trace.get_current_span().get_span_context()
        if self._trace_relay_endpoint is None or not span_context.is_valid or not span_context.trace_flags.sampled:
            return {**env, 'OTEL_TRACES_EXPORTER': 'none'}
        count_failures_under(span_context.span_id)
        carrier: dict[str, str] = {}
        TraceContextTextMapPropagator().inject(carrier)
        return {
            **env,
            'TRACEPARENT': carrier['traceparent'],
            'OTEL_TRACES_EXPORTER': 'otlp',
            'OTEL_EXPORTER_OTLP_PROTOCOL': 'http/protobuf',
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': self._trace_relay_endpoint,
        }

    def _command_name(self, command: str) -> str | None:
        if not self._command_prefixes or any(marker in command for marker in ('\n', '`', '$(')):
            return None
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ''
        try:
            words = list(lexer)
        except ValueError:
            # Invalid shell syntax still runs and reports its normal command failure.
            return None
        if any(word and set(word) <= set(';&|()<>') for word in words):
            return None
        for prefix in self._command_prefixes:
            leading = prefix.split()
            if words[:len(leading)] == leading:
                return prefix
        return None

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
