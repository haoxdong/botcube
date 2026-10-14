import copy
import gzip
import hashlib
import io
import json
import runpy
import time
import unittest
from datetime import datetime, timedelta
from typing import Any
from unittest.mock import Mock, patch

from deploy_script_support import DEPLOY_ECS

verifier = runpy.run_path(str(DEPLOY_ECS / 'verify-service.py'))


class ServiceVerificationTests(unittest.TestCase):
    def test_only_requested_completed_revision_can_pass(self):
        ready = verifier['deployment_ready']
        service = {'taskDefinition': 'expected:2', 'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0,
                   'deployments': [{'rolloutState': 'COMPLETED'}]}
        self.assertTrue(ready({'services': [service]}, 'expected:2'))
        pending = copy.deepcopy(service)
        pending['deployments'][0]['rolloutState'] = 'IN_PROGRESS'
        self.assertFalse(ready({'services': [pending]}, 'expected:2'))
        failed = copy.deepcopy(service)
        failed['deployments'][0]['rolloutState'] = 'FAILED'
        for response in ({'services': [failed]}, {'services': [service], 'failures': [{'reason': 'MISSING'}]}):
            with self.assertRaises(RuntimeError):
                ready(response, 'expected:2')
        with self.assertRaisesRegex(RuntimeError, 'rolled back'):
            ready({'services': [service]}, 'expected:3')

    def deployment(self) -> tuple[Mock, Mock, Mock, dict[str, Any], dict[str, Any], dict[str, Any]]:
        ecs, elb, ec2 = Mock(), Mock(), Mock()
        ecs.describe_services.return_value = {'services': [{'taskDefinition': 'expected:2', 'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0, 'deployments': [{'rolloutState': 'COMPLETED'}]}]}
        ecs.list_tasks.return_value = {'taskArns': ['task']}
        task = {'taskDefinitionArn': 'expected:2', 'lastStatus': 'RUNNING', 'taskArn': 'task', 'containers': [{'imageDigest': 'sha256:1234', 'image': 'image', 'networkInterfaces': [{}]}], 'attachments': [{'type': 'ElasticNetworkInterface', 'details': [{'name': 'networkInterfaceId', 'value': 'eni-task'}]}]}
        ecs.describe_tasks.return_value = {'tasks': [task]}
        subnet = verifier['IDENTITY']['aws']['agentCore']['privateNatBrowser']['subnets'][0]['id']
        ec2.describe_network_interfaces.return_value = {'NetworkInterfaces': [{'SubnetId': subnet, 'PrivateIpAddress': '172.31.96.10'}]}
        current = {'Target': {'Id': '172.31.96.10', 'Port': 8123}, 'TargetHealth': {'State': 'healthy'}}
        old = {'Target': {'Id': '172.31.96.11', 'Port': 8123}, 'TargetHealth': {'State': 'draining'}}
        elb.describe_target_health.return_value = {'TargetHealthDescriptions': [current, old]}
        return ecs, elb, ec2, task, current, old

    def test_completed_revision_can_have_an_old_draining_target(self):
        verify = verifier['verify_deployment']
        ecs, elb, ec2, _, current, old = self.deployment()
        outputs = {'ClusterName': 'test', 'ServiceName': 'preview', 'TaskDefinitionArn': 'expected:2', 'TargetGroupArn': 'target'}
        with patch.object(verifier['boto3'], 'client', return_value=ec2):
            self.assertTrue(verify(outputs, ecs, elb)['targetHealthy'])
            current['TargetHealth']['State'] = 'unhealthy'
            old['TargetHealth']['State'] = 'healthy'
            with self.assertRaisesRegex(RuntimeError, 'target is not healthy'):
                verify(outputs, ecs, elb)

    def test_a_running_task_missing_a_field_the_evidence_reports_fails_loud(self):
        outputs = {'ClusterName': 'test', 'ServiceName': 'preview', 'TaskDefinitionArn': 'expected:2', 'TargetGroupArn': 'target'}
        for field in ('taskArn', 'image'):
            ecs, elb, ec2, task, _, _ = self.deployment()
            (task if field == 'taskArn' else task['containers'][0]).pop(field)
            with self.subTest(field=field), patch.object(verifier['boto3'], 'client', return_value=ec2), \
                    self.assertRaisesRegex(RuntimeError, f'lacks .*{field}'):
                verifier['verify_deployment'](outputs, ecs, elb)

    def test_a_target_missing_its_port_fails_loud(self):
        outputs = {'ClusterName': 'test', 'ServiceName': 'preview', 'TaskDefinitionArn': 'expected:2', 'TargetGroupArn': 'target'}
        ecs, elb, ec2, _, current, _ = self.deployment()
        current['Target'].pop('Port')
        with patch.object(verifier['boto3'], 'client', return_value=ec2), self.assertRaisesRegex(RuntimeError, 'lacks target Port'):
            verifier['verify_deployment'](outputs, ecs, elb)

    def test_misspelled_aop_option_fails_before_provider_access(self):
        origin = runpy.run_path(str(DEPLOY_ECS / 'verify-origin.py'))
        args = origin['parse_args'](['verify', 'outputs.json', '--probe-aop'])
        self.assertTrue(args.probe_aop)
        self.assertEqual(args.action, 'verify')
        self.assertEqual(origin['parse_args'](['production', 'outputs.json']).action, 'production')
        with self.assertRaises(SystemExit) as failure:
            origin['parse_args'](['verify', 'outputs.json', '--probe-aops'])
        self.assertEqual(failure.exception.code, 2)

    def test_tls_logs_allow_bounded_clock_skew_but_require_probe_identity(self):
        origin = runpy.run_path(str(DEPLOY_ECS / 'verify-origin.py'))
        collect = origin['connection_evidence']
        fixture = json.loads((DEPLOY_ECS.parents[2] / 'contract/regressions/preview-origin-log-clock.json').read_text())
        observed = {name: [datetime.fromisoformat(value) for value in values] for name, values in fixture['phases'].items()}
        phases = {name: (values[0], values[1], 520) for name, values in observed.items()}
        def evidence(serial: str = 'ABCD', extra_seconds: float = 0) -> str:
            missing_time = observed['missing'][2].isoformat()
            untrusted_time = (observed['untrusted'][2] + timedelta(seconds=extra_seconds)).isoformat()
            return (f'{missing_time} 192.0.2.1 12345 443 TLSv1.3 cipher - - - - Failed:UnmappedConnectionError\n'
                    f'{untrusted_time} 192.0.2.1 12345 443 TLSv1.3 cipher - probe - {serial} Failed:ClientCertUntrusted\n')
        s3 = Mock()
        s3.get_paginator.return_value.paginate.return_value = [{'Contents': [{'LastModified': observed['untrusted'][2], 'Key': 'test.log.gz'}]}]
        def read_logs(content: str):
            s3.get_object.side_effect = lambda **_kwargs: {'Body': io.BytesIO(gzip.compress(content.encode()))}
            with patch.object(origin['boto3'], 'client', return_value=s3), patch.object(origin['time'], 'sleep'):
                return collect('bucket', phases, 'ABCD')
        self.assertEqual(set(read_logs(evidence())), {'missing', 'untrusted'})
        for content in (evidence(serial='WRONG'), evidence(extra_seconds=2)):
            with self.assertRaisesRegex(RuntimeError, 'untrusted'):
                read_logs(content)

    def test_production_dns_checks_accept_only_the_expected_owner_and_target(self):
        origin = runpy.run_path(str(DEPLOY_ECS / 'verify-origin.py'))
        ecs = {'type': 'CNAME', 'proxied': True, 'comment': origin['OWNER'], 'content': 'origin.elb.amazonaws.com'}
        outputs = {'OriginDnsName': 'Origin.elb.amazonaws.com.', 'ProductionClientCertificateId': 'cert'}
        association = {'cert_id': 'cert', 'enabled': True}
        cases = [('verify_production', [ecs], (outputs,), True), ('verify_production', [{**ecs, 'comment': None}], (outputs,), False),
                 ('verify_production', [{**ecs, 'content': 'other.example.com'}], (outputs,), False)]
        for name, records, args, accepted in cases:
            with self.subTest(name=name, records=records):
                check = origin[name]
                cf = Mock()
                cf.records.return_value = records
                cf.call.return_value = association
                ready = Mock()
                with patch.dict(check.__globals__, {'expect_ready': ready}):
                    if accepted:
                        check(cf, 'zone', *args)
                        ready.assert_called_once_with(origin['PRODUCTION_HOST'])
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'Production DNS'):
                            check(cf, 'zone', *args)
                        ready.assert_not_called()
        cf = Mock()
        cf.records.return_value = [ecs]
        cf.call.return_value = {'cert_id': 'other', 'enabled': True}
        with self.assertRaisesRegex(RuntimeError, 'Production AOP'):
            origin['verify_production'](cf, 'zone', outputs)

    def test_readiness_rejects_application_errors_and_unexpected_bodies(self):
        origin = runpy.run_path(str(DEPLOY_ECS / 'verify-origin.py'))
        ready = origin['expect_ready']
        for status, body in [(503, '{"detail":"Session Metadata storage is unavailable"}'), (200, '{"status":"wrong"}')]:
            with patch.dict(ready.__globals__, {'request_status': Mock(return_value=(status, body))}), self.assertRaises(RuntimeError):
                ready()


class ConversationVerificationTests(unittest.TestCase):
    def test_probe_deadline_interrupts_even_a_peer_sending_partial_lines(self):
        with self.assertRaisesRegex(RuntimeError, 'probe deadline'), verifier['probe_deadline'](0.02):
            time.sleep(1)

    def test_session_record_is_the_deployed_memory_and_waits_for_the_purge(self):
        control, data = Mock(), Mock()
        name = verifier['IDENTITY']['aws']['agentCore']['memory']
        control.list_memories.side_effect = [
            {'memories': [{'id': 'other_memory-1'}], 'nextToken': 'page-2'},
            {'memories': [{'id': name + '-AbC123'}]},
        ]
        data.list_events.side_effect = [{'events': [{'eventId': 'e1'}]}, {'events': []}]
        data.list_sessions.return_value = {'sessionSummaries': []}
        record = verifier['SessionRecord'](control, data)
        with patch.object(verifier['time'], 'sleep'):
            record.wait_purged('actor-1', 'session-1')
        self.assertEqual(data.list_events.call_args.kwargs,
                         {'memoryId': name + '-AbC123', 'actorId': 'actor-1', 'sessionId': 'session-1', 'includePayloads': False, 'maxResults': 1})
        data.list_events.side_effect = None
        data.list_events.return_value = {'events': [{'eventId': 'e1'}]}
        with patch.object(verifier['time'], 'sleep'), self.assertRaisesRegex(RuntimeError, 'were not purged'):
            record.wait_purged('actor-1', 'session-1', seconds=0)
        control.list_memories.side_effect = [{'memories': []}]
        with self.assertRaisesRegex(RuntimeError, 'exactly one deployed AgentCore memory'):
            verifier['SessionRecord'](control, data)

    def test_the_purge_waits_for_the_sessions_pending_writes_sessions(self):
        control, data = Mock(), Mock()
        name = verifier['IDENTITY']['aws']['agentCore']['memory']
        control.list_memories.return_value = {'memories': [{'id': name + '-AbC123'}]}
        writes = 'lgw-' + hashlib.sha256(b'session-1').hexdigest()[:32] + '-0'
        data.list_sessions.side_effect = lambda **kwargs: (
            {'sessionSummaries': [{'sessionId': writes}]} if kwargs.get('nextToken')
            else {'sessionSummaries': [{'sessionId': 'session-1'}, {'sessionId': 'lgw-other-0'}], 'nextToken': 'page-2'})
        events = {'session-1': [], writes: [{'eventId': 'w1'}]}
        data.list_events.side_effect = lambda **kwargs: {'events': events[kwargs['sessionId']]}
        record = verifier['SessionRecord'](control, data)

        with patch.object(verifier['time'], 'sleep'), self.assertRaisesRegex(RuntimeError, 'were not purged'):
            record.wait_purged('actor-1', 'session-1', seconds=0)
        events[writes] = []
        record.wait_purged('actor-1', 'session-1', seconds=0)

        self.assertEqual(data.list_sessions.call_args.kwargs, {'memoryId': name + '-AbC123', 'actorId': 'actor-1', 'nextToken': 'page-2'})

    def test_a_listed_memory_without_an_id_fails_loud(self):
        control = Mock()
        control.list_memories.return_value = {'memories': [{'name': 'nameless'}]}
        with self.assertRaisesRegex(RuntimeError, 'lacks AgentCore memory id'):
            verifier['SessionRecord'](control, Mock())

    def test_session_api_keeps_a_year_and_rejects_callers_other_than_the_chat_service(self):
        from botocore.exceptions import ClientError
        verify = verifier['verify_session_api']
        record = Mock()
        record.expiry_days.return_value = 365
        denied = Mock()
        denied.invoke.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'Invoke')
        self.assertEqual(verify(record, denied), {'eventExpiryDays': 365, 'foreignCallerRejected': True})
        aws = verifier['IDENTITY']['aws']
        self.assertEqual(denied.invoke.call_args.kwargs['FunctionName'],
                         f"arn:aws:lambda:{aws['region']}:{aws['account']}:function:{aws['agentCore']['sessionApiFunction']}")
        with self.assertRaisesRegex(RuntimeError, 'accepted a caller other than the Chat Service'):
            verify(record, Mock())
        missing = Mock()
        missing.invoke.side_effect = ClientError({'Error': {'Code': 'ResourceNotFoundException', 'Message': 'no'}}, 'Invoke')
        with self.assertRaisesRegex(RuntimeError, 'for another reason'):
            verify(record, missing)
        record.expiry_days.return_value = 90
        with self.assertRaisesRegex(RuntimeError, 'not 365 days'):
            verify(record, denied)

    def test_sse_rejects_incomplete_frames_and_non_sse(self):
        from email.message import Message

        class Response(io.BytesIO):
            status = 200
            headers = Message()

        response = Response(b'data: {"type":"RUN_FINISHED"}')
        response.headers['Content-Type'] = 'text/event-stream'
        with self.assertRaisesRegex(RuntimeError, 'incomplete SSE'):
            verifier['read_events'](response)
        response.headers.replace_header('Content-Type', 'application/json')
        with self.assertRaisesRegex(RuntimeError, 'not SSE'):
            verifier['read_events'](response)


if __name__ == '__main__':
    unittest.main()
