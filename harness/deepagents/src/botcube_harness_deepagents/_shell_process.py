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
from typing import BinaryIO, TypedDict, cast


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


def _read_ready(selector: selectors.BaseSelector, buffers: dict[int, bytearray], limit: int) -> bool:
    overflow = False
    for key, _ in selector.select(timeout=0.02):
        stream = cast(BinaryIO, key.fileobj)
        chunk = os.read(stream.fileno(), 65536)
        if not chunk:
            selector.unregister(stream)
            continue
        buffer = buffers[stream.fileno()]
        available = max(0, limit + 1 - len(buffer))
        buffer.extend(chunk[:available])
        overflow |= len(buffer) > limit
    return overflow


def _capture(process: subprocess.Popen[bytes], request: Request) -> Result:
    assert process.stdout is not None and process.stderr is not None
    buffers = {process.stdout.fileno(): bytearray(), process.stderr.fileno(): bytearray()}
    deadline = time.monotonic() + request['timeout']
    overflow = False
    timed_out = False
    with selectors.DefaultSelector() as selector:
        for stream in (process.stdout, process.stderr):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map() or process.poll() is None:
            if time.monotonic() >= deadline:
                timed_out = True
                break
            overflow |= _read_ready(selector, buffers, request['max_output_bytes'])
        exit_code = process.poll()
    return Result(
        stdout=buffers[process.stdout.fileno()].decode('utf-8', errors='replace'),
        stderr=buffers[process.stderr.fileno()].decode('utf-8', errors='replace'),
        exit_code=exit_code if exit_code is not None else 124,
        timed_out=timed_out,
        overflow=overflow,
    )


def run(request: Request) -> Result:
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
        result = _capture(process, request)
        cleanup_required = result['timed_out']
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
        print(json.dumps(run(request)))
    except Exception as error:
        print(json.dumps({'error': f'{type(error).__name__}: {error}'}))
        raise SystemExit(1) from error


if __name__ == '__main__':
    main()
