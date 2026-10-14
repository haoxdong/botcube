"""Attended acceptance runs in Safari: the WebDriver session, safaridriver, and the redacted evidence report.

A Cartridge's runner drives its own sign-in steps through `WebDriver`; failures carry only a reason code.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import socket
import subprocess
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'


class RunnerError(RuntimeError):
    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class SafariDriverService:
    def __init__(self, binary: str) -> None:
        self.binary = binary
        self.process: subprocess.Popen[bytes] | None = None
        self.url: str | None = None

    def start(self) -> str:
        if sys.platform != 'darwin' or shutil.which(self.binary) is None:
            raise RunnerError('safari_unavailable')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        self.url = f'http://127.0.0.1:{port}'
        try:
            self.process = subprocess.Popen(
                [self.binary, '--port', str(port)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise RunnerError('safari_unavailable') from exc
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RunnerError('safari_remote_automation_unavailable')
            try:
                with urlopen(f'{self.url}/status', timeout=0.25):
                    return self.url
            except (HTTPError, URLError, TimeoutError):
                time.sleep(0.1)
        raise RunnerError('safari_remote_automation_unavailable')

    def close(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)


@dataclass(frozen=True)
class EvidenceRow:
    stage: str
    timestamp: str
    status: str
    duration_ms: int
    reason_code: str


def write_report(path: Path, rows: list[EvidenceRow], stages: Sequence[str]) -> None:
    """The run's evidence as a Markdown table: one row per stage, in order, carrying only status and reason codes."""
    if [row.stage for row in rows] != list(stages):
        raise RunnerError('invalid_evidence')
    if any(
        row.status not in {'passed', 'failed', 'skipped'}
        or not row.reason_code.replace('_', '').isalnum()
        for row in rows
    ):
        raise RunnerError('invalid_evidence')
    lines = [
        '| stage | timestamp | status | duration_ms | reason_code |',
        '| --- | --- | --- | ---: | --- |',
        *(
            f'| {row.stage} | {row.timestamp} | {row.status} | '
            f'{row.duration_ms} | {row.reason_code} |'
            for row in rows
        ),
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(lines) + '\n')


def timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def evidence_row(stage: str, status: str, reason_code: str, started: float) -> EvidenceRow:
    return EvidenceRow(
        stage=stage,
        timestamp=timestamp(),
        status=status,
        duration_ms=max(0, round((time.monotonic() - started) * 1000)),
        reason_code=reason_code,
    )


def ensure_report_writable(path: Path) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        probe = path.with_name(f'.{path.name}.preflight-{os.getpid()}')
        descriptor = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        probe.unlink()
    except OSError as exc:
        raise RunnerError('report_unwritable') from exc


def prompt_exact(prompt: str, expected: str, timeout_seconds: float) -> bool:
    """Ask the operator on stderr; whether they typed exactly `expected` before the timeout."""
    print(prompt, end='', file=sys.stderr, flush=True)
    ready, _, _ = select.select([sys.stdin], [], [], timeout_seconds)
    if not ready:
        raise RunnerError('confirmation_timeout')
    return sys.stdin.readline().strip() == expected


class WebDriver:
    """A W3C WebDriver session in Safari; every failure is a `RunnerError` reason code."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip('/') + '/'
        self.session_id: str | None = None

    def open(self) -> None:
        response = self.command(
            'POST',
            'session',
            {
                'capabilities': {
                    'alwaysMatch': {
                        'browserName': 'Safari',
                        # The live DCV stream keeps page-load resources open;
                        # waiting for the normal load event can make Safari's
                        # WebDriver /url command time out before the app is
                        # interactive.
                        'pageLoadStrategy': 'eager',
                    },
                },
            },
        )
        value = response.get('value')
        session_id = value.get('sessionId') if isinstance(value, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise RunnerError('webdriver_session_failed')
        self.session_id = session_id
        self.command(
            'POST',
            self.path('timeouts'),
            {'implicit': 0, 'pageLoad': 20_000, 'script': 20_000},
        )

    def navigate(self, app_url: str) -> None:
        self.command('POST', self.path('url'), {'url': app_url})

    def refresh(self) -> None:
        self.command('POST', self.path('refresh'), {})

    def wait_for_element(self, xpath: str, timeout: float = 60) -> str:
        deadline = time.monotonic() + timeout
        while True:
            try:
                return self.find(xpath)
            except RunnerError as exc:
                if exc.reason_code != 'required_control_missing':
                    raise
                if time.monotonic() >= deadline:
                    raise RunnerError('required_control_missing') from exc
                time.sleep(0.25)

    def find(self, xpath: str) -> str:
        response = self.command(
            'POST',
            self.path('element'),
            {'using': 'xpath', 'value': xpath},
        )
        value = response.get('value')
        element = value.get(_ELEMENT_KEY) if isinstance(value, dict) else None
        if not isinstance(element, str) or not element:
            raise RunnerError('required_control_missing')
        return element

    def click(self, element: str) -> None:
        self.command('POST', self.path(f'element/{element}/click'), {})

    def text(self, element: str) -> str:
        response = self.command('GET', self.path(f'element/{element}/text'))
        value = response.get('value')
        if not isinstance(value, str):
            raise RunnerError('webdriver_command_failed')
        return value

    def execute_async(self, script: str) -> object:
        """The value the page script passes to its callback, the last of its `arguments`."""
        return self.command(
            'POST',  # pragma: no mutate: urllib sends a request with a body as POST when its method is None
            self.path('execute/async'),
            {'script': script, 'args': []},
        ).get('value')

    def execute_sync(self, script: str) -> object:
        return self.command('POST', self.path('execute/sync'), {'script': script, 'args': []}).get('value')

    def close(self) -> None:
        if self.session_id is None:
            return
        try:
            self.command('DELETE', f'session/{self.session_id}')
        finally:
            self.session_id = None

    def path(self, suffix: str) -> str:
        if self.session_id is None:
            raise RunnerError('webdriver_session_failed')
        return f'session/{self.session_id}/{suffix}'

    def command(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode()
        request = Request(
            urljoin(self.base_url, path),
            data=body,
            method=method,
            headers={'Content-Type': 'application/json'},
        )
        try:
            with urlopen(request, timeout=60) as response:
                decoded = json.loads(response.read() or b'{}')
        except HTTPError as exc:
            raise RunnerError(_http_error_reason_code(exc, path)) from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RunnerError('webdriver_command_failed') from exc
        if not isinstance(decoded, dict):
            raise RunnerError('webdriver_command_failed')
        return decoded


def _http_error_reason_code(exc: HTTPError, path: str) -> str:
    try:
        failure = json.loads(exc.read() or b'{}')
    except json.JSONDecodeError:
        failure = {}
    value = failure.get('value') if isinstance(failure, dict) else None
    error = value.get('error') if isinstance(value, dict) else None
    if path == 'session' and error == 'session not created':
        return 'safari_remote_automation_unavailable'
    if error == 'no such element':
        return 'required_control_missing'
    return 'webdriver_command_failed'
