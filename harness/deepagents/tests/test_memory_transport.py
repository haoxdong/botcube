import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from botocore.exceptions import ReadTimeoutError

from botcube_harness_deepagents.memory import agentcore

pytestmark = pytest.mark.integration


def test_slow_sts_response_exhausts_two_bounded_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        monkeypatch.delenv(name, raising=False)
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers['Content-Length']))
            calls.append(time.monotonic())
            time.sleep(6)
            try:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'<AssumeRoleWithWebIdentityResponse/>')
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    agentcore.sts_client.cache_clear()
    client = agentcore.sts_client('us-east-1')
    client.meta.events.register('before-call.sts.AssumeRoleWithWebIdentity',
        lambda params, **_: params.update(url=f'http://127.0.0.1:{server.server_port}'))
    try:
        with pytest.raises(ReadTimeoutError):
            client.assume_role_with_web_identity(RoleArn='arn:aws:iam::000000000000:role/test',
                RoleSessionName='test', WebIdentityToken='test-token')
        assert len(calls) == 2
    finally:
        client.close()
        agentcore.sts_client.cache_clear()
        server.shutdown()
        server.server_close()
