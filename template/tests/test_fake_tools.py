import json
import os
import socket
import subprocess
import threading
import time
from urllib.request import urlopen

import httpx
import uvicorn

from botcube_credential_service.server import CredentialServiceSettings, create_app
from botcube_credential_service.vault import DynamoDbCredentialVault
from botcube_template.fake_site import FakeSiteServer
from botcube_template.site_provider import FakeSiteProvider
from test_site_provider import LocalKeys, LocalTable, authorization


def test_cli_reads_minted_access_and_fails_loud_after_unlink() -> None:
    site = FakeSiteServer(('127.0.0.1', 0))
    site_thread = threading.Thread(target=site.serve_forever, daemon=True)
    site_thread.start()
    site_url = f'http://127.0.0.1:{site.server_port}'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    table = LocalTable()
    vault = DynamoDbCredentialVault(table, LocalKeys())
    app = create_app(CredentialServiceSettings('template', lambda: 'local-secret', 'X-Template-Account', 'X-Template-Session'), [FakeSiteProvider(lambda: vault, site_url)])
    service = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='error'))
    thread = threading.Thread(target=service.run, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{port}'
    try:
        for _ in range(200):
            if service.started:
                break
            time.sleep(0.01)
        assert service.started
        with urlopen(f'{site_url}/login') as response:
            assert '<form method="post" action="/login">' in response.read().decode()
        assert httpx.post(f'{url}/fake-site/auth/link/sign-in', headers=authorization('credential_capture')).json() == {'status': 'linked'}
        environment = {**os.environ, 'TEMPLATE_CREDENTIAL_SERVICE_URL': url, 'TEMPLATE_CREDENTIAL_INVOCATION': authorization()['Authorization'].removeprefix('Bearer '), 'TEMPLATE_CREDENTIAL_SESSION': 'session'}
        result = subprocess.run(['template-cli', 'data'], env=environment, capture_output=True, text=True)
        assert (result.returncode, result.stdout) == (0, '{"items": [{"name": "Sample item", "value": 42}]}\n')
        assert site.access
        assert not any(credential in json.dumps(table.items['template-user', 'fake-site']) for credential in site.credentials)
        assert httpx.post(f'{url}/fake-site/auth/link/revoke', headers=authorization('credential_revocation')).status_code == 200
        rejected = subprocess.run(['template-cli', 'data'], env=environment, capture_output=True, text=True)
        assert rejected.returncode == 1
        assert 'sign-in needed' in rejected.stderr
        environment['TEMPLATE_CREDENTIAL_INVOCATION'] = 'invalid'
        refused = subprocess.run(['template-cli', 'data'], env=environment, capture_output=True, text=True)
        assert refused.returncode == 1
    finally:
        service.should_exit = True
        thread.join(timeout=5)
        site.shutdown()
        site.server_close()
        site_thread.join()


def test_cli_transport_and_malformed_response_failures_exit_nonzero() -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class MalformedSite(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'not json')

    server = ThreadingHTTPServer(('127.0.0.1', 0), MalformedSite)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    environment = {
        **os.environ,
        'TEMPLATE_CREDENTIAL_SERVICE_URL': f'http://127.0.0.1:{server.server_port}',
        'TEMPLATE_CREDENTIAL_INVOCATION': 'invocation',
        'TEMPLATE_CREDENTIAL_SESSION': 'session',
    }
    try:
        malformed = subprocess.run(['template-cli', 'data'], env=environment, capture_output=True, text=True)
        assert malformed.returncode == 1
        assert malformed.stdout == ''
        assert 'Template site request failed:' in malformed.stderr
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    unreachable = subprocess.run(['template-cli', 'data'], env=environment, capture_output=True, text=True)
    assert unreachable.returncode == 1
    assert unreachable.stdout == ''
    assert 'Template site request failed:' in unreachable.stderr
