from __future__ import annotations

import ctypes
import json
import os
import selectors
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path
from typing import TypedDict, cast


class Request(TypedDict):
    command: str
    cwd: str
    env: dict[str, str]
    timeout: int
    max_output_bytes: int


class Result(TypedDict):
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool
    overflow: bool


def _become_subreaper() -> None:
    if sys.platform == 'linux':
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))


def _reap_children(process: subprocess.Popen[bytes]) -> bool:
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return False
        if pid == 0:
            return True
        if pid == process.pid:
            process.returncode = os.waitstatus_to_exitcode(status)


def _direct_children() -> list[int]:
    children: list[int] = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            status = (entry / 'status').read_text()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if f'PPid:\t{os.getpid()}\n' in status:
            children.append(int(entry.name))
    return children


def _cleanup(process: subprocess.Popen[bytes]) -> None:
    if sys.platform != 'linux':
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=1)
        return
    deadline = time.monotonic() + 2
    while True:
        for child in _direct_children():
            with suppress(ProcessLookupError):
                os.kill(child, signal.SIGKILL)
        if not _reap_children(process):
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('Shell descendants did not exit after SIGKILL')
        time.sleep(0.005)


def _read_output(selector: selectors.BaseSelector, fd: int, buffer: bytearray, limit: int) -> None:
    chunk = os.read(fd, 65536)
    if not chunk:
        selector.unregister(fd)
    else:
        buffer.extend(chunk[:max(0, limit + 1 - len(buffer))])


def _capture(process: subprocess.Popen[bytes], request: Request, cancel_fd: int | None) -> Result | None:
    assert process.stdout is not None and process.stderr is not None
    buffers = {process.stdout.fileno(): bytearray(), process.stderr.fileno(): bytearray()}
    deadline = time.monotonic() + request['timeout']
    timed_out = False
    with selectors.DefaultSelector() as selector:
        for stream in (process.stdout, process.stderr):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        if cancel_fd is not None:
            selector.register(cancel_fd, selectors.EVENT_READ)
        while process.poll() is None or any(fd in selector.get_map() for fd in buffers):
            if time.monotonic() >= deadline:
                timed_out = True
                break
            for key, _ in selector.select(timeout=0.02):
                if key.fd == cancel_fd:
                    return None
                _read_output(selector, key.fd, buffers[key.fd], request['max_output_bytes'])
        exit_code = process.poll()
    return Result(
        stdout=buffers[process.stdout.fileno()].decode('utf-8', errors='replace'),
        stderr=buffers[process.stderr.fileno()].decode('utf-8', errors='replace'),
        exit_code=exit_code if exit_code is not None else 124,
        timed_out=timed_out,
        overflow=any(len(buffer) > request['max_output_bytes'] for buffer in buffers.values()),
    )


def run(request: Request, cancel_fd: int | None) -> Result | None:
    _become_subreaper()
    process = subprocess.Popen(
        ['bash', '-c', request['command']],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        env=request['env'],
        cwd=request['cwd'],
        start_new_session=True,
    )
    cleanup_required = True
    try:
        result = _capture(process, request, cancel_fd)
        cleanup_required = result is None or result['timed_out']
    finally:
        if cleanup_required:
            _cleanup(process)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()
    return result


def main() -> None:
    try:
        request = cast(Request, json.load(sys.stdin))
        cancel_fd = int(sys.argv[1]) if len(sys.argv) > 1 else None
        print(json.dumps(run(request, cancel_fd)))
    except Exception as error:
        print(json.dumps({'error': f'{type(error).__name__}: {error}'}))
        raise SystemExit(1) from error


if __name__ == '__main__':
    main()
