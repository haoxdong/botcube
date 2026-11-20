from __future__ import annotations

import logging
import re
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pytest

from botcube_credential_service.credential_source import (
    CredentialSource,
    CredentialSourceError,
    credential_source,
)

START = 1_795_000_000.0
OPTED_IN = {'BOTCUBE_ALLOW_COMMAND_CREDENTIALS': '1'}
pytestmark = pytest.mark.integration


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).isoformat()


def _eventually(condition: Callable[[], bool]) -> bool:
    deadline = time.monotonic() + 10
    while not condition():
        if time.monotonic() > deadline:
            return False
        time.sleep(0.01)
    return True


class _TokenHelper:
    def __init__(self, tmp_path: Path) -> None:
        self._dir = tmp_path
        self.script = tmp_path / 'helper.py'
        self.script.write_text(f'''
import json, pathlib, sys, time
here = pathlib.Path(__file__).parent
runs = here / 'runs'
run = int(runs.read_text()) + 1 if runs.exists() else 1
runs.write_text(str(run))
release = here / f'release-{{run}}'
while run > 1 and not release.exists():
    time.sleep(0.01)
outcome = release.read_text() if run > 1 else {_iso(START + 300)!r}
if outcome == 'fail':
    sys.exit(1)
sys.stdout.write(json.dumps({{'kind': 'ExecCredential', 'status': {{'token': f'token-{{run}}', 'expirationTimestamp': outcome}}}}))
''')

    def runs(self) -> int:
        runs = self._dir / 'runs'
        return int(runs.read_text()) if runs.exists() else 0

    def release(self, run: int, outcome: str) -> None:
        (self._dir / f'release-{run}').write_text(outcome)


def _refreshing_source(tmp_path: Path) -> tuple[list[float], _TokenHelper, CredentialSource]:
    clock = [START]
    helper = _TokenHelper(tmp_path)
    source = credential_source(
        'models', {'kind': 'command', 'command': [sys.executable, str(helper.script)], 'timeoutSeconds': 30},
        env=OPTED_IN, now=lambda: clock[0],
    )
    assert source.get().value == 'token-1'
    return clock, helper, source


def _named() -> str:
    return re.escape(f'models credential (command {sys.executable}): the command exited with code 1')


def _refresh_threads() -> list[threading.Thread]:
    return [thread for thread in threading.enumerate() if thread.name.startswith('credential-refresh')]


def test_serves_its_credential_before_half_the_lifetime_without_minting_again(tmp_path: Path) -> None:
    clock, helper, source = _refreshing_source(tmp_path)
    clock[0] = START + 120

    assert source.get().value == 'token-1'
    assert helper.runs() == 1


def test_answers_n_concurrent_reads_in_the_advisory_window_at_once_with_one_refresh(tmp_path: Path) -> None:
    clock, helper, source = _refreshing_source(tmp_path)
    clock[0] = START + 180

    with ThreadPoolExecutor(8) as pool:
        answers = list(pool.map(lambda _: source.get().value, range(8)))

    assert answers == ['token-1'] * 8
    assert _eventually(lambda: helper.runs() == 2)
    helper.release(2, _iso(START + 480))
    assert _eventually(lambda: source.get().value == 'token-2')
    assert helper.runs() == 2


def test_makes_a_read_in_the_mandatory_window_wait_for_the_refresh(tmp_path: Path) -> None:
    clock, helper, source = _refreshing_source(tmp_path)
    clock[0] = START + 241

    with ThreadPoolExecutor(1) as pool:
        waiting = pool.submit(source.get)
        assert _eventually(lambda: helper.runs() == 2)
        assert not waiting.done()
        helper.release(2, _iso(START + 540))
        assert waiting.result(timeout=10).value == 'token-2'


def test_keeps_serving_its_credential_when_an_advisory_refresh_fails_logging_the_failure_once(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    clock, helper, source = _refreshing_source(tmp_path)
    helper.release(2, 'fail')
    helper.release(3, _iso(START + 480))
    clock[0] = START + 180

    with caplog.at_level(logging.WARNING, logger='botcube_credential_service.credential_source'):
        assert [source.get().value for _ in range(3)] == ['token-1'] * 3
        assert _eventually(lambda: len(caplog.records) == 1)
        assert _eventually(lambda: source.get().value == 'token-3')

    assert [record.getMessage() for record in caplog.records] == [
        f'Credential refresh failed: models credential (command {sys.executable}): the command exited with code 1',
    ]


def test_fails_a_read_in_the_mandatory_window_when_its_refresh_fails(tmp_path: Path) -> None:
    clock, helper, source = _refreshing_source(tmp_path)
    helper.release(2, 'fail')
    clock[0] = START + 241

    with pytest.raises(CredentialSourceError, match=f'^{_named()}$'):
        source.get()


def test_opens_the_advisory_window_no_earlier_than_fifteen_minutes_before_a_long_lived_credential_expires(tmp_path: Path) -> None:
    token = tmp_path / 'token'
    token.write_text('token-1')
    printing = (
        'import json, pathlib, sys; '
        f'sys.stdout.write(json.dumps({{"kind": "ExecCredential", "status": {{"token": pathlib.Path({str(token)!r}).read_text(), '
        f'"expirationTimestamp": {_iso(START + 3600)!r}}}}}))'
    )
    clock = [START]
    source = credential_source(
        'models', {'kind': 'command', 'command': [sys.executable, '-c', printing], 'timeoutSeconds': 30},
        env=OPTED_IN, now=lambda: clock[0],
    )
    source.get()
    token.write_text('token-2')

    clock[0] = START + 44 * 60
    assert source.get().value == 'token-1'
    assert _eventually(lambda: not _refresh_threads())
    assert source.get().value == 'token-1'
    clock[0] = START + 46 * 60
    assert _eventually(lambda: source.get().value == 'token-2')


def test_leaves_no_thread_behind_once_a_refresh_lands(tmp_path: Path) -> None:
    clock, helper, source = _refreshing_source(tmp_path)
    helper.release(2, _iso(START + 480))
    clock[0] = START + 180

    source.get()
    assert _eventually(lambda: source.get().value == 'token-2')

    assert _eventually(lambda: not _refresh_threads())
