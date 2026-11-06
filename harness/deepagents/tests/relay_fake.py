"""The Credential Service relay at the outer edge of a plan model (ADR 0078)."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# Recorded from a live streaming Responses call on the owner's plan; it came with no content type.
RECORDED_STREAM = (Path(__file__).parent / 'fixtures' / 'openai-plan-responses-stream.sse').read_bytes()
# The recorded stream with a two-part reasoning summary added before its message, in the Responses API's event shapes.
REASONING_STREAM = (Path(__file__).parent / 'fixtures' / 'openai-plan-reasoning-stream.sse').read_bytes()


@dataclass
class RelayReply:
    status: int = 200
    body: bytes = RECORDED_STREAM
    content_type: str | None = None


def plan_usage_error(code: str, message: str) -> dict[str, Any]:
    """A classified Plan Usage error as the relay answers it, in OpenAI's error shape."""
    return {'error': {'type': 'plan_usage', 'code': code, 'message': message}}


def failing_stream(error: dict[str, Any]) -> bytes:
    """The recorded stream's opening event, then the relay's error frame for a mid-stream failure."""
    opening = RECORDED_STREAM.split(b'\n\n')[0] + b'\n\n'
    return opening + f'event: error\ndata: {json.dumps({"type": "error", **error})}\n\n'.encode()


class FakeRelay:
    """Records each call and answers `reply`, the recorded stream unless a test sets it."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.reply = RelayReply()
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers['content-length']))
                relay.calls.append({'path': self.path, 'headers': dict(self.headers), 'body': json.loads(body)})
                reply = relay.reply
                self.send_response(reply.status)
                if reply.content_type:
                    self.send_header('content-type', reply.content_type)
                self.send_header('content-length', str(len(reply.body)))
                self.end_headers()
                self.wfile.write(reply.body)

            def log_message(self, format: str, *args: Any) -> None:
                return None

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/openai/v1'


@contextmanager
def serving_relay() -> Iterator[FakeRelay]:
    fake = FakeRelay()
    thread = threading.Thread(target=fake.server.serve_forever, daemon=True)
    thread.start()
    yield fake
    fake.server.shutdown()
