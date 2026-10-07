from __future__ import annotations

import json
import os
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeSiteServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int]) -> None:
        self.credentials: set[str] = set()
        self.access: dict[str, float] = {}
        super().__init__(address, FakeSiteHandler)


class FakeSiteHandler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict[str, object]) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == '/login':
            page = b'<html><body><h1>Template site</h1><form method="post" action="/login"><button>Sign in</button></form></body></html>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return
        if self.path != '/data':
            self._json(404, {'error': 'Not found'})
            return
        assert isinstance(self.server, FakeSiteServer)
        credential = self.headers.get('Authorization', '').removeprefix('Bearer ')
        if credential not in self.server.credentials and self.server.access.get(credential, 0) <= time.time():
            self._json(401, {'error': 'Sign-in needed'})
            return
        self._json(200, {'items': [{'name': 'Sample item', 'value': 42}]})

    def do_POST(self) -> None:
        assert isinstance(self.server, FakeSiteServer)
        if self.path.startswith('/model/') and self.path.endswith('/converse'):
            try:
                request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                tool = request['toolConfig']['toolChoice']['tool']['name']
            except (ValueError, KeyError, TypeError):
                self._json(400, {'error': 'Invalid Converse request'})
                return
            if tool != 'turn_summary':
                self._json(400, {'error': 'Only turn_summary is supported'})
                return
            self._json(200, {
                'output': {'message': {'role': 'assistant', 'content': [{'toolUse': {
                    'toolUseId': 'local-summary', 'name': 'turn_summary',
                    'input': {'title': 'Answered a question', 'summary': 'Replied to the user'},
                }}]}},
                'stopReason': 'tool_use',
            })
            return
        if self.path == '/access':
            credential = self.headers.get('Authorization', '').removeprefix('Bearer ')
            if credential not in self.server.credentials:
                self._json(401, {'error': 'Sign-in needed'})
                return
            access = secrets.token_urlsafe(32)
            self.server.access[access] = time.time() + 60
            self._json(200, {'access': access})
            return
        if self.path != '/login':
            self._json(404, {'error': 'Not found'})
            return
        credential = secrets.token_urlsafe(32)
        self.server.credentials.add(credential)
        self._json(200, {'credential': credential})


def main() -> None:
    server = FakeSiteServer((os.environ.get('TEMPLATE_SITE_HOST', '127.0.0.1'), int(os.environ.get('PORT', '8124'))))
    print(f'Template site listening on :{server.server_port}', flush=True)
    server.serve_forever()
