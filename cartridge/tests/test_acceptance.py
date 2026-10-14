import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from botcube_cartridge.acceptance import (
    EvidenceRow,
    RunnerError,
    SafariDriverService,
    WebDriver,
    write_report,
)

_STAGES = ('prerequisites', 'cleanup')


def _rows() -> list[EvidenceRow]:
    return [
        EvidenceRow('prerequisites', '2026-01-01T00:00:00Z', 'passed', 3, 'prerequisites_ok'),
        EvidenceRow('cleanup', '2026-01-01T00:00:01Z', 'passed', 1, 'no_session'),
    ]


def test_report_is_a_table_of_the_stages_in_order(tmp_path: Path) -> None:
    report = tmp_path / 'out' / 'evidence.md'

    write_report(report, _rows(), _STAGES)

    assert report.read_text().splitlines() == [
        '| stage | timestamp | status | duration_ms | reason_code |',
        '| --- | --- | --- | ---: | --- |',
        '| prerequisites | 2026-01-01T00:00:00Z | passed | 3 | prerequisites_ok |',
        '| cleanup | 2026-01-01T00:00:01Z | passed | 1 | no_session |',
    ]


@pytest.mark.parametrize(
    'rows',
    [
        pytest.param(_rows()[::-1], id='stages out of order'),
        pytest.param(_rows()[:1], id='a stage missing'),
        pytest.param([replace(_rows()[0], status='ok'), _rows()[1]], id='unknown status'),
        pytest.param([replace(_rows()[0], reason_code='user@example.com'), _rows()[1]], id='free text reason'),
    ],
)
def test_report_refuses_rows_that_are_not_redacted_stage_evidence(tmp_path: Path, rows: list[EvidenceRow]) -> None:
    report = tmp_path / 'evidence.md'

    with pytest.raises(RunnerError, match='^invalid_evidence$'):
        write_report(report, rows, _STAGES)

    assert not report.exists()


def test_missing_safaridriver_is_safari_unavailable() -> None:
    with pytest.raises(RunnerError, match='^safari_unavailable$'):
        SafariDriverService('/nonexistent/safaridriver').start()


@contextmanager
def _webdriver(status: int, error: str) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.dumps({'value': {'error': error}}).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize(
    ('status', 'error', 'reason_code'),
    [
        (500, 'session not created', 'safari_remote_automation_unavailable'),
        (500, 'unknown error', 'webdriver_command_failed'),
    ],
)
def test_opening_a_session_maps_webdriver_errors_to_reason_codes(status: int, error: str, reason_code: str) -> None:
    with _webdriver(status, error) as url, pytest.raises(RunnerError, match=f'^{reason_code}$'):
        WebDriver(url).open()


def test_a_missing_element_is_a_missing_control() -> None:
    with _webdriver(404, 'no such element') as url:
        driver = WebDriver(url)
        driver.session_id = 'session'
        with pytest.raises(RunnerError, match='^required_control_missing$'):
            driver.find('//button')
