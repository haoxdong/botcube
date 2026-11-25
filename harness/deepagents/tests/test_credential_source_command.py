from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from botcube_credential_source import (
    Credential,
    CredentialSourceError,
    credential_source,
)

START = 1_795_000_000.0
OPTED_IN = {'BOTCUBE_ALLOW_COMMAND_CREDENTIALS': '1'}
pytestmark = pytest.mark.integration
NAMED = f'^models credential \\(command {sys.executable}\\): '


def _helper(tmp_path: Path, script: str) -> list[str]:
    path = tmp_path / 'helper.py'
    path.write_text(script)
    return [sys.executable, str(path)]


def _exec_credential(status: dict[str, str]) -> str:
    return json.dumps({'kind': 'ExecCredential', 'status': status})


def _printing(tmp_path: Path, status: dict[str, str]) -> list[str]:
    return _helper(tmp_path, f'import sys; sys.stdout.write({_exec_credential(status)!r})')


def _source(command: list[str], timeout_seconds: int = 30) -> dict[str, object]:
    return {'kind': 'command', 'command': command, 'timeoutSeconds': timeout_seconds}


def test_gives_the_token_and_expiry_of_the_exec_credential_it_prints(tmp_path: Path) -> None:
    command = _printing(tmp_path, {'token': 'gw-token', 'expirationTimestamp': '2026-11-19T13:00:00Z'})

    credential = credential_source('models', _source(command), env=OPTED_IN).get()

    assert credential == Credential(value='gw-token', expires_at=1_795_093_200.0)


def test_keeps_a_token_printed_without_an_expiry(tmp_path: Path) -> None:
    command = _printing(tmp_path, {'token': 'gw-token'})
    assert credential_source('models', _source(command), env=OPTED_IN).get() == Credential(value='gw-token', expires_at=None)


def test_runs_the_command_again_a_minute_before_its_token_expires(tmp_path: Path) -> None:
    command = _helper(tmp_path, f'''
import pathlib, sys
counter = pathlib.Path(__file__).with_name('runs')
runs = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(runs))
sys.stdout.write({_exec_credential({'expirationTimestamp': '2026-11-19T12:10:00Z'})!r}.replace('"status": {{', '"status": {{"token": "gw-token-%d", ' % runs))
''')
    clock = [1_795_089_600.0]  # 2026-11-19T12:00:00Z
    source = credential_source('models', _source(command), env=OPTED_IN, now=lambda: clock[0])

    assert source.get().value == 'gw-token-1'
    clock[0] += 240
    assert source.get().value == 'gw-token-1'
    clock[0] += 301
    assert source.get().value == 'gw-token-2'


def test_fails_naming_its_seam_and_program_without_its_output(tmp_path: Path) -> None:
    command = _helper(tmp_path, 'import sys; print("sk-leaked"); print("sk-leaked", file=sys.stderr); sys.exit(3)')
    with pytest.raises(CredentialSourceError, match=NAMED + 'the command exited with code 3$'):
        credential_source('models', _source(command), env=OPTED_IN).get()


@pytest.mark.parametrize('env', [{}, {'BOTCUBE_ALLOW_COMMAND_CREDENTIALS': 'true'}])
def test_is_refused_unless_the_deploy_opts_in(tmp_path: Path, env: dict[str, str]) -> None:
    with pytest.raises(CredentialSourceError, match=NAMED + 'a command credential runs only when BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1$'):
        credential_source('models', _source(_printing(tmp_path, {'token': 'gw-token'})), env=env)


def test_stops_a_command_that_runs_past_its_timeout(tmp_path: Path) -> None:
    command = _helper(tmp_path, 'import time; time.sleep(60)')
    with pytest.raises(CredentialSourceError, match=NAMED + 'the command did not finish within 1 s$'):
        credential_source('models', _source(command, 1), env=OPTED_IN).get()


@pytest.mark.parametrize('output', [
    'sk-raw-token',
    json.dumps({'kind': 'Secret', 'status': {'token': 'sk-raw-token'}}),
    _exec_credential({'expirationTimestamp': '2026-11-19T13:00:00Z'}),
    _exec_credential({'token': 'sk-raw-token', 'expirationTimestamp': 'soon'}),
])
def test_rejects_malformed_output_without_echoing_it(tmp_path: Path, output: str) -> None:
    command = _helper(tmp_path, f'import sys; sys.stdout.write({output!r})')
    with pytest.raises(CredentialSourceError, match=NAMED + 'the command did not print a Kubernetes ExecCredential with status.token$'):
        credential_source('models', _source(command), env=OPTED_IN).get()


def test_never_passes_the_commands_stderr_on_to_the_services_own(tmp_path: Path) -> None:
    command = _helper(tmp_path, f'import sys; print("sk-on-stderr", file=sys.stderr); sys.stdout.write({_exec_credential({"token": "gw-token"})!r})')
    service = (
        'from botcube_credential_source import credential_source\n'
        f'print(credential_source("models", {_source(command)!r}, env={OPTED_IN!r}).get().value)\n'
    )

    finished = subprocess.run([sys.executable, '-c', service], capture_output=True, text=True, check=True)

    assert finished.stdout == 'gw-token\n'
    assert 'sk-on-stderr' not in finished.stderr
