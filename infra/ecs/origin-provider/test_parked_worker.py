import json
import os
import unittest
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any
from unittest.mock import patch

os.environ.update({'ORIGIN_OWNERSHIP': 'bot-cube:preview-origin', 'PARKED_WORKER_NAME': 'bot-cube-parked', 'ORIGIN_ZONE': 'example.com'})
os.environ['BOTCUBE_DEPLOY_ROOT'] = str(Path(__file__).resolve().parents[3] / 'examples/public/deploy')
import handler


class ParkedWorkerTests(unittest.TestCase):
    """While Parked, one Worker answers every request on both API hostnames."""

    HOSTNAMES = ['api-next.example.com', 'api.example.com']

    def setUp(self):
        for patcher in (patch.dict(handler.os.environ, {'HOSTNAMES': ','.join(self.HOSTNAMES), 'TOKEN_SECRET': 'token'}),):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.calls, self.routes, self.script_missing = [], [], False
        self.keys = [{'kty': 'EC', 'crv': 'P-256', 'kid': 'current', 'x': 'public-x', 'y': 'public-y', 'd': 'PRIVATE-NEVER-UPLOAD', 'unexpected': 'PRIVATE-EXTRA'}]
        client = patch.object(handler.boto3, 'client')
        client.start().return_value.get_secret_value.return_value = {'SecretString': json.dumps(self.keys)}
        self.addCleanup(client.stop)

    def event(self, request: str = 'Create') -> dict[str, Any]:
        props: dict[str, object] = {'Kind': 'ParkedWorker', 'Issuer': 'https://api.example.com', 'TurnIdentityKeysSecret': 'keys', 'Hostnames': self.HOSTNAMES, 'Origins': ['https://example.com'], 'WakeUrl': 'https://wake.example.com/'}
        return {'RequestType': request, 'RequestId': 'request', 'PhysicalResourceId': 'bot-cube-parked',
                'ResourceProperties': props, 'OldResourceProperties': props}

    def cloudflare(self, _cf: handler.Cloudflare, path: str, method: str, data: bytes | None, content_type: str) -> object:
        self.calls.append((method, path))
        if path.startswith('zones?'):
            return [{'id': 'z', 'account': {'id': 'a'}}]
        if path == 'zones/z/workers/routes' and method == 'GET':
            return self.routes
        if method == 'PUT' and path.startswith('accounts/'):
            self.upload = (data, content_type)
        if method == 'DELETE' and path.startswith('accounts/') and self.script_missing:
            raise handler.ProviderError('missing', [10007])
        return {}

    def run_event(self, event: Mapping[str, Any], step: Callable[[Mapping[str, Any], object], Mapping[str, object]] = handler.on_event):
        with patch.object(handler.Cloudflare, 'send', autospec=True, side_effect=self.cloudflare):
            return step(event, None)

    def test_create_uploads_the_worker_and_routes_every_hostname(self):
        self.assertEqual(self.run_event(self.event())['PhysicalResourceId'], 'bot-cube-parked')
        writes = [call for call in self.calls if call[0] != 'GET']
        self.assertEqual(writes, [('PUT', 'accounts/a/workers/scripts/bot-cube-parked'),
                                  ('POST', 'zones/z/workers/routes'), ('POST', 'zones/z/workers/routes')])
        body, content_type = self.upload
        assert body is not None
        self.assertTrue(content_type.startswith('multipart/form-data; boundary='))
        boundary = content_type.split('boundary=')[1]
        metadata = json.loads(body.decode().split('--' + boundary)[1].split('\r\n\r\n', 1)[1].rsplit('\r\n', 1)[0])
        self.assertEqual(metadata['main_module'], 'parked-worker.mjs')
        self.assertEqual(metadata['bindings'][:2], [{'type': 'plain_text', 'name': 'ALLOWED_ORIGINS', 'text': '["https://example.com"]'},
                                                {'type': 'plain_text', 'name': 'WAKE_URL', 'text': 'https://wake.example.com/'}])
        self.assertIn(b'{"status":"parked"}', body)
        self.assertNotIn(b'PRIVATE-NEVER-UPLOAD', body)
        self.assertNotIn(b'PRIVATE-EXTRA', body)
        documents = json.loads(metadata['bindings'][2]['text'])
        public = documents['/.well-known/jwks.json']['keys']
        self.assertEqual(public, [{'kty': 'EC', 'crv': 'P-256', 'kid': 'current', 'x': 'public-x', 'y': 'public-y', 'alg': 'ES256', 'use': 'sig'}])
        self.assertEqual(documents['/.well-known/openid-configuration']['issuer'], 'https://api.example.com')
        self.keys.append({**self.keys[0], 'kid': 'next'})
        self.assertEqual(len(handler.issuer_documents(self.keys, 'https://api.example.com')['/.well-known/jwks.json']['keys']), 2)


    def test_create_is_idempotent_on_existing_owned_routes(self):
        self.routes = [{'id': f'r{i}', 'pattern': f'{host}/*', 'script': 'bot-cube-parked'} for i, host in enumerate(self.HOSTNAMES)]
        self.run_event(self.event())
        self.assertNotIn(('POST', 'zones/z/workers/routes'), self.calls)

    def test_unowned_route_is_neither_replaced_nor_deleted(self):
        self.routes = [{'id': 'r0', 'pattern': 'api.example.com/*', 'script': 'someone-else'}]
        for request in ('Create', 'Delete'):
            with self.subTest(request=request), self.assertRaisesRegex(handler.ProviderError, 'unowned Worker route'):
                self.run_event(self.event(request))
        self.assertFalse(any(method == 'DELETE' for method, _ in self.calls))

    def test_delete_removes_routes_before_the_script(self):
        self.routes = [{'id': 'r0', 'pattern': 'api.example.com/*', 'script': 'bot-cube-parked'}]
        self.run_event(self.event('Delete'))
        writes = [call for call in self.calls if call[0] != 'GET']
        self.assertEqual(writes, [('DELETE', 'zones/z/workers/routes/r0'), ('DELETE', 'accounts/a/workers/scripts/bot-cube-parked')])

    def test_delete_treats_only_an_explicit_missing_script_as_done(self):
        self.script_missing = True
        self.run_event(self.event('Delete'))
        with patch.object(handler.Cloudflare, 'send', autospec=True, side_effect=handler.ProviderError('forbidden', [10000])), self.assertRaises(handler.ProviderError):
            handler.on_event(self.event('Delete'), None)

    def test_worker_is_complete_once_written(self):
        self.assertEqual(self.run_event(self.event(), handler.is_complete), {'IsComplete': True})
        self.assertEqual(self.calls, [])

    def test_non_identity_hostnames_are_rejected_before_provider_access(self):
        event = self.event()
        event['ResourceProperties']['Hostnames'] = ['api.example.com', 'www.example.com']
        with self.assertRaisesRegex(handler.ProviderError, 'identity Chat Service hostnames'):
            self.run_event(event)
        self.assertEqual(self.calls, [])

    def test_update_reconciles_routes_in_place_when_hostnames_change(self):
        added, kept = self.event('Update'), {'id': 'r0', 'pattern': 'api.example.com/*', 'script': 'bot-cube-parked'}
        added['OldResourceProperties'] = {**added['ResourceProperties'], 'Hostnames': ['api.example.com']}
        self.routes = [kept]
        self.assertEqual(self.run_event(added)['PhysicalResourceId'], 'bot-cube-parked')
        self.assertEqual([call for call in self.calls if call[0] != 'GET'],
                         [('PUT', 'accounts/a/workers/scripts/bot-cube-parked'), ('POST', 'zones/z/workers/routes')])
        self.calls, self.routes = [], [kept, {'id': 'r1', 'pattern': 'api-next.example.com/*', 'script': 'bot-cube-parked'}]
        rolled_back = self.event('Update')
        rolled_back['ResourceProperties'], rolled_back['OldResourceProperties'] = added['OldResourceProperties'], added['ResourceProperties']
        self.assertEqual(self.run_event(rolled_back)['PhysicalResourceId'], 'bot-cube-parked')
        self.assertEqual([call for call in self.calls if call[0] != 'GET'],
                         [('PUT', 'accounts/a/workers/scripts/bot-cube-parked'), ('DELETE', 'zones/z/workers/routes/r1')])


if __name__ == '__main__':
    unittest.main()
