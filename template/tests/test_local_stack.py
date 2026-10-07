from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import httpx


def _invocation(run_id: str, message_id: str, content: str) -> dict[str, object]:
    """A Turn as the Chat Service forwards it to the Harness."""
    return {
        'threadId': 'thread-local',
        'runId': run_id,
        'state': {},
        'messages': [{'id': message_id, 'role': 'user', 'content': content}],
        'tools': [],
        'context': [],
        'forwardedProps': {'sessionUserId': 'template-user'},
    }


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return int(listener.getsockname()[1])


@contextmanager
def _harness_process(port: int, checkpoint_path: str) -> Iterator[str]:
    with _local_process('botcube_harness_deepagents.serving', port, checkpoint_path) as url:
        yield url


@contextmanager
def _local_process(module: str, port: int, checkpoint_path: str) -> Iterator[str]:
    environment = {
        **os.environ,
        'AGENTCORE_MEMORY_ID': '',
        'BOTCUBE_MODEL': 'echo',
        'BOTCUBE_CHECKPOINT_PATH': checkpoint_path,
        'BOTCUBE_CARTRIDGE_MODULE': 'botcube_template.harness',
        'PORT': str(port),
    }
    process = subprocess.Popen(
        [
            sys.executable,
            '-m',
            module,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    url = f'http://127.0.0.1:{port}'
    try:
        for _ in range(300):
            if process.poll() is not None:
                output = process.stdout.read() if process.stdout else ''
                raise AssertionError(f'{module} exited early:\n{output}')
            try:
                if httpx.get(f'{url}/ping', timeout=0.2).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.05)
        else:
            raise AssertionError(f'{module} did not become healthy')
        yield url
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def test_local_harness_resumes_after_process_replacement(tmp_path: Path) -> None:
    port = _free_port()
    checkpoint_path = str(tmp_path / 'checkpoints.sqlite3')
    with _harness_process(port, checkpoint_path) as harness_url:
        first = httpx.post(
            f'{harness_url}/invocations',
            json=_invocation('run-1', 'message-1', 'first turn'),
            timeout=30,
        )
        assert first.status_code == 200
        assert 'Echo: first turn' in first.text

    with _harness_process(port, checkpoint_path) as harness_url:
        resumed = httpx.post(
            f'{harness_url}/invocations',
            json=_invocation('run-2', 'message-2', 'second turn'),
            timeout=30,
        )

    assert resumed.status_code == 200
    events = [
        json.loads(line.removeprefix('data: '))
        for line in resumed.text.splitlines()
        if line.startswith('data: ')
    ]
    assert events[-1]['type'] == 'RUN_FINISHED'
    with _local_process('botcube_harness_deepagents.session_api', port, checkpoint_path) as session_url:
        history = httpx.post(
            f'{session_url}/invocations',
            json={'operation': 'get', 'sessionId': 'thread-local', 'userId': 'template-user'},
            timeout=30,
        )

    assert history.status_code == 200
    assert [(message['role'], message['content']) for message in history.json()['messages']] == [
        ('user', 'first turn'), ('assistant', 'Echo: first turn'),
        ('user', 'second turn'), ('assistant', 'Echo: second turn'),
    ]


def test_local_harness_files_two_owners_separately_and_rejects_missing_identity(tmp_path: Path) -> None:
    port = _free_port()
    checkpoint_path = str(tmp_path / 'owners.sqlite3')
    with _harness_process(port, checkpoint_path) as harness_url:
        for owner in ('owner-one', 'owner-two'):
            payload = _invocation(owner, owner, owner)
            payload['forwardedProps'] = {'sessionUserId': owner}
            response = httpx.post(f'{harness_url}/invocations', json=payload, timeout=30)
            assert response.status_code == 200
            assert 'RUN_FINISHED' in response.text
        payload = _invocation('missing', 'missing', 'missing')
        payload['forwardedProps'] = {}
        response = httpx.post(f'{harness_url}/invocations', json=payload, timeout=30)
        assert 'RUN_ERROR' in response.text
        assert 'Chat Service must forward' in response.text

    with _local_process('botcube_harness_deepagents.session_api', port, checkpoint_path) as session_url:
        for owner in ('owner-one', 'owner-two'):
            history = httpx.post(f'{session_url}/invocations', json={
                'operation': 'get', 'sessionId': 'thread-local', 'userId': owner,
            }, timeout=30)
            assert history.status_code == 200
            assert [(message['role'], message['content']) for message in history.json()['messages']] == [
                ('user', owner), ('assistant', f'Echo: {owner}'),
            ]
