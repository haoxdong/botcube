from __future__ import annotations

import json
import logging
import os
import shlex
import sys
import time
import venv
from pathlib import Path

import pytest
from deepagents.backends.protocol import ExecuteResponse
from opentelemetry.instrumentation import auto_instrumentation
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.sampling import ALWAYS_OFF

from botcube_harness_deepagents.shell_backend import WorkerShellBackend


def _backend(tmp_path: Path) -> WorkerShellBackend:
    return WorkerShellBackend(
        root_dir=tmp_path,
        virtual_mode=True,
        timeout=60,
        inherit_env=False,
    )


@pytest.mark.integration
def test_a_command_runs_in_the_backend_root(tmp_path: Path) -> None:
    assert _backend(tmp_path).execute('echo hello') == ExecuteResponse(output='hello\n', exit_code=0)


@pytest.mark.integration
@pytest.mark.parametrize('exit_code', [0, 7])
def test_tool_python_does_not_load_the_harness_instrumentation(tmp_path: Path, exit_code: int) -> None:
    tools = tmp_path / 'python-tools'
    venv.EnvBuilder(with_pip=False).create(tools)
    modules = tmp_path / 'modules'
    modules.mkdir()
    (modules / 'shell_helper.py').write_text("result = 'tool result'\n")
    instrumentation = str(Path(auto_instrumentation.__file__).parent)
    backend = WorkerShellBackend(
        root_dir=tmp_path, inherit_env=False,
        env={'PYTHONPATH': os.pathsep.join([instrumentation, str(modules)])},
    )
    program = f'import shell_helper, sys; print(shell_helper.result); sys.exit({exit_code})'

    result = backend.execute(f'{shlex.quote(str(tools / "bin/python"))} -c {shlex.quote(program)}')

    assert result.exit_code == exit_code
    assert result.output == ('tool result\n' if exit_code == 0 else 'tool result\n\nExit code: 7')


def test_a_command_keeps_its_own_timeout(tmp_path: Path) -> None:
    result = _backend(tmp_path).execute('echo slow && sleep 5', timeout=1)

    assert result.exit_code == 124
    assert result.output.startswith('Error: Command timed out after 1 seconds')


def test_a_command_keeps_the_output_cap(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, max_output_bytes=16, inherit_env=False)

    result = backend.execute('printf "%050d" 0')

    assert result.exit_code == 0
    assert result.truncated is True
    assert result.output.startswith('0000000000000000')


def test_timeout_terminates_pipeline_descendants(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute('(sleep 2; touch survived) | cat', timeout=1)

    assert result.exit_code == 124
    time.sleep(1.5)
    assert not (tmp_path / 'survived').exists()


def test_nonzero_command_keeps_stderr_and_status(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute('printf "failure\\n" >&2; exit 7')

    assert result == ExecuteResponse(output='[stderr] failure\n\nExit code: 7', exit_code=7)


def test_command_without_output_keeps_the_upstream_result(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)

    assert backend.execute('true') == ExecuteResponse(output='<no output>', exit_code=0)


def test_invalid_command_and_timeout_keep_the_upstream_errors(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)

    assert backend.execute('') == ExecuteResponse(output='Error: Command must be a non-empty string.', exit_code=1)
    with pytest.raises(ValueError, match='timeout must be positive, got 0'):
        backend.execute('true', timeout=0)


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux runtime process ownership')
def test_timeout_terminates_detached_descendants(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute("setsid sh -c 'sleep 2; touch survived' >/dev/null 2>&1 & wait", timeout=1)

    assert result.exit_code == 124
    time.sleep(1.5)
    assert not (tmp_path / 'survived').exists()


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux runtime process ownership')
def test_timeout_does_not_wait_for_detached_output_pipes(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    started = time.monotonic()

    result = backend.execute("setsid sh -c 'sleep 4' & wait", timeout=1)

    assert result.exit_code == 124
    assert time.monotonic() - started < 2.5


@pytest.mark.integration
@pytest.mark.skipif(sys.platform != 'linux', reason='Linux peak memory units')
def test_large_output_is_bounded_while_the_command_runs(tmp_path: Path) -> None:
    import subprocess
    import sys

    probe = '''
import os
import resource
from pathlib import Path
from threading import Event, Thread
from botcube_harness_deepagents.shell_backend import WorkerShellBackend
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
    result = WorkerShellBackend(root_dir='.', max_output_bytes=100000).execute('head -c 67108864 /dev/zero; sleep 0.2')
    assert result.exit_code == 0 and result.truncated
    endless = WorkerShellBackend(root_dir='.', max_output_bytes=100000).execute('yes', timeout=1)
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
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)

    result = backend.execute("(sleep 0.2; touch completed) >/dev/null 2>&1 &", timeout=1)

    assert result.exit_code == 0
    deadline = time.monotonic() + 2
    while not (tmp_path / 'completed').exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert (tmp_path / 'completed').exists()


def test_timeout_does_not_kill_a_concurrent_invocation(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor

    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    with ThreadPoolExecutor(max_workers=2) as executor:
        surviving = executor.submit(backend.execute, 'sleep 1.5; echo completed', timeout=3)
        timed_out = executor.submit(backend.execute, 'sleep 5', timeout=1)

    assert timed_out.result().exit_code == 124
    assert surviving.result() == ExecuteResponse(output='completed\n', exit_code=0)


def test_missing_working_directory_reports_execution_failure(tmp_path: Path) -> None:
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    backend = WorkerShellBackend(root_dir=workspace, inherit_env=False)
    workspace.rmdir()

    result = backend.execute('true')

    assert result.exit_code == 1
    assert 'FileNotFoundError' in result.output
    assert '<no output>' not in result.output


_TRACE_ENV = 'printf "%s|" "${TRACEPARENT-unset}" "$OTEL_TRACES_EXPORTER" "${OTEL_EXPORTER_OTLP_PROTOCOL-unset}" "${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT-unset}"'
_RELAY = 'http://127.0.0.1:4318/v1/traces'


@pytest.mark.integration
def test_a_command_exports_its_spans_to_the_relay_under_the_active_span(tmp_path: Path) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False, env={'OTEL_TRACES_EXPORTER': 'otlp'}, trace_relay_endpoint=_RELAY)

    with TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span:
        result = backend.execute(_TRACE_ENV)
    context = span.get_span_context()

    assert result.output == f'00-{context.trace_id:032x}-{context.span_id:016x}-{context.trace_flags:02x}|otlp|http/protobuf|{_RELAY}|'
    assert backend.execute(_TRACE_ENV).output == 'unset|none|unset|unset|'


@pytest.mark.integration
@pytest.mark.parametrize(('relay', 'tracer_provider'), [
    (None, TracerProvider()),
    (_RELAY, None),
    (_RELAY, TracerProvider(sampler=ALWAYS_OFF)),
], ids=['no relay', 'no active span', 'unsampled span'])
def test_a_command_exports_no_spans_without_a_relay_and_a_sampled_span(
    tmp_path: Path, relay: str | None, tracer_provider: TracerProvider | None,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False, env={'OTEL_TRACES_EXPORTER': 'otlp'}, trace_relay_endpoint=relay)

    if tracer_provider is None:
        result = backend.execute(_TRACE_ENV)
    else:
        with tracer_provider.get_tracer(__name__).start_as_current_span('execute_tool shell'):
            result = backend.execute(_TRACE_ENV)

    assert result.output == 'unset|none|unset|unset|'


_DEBUG_OUTPUT = """* Request to https://api.example.com/v1/data?access_token=query-secret-1&dataset=EDRVOL
> GET /v1/data?access_token=query-secret-1&dataset=EDRVOL
> authorization: Bearer abcdefgh-header-secret
> cookie: APP_SESSION=cookie-secret-2
> x-botcube-session-id: owner-session-3
< 200 OK
< set-cookie: GSSSO=cookie-secret-4; HttpOnly
{"sessionId":"session-secret-5","chart":"https://bucket.s3.amazonaws.com/c.png?X-Amz-Signature=signed-secret-6"}
ran with env-token-secret-7
{"success":true,"data":{"cookies":[{"name":"ExampleLogin","value":"opaque-cookie-secret-9","path":"/","secure":true},
 {"name":"pref","value":"theme","path":"/"}]}}
{"rows":[{"name":"EDRVOL","value":"1.25"}]}"""


@pytest.mark.integration
@pytest.mark.parametrize(('redirect', 'exit_code'), [('', 0), ('>&2', 3)], ids=['stdout-success', 'stderr-failure'])
def test_a_command_keeps_its_output_in_the_log_under_the_tool_span_with_secrets_stripped(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, redirect: str, exit_code: int,
) -> None:
    (tmp_path / 'debug.txt').write_text(_DEBUG_OUTPUT)
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False, env={'APP_AUTH_TOKEN': 'env-token-secret-7'})

    command = f'cat debug.txt {redirect}; cli data view --token flag-secret-8; exit {exit_code}'
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert {key: record[key] for key in ('event', 'exitCode', 'traceId', 'spanId')} == {
        'event': 'harness_shell_output', 'exitCode': exit_code, 'traceId': f'{context.trace_id:032x}', 'spanId': f'{context.span_id:016x}',
    }
    assert record['command'] == f'cat debug.txt {redirect}; cli data view --token [redacted]; exit {exit_code}'
    assert 'dataset=EDRVOL' in record['output'] and '/v1/data' in record['output']
    assert '"name":"ExampleLogin"' in record['output'] and '"secure":true' in record['output']
    assert '{"rows":[{"name":"EDRVOL","value":"1.25"}]}' in record['output']
    assert result.exit_code == exit_code
    assert 'opaque-cookie-secret-9' in result.output
    kept = json.dumps(record)
    for secret in [f'secret-{n}' for n in range(1, 10)] + ['owner-session-3', 'theme']:
        assert secret not in kept
    assert 'cookie-secret-2' in result.output


@pytest.mark.integration
@pytest.mark.parametrize('quote', ["'", '"'], ids=['single-quoted', 'double-quoted'])
@pytest.mark.parametrize(('redirect', 'exit_code'), [('', 0), ('>&2', 3)], ids=['stdout-success', 'stderr-failure'])
def test_a_quoted_cookie_header_is_stripped_from_the_kept_command_and_output(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, quote: str, redirect: str, exit_code: int,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    header = 'Cookie: a=first-secret; ExampleLogin=opaque-cookie-secret'
    command = f"printf '%s' {quote}{header}{quote} {redirect}; printf '\\nordinary=value'; exit {exit_code}"
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell'),
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]

    assert record['command'] == f"printf '%s' {quote}Cookie: [redacted]{quote} {redirect}; printf '\\nordinary=value'; exit {exit_code}"
    assert 'first-secret' not in json.dumps(record)
    assert 'opaque-cookie-secret' not in json.dumps(record)
    assert 'ordinary=value' in record['output']
    assert header in result.output
    assert result.exit_code == record['exitCode'] == exit_code


@pytest.mark.integration
@pytest.mark.parametrize(('producer', 'login'), [
    ("printf '%s' 'opaque-login-42'", ' | cli auth login --password-stdin'),
    ('echo "opaque-login-42"', ' | cli auth login --password-stdin'),
    ("printf 'opaque-login-42'", ' | cli auth login --password-stdin'),
    ("printf '%s' 'opaque-login-42'", ' |\n cli auth login "--password-stdin"'),
    ('echo -n "opaque-login-42"', ' | cli auth login --password-stdin'),
], ids=['printf', 'echo', 'printf-format', 'continued-quoted-option', 'echo-option'])
@pytest.mark.parametrize(('redirect', 'exit_code'), [('', 0), ('>&2', 3)], ids=['stdout-success', 'stderr-failure'])
def test_a_password_stdin_pipeline_keeps_no_password_and_preserves_execution(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, producer: str, login: str, redirect: str, exit_code: int,
) -> None:
    (tmp_path / 'cli').write_text(
        '#!/bin/sh\n'
        'input=$(cat)\n'
        '[ "$input" = "opaque-login-42" ] || exit 99\n'
        f'printf "ordinary=EDRVOL" {redirect}\n'
        f'exit {exit_code}\n'
    )
    (tmp_path / 'cli').chmod(0o755)
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False, command_prefixes=('cli auth login',), env={'PATH': f'{tmp_path}:/usr/bin:/bin'})
    command = f"{producer}{login}; status=$?; printf '\\nordinary=value'; exit $status"
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert result == ExecuteResponse(
        output='ordinary=EDRVOL\nordinary=value' if exit_code == 0 else '\nordinary=value\n[stderr] ordinary=EDRVOL\n\nExit code: 3',
        exit_code=exit_code,
        truncated=False,
    )
    assert record['output'] == result.output
    assert record['exitCode'] == exit_code
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'
    assert 'opaque-login-42' not in record['command']
    assert f"{login}; status=$?; printf '\\nordinary=value'; exit $status" in record['command']
    if producer.startswith('echo -n'):
        assert record['command'].startswith('echo -n ')


@pytest.mark.integration
@pytest.mark.parametrize('producer', [
    "printf '%s' 'opaque-login-42'",
    'echo "opaque-login-42"',
    r"printf '%s' opaque\-login-42",
])
@pytest.mark.parametrize('exit_code', [0, 3], ids=['success', 'failure'])
def test_traced_password_stdin_redacts_retained_output(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, producer: str, exit_code: int,
) -> None:
    (tmp_path / 'cli').write_text(f'#!/bin/sh\ncat >/dev/null\nprintf ordinary=value\nexit {exit_code}\n')
    (tmp_path / 'cli').chmod(0o755)
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False, command_prefixes=('cli auth login',), env={'PATH': f'{tmp_path}:/usr/bin:/bin'})
    command = f'set -x; {producer} | cli auth login --password-stdin'
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert 'opaque-login-42' in result.output
    assert 'ordinary=value' in result.output
    assert record['output'] == result.output.replace('opaque-login-42', '[redacted]')
    assert 'opaque-login-42' not in json.dumps(record)
    assert record['exitCode'] == result.exit_code == exit_code
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'


@pytest.mark.integration
@pytest.mark.parametrize('command', [
    "printf '%s' 'ordinary=value' | cat",
    "printf '%s' 'echo ordinary | cli auth login --password-stdin '",
])
def test_an_ordinary_pipeline_keeps_its_command_and_output(tmp_path: Path, caplog: pytest.LogCaptureFixture, command: str) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False, command_prefixes=('cli auth login',))
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]

    assert record['command'] == command
    assert record['output'] == result.output
    assert 'ordinary' in result.output
    assert result.exit_code == 0


@pytest.mark.integration
@pytest.mark.parametrize(('text', 'stripped', 'secret'), [
    ("{'access_token': 'opaque-private-token', 'dataset': 'EDRVOL', 'value': '1.25'}",
     "{'access_token': '[redacted]', 'dataset': 'EDRVOL', 'value': '1.25'}", 'opaque-private-token'),
    ('{"password": "prefix\\\"private-suffix", "dataset": "EDRVOL", "value": "1.25"}',
     '{"password": "[redacted]", "dataset": "EDRVOL", "value": "1.25"}', 'private-suffix'),
], ids=['python-notation', 'escaped-json-quote'])
@pytest.mark.parametrize(('redirect', 'exit_code'), [('', 0), ('>&2', 3)], ids=['stdout-success', 'stderr-failure'])
def test_quoted_credentials_are_stripped_from_kept_command_and_output(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, text: str, stripped: str, secret: str, redirect: str, exit_code: int,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    command = f"cat <<'PAYLOAD' {redirect}\n{text}\nPAYLOAD\nexit {exit_code}"
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert record['command'] == f"cat <<'PAYLOAD' {redirect}\n{stripped}\nPAYLOAD\nexit {exit_code}"
    assert record['output'] == (f'[stderr] {stripped}\n\nExit code: 3' if exit_code else f'{stripped}\n')
    assert secret not in json.dumps(record)
    assert result.output == (f'[stderr] {text}\n\nExit code: 3' if exit_code else f'{text}\n')
    assert result.exit_code == record['exitCode'] == exit_code
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'


@pytest.mark.integration
@pytest.mark.parametrize('argument', [
    "--cookie 'a=opaque-first; b=opaque-second'",
    '--cookie="a=opaque-first; b=opaque-second"',
    "-b 'a=opaque-first; b=opaque-second'",
    '-b"a=opaque-first; b=opaque-second"',
    '--cookie a=opaque-first',
    '-ba=opaque-first',
    "-kb 'a=opaque-first; b=opaque-second'",
    '-kba=opaque-first',
    "-sb 'a=opaque-first; b=opaque-second'",
    '-sba=opaque-first',
    "--cookie 'a=opaque-first\\\ncontinued; b=opaque-second'",
])
@pytest.mark.parametrize(('redirect', 'exit_code'), [('', 0), ('>&2', 3)], ids=['stdout-success', 'stderr-failure'])
def test_curl_cookie_arguments_are_stripped_from_kept_command_and_output(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, argument: str, redirect: str, exit_code: int,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    command = f"curl() {{ printf 'curl %s\\n' \"$*\"; }}; curl {argument} https://example.com/data?dataset=EDRVOL {redirect}; exit {exit_code}"
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert 'opaque-first' not in json.dumps(record)
    assert 'opaque-second' not in json.dumps(record)
    assert '[redacted]' in record['command']
    assert 'https://example.com/data?dataset=EDRVOL' in record['command']
    assert 'https://example.com/data?dataset=EDRVOL' in record['output']
    output = "curl " + argument.replace("\"", "").replace("'", "")
    output += ' https://example.com/data?dataset=EDRVOL\n'
    stderr_output = '[stderr] ' + output.rstrip().replace('\n', '\n[stderr] ') + '\n\nExit code: 3'
    assert result.output == (stderr_output if exit_code else output)
    assert result.exit_code == record['exitCode'] == exit_code
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'


@pytest.mark.integration
@pytest.mark.parametrize(('redirect', 'exit_code', 'cap', 'prefix', 'secret'), [
    ('', 0, 36, '', 'opaque-private-auth'), ('>&2', 3, 45, '[stderr] ', 'opaque-private-auth'),
    ('', 0, 28, '', 'opaque-priv'), ('>&2', 3, 37, '[stderr] ', 'opaque-priv'),
])
def test_capped_named_secrets_preserve_agent_output_but_leave_no_retained_credential(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, redirect: str, exit_code: int, cap: int, prefix: str, secret: str,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False, max_output_bytes=cap)
    command = f"""printf '%s' '{{"access_token":"opaque-private-auth"}}' {redirect}; exit {exit_code}"""
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    expected = prefix + '{"access_token":"' + secret
    expected += f'\n\n... Output truncated at {cap} bytes.'
    if exit_code:
        expected += '\n\nExit code: 3'
    assert result.output == expected
    assert result.exit_code == record['exitCode'] == exit_code
    assert result.truncated is record['truncated'] is True
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'
    assert record['output'] == expected.replace(secret, '[redacted]"')
    assert secret not in json.dumps(record)


@pytest.mark.integration
@pytest.mark.parametrize('malformed_command', [False, True], ids=['successful-truncated-output', 'malformed-command'])
def test_truncated_cookie_snippets_preserve_shell_results(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, malformed_command: bool,
) -> None:
    snippet = "curl --cookie a='opaque-first"
    command = snippet if malformed_command else (
        "curl() { printf \"curl --cookie a='%s\" \"${2#a=}\"; }; curl --cookie a='opaque-first'"
    )
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert 'opaque-first' not in json.dumps(record)
    assert result.exit_code == record['exitCode'] == (2 if malformed_command else 0)
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'
    if malformed_command:
        assert 'unexpected EOF' in result.output
        assert record['output'] == result.output
    else:
        assert result.output == snippet
        assert record['output'] == 'curl --cookie [redacted]'


@pytest.mark.integration
@pytest.mark.parametrize('argument', [
    "--proxy-user 'alice:opaque-private-auth'",
    '--proxy-user="alice:opaque-private-auth"',
    "-U 'alice:opaque-private-auth'",
    '-Ualice:opaque-private-auth',
    "-kU 'alice:opaque-private-auth'",
    '-kUalice:opaque-private-auth',
    "-ku 'alice:opaque-private-auth'",
    '-kualice:opaque-private-auth',
    "-sSU 'alice:opaque-private-auth'",
    '-sSUalice:opaque-private-auth',
    "--user 'alice:opaque-private-auth'",
    '--user="alice:opaque-private-auth"',
    "-u 'alice:opaque-private-auth'",
    '-ualice:opaque-private-auth',
    "-sSu 'alice:opaque-private-auth'",
    '-sSualice:opaque-private-auth',
    "--oauth2-bearer 'opaque-private-auth'",
    '--oauth2-bearer=opaque-private-auth',
])
@pytest.mark.parametrize(('redirect', 'exit_code'), [('', 0), ('>&2', 3)], ids=['stdout-success', 'stderr-failure'])
def test_curl_user_credentials_are_stripped_from_kept_command_and_output(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, argument: str, redirect: str, exit_code: int,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    command = f"curl() {{ printf '%s' opaque-private-auth; }}; curl {argument} https://example.com/data?dataset=EDRVOL {redirect}; exit {exit_code}"
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert 'opaque-private-auth' not in json.dumps(record)
    assert '[redacted]' in record['command']
    assert 'https://example.com/data?dataset=EDRVOL' in record['command']
    assert result.output == ('[stderr] opaque-private-auth\n\nExit code: 3' if exit_code else 'opaque-private-auth')
    assert record['output'] == ('[stderr] [redacted]\n\nExit code: 3' if exit_code else '[redacted]')
    assert result.exit_code == record['exitCode'] == exit_code
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'


@pytest.mark.integration
@pytest.mark.parametrize('option', ['--proxy-user', '-U'])
def test_failed_curl_proxy_credentials_are_stripped_from_retained_execution(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, option: str,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    command = f"set -x; curl {option} 'synthetic:opaque-proxy-42' --connect-timeout 1 http://127.0.0.1:1"
    with (
        caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'),
        TracerProvider().get_tracer(__name__).start_as_current_span('execute_tool shell') as span,
    ):
        result = backend.execute(command)
    [record] = [json.loads(message) for message in caplog.messages]
    context = span.get_span_context()

    assert result.exit_code == record['exitCode'] == 7
    assert 'opaque-proxy-42' in result.output
    assert 'opaque-proxy-42' not in json.dumps(record)
    assert f'curl {option}' in record['command']
    assert 'http://127.0.0.1:1' in record['command']
    assert 'http://127.0.0.1:1' in record['output']
    assert record['traceId'] == f'{context.trace_id:032x}'
    assert record['spanId'] == f'{context.span_id:016x}'


@pytest.mark.integration
@pytest.mark.parametrize('argument', [
    "-kb 'ExampleLogin=opaque-private-auth'",
    '-kbExampleLogin=opaque-private-auth',
    "-ku 'alice:opaque-private-auth'",
    '-kualice:opaque-private-auth',
    "-kU 'alice:opaque-private-auth'",
    '-kUalice:opaque-private-auth',
])
def test_real_curl_insecure_bundles_strip_retained_credentials(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, argument: str,
) -> None:
    backend = WorkerShellBackend(root_dir=tmp_path, inherit_env=False)
    with caplog.at_level(logging.INFO, logger='botcube_harness_deepagents.shell_backend'):
        result = backend.execute(f'curl {argument} --version')
    [record] = [json.loads(message) for message in caplog.messages]

    assert result.exit_code == record['exitCode'] == 0
    assert result.output.startswith('curl ')
    assert record['output'] == result.output
    assert 'opaque-private-auth' not in record['command']
    assert '[redacted]' in record['command']
    assert record['command'].endswith(' --version')
