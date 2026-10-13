import io
import json
import os
import runpy
import sys
import unittest
from collections.abc import Callable, Mapping
from email.message import Message
from pathlib import Path
from typing import Any, TypedDict
from unittest.mock import Mock, patch
from urllib.error import HTTPError

os.environ.update({'ORIGIN_OWNERSHIP': 'bot-cube:preview-origin', 'PARKED_WORKER_NAME': 'bot-cube-parked', 'ORIGIN_ZONE': 'bot-cube.com'})
os.environ['CARTRIDGE_DEPLOY_ROOT'] = str(Path(__file__).resolve().parents[3] / 'template/deploy')
import handler

# The deploy scripts import their shared identity module from their own directory.
ECS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ECS))


class _Event(TypedDict):
    """A CloudFormation custom resource request, as the provider framework passes it."""

    RequestType: str
    RequestId: str
    PhysicalResourceId: str
    ResourceProperties: dict[str, object]
    OldResourceProperties: dict[str, object]


class OriginTests(unittest.TestCase):
    def setUp(self):
        hostnames = patch.dict(handler.os.environ, {'HOSTNAMES': 'api-next.bot-cube.com,api.bot-cube.com'})
        hostnames.start()
        self.addCleanup(hostnames.stop)

    def event(self, kind: str, request: str = 'Create') -> _Event:
        return {'RequestType': request, 'RequestId': 'request', 'PhysicalResourceId': 'owned',
                'ResourceProperties': {'Kind': kind, 'Hostname': 'api-next.bot-cube.com', 'ClientVersion': 'v1'},
                'OldResourceProperties': {'Hostname': 'api-next.bot-cube.com', 'ClientVersion': 'v1'}}

    def test_restoration_waits_for_data_plane_after_control_plane_is_active(self):
        verifier = runpy.run_path(str(ECS / 'verify-origin.py'))
        wait = verifier['expect_ready']
        clock = Mock()
        clock.monotonic.return_value = 0
        responses = Mock(side_effect=[(520, 'old diagnostic cert'), (520, 'old diagnostic cert'), (200, '{"status":"ok"}')])
        with patch.dict(wait.__globals__, {'time': clock, 'request_status': responses}):
            wait()
        self.assertEqual(responses.call_count, 3)
        for status in (520, 403, 503):
            with self.subTest(status=status), patch.dict(wait.__globals__, {'time': clock, 'request_status': Mock(return_value=(status, 'wrong body'))}), self.assertRaises(RuntimeError):
                wait()

    def test_negative_probe_rejects_edge_auth_and_origin_success(self):
        verifier = runpy.run_path(str(ECS / 'verify-origin.py'))
        phase = verifier['tls_failure_phase']
        for status in (520, 525, 403, 503):
            with self.subTest(status=status), patch.dict(phase.__globals__, {'set_aop': Mock(), 'time': Mock(), 'request_status': Mock(return_value=(status, 'body'))}):
                if status in (520, 525):
                    self.assertEqual(phase(Mock(), 'base', 'cert', False)[2], status)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'Expected Cloudflare origin failure'):
                        phase(Mock(), 'base', 'cert', False)

    def test_origin_probe_identifies_itself_and_preserves_edge_errors(self):
        verifier = runpy.run_path(str(ECS / 'verify-origin.py'))
        rejected = HTTPError('url', 403, 'forbidden', Message(), io.BytesIO(b'error code: 1010'))
        with patch.object(handler.urllib.request, 'urlopen', side_effect=rejected) as request:
            self.assertEqual(verifier['request_status'](), (403, 'error code: 1010'))
            self.assertEqual(request.call_args.args[0].get_header('User-agent'), 'BotCube-Origin-Verification/1.0')

    def test_non_identity_hostname_rejected_before_provider_access(self):
        event = self.event('Dns')
        event['ResourceProperties']['Hostname'] = 'www.bot-cube.com'
        with patch.object(handler, 'Cloudflare') as cf:
            with self.assertRaisesRegex(handler.ProviderError, 'identity Chat Service hostnames'):
                handler.on_event(event, None)
            cf.assert_not_called()

    def test_unowned_dns_is_neither_overwritten_nor_deleted(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.records = Mock(return_value=[{'id': 'existing', 'comment': None}])
        cf.call = Mock()
        with self.assertRaisesRegex(handler.ProviderError, 'unowned'):
            cf.put_record('zone', 'api-next.bot-cube.com', 'origin', True)
        with self.assertRaisesRegex(handler.ProviderError, 'unowned'):
            cf.remove_record('zone', 'api-next.bot-cube.com')
        cf.call.assert_not_called()

    def test_owned_dns_update_preserves_provider_record_id(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.records = Mock(return_value=[{'id': 'owned', 'comment': handler.OWNER}])
        cf.call = Mock(return_value={'id': 'owned'})
        self.assertEqual(cf.put_record('zone', 'api-next.bot-cube.com', 'new.', True, 'owned'), 'owned')
        args = cf.call.call_args.args
        self.assertEqual(args[:2], ('zone/dns_records/owned', 'PUT'))
        self.assertEqual(args[2]['content'], 'new')

    def test_provider_failure_is_not_empty_success_or_secret_echo(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.token = 'never-log-token'
        failure = HTTPError('url', 403, 'forbidden', Message(), io.BytesIO(json.dumps({'success': False, 'errors': [{'code': 10000, 'message': 'never-log-token'}]}).encode()))
        with patch.object(handler.urllib.request, 'urlopen', side_effect=failure):
            with self.assertRaisesRegex(handler.ProviderError, r'GET zones HTTP 403 error codes: \[10000\]') as raised:
                cf.call('zones')
            self.assertNotIn('never-log-token', str(raised.exception))

    def test_malformed_http_error_body_is_a_classified_provider_failure(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.token = 'never-log-token'
        for body in (b'<html>never-log-token: Bad Gateway</html>', b''):
            failure = HTTPError('url', 502, 'Bad Gateway', Message(), io.BytesIO(body))
            with self.subTest(body=body), patch.object(handler.urllib.request, 'urlopen', side_effect=failure):
                with self.assertRaisesRegex(handler.ProviderError, 'Cloudflare transport/response failure') as raised:
                    cf.call('zones')
                self.assertIsInstance(raised.exception.__cause__, json.JSONDecodeError)
                self.assertNotIn('never-log-token', str(raised.exception))

    def test_successful_cloudflare_response_preserves_the_result_and_request(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.token = 'test-token'
        response = Mock()
        response.status = 200
        response.read.return_value = b'{"success":true,"result":{"id":"created"}}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(handler.urllib.request, 'urlopen', return_value=response) as send:
            self.assertEqual(cf.call('zones/z/dns_records', 'POST', {'name': 'example.test'}), {'id': 'created'})
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.cloudflare.com/client/v4/zones/z/dns_records')
        self.assertEqual(request.method, 'POST')
        self.assertEqual(json.loads(request.data), {'name': 'example.test'})
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-token')
        self.assertEqual(send.call_args.kwargs, {'timeout': 25})

    def test_acm_validation_creates_unproxied_record_and_waits(self):
        acm = Mock()
        acm.describe_certificate.return_value = {'Certificate': {'Status': 'PENDING_VALIDATION', 'DomainValidationOptions': [{'ResourceRecord': {'Name': '_token.api-next.bot-cube.com.', 'Value': '_token.acm-validations.aws.'}}]}}
        with patch.object(handler, 'Cloudflare') as cf, patch.object(handler.boto3, 'client', return_value=acm):
            cf.return_value.zone.return_value = 'zone'
            self.assertEqual(handler.is_complete(self.event('Certificate'), None), {'IsComplete': False})
            cf.return_value.put_record.assert_called_once_with('zone', '_token.api-next.bot-cube.com.', '_token.acm-validations.aws.', False)

    def test_aop_pending_does_not_restart_deployment(self):
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [{'status': 'active'}, {'enabled': True, 'cert_id': 'owned', 'status': 'pending_deployment'}]
            self.assertEqual(handler.is_complete(self.event('Aop'), None), {'IsComplete': False})
            self.assertTrue(all(len(call.args) == 1 for call in cf.return_value.call.call_args_list))

    def test_aop_active_is_complete(self):
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [{'status': 'active'}, {'enabled': True, 'cert_id': 'owned', 'status': 'active'}]
            self.assertEqual(handler.is_complete(self.event('Aop'), None), {'IsComplete': True})

    def test_replacement_delete_does_not_disable_new_association(self):
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [[{'id': 'owned'}], {'enabled': True, 'cert_id': 'replacement'}, {}]
            self.assertEqual(handler.is_complete(self.event('Aop', 'Delete'), None), {'IsComplete': True})
            self.assertFalse(any(len(call.args) > 1 and call.args[1] == 'PUT' for call in cf.return_value.call.call_args_list))

    def test_shared_certificate_aop_associates_without_upload_and_never_deletes_it(self):
        event = self.event('Aop')
        event['ResourceProperties'].update({'Hostname': 'api.bot-cube.com', 'CertId': 'preview-cert'})
        with patch.object(handler, 'Cloudflare') as cf:
            self.assertEqual(handler.on_event(event, None)['PhysicalResourceId'], 'preview-cert')
            cf.return_value.call.assert_not_called()
        event = self.event('Aop', 'Delete')
        event['PhysicalResourceId'] = 'preview-cert'
        event['ResourceProperties'].update({'Hostname': 'api.bot-cube.com', 'CertId': 'preview-cert'})
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [[{'id': 'preview-cert'}], {'enabled': True, 'cert_id': 'preview-cert'}, {}]
            self.assertEqual(handler.is_complete(event, None), {'IsComplete': True})
            calls = cf.return_value.call.call_args_list
            self.assertEqual(calls[-1].args[1:], ('PUT', {'config': [{'hostname': 'api.bot-cube.com', 'cert_id': 'preview-cert', 'enabled': None}]}))
            self.assertFalse(any(len(call.args) > 1 and call.args[1] == 'DELETE' for call in calls))

    def test_aop_delete_waits_only_for_documented_pending_state(self):
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [[{'id': 'owned'}], {}, handler.ProviderError('pending', [1434])]
            self.assertEqual(handler.is_complete(self.event('Aop', 'Delete'), None), {'IsComplete': False})
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [[{'id': 'owned'}], {}, handler.ProviderError('forbidden', [10000])]
            with self.assertRaises(handler.ProviderError):
                handler.is_complete(self.event('Aop', 'Delete'), None)


class ParkedWorkerTests(unittest.TestCase):
    """While Parked, one Worker answers every request on both API hostnames."""

    HOSTNAMES = ['api-next.bot-cube.com', 'api.bot-cube.com']

    def setUp(self):
        for patcher in (patch.dict(handler.os.environ, {'HOSTNAMES': ','.join(self.HOSTNAMES), 'TOKEN_SECRET': 'token'}),
                        patch.object(handler.boto3, 'client')):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.calls, self.routes, self.script_missing = [], [], False

    def event(self, request: str = 'Create') -> _Event:
        props: dict[str, object] = {'Kind': 'ParkedWorker', 'Hostnames': self.HOSTNAMES, 'Origins': ['https://bot-cube.com']}
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
        self.assertEqual(metadata['bindings'], [{'type': 'plain_text', 'name': 'ALLOWED_ORIGINS', 'text': '["https://bot-cube.com"]'}])
        self.assertIn(b'{"status":"parked"}', body)

    def test_create_is_idempotent_on_existing_owned_routes(self):
        self.routes = [{'id': f'r{i}', 'pattern': f'{host}/*', 'script': 'bot-cube-parked'} for i, host in enumerate(self.HOSTNAMES)]
        self.run_event(self.event())
        self.assertNotIn(('POST', 'zones/z/workers/routes'), self.calls)

    def test_unowned_route_is_neither_replaced_nor_deleted(self):
        self.routes = [{'id': 'r0', 'pattern': 'api.bot-cube.com/*', 'script': 'someone-else'}]
        for request in ('Create', 'Delete'):
            with self.subTest(request=request), self.assertRaisesRegex(handler.ProviderError, 'unowned Worker route'):
                self.run_event(self.event(request))
        self.assertFalse(any(method == 'DELETE' for method, _ in self.calls))

    def test_delete_removes_routes_before_the_script(self):
        self.routes = [{'id': 'r0', 'pattern': 'api.bot-cube.com/*', 'script': 'bot-cube-parked'}]
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

    def test_hostname_changes_and_non_identity_hostnames_are_rejected_before_provider_access(self):
        event = self.event()
        event['ResourceProperties']['Hostnames'] = ['api.bot-cube.com', 'www.bot-cube.com']
        with self.assertRaisesRegex(handler.ProviderError, 'identity Chat Service hostnames'):
            self.run_event(event)
        event = self.event('Update')
        event['OldResourceProperties'] = {**event['ResourceProperties'], 'Hostnames': ['api.bot-cube.com']}
        with self.assertRaisesRegex(handler.ProviderError, 'Hostname replacement'):
            self.run_event(event)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
