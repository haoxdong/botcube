import io
import json
import os
import runpy
import sys
import unittest
from email.message import Message
from pathlib import Path
from typing import TypedDict
from unittest.mock import Mock, patch
from urllib.error import HTTPError

os.environ.update({'ORIGIN_OWNERSHIP': 'bot-cube:preview-origin', 'PARKED_WORKER_NAME': 'bot-cube-parked'})
os.environ['BOTCUBE_DEPLOY_ROOT'] = str(Path(__file__).resolve().parents[3] / 'examples/public/deploy')
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
        hostnames = patch.dict(handler.os.environ, {'HOSTNAMES': 'api-next.example.com,api.example.com'})
        hostnames.start()
        self.addCleanup(hostnames.stop)

    def event(self, kind: str, request: str = 'Create') -> _Event:
        return {'RequestType': request, 'RequestId': 'request', 'PhysicalResourceId': 'owned',
                'ResourceProperties': {'Kind': kind, 'Hostname': 'api-next.example.com', 'ClientVersion': 'v1', 'Zone': 'example.com'},
                'OldResourceProperties': {'Hostname': 'api-next.example.com', 'ClientVersion': 'v1'}}

    def test_dns_creation_and_update_enable_native_edge_https_before_serving_http_checks(self):
        for request in ('Create', 'Update'):
            with self.subTest(request=request):
                event = self.event('Dns', request)
                event['ResourceProperties'].update({'Target': 'origin.example.com', 'AlwaysUseHttps': 'on'})
                cf = Mock()
                cf.put_record.return_value = 'owned'
                self.assertEqual(handler.dns_event(cf, 'zone', event, event['ResourceProperties']), 'owned')
                cf.call.assert_called_once_with('zone/settings/always_use_https', 'PATCH', {'value': 'on'})

    def test_dns_deletion_preserves_shared_edge_https_setting(self):
        event = self.event('Dns', 'Delete')
        cf = Mock()
        handler.dns_event(cf, 'zone', event, event['ResourceProperties'])
        cf.call.assert_not_called()

    def test_edge_https_permission_failure_fails_the_deploy(self):
        event = self.event('Dns')
        event['ResourceProperties'].update({'Target': 'origin.example.com', 'AlwaysUseHttps': 'on'})
        cf = Mock()
        cf.call.side_effect = handler.ProviderError('settings denied')
        with self.assertRaisesRegex(handler.ProviderError, 'settings denied'):
            handler.dns_event(cf, 'zone', event, event['ResourceProperties'])

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

    def test_origin_probe_identifies_itself_as_the_release_tooling_says_and_preserves_edge_errors(self):
        verifier = runpy.run_path(str(ECS / 'verify-origin.py'))
        rejected = HTTPError('url', 403, 'forbidden', Message(), io.BytesIO(b'error code: 1010'))
        with patch.dict(os.environ, {'ORIGIN_VERIFICATION_USER_AGENT': 'Example-Origin-Verification/1.0'}), \
                patch.object(handler.urllib.request, 'urlopen', side_effect=rejected) as request:
            self.assertEqual(verifier['request_status'](), (403, 'error code: 1010'))
            self.assertEqual(request.call_args.args[0].get_header('User-agent'), 'Example-Origin-Verification/1.0')

    def test_origin_probe_refuses_a_user_agent_the_chat_service_would_count_as_a_person(self):
        verifier = runpy.run_path(str(ECS / 'verify-origin.py'))
        with patch.dict(os.environ, {'ORIGIN_VERIFICATION_USER_AGENT': 'Example-Origin-Probe/1.0'}), \
                patch.object(handler.urllib.request, 'urlopen') as request:
            with self.assertRaisesRegex(RuntimeError, 'ORIGIN_VERIFICATION_USER_AGENT must give the deploy check user agent, carrying -Verification/'):
                verifier['request_status']()
            request.assert_not_called()

    def test_origin_probe_named_by_no_release_tooling_identifies_itself_as_botcube(self):
        # The parking Transition runs this probe in a Lambda no release tooling configures.
        verifier = runpy.run_path(str(ECS / 'verify-origin.py'))
        others = {name: value for name, value in os.environ.items() if name != 'ORIGIN_VERIFICATION_USER_AGENT'}
        rejected = HTTPError('url', 403, 'forbidden', Message(), io.BytesIO(b'error code: 1010'))
        with patch.dict(os.environ, others, clear=True), patch.object(handler.urllib.request, 'urlopen', side_effect=rejected) as request:
            verifier['request_status']()
            self.assertEqual(request.call_args.args[0].get_header('User-agent'), 'BotCube-Origin-Verification/1.0')

    def test_non_identity_hostname_rejected_before_provider_access(self):
        event = self.event('Dns')
        event['ResourceProperties']['Hostname'] = 'www.example.com'
        with patch.object(handler, 'Cloudflare') as cf:
            with self.assertRaisesRegex(handler.ProviderError, 'identity Chat Service hostnames'):
                handler.on_event(event, None)
            cf.assert_not_called()

    def test_single_hostname_change_is_rejected_before_provider_access(self):
        for kind in ('Certificate', 'Dns', 'Aop'):
            event = self.event(kind, 'Update')
            event['OldResourceProperties']['Hostname'] = 'api.example.com'
            with self.subTest(kind=kind), patch.object(handler, 'Cloudflare') as cf, self.assertRaisesRegex(handler.ProviderError, 'Hostname replacement'):
                handler.on_event(event, None)
            cf.assert_not_called()

    def test_unowned_dns_is_neither_overwritten_nor_deleted(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.records = Mock(return_value=[{'id': 'existing', 'comment': None}])
        cf.call = Mock()
        with self.assertRaisesRegex(handler.ProviderError, 'unowned'):
            cf.put_record('zone', 'api-next.example.com', 'origin', True)
        with self.assertRaisesRegex(handler.ProviderError, 'unowned'):
            cf.remove_record('zone', 'api-next.example.com')
        cf.call.assert_not_called()

    def test_owned_dns_update_preserves_provider_record_id(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.records = Mock(return_value=[{'id': 'owned', 'comment': handler.OWNER}])
        cf.call = Mock(return_value={'id': 'owned'})
        self.assertEqual(cf.put_record('zone', 'api-next.example.com', 'new.', True, 'owned'), 'owned')
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

    def test_malformed_permanent_http_error_body_is_a_classified_provider_failure(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.token = 'never-log-token'
        for body in (b'<html>never-log-token: Bad Gateway</html>', b''):
            failure = HTTPError('url', 403, 'Forbidden', Message(), io.BytesIO(body))
            with self.subTest(body=body), patch.object(handler.urllib.request, 'urlopen', side_effect=failure):
                with self.assertRaisesRegex(handler.ProviderError, 'Cloudflare transport/response failure') as raised:
                    cf.call('zones')
                self.assertIsInstance(raised.exception.__cause__, json.JSONDecodeError)
                self.assertNotIn('never-log-token', str(raised.exception))

    def test_transient_http_errors_preserve_status_for_the_parking_retry_policy(self):
        cf = handler.Cloudflare.__new__(handler.Cloudflare)
        cf.token = 'never-log-token'
        for status in (429, 500, 502, 503):
            for body in (b'<html>never-log-token</html>', b'', b'{"success":false}'):
                failure = HTTPError('url', status, 'provider unavailable', Message(), io.BytesIO(body))
                with self.subTest(status=status, body=body), patch.object(handler.urllib.request, 'urlopen', side_effect=failure):
                    with self.assertRaises(HTTPError) as raised:
                        cf.call('zones')
                    self.assertIs(raised.exception, failure)
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
        acm.describe_certificate.return_value = {'Certificate': {'Status': 'PENDING_VALIDATION', 'DomainValidationOptions': [{'ResourceRecord': {'Name': '_token.api-next.example.com.', 'Value': '_token.acm-validations.aws.'}}]}}
        with patch.object(handler, 'Cloudflare') as cf, patch.object(handler.boto3, 'client', return_value=acm):
            cf.return_value.zone.return_value = 'zone'
            self.assertEqual(handler.is_complete(self.event('Certificate'), None), {'IsComplete': False})
            cf.return_value.put_record.assert_called_once_with('zone', '_token.api-next.example.com.', '_token.acm-validations.aws.', False)

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
        event['ResourceProperties'].update({'Hostname': 'api.example.com', 'CertId': 'preview-cert'})
        with patch.object(handler, 'Cloudflare') as cf:
            self.assertEqual(handler.on_event(event, None)['PhysicalResourceId'], 'preview-cert')
            cf.return_value.call.assert_not_called()
        event = self.event('Aop', 'Delete')
        event['PhysicalResourceId'] = 'preview-cert'
        event['ResourceProperties'].update({'Hostname': 'api.example.com', 'CertId': 'preview-cert'})
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [[{'id': 'preview-cert'}], {'enabled': True, 'cert_id': 'preview-cert'}, {}]
            self.assertEqual(handler.is_complete(event, None), {'IsComplete': True})
            calls = cf.return_value.call.call_args_list
            self.assertEqual(calls[-1].args[1:], ('PUT', {'config': [{'hostname': 'api.example.com', 'cert_id': 'preview-cert', 'enabled': None}]}))
            self.assertFalse(any(len(call.args) > 1 and call.args[1] == 'DELETE' for call in calls))

    def test_aop_delete_waits_only_for_documented_pending_state(self):
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [[{'id': 'owned'}], {}, handler.ProviderError('pending', [1434])]
            self.assertEqual(handler.is_complete(self.event('Aop', 'Delete'), None), {'IsComplete': False})
        with patch.object(handler, 'Cloudflare') as cf:
            cf.return_value.call.side_effect = [[{'id': 'owned'}], {}, handler.ProviderError('forbidden', [10000])]
            with self.assertRaises(handler.ProviderError):
                handler.is_complete(self.event('Aop', 'Delete'), None)



if __name__ == '__main__':
    unittest.main()
