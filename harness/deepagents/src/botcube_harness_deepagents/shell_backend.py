from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
from collections.abc import Collection
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
    MIN_LITERAL_SECRET,
    cookie_secrets,
    environment_secrets,
    strip_secrets,
)

log = logging.getLogger(__name__)
_SHELL_WORD = r"""(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\|;&()<>])+"""
_SHELL_TOKEN = re.compile(rf'{_SHELL_WORD}|[|;&()<>]+|\n')
_PROGRAM = re.compile(r'[\w.+-]+')
_SUBCOMMAND = re.compile(r'[a-z][a-z0-9-]*')
_SHELL_BOUNDARIES = {'|', '||', '&', '&&', ';', ';;', '(', ')', '<', '>', '>>', '<<', '\n'}


def _word(token: re.Match[str]) -> str:
    return shlex.split(token.group())[0]


def _piped_literals(tokens: list[re.Match[str]]) -> list[re.Match[str]]:
    """The literal words an `echo` or `printf` just before a pipe writes to the next command's stdin."""
    start = len(tokens)
    while start > 0 and tokens[start - 1].group() not in _SHELL_BOUNDARIES:
        start -= 1
    producer = tokens[start:]
    if not producer or _word(producer[0]) not in ('printf', 'echo'):
        return []
    program, inputs = _word(producer[0]), producer[1:]
    if program == 'printf' and inputs and _word(inputs[0]) in ('%s', '%s\\n', '%b'):
        inputs = inputs[1:]
    if program == 'echo':
        while inputs and re.fullmatch(r'-[neE]+', _word(inputs[0])):
            inputs = inputs[1:]
    return inputs


def _heredoc_body(command: str, newline: int, delimiter: str) -> tuple[int, int, int]:
    """Start and end of the here-document body after `newline`, and the end of its terminator line."""
    strip_tabs, delimiter = delimiter.startswith('-'), delimiter.removeprefix('-')
    start = line = newline + 1
    while line <= len(command):
        end = command.find('\n', line)
        end = len(command) if end < 0 else end
        if (command[line:end].lstrip('\t') if strip_tabs else command[line:end]) == delimiter:
            return start, max(start, line - 1), end
        line = end + 1
    return start, len(command), len(command)


_Stdin = tuple[int, int, str, str]


def _heredoc_bodies(command: str, newline: int, delimiters: list[str]) -> tuple[list[_Stdin], int]:
    """The bodies of the here-documents opened on the line ending at `newline`, and where scanning resumes."""
    bodies: list[_Stdin] = []
    for delimiter in delimiters:
        start, end, newline = _heredoc_body(command, newline, delimiter)
        if end > start:
            bodies.append((start, end, command[start:end], '[redacted]'))
    return bodies, newline


def _redirected_stdin(command: str, token: re.Match[str], heredocs: list[str]) -> tuple[list[_Stdin], int]:
    """A here-string's word, or a here-document's delimiter added to `heredocs`, and where scanning resumes."""
    word = _SHELL_TOKEN.search(command, token.end())
    if word is None or not re.fullmatch(_SHELL_WORD, word.group()):
        return [], token.end()
    if token.group() == '<<':
        heredocs.append(_word(word))
        return [], word.end()
    return [(word.start(), word.end(), word.group(), "'[redacted]'")], word.end()


def _strip_stdin(command: str) -> tuple[str, list[str]]:
    """`command` with every literal it writes to a command's stdin replaced, and those literals.

    Covers `echo`/`printf` piped into any command, here-strings and here-documents: any program
    can read a password from stdin, so no stdin is kept in the Turn's log stream.
    """
    tokens: list[re.Match[str]] = []
    stdin: list[_Stdin] = []
    heredocs: list[str] = []
    position = 0
    while token := _SHELL_TOKEN.search(command, position):
        position = token.end()
        found: list[_Stdin] = []
        if token.group() == '|':
            found = [(word.start(), word.end(), word.group(), "'[redacted]'") for word in _piped_literals(tokens)]
        elif token.group() in ('<<', '<<<'):
            found, position = _redirected_stdin(command, token, heredocs)
        elif token.group() == '\n' and heredocs:
            found, position = _heredoc_bodies(command, token.start(), heredocs)
            heredocs = []
        stdin.extend(found)
        tokens.append(token)
    literals: list[str] = []
    for start, end, text, replacement in reversed(stdin):
        literals.extend(filter(None, [text] if replacement == '[redacted]' else shlex.split(text)))
        command = command[:start] + replacement + command[end:]
    return command, literals


def _strip_words(text: str, words: list[str]) -> str:
    """`text` with each of `words` redacted where it stands as a whole shell word, such as a short password a `set -x` trace echoes."""
    for word in sorted(words, key=len, reverse=True):
        text = re.sub(rf'(?<![^\s\'"=]){re.escape(word)}(?![^\s\'"])', '[redacted]', text)
    return text


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
        # `command_prefixes` is accepted and ignored: every command is named and has its stdin stripped
        # generically. It stays only until Cartridges stop passing `shell_command_prefixes`, then goes.
        del command_prefixes
        super().__init__(**kwargs)
        self._trace_relay_endpoint = trace_relay_endpoint

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        response = self._execute(command, timeout=timeout)
        if command and isinstance(command, str):
            self._keep_output(command, response)
        return response

    def _keep_output(self, command: str, response: ExecuteResponse) -> None:
        """Keeps the command and its full output in the Turn's log stream, joined to the tool span, secrets stripped (ADR 0085)."""
        context = trace.get_current_span().get_span_context()
        kept_command, stdin = _strip_stdin(command)
        echoed_stdin = [literal for literal in stdin if len(literal) >= MIN_LITERAL_SECRET]
        literals = sorted(environment_secrets(self._env) + cookie_secrets(command) + echoed_stdin, key=len, reverse=True)
        output = _strip_words(strip_secrets(response.output, literals), [literal for literal in stdin if len(literal) < MIN_LITERAL_SECRET])
        log.info(json.dumps({
            'event': 'harness_shell_output',
            'command': strip_secrets(kept_command, literals),
            'exitCode': response.exit_code,
            'truncated': response.truncated,
            'output': output,
            'traceId': format(context.trace_id, '032x') if context.is_valid else None,
            'spanId': format(context.span_id, '016x') if context.is_valid else None,
        }, separators=(',', ':')))

    def _execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if not command or not isinstance(command, str):
            return ExecuteResponse(output='Error: Command must be a non-empty string.', exit_code=1)
        name = self._command_name(command, environment_secrets(self._env))
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

    @staticmethod
    def _command_name(command: str, secrets: Collection[str] = ()) -> str | None:
        """`<program> <subcommand>` for one simple command, such as `samplecli reports`, or None.

        The program is the first word's basename; the subcommand is the word right after it, kept only when
        it looks like a subcommand (lowercase letters, digits, dashes) and is not one of `secrets`, so paths,
        URLs, quoted text and flag values (`curl --oauth2-bearer <token>`) never reach the span. A compound
        command, an environment prefix, a substitution or invalid syntax gets no label.
        """
        if any(marker in command for marker in ('\n', '`', '$(')):
            return None
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ''
        try:
            words = list(lexer)
        except ValueError:
            # Invalid shell syntax still runs and reports its normal command failure.
            return None
        if not words or any(word and set(word) <= set(';&|()<>') for word in words):
            return None
        program = words[0].rsplit('/', 1)[-1]
        if '=' in words[0] or not _PROGRAM.fullmatch(program):
            return None
        subcommand = words[1] if len(words) > 1 else ''
        return f'{program} {subcommand}' if _SUBCOMMAND.fullmatch(subcommand) and subcommand not in secrets else program

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
