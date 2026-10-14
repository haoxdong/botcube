"""Park/unpark verification names every mismatch and records per-step timings and Credential Service start."""
import runpy
import unittest
import urllib.error
from datetime import UTC, datetime, timedelta
from email.message import Message
from io import BytesIO
from typing import Any
from unittest.mock import MagicMock, Mock, patch

from deploy_script_support import DEPLOY_ECS

verifier = runpy.run_path(str(DEPLOY_ECS / 'verify-park.py'))
transition = runpy.run_path(str(DEPLOY_ECS / 'transition.py'))

EXPECTED = {'publicIp': '192.0.2.1', 'allocationId': 'eipalloc-1', 'natGatewayId': 'nat-1'}
ALB_ALARMS = ('bot-cube-preview-alb-5xx', 'bot-cube-preview-target-5xx', 'bot-cube-preview-unhealthy-hosts')


def parked() -> dict[str, Any]:
    return {
        'stacks': {'origin': 'UPDATE_COMPLETE', 'egress': 'UPDATE_COMPLETE'},
        'servingResources': [], 'natResources': [], 'defaultRoutes': [], 'natGateways': [],
        'address': {'AllocationId': 'eipalloc-1'},
        'services': {name: {'desired': 0, 'running': 0, 'pending': 0, 'rollout': 'COMPLETED'}
                     for name in ('chat-service-preview', 'credential-service')},
        'reaper': 'DISABLED',
        'healthCheckDisabled': True,
        'alarmActions': {'bot-cube-api-health': False, 'bot-cube-preview-task-deficit': False},
        'dns': {host: {'type': 'CNAME', 'content': 'parked.invalid', 'proxied': True, 'owned': True}
                for host in ('api.bot-cube.com', 'api-next.bot-cube.com')},
        'responses': {host: parked_response() for host in ('api.bot-cube.com', 'api-next.bot-cube.com')},
    }


def parked_response() -> dict[str, object]:
    return {'status': 503, 'body': {'status': 'parked'},
            'allowOrigin': 'http://localhost:3001', 'allowCredentials': 'true'}


def live() -> dict[str, Any]:
    return {
        'stacks': {'origin': 'UPDATE_COMPLETE', 'egress': 'UPDATE_COMPLETE'},
        'servingResources': ['AWS::ElasticLoadBalancingV2::LoadBalancer'],
        'natResources': ['AWS::EC2::NatGateway', 'AWS::EC2::Route'],
        'defaultRoutes': [{'NatGatewayId': 'nat-1', 'State': 'active'}],
        'natGateways': [{'NatGatewayId': 'nat-1', 'State': 'available', 'AllocationIds': ['eipalloc-1']}],
        'address': {'AllocationId': 'eipalloc-1', 'AssociationId': 'eipassoc-1'},
        'services': {name: {'desired': 1, 'running': 1, 'pending': 0, 'rollout': 'COMPLETED'}
                     for name in ('chat-service-preview', 'credential-service')},
        'health': {'chat-service-preview': ['healthy'], 'credential-service': ['HEALTHY']},
        'reaper': 'ENABLED',
        'healthCheckDisabled': False,
        'alarmActions': dict.fromkeys(('bot-cube-api-health', 'bot-cube-preview-task-deficit', *ALB_ALARMS), True),
        'egressIp': '192.0.2.1',
        'responses': {host: {'status': 200, 'body': {'status': 'ok'}, 'allowOrigin': 'http://localhost:3001', 'allowCredentials': 'true'}
                      for host in ('api.bot-cube.com', 'api-next.bot-cube.com')},
    }


class ParkedVerificationTests(unittest.TestCase):
    def test_parked_production_passes(self):
        self.assertEqual(verifier['parked_failures'](parked(), EXPECTED), [])

    def test_each_parked_mismatch_is_named(self):
        cases = {
            'ALB still exists': ('servingResources', ['AWS::ElasticLoadBalancingV2::LoadBalancer']),
            'NAT Gateway still in the egress stack': ('natResources', ['AWS::EC2::NatGateway']),
            'private default route still exists': ('defaultRoutes', [{'NatGatewayId': 'nat-1', 'State': 'blackhole'}]),
            'NAT Gateway still billed': ('natGateways', [{'NatGatewayId': 'nat-1', 'State': 'deleting', 'AllocationIds': []}]),
            'Elastic IP 192.0.2.1 is not retained': ('address', None),
            'reaper schedule is ENABLED': ('reaper', 'ENABLED'),
        }
        for message, (field, value) in cases.items():
            with self.subTest(field=field):
                facts = parked()
                facts[field] = value
                self.assertEqual(verifier['parked_failures'](facts, EXPECTED), [message])

    def test_running_tasks_or_failed_stacks_fail(self):
        facts = parked()
        facts['services']['credential-service']['running'] = 1
        facts['stacks']['origin'] = 'UPDATE_ROLLBACK_COMPLETE'
        self.assertEqual(verifier['parked_failures'](facts, EXPECTED), [
            'stack origin is UPDATE_ROLLBACK_COMPLETE',
            'credential-service is not at 0 tasks: desired 0, running 1, pending 0, rollout COMPLETED'])

    def test_a_deleted_or_unproxied_record_fails_because_a_worker_route_needs_it(self):
        facts = parked()
        facts['dns']['api.bot-cube.com'] = None
        facts['dns']['api-next.bot-cube.com']['proxied'] = False
        self.assertEqual(verifier['parked_failures'](facts, EXPECTED), [
            'api.bot-cube.com DNS is not an owned proxied CNAME to parked.invalid',
            'api-next.bot-cube.com DNS is not an owned proxied CNAME to parked.invalid'])

    def test_the_web_ui_must_be_able_to_read_the_parked_503(self):
        cases = {
            'Cloudflare error': {'status': 522, 'body': 'error code: 522', 'allowOrigin': None, 'allowCredentials': None},
            'no CORS grant': {**parked_response(), 'allowOrigin': None, 'allowCredentials': None},
            'other 503': {**parked_response(), 'body': {'detail': 'unavailable'}},
        }
        for name, response in cases.items():
            with self.subTest(name):
                facts = parked()
                facts['responses']['api.bot-cube.com'] = response
                self.assertEqual(verifier['parked_failures'](facts, EXPECTED),
                                 [f'api.bot-cube.com does not answer the parked 503 to the web UI: {response}'])

    def test_monitoring_that_would_breach_at_zero_tasks_must_be_off(self):
        facts = parked()
        facts['healthCheckDisabled'] = False
        facts['alarmActions'] = {'bot-cube-api-health': True, 'bot-cube-preview-task-deficit': False,
                                 'bot-cube-preview-alb-5xx': True}
        self.assertEqual(verifier['parked_failures'](facts, EXPECTED), [
            'API health check is enabled',
            'alarm actions are not off: bot-cube-api-health on, bot-cube-preview-alb-5xx on'])


class LiveVerificationTests(unittest.TestCase):
    def test_task_lookup_failures_cannot_become_healthy_live_evidence(self):
        for tasks in ([], [{'healthStatus': 'HEALTHY'}]):
            with self.subTest(tasks=tasks):
                ecs, elb = Mock(), Mock()
                ecs.list_tasks.return_value = {'taskArns': ['healthy', 'missing']}
                ecs.describe_tasks.return_value = {
                    'tasks': tasks, 'failures': [{'arn': 'missing', 'reason': 'MISSING'}]}
                elb.describe_target_health.return_value = {
                    'TargetHealthDescriptions': [{'TargetHealth': {'State': 'healthy'}}]}
                with self.assertRaisesRegex(RuntimeError, 'Credential Service health task lookup failed'):
                    verifier['health_facts'](ecs, elb, {'TargetGroupArn': 'target'})

    def test_successful_health_lookup_reaches_the_live_verdict(self):
        for arns in ([], ['healthy']):
            with self.subTest(arns=arns):
                ecs, elb = Mock(), Mock()
                ecs.list_tasks.return_value = {'taskArns': arns}
                ecs.describe_tasks.return_value = {'tasks': [{'healthStatus': 'HEALTHY'}], 'failures': []}
                elb.describe_target_health.return_value = {
                    'TargetHealthDescriptions': [{'TargetHealth': {'State': 'healthy'}}]}
                facts = live()
                facts['health'] = verifier['health_facts'](ecs, elb, {'TargetGroupArn': 'target'})
                if arns:
                    self.assertEqual(verifier['live_failures'](facts, EXPECTED), [])
                    ecs.describe_tasks.assert_called_once_with(cluster='bot-cube', tasks=['healthy'])
                else:
                    self.assertEqual(verifier['live_failures'](facts, EXPECTED),
                                     ['credential-service tasks are not healthy: none'])
                    ecs.describe_tasks.assert_not_called()
    @staticmethod
    def edge_response(status: int, body: bytes, origin: str | None = 'http://localhost:3001', credentials: str | None = 'true') -> MagicMock:
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = status
        response.headers = {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': credentials}
        response.read.return_value = body
        return response

    def test_failed_edge_responses_cannot_verify_live(self):
        cases = ((500, b'{"detail":"unavailable"}', 'http://localhost:3001', 'true'),
                 (522, b'error code: 522', 'http://localhost:3001', 'true'),
                 (200, b'{"status":"unavailable"}', 'http://localhost:3001', 'true'),
                 (200, b'{"status":"ok"}', None, 'true'),
                 (200, b'{"status":"ok"}', 'http://localhost:3001', None))
        for status, body, origin, credentials in cases:
            with self.subTest(status=status, body=body, origin=origin, credentials=credentials):
                response = self.edge_response(status, body, origin, credentials)
                def request(*args: Any, status: int = status, body: bytes = body, response: MagicMock = response, **kwargs: Any) -> MagicMock:
                    if status != 200:
                        raise urllib.error.HTTPError(args[0].full_url, status, 'unavailable', response.headers, BytesIO(body))
                    return response
                with patch('urllib.request.urlopen', side_effect=request), patch('time.sleep'):
                    responses = verifier['response_facts'](False)
                facts = live()
                facts['responses'] = responses
                self.assertEqual(verifier['live_failures'](facts, EXPECTED), [
                    f'{host} does not answer live readiness to the web UI: {value}' for host, value in responses.items()])

    def test_live_probe_waits_for_readiness_after_an_edge_failure(self):
        with patch('urllib.request.urlopen', side_effect=[
            urllib.error.HTTPError('https://api.bot-cube.com/health', 522, 'unavailable', Message(), BytesIO(b'error code: 522')),
            self.edge_response(200, b'{"status":"ok"}'),
            self.edge_response(200, b'{"status":"ok"}'), self.edge_response(200, b'{"status":"ok"}')]) as request, patch('time.sleep'):
            facts = live()
            facts['responses'] = verifier['response_facts'](False)
        self.assertEqual(request.call_count, 4)
        self.assertEqual(verifier['live_failures'](facts, EXPECTED), [])

    def test_live_production_passes(self):
        self.assertEqual(verifier['live_failures'](live(), EXPECTED), [])

    def test_each_live_mismatch_is_named(self):
        cases = {
            'private default route is not active through nat-1': ('defaultRoutes', []),
            'NAT Gateway nat-1 is not available on eipalloc-1': ('natGateways', [{'NatGatewayId': 'nat-1', 'State': 'available', 'AllocationIds': ['eipalloc-2']}]),
            'egress left through 3.3.3.3, not 192.0.2.1': ('egressIp', '3.3.3.3'),
            'reaper schedule is DISABLED': ('reaper', 'DISABLED'),
        }
        for message, (field, value) in cases.items():
            with self.subTest(field=field):
                facts = live()
                facts[field] = value
                self.assertEqual(verifier['live_failures'](facts, EXPECTED), [message])

    def test_unsteady_or_unhealthy_services_fail(self):
        facts = live()
        facts['services']['chat-service-preview'].update(running=0, rollout='IN_PROGRESS')
        facts['health']['credential-service'] = ['UNKNOWN']
        self.assertEqual(verifier['live_failures'](facts, EXPECTED), [
            'chat-service-preview is not steady at 1 task: desired 1, running 0, pending 0, rollout IN_PROGRESS',
            'credential-service tasks are not healthy: UNKNOWN'])

    def test_old_draining_target_does_not_fail_a_healthy_unpark(self):
        facts = live()
        facts['health']['chat-service-preview'] = ['draining', 'healthy']
        self.assertEqual(verifier['live_failures'](facts, EXPECTED), [])
        facts['health']['chat-service-preview'] = ['draining']
        self.assertEqual(verifier['live_failures'](facts, EXPECTED), ['chat-service-preview tasks are not healthy: none'])

    def test_unpark_is_not_done_until_monitoring_is_restored(self):
        facts = live()
        facts['healthCheckDisabled'] = True
        facts['alarmActions']['bot-cube-preview-task-deficit'] = False
        del facts['alarmActions']['bot-cube-api-health']
        self.assertEqual(verifier['live_failures'](facts, EXPECTED), [
            'API health check is disabled',
            'alarm actions are not on: bot-cube-api-health missing, bot-cube-preview-task-deficit off'])

    def test_a_lingering_parked_response_fails(self):
        facts = live()
        facts['responses']['api-next.bot-cube.com'] = parked_response()
        self.assertEqual(verifier['live_failures'](facts, EXPECTED), ['api-next.bot-cube.com still answers the parked 503'])


class CredentialStartTests(unittest.TestCase):
    def test_task_lookup_failures_are_not_reported_as_no_new_task(self):
        since = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)
        for tasks in ([], [{'taskArn': 'new', 'createdAt': since, 'healthStatus': 'HEALTHY',
                           'pullStartedAt': since, 'pullStoppedAt': since, 'startedAt': since}]):
            with self.subTest(tasks=tasks):
                ecs = Mock()
                ecs.list_tasks.return_value = {'taskArns': ['new', 'missing']}
                ecs.describe_tasks.return_value = {'tasks': tasks, 'failures': [{'arn': 'missing', 'reason': 'MISSING'}]}
                watch = transition['CredentialWatch'](since)
                watch.done.set()
                with patch('boto3.client', return_value=ecs):
                    watch.start()
                    with self.assertRaisesRegex(RuntimeError, 'Credential Service task lookup failed'):
                        watch.stop()
                ecs.describe_tasks.assert_called_once_with(cluster=transition['IDENTITY']['aws']['ecs']['cluster'], tasks=['new', 'missing'])

    def test_watch_preserves_no_task_and_successful_measurement_results(self):
        since = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)
        for arns in ([], ['new']):
            with self.subTest(arns=arns):
                ecs = Mock()
                ecs.list_tasks.return_value = {'taskArns': arns}
                ecs.describe_tasks.return_value = {'tasks': [{'taskArn': 'new', 'createdAt': since,
                    'healthStatus': 'HEALTHY', 'pullStartedAt': since,
                    'pullStoppedAt': since + timedelta(seconds=2), 'startedAt': since}], 'failures': []}
                watch = transition['CredentialWatch'](since)
                watch.done.set()
                with patch('boto3.client', return_value=ecs):
                    watch.start()
                    result = watch.stop()
                if arns:
                    self.assertEqual(result['task'], 'new')
                    self.assertEqual(result['pullSeconds'], 2.0)
                else:
                    self.assertIsNone(result)
                    ecs.describe_tasks.assert_not_called()

    def test_time_to_healthy_runs_from_the_new_task_start_to_the_first_healthy_observation(self):
        since = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)

        def at(seconds: float) -> datetime:
            return since + timedelta(seconds=seconds)

        old = {'taskArn': 'old', 'createdAt': at(-600), 'pullStartedAt': at(-599), 'pullStoppedAt': at(-560),
               'startedAt': at(-555), 'healthStatus': 'HEALTHY'}
        new = {'taskArn': 'new', 'createdAt': at(20), 'pullStartedAt': at(22), 'pullStoppedAt': at(40),
               'startedAt': at(43), 'healthStatus': 'UNKNOWN'}
        self.assertIsNone(transition['credential_start']([old, new], since, at(50)))
        self.assertEqual(transition['credential_start']([old, {**new, 'healthStatus': 'HEALTHY'}], since, at(61)),
                         {'task': 'new', 'pullSeconds': 18.0, 'startToHealthySeconds': 18.0})


class TransitionTests(unittest.TestCase):
    def test_states_map_to_the_cdk_flag(self):
        self.assertEqual(transition['TARGETS'], {'park': 'parked', 'unpark': 'live'})

    def test_stored_state_must_be_live_or_parked(self):
        self.assertEqual(transition['parse_state']('parked'), 'parked')
        self.assertEqual(transition['parse_state']('live'), 'live')
        for value in ('Parked', 'paused', ''):
            with self.subTest(value=value), self.assertRaisesRegex(SystemExit, 'Stored park state'):
                transition['parse_state'](value)

    def test_steps_are_timed_and_a_failure_names_its_step(self):
        clock = iter([0.0, 2.5, 2.5, 4.0])
        run = transition['Run']('unpark', clock=lambda: next(clock))
        run.step('record state', lambda: None)
        with self.assertRaisesRegex(SystemExit, 'unpark failed at step "deploy": RuntimeError: boom'):
            run.step('deploy', lambda: (_ for _ in ()).throw(RuntimeError('boom')))
        self.assertEqual(run.steps, [{'step': 'record state', 'seconds': 2.5, 'ok': True},
                                     {'step': 'deploy', 'seconds': 1.5, 'ok': False, 'error': 'RuntimeError: boom'}])


class MissingProviderFieldTests(unittest.TestCase):
    """A provider response without a field a verdict reads fails loud, naming the field (ADR 0030)."""

    def test_a_health_check_without_its_disabled_flag_fails(self):
        route53, cloudwatch = Mock(), Mock()
        route53.get_health_check.return_value = {'HealthCheck': {'HealthCheckConfig': {}}}
        cloudwatch.describe_alarms.return_value = {'MetricAlarms': []}
        with self.assertRaisesRegex(RuntimeError, 'lacks health check Disabled'):
            verifier['monitoring_facts'](route53, cloudwatch, {'HealthCheckId': 'check'})

    def test_an_alarm_without_its_actions_flag_fails(self):
        route53, cloudwatch = Mock(), Mock()
        route53.get_health_check.return_value = {'HealthCheck': {'HealthCheckConfig': {'Disabled': True}}}
        cloudwatch.describe_alarms.return_value = {'MetricAlarms': [{'AlarmName': 'bot-cube-api-health'}]}
        with self.assertRaisesRegex(RuntimeError, 'lacks alarm ActionsEnabled'):
            verifier['monitoring_facts'](route53, cloudwatch, {'HealthCheckId': 'check'})

    def test_a_service_without_its_running_count_fails(self):
        ecs = Mock()
        ecs.describe_services.return_value = {'services': [
            {'serviceName': name, 'desiredCount': 0, 'pendingCount': 0, 'deployments': []}
            for name in ('chat-service-preview', 'credential-service')]}
        with self.assertRaisesRegex(RuntimeError, 'lacks ECS service runningCount'):
            verifier['service_facts'](ecs)

    def test_a_nat_gateway_address_without_its_allocation_fails(self):
        ec2 = Mock()
        ec2.describe_route_tables.return_value = {'RouteTables': [{'Routes': []}]}
        ec2.describe_nat_gateways.return_value = {'NatGateways': [
            {'NatGatewayId': 'nat-1', 'State': 'available', 'NatGatewayAddresses': [{}]}]}
        with self.assertRaisesRegex(RuntimeError, 'lacks NAT gateway address AllocationId'):
            verifier['network_facts'](ec2)

    def test_a_target_without_its_health_state_fails(self):
        ecs, elb = Mock(), Mock()
        elb.describe_target_health.return_value = {'TargetHealthDescriptions': [{'Target': {'Id': '10.0.0.1'}}]}
        ecs.list_tasks.return_value = {'taskArns': []}
        with self.assertRaisesRegex(RuntimeError, 'lacks target TargetHealth'):
            verifier['health_facts'](ecs, elb, {'TargetGroupArn': 'target'})

    def test_a_stopped_egress_probe_without_containers_fails(self):
        ecs, logs = Mock(), Mock()
        ecs.run_task.return_value = {'tasks': [{'taskArn': 'arn:task/probe'}]}
        ecs.describe_tasks.return_value = {'tasks': [{'taskArn': 'arn:task/probe'}]}
        outputs = {'ReaperTaskDefinitionArn': 'reaper', 'ReaperLogGroupName': 'logs', 'ReaperSecurityGroupId': 'sg-placeholder'}
        with self.assertRaisesRegex(RuntimeError, 'lacks egress probe task containers'):
            verifier['egress_ip'](ecs, logs, outputs)

    def test_stored_park_state_without_a_value_fails(self):
        ssm = Mock()
        ssm.get_parameter.return_value = {'Parameter': {'Name': 'state'}}
        with patch('boto3.client', return_value=ssm), self.assertRaisesRegex(RuntimeError, 'lacks stored park state Value'):
            transition['stored_state']()


if __name__ == '__main__':
    unittest.main()
