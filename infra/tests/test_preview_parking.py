"""Park/unpark verification names every mismatch and records per-step timings and Credential Service start."""
import json
import runpy
import unittest
import urllib.error
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from email.message import Message
from io import BytesIO
from typing import Any, TypedDict
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
                for host in ('api.example.com', 'api-next.example.com')},
        'responses': {host: parked_response() for host in ('api.example.com', 'api-next.example.com')},
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
                      for host in ('api.example.com', 'api-next.example.com')},
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
        facts['dns']['api.example.com'] = None
        facts['dns']['api-next.example.com']['proxied'] = False
        self.assertEqual(verifier['parked_failures'](facts, EXPECTED), [
            'api.example.com DNS is not an owned proxied CNAME to parked.invalid',
            'api-next.example.com DNS is not an owned proxied CNAME to parked.invalid'])

    def test_the_web_ui_must_be_able_to_read_the_parked_503(self):
        cases = {
            'Cloudflare error': {'status': 522, 'body': 'error code: 522', 'allowOrigin': None, 'allowCredentials': None},
            'no CORS grant': {**parked_response(), 'allowOrigin': None, 'allowCredentials': None},
            'other 503': {**parked_response(), 'body': {'detail': 'unavailable'}},
        }
        for name, response in cases.items():
            with self.subTest(name):
                facts = parked()
                facts['responses']['api.example.com'] = response
                self.assertEqual(verifier['parked_failures'](facts, EXPECTED),
                                 [f'api.example.com does not answer the parked 503 to the web UI: {response}'])

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
            urllib.error.HTTPError('https://api.example.com/health', 522, 'unavailable', Message(), BytesIO(b'error code: 522')),
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
        facts['responses']['api-next.example.com'] = parked_response()
        self.assertEqual(verifier['live_failures'](facts, EXPECTED), ['api-next.example.com still answers the parked 503'])


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


    # Run 42087296686 (2026-11-05 18:45Z) and an 11:22Z unpark: ECS reported the new task HEALTHY while it was
    # still ACTIVATING, before `startedAt`, and the step crashed with KeyError: 'startedAt' after a good deploy.
    def test_a_healthy_task_without_startedAt_is_not_measured_yet(self):
        since = datetime(2026, 11, 5, 18, 0, tzinfo=UTC)
        activating = {'taskArn': 'new', 'createdAt': since, 'healthStatus': 'HEALTHY',
                      'pullStartedAt': since, 'pullStoppedAt': since + timedelta(seconds=100)}
        self.assertIsNone(transition['credential_start']([activating], since, since + timedelta(seconds=110)))
        self.assertEqual(transition['unstarted_task']([activating], since), 'new')

    def test_the_watch_waits_for_startedAt_after_the_deploy(self):
        since = datetime(2026, 11, 5, 18, 0, tzinfo=UTC)
        activating = {'taskArn': 'new', 'createdAt': since, 'healthStatus': 'HEALTHY',
                      'pullStartedAt': since, 'pullStoppedAt': since + timedelta(seconds=100)}
        running = {**activating, 'startedAt': since + timedelta(seconds=109)}
        ecs = Mock()
        ecs.list_tasks.return_value = {'taskArns': ['new']}
        ecs.describe_tasks.side_effect = [{'tasks': [activating]}, {'tasks': [activating]}, {'tasks': [running]}]
        watch = transition['CredentialWatch'](since, pause=lambda _: None)
        watch.done.set()
        with patch('boto3.client', return_value=ecs):
            watch.start()
            result = watch.stop()
        self.assertEqual((result['task'], result['pullSeconds']), ('new', 100.0))
        self.assertEqual(ecs.describe_tasks.call_count, 3)

    def test_a_task_never_started_within_the_grace_is_reported_not_started(self):
        since = datetime(2026, 11, 5, 18, 0, tzinfo=UTC)
        activating = {'taskArn': 'new', 'createdAt': since, 'healthStatus': 'HEALTHY',
                      'pullStartedAt': since, 'pullStoppedAt': since}
        ecs = Mock()
        ecs.list_tasks.return_value = {'taskArns': ['new']}
        ecs.describe_tasks.return_value = {'tasks': [activating]}
        ticks = iter(range(1000))
        watch = transition['CredentialWatch'](since, grace=5, clock=lambda: next(ticks), pause=lambda _: None)
        watch.done.set()
        with patch('boto3.client', return_value=ecs):
            watch.start()
            self.assertEqual(watch.stop(), {'task': 'new', 'started': False})


class ServiceCapacityTests(unittest.TestCase):
    def test_unpark_restores_both_services_from_desired_zero_and_waits_before_live_verification(self):
        import tempfile
        desired = dict.fromkeys(verifier['SERVICES'], 0)
        ecs = Mock()
        def update_service(*, cluster, service, desiredCount):
            desired[service] = desiredCount
        ecs.update_service.side_effect = update_service
        def command(*args, **kwargs):
            if 'live' in args and str(DEPLOY_ECS / 'verify-park.py') in args:
                facts = live()
                for name, count in desired.items():
                    facts['services'][name]['desired'] = count
                failures = verifier['live_failures'](facts, EXPECTED)
                if failures:
                    raise RuntimeError('; '.join(failures))
                ecs.get_waiter.return_value.wait.assert_called_once()
        with tempfile.TemporaryDirectory() as temp, \
                patch.dict(transition['transition'].__globals__, {
                    'run': command, 'CredentialWatch': Mock(return_value=Mock(stop=Mock(return_value=None))), 'session_api_capacity': Mock(),
                    'refresh_runtime_spares': Mock(return_value={}), 'await_spare_handoff': Mock(), 'remove_legacy_files_imports': Mock()}), \
                patch.dict('os.environ', {'RUNNER_TEMP': temp}), patch('boto3.client', return_value=ecs):
            transition['transition']('unpark')
        self.assertEqual(desired, dict.fromkeys(verifier['SERVICES'], 1))
        ecs.get_waiter.return_value.wait.assert_called_once_with(
            cluster=transition['IDENTITY']['aws']['ecs']['cluster'], services=list(verifier['SERVICES']),
            WaiterConfig={'Delay': 15, 'MaxAttempts': 40})

    def test_capacity_restore_failure_stops_the_transition(self):
        for failure in ('update', 'stability'):
            with self.subTest(failure=failure):
                ecs = Mock()
                if failure == 'update':
                    ecs.update_service.side_effect = RuntimeError('service missing')
                else:
                    ecs.get_waiter.return_value.wait.side_effect = RuntimeError('service unstable')
                with self.assertRaisesRegex(RuntimeError, 'service'):
                    transition['restore_service_capacity'](ecs)
                if failure == 'update':
                    ecs.get_waiter.assert_not_called()

    def test_park_keeps_service_capacity_at_zero(self):
        import tempfile
        ecs = Mock()
        with tempfile.TemporaryDirectory() as temp, \
                patch.dict(transition['transition'].__globals__, {
                    'run': Mock(), 'CredentialWatch': Mock(return_value=Mock(stop=Mock(return_value=None))),
                    'session_api_capacity': Mock(), 'remove_legacy_files_imports': Mock()}), \
                patch.dict('os.environ', {'RUNNER_TEMP': temp}), patch('boto3.client', return_value=ecs):
            transition['transition']('park')
        ecs.update_service.assert_not_called()
        ecs.get_waiter.assert_not_called()


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
        elb.describe_target_health.return_value = {'TargetHealthDescriptions': [{'Target': {'Id': '192.0.2.1'}}]}
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


class SessionApiProduction:
    """Application Auto Scaling and Lambda as the session API alias sees them, in memory."""

    def __init__(self, provisioned: int | None = 2, minimum: int = 2, target: bool = True):
        agent = transition['IDENTITY']['aws']['agentCore']
        self.function, self.alias = agent['sessionApiFunction'], agent['sessionApiAlias']
        self.provisioned, self.minimum, self.target = provisioned, minimum, target
        self.weighted_for = 0
        self.suspended: dict[str, bool] | None = None
        self.alias_updates: list[dict[str, Any]] = []

    def get_alias(self, FunctionName: str, Name: str) -> dict[str, Any]:
        assert (FunctionName, Name) == (self.function, self.alias)
        weights = {'AdditionalVersionWeights': {'171': 1.0}} if self.weighted_for else {}
        return {'FunctionVersion': '172', **({'RoutingConfig': weights} if weights else {})}

    def update_alias(self, **kwargs: Any) -> None:
        self.alias_updates.append(kwargs)
        if kwargs.get('RoutingConfig') == {'AdditionalVersionWeights': {}}:
            self.weighted_for = 0

    def describe_scalable_targets(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs == {'ServiceNamespace': 'lambda', 'ResourceIds': [f'function:{self.function}:{self.alias}'], 'ScalableDimension': 'lambda:function:ProvisionedConcurrency'}
        return {'ScalableTargets': [{'MinCapacity': self.minimum, 'MaxCapacity': 5}] if self.target else []}

    def register_scalable_target(self, **kwargs: Any) -> None:
        self.suspended = kwargs['SuspendedState']

    def list_provisioned_concurrency_configs(self, FunctionName: str) -> dict[str, Any]:
        arn = f'arn:aws:lambda:us-east-1:123456789012:function:{FunctionName}:{self.alias}'
        return {'ProvisionedConcurrencyConfigs': [] if self.provisioned is None else [{'FunctionArn': arn}]}

    def put_provisioned_concurrency_config(self, FunctionName: str, Qualifier: str, ProvisionedConcurrentExecutions: int) -> None:
        assert (FunctionName, Qualifier) == (self.function, self.alias)
        if self.weighted_for:
            self.weighted_for -= 1
            raise RuntimeError('An error occurred (InvalidParameterValueException) when calling the PutProvisionedConcurrencyConfig '
                               'operation: Alias with weights can not be used with Provisioned Concurrency')
        self.provisioned = ProvisionedConcurrentExecutions

    def delete_provisioned_concurrency_config(self, FunctionName: str, Qualifier: str) -> None:
        assert (FunctionName, Qualifier) == (self.function, self.alias)
        self.provisioned = None


SUSPENDED = {'DynamicScalingInSuspended': True, 'DynamicScalingOutSuspended': True, 'ScheduledScalingSuspended': True}
RESUMED = dict.fromkeys(SUSPENDED, False)


class SessionApiCapacityTests(unittest.TestCase):

    def test_park_releases_every_provisioned_environment_with_scaling_suspended_so_it_stays_released(self):
        api = SessionApiProduction()
        transition['session_api_capacity']('parked', api, api)
        self.assertEqual((api.provisioned, api.suspended), (None, SUSPENDED))

    def test_a_park_re_run_with_nothing_provisioned_converges(self):
        api = SessionApiProduction(provisioned=None)
        transition['session_api_capacity']('parked', api, api)
        self.assertEqual((api.provisioned, api.suspended), (None, SUSPENDED))

    def test_unpark_restores_the_scaling_minimum_and_resumes_scaling(self):
        api = SessionApiProduction(provisioned=None, minimum=2)
        transition['session_api_capacity']('live', api, api)
        self.assertEqual((api.provisioned, api.suspended), (2, RESUMED))

    def test_unpark_waits_out_an_agentcore_deploys_alias_weights(self):
        # 2026-11-05 11:24Z: an AgentCore deploy's alias update overlapped unpark, and Lambda refused the provisioning.
        api = SessionApiProduction(provisioned=None, minimum=2)
        api.weighted_for = 2
        pauses: list[float] = []
        transition['session_api_capacity']('live', api, api, pause=pauses.append)
        self.assertEqual((api.provisioned, api.suspended, len(pauses)), (2, RESUMED, 2))

    def test_alias_weights_that_outlast_the_wait_with_provisioning_in_place_fail_loud(self):
        api = SessionApiProduction(provisioned=2)
        api.weighted_for = 99
        with self.assertRaisesRegex(RuntimeError, "still routes by weights after .*re-run unpark once the AgentCore deploy finishes"):
            transition['session_api_capacity']('live', api, api, pause=lambda _: None, timeout=-1)
        self.assertEqual(api.alias_updates, [])

    def test_unpark_clears_weights_a_park_orphaned_and_provisions(self):
        # 2026-11-06 02:42Z: a Harness deploy moved the provisioned alias to version 172, so Lambda routed to 171 until
        # 172's environments were ready; a park deleted the provisioning a minute later, so the shift could never finish.
        api = SessionApiProduction(provisioned=None, minimum=2)
        api.weighted_for = 99
        transition['session_api_capacity']('live', api, api, pause=lambda _: None, timeout=-1)
        self.assertEqual(api.alias_updates, [{'FunctionName': api.function, 'Name': api.alias, 'FunctionVersion': '172',
                                              'RoutingConfig': {'AdditionalVersionWeights': {}}}])
        self.assertEqual((api.provisioned, api.suspended), (2, RESUMED))

    def test_any_other_provisioning_refusal_fails_at_once(self):
        api = SessionApiProduction(provisioned=None)
        api.put_provisioned_concurrency_config = Mock(side_effect=RuntimeError('AccessDeniedException'))
        with self.assertRaisesRegex(RuntimeError, 'AccessDeniedException'):
            transition['session_api_capacity']('live', api, api, pause=lambda _: self.fail('waited on an unrelated refusal'))

    def test_a_missing_scalable_target_fails_loud(self):
        api = SessionApiProduction(target=False)
        with self.assertRaisesRegex(RuntimeError, 'has no scalable target; deploy the AgentCore stack'):
            transition['session_api_capacity']('parked', api, api)


class NetworkModeFixture(TypedDict):
    subnets: list[str]
    securityGroups: list[str]


class NetworkFixture(TypedDict):
    networkMode: str
    networkModeConfig: NetworkModeFixture


class RuntimeConfigurationFixture(TypedDict):
    agentRuntimeArtifact: dict[str, dict[str, str]]
    roleArn: str
    networkConfiguration: NetworkFixture
    description: str
    protocolConfiguration: dict[str, str]
    lifecycleConfiguration: dict[str, int]
    metadataConfiguration: dict[str, bool]
    environmentVariables: dict[str, str]
    filesystemConfigurations: list[dict[str, dict[str, str]]]
    platformVersion: str


class AgentCoreProduction:
    """The AgentCore control plane as the refresh sees it, in memory: one runtime whose update makes a new version."""

    def __init__(self, extra: dict[str, Any] | None = None, status: str = 'READY', fail: str | None = None):
        self.name = transition['IDENTITY']['aws']['agentCore']['runtime']
        self.configuration: RuntimeConfigurationFixture = {
            'agentRuntimeArtifact': {'containerConfiguration': {'containerUri': 'example.dkr.ecr/runtime@sha256:1'}},
            'roleArn': 'arn:aws:iam::123456789012:role/runtime',
            'networkConfiguration': {'networkMode': 'VPC', 'networkModeConfig': {'subnets': ['private-a'], 'securityGroups': ['runtime']}},
            'description': 'runtime', 'protocolConfiguration': {'serverProtocol': 'AGUI'},
            'lifecycleConfiguration': {'idleRuntimeSessionTimeout': 300, 'maxLifetime': 3600},
            'metadataConfiguration': {'requireMMDSV2': True}, 'environmentVariables': {'BOTCUBE_SNAPSHOT_PRIME': '1'},
            'filesystemConfigurations': [{'sessionStorage': {'mountPath': '/mnt/workspace'}}], 'platformVersion': 'V1',
        }
        self.version, self.status, self.fail, self.extra = '204', status, fail, extra or {}
        self.reported_network = {'requireServiceS3Endpoint': False}
        self.updates: list[dict[str, Any]] = []

    def get_paginator(self, operation: str) -> Any:
        assert operation == 'list_agent_runtimes'
        runtimes = [{'agentRuntimeName': 'other_runtime', 'agentRuntimeId': 'other-1'}, {'agentRuntimeName': self.name, 'agentRuntimeId': 'rt-1'}]
        return Mock(paginate=lambda: iter([{'agentRuntimes': runtimes[:1]}, {'agentRuntimes': runtimes[1:]}]))

    def get_agent_runtime(self, agentRuntimeId: str) -> dict[str, Any]:
        assert agentRuntimeId == 'rt-1'
        return {'agentRuntimeId': 'rt-1', 'agentRuntimeName': self.name, 'agentRuntimeVersion': self.version,
                'status': self.status, 'workloadIdentityDetails': {}, **self.configuration, **self.extra,
                'networkConfiguration': {**self.configuration['networkConfiguration'],
                                         'networkModeConfig': {**self.configuration['networkConfiguration']['networkModeConfig'], **self.reported_network}}}

    def update_agent_runtime(self, agentRuntimeId: str, **configuration: Any) -> None:
        assert agentRuntimeId == 'rt-1'
        if 'requireServiceS3Endpoint' in configuration['networkConfiguration']['networkModeConfig']:
            raise ValueError('Agents created after 2026-06-11T00:00:00Z cannot modify requireServiceS3Endpoint')
        self.updates.append(configuration)
        if self.fail:
            self.status = self.fail
        else:
            self.version = str(int(self.version) + 1)


class RuntimeSparesTests(unittest.TestCase):
    """After a park, the runtime has no spare microVMs until a new version starts them with egress back."""

    def test_unpark_refreshes_the_runtime_with_its_unchanged_configuration_and_waits_for_the_new_version(self):
        agentcore = AgentCoreProduction()
        self.assertEqual(transition['refresh_runtime_spares'](agentcore, pause=lambda _: None)['agentRuntimeVersion'], '205')
        self.assertEqual(agentcore.updates, [agentcore.configuration])

    def test_a_runtime_field_the_refresh_would_drop_fails_before_any_update(self):
        agentcore = AgentCoreProduction(extra={'newSetting': {'on': True}})
        with self.assertRaisesRegex(RuntimeError, 'would drop: newSetting'):
            transition['refresh_runtime_spares'](agentcore, pause=lambda _: None)
        self.assertEqual(agentcore.updates, [])

    def test_a_runtime_mid_update_is_not_refreshed(self):
        agentcore = AgentCoreProduction(status='UPDATING')
        with self.assertRaisesRegex(RuntimeError, 'is UPDATING, not READY'):
            transition['refresh_runtime_spares'](agentcore, pause=lambda _: None)
        self.assertEqual(agentcore.updates, [])

    def test_a_failed_refresh_fails_loud(self):
        agentcore = AgentCoreProduction(fail='UPDATE_FAILED')
        with self.assertRaisesRegex(RuntimeError, 'refresh UPDATE_FAILED'):
            transition['refresh_runtime_spares'](agentcore, pause=lambda _: None)

    def test_unpark_refreshes_the_runtime_once_egress_is_back_before_the_deploy_that_opens_the_front_door(self):
        # Spares take minutes to start; refreshed before the front door opens, they start during the main deploy,
        # so the first users after a wake land on spares, not 30 s fresh microVMs.
        for action, expected in (('unpark', ['deploy egress', 'refresh runtime spares', 'remove legacy Files imports', 'deploy', 'restore service capacity', 'measure credential service start']), ('park', ['verify parked', 'release session API capacity'])):
            with self.subTest(action=action):
                run = Mock(report=dict)
                with patch.dict(transition['transition'].__globals__, {'Run': Mock(return_value=run), 'CredentialWatch': MagicMock()}), \
                        patch.dict('os.environ', {'RUNNER_TEMP': '/tmp'}), patch.dict('sys.modules', {'boto3': MagicMock()}):
                    transition['transition'](action)
                steps = [call.args[0] for call in run.step.call_args_list]
                start = steps.index(expected[0])
                self.assertEqual(steps[start:start + len(expected)], expected)
                self.assertEqual('refresh runtime spares' in steps, action == 'unpark')
                self.assertEqual('deploy egress' in steps, action == 'unpark')

    def test_unpark_deploys_egress_alone_and_live(self):
        run = Mock(report=dict)
        commands = []
        with patch.dict(transition['transition'].__globals__, {'Run': Mock(return_value=run), 'CredentialWatch': MagicMock(),
                                                               'run': lambda *command, **_: commands.append(command)}), \
                patch.dict('os.environ', {'RUNNER_TEMP': '/tmp'}), patch.dict('sys.modules', {'boto3': MagicMock()}):
            transition['transition']('unpark')
            works = {call.args[0]: call.args[1] for call in run.step.call_args_list}
            works['deploy egress']()
        self.assertEqual(commands, [('./node_modules/.bin/cdk', 'deploy', 'PrivateEgress', '--exclusively', '-c', 'previewOrigin=true',
                                     '-c', 'parked=false', '--require-approval', 'never')])


READY = datetime(2026, 11, 5, 16, 8, 49, tzinfo=UTC)


class RuntimeLogs:
    """The runtime log group in memory: each microVM's stream logs its handoff and, when a request reaches it,
    that request, and a filter returns the events logged by the clock's time."""

    def __init__(self, clock: list[float]):
        self.clock, self.records, self.filters = clock, [], []

    def microvm(self, stream: str, handoff: float, request: float | None = None):
        self.records.append((stream, 'serve_handoff', handoff))
        if request is not None:
            self.records.append((stream, 'first_asgi_invocation', request))

    def get_paginator(self, operation: str) -> Any:
        assert operation == 'filter_log_events'
        return Mock(paginate=self.paginate)

    def paginate(self, logGroupName: str, startTime: int, filterPattern: str) -> Iterator[dict[str, list[dict[str, Any]]]]:
        self.filters.append(logGroupName)
        assert filterPattern == transition['HANDOFF_PATTERN']
        events = [{'logStreamName': stream, 'timestamp': int(at * 1000),
                   'message': json.dumps({'event': 'harness_process_observation', 'stage': stage, 'atUnixNs': int(at * 1e9)})}
                  for stream, stage, at in self.records if startTime <= at * 1000 <= self.clock[0] * 1000]
        return iter([{'events': events[:1]}, {'events': events[1:]}])


class SpareHandoffTests(unittest.TestCase):
    """Unpark reports Live once the refreshed version's first spare microVM is handed off, or after 5 minutes."""

    def wait(self, logs: RuntimeLogs, clock: list[float]) -> str:
        def pause(seconds: float):
            clock[0] += seconds
        runtime = {'agentRuntimeId': 'rt-1', 'agentRuntimeVersion': '208', 'lastUpdatedAt': READY}
        with patch('builtins.print') as printed:
            transition['await_spare_handoff'](runtime, logs, clock=lambda: clock[0], pause=pause)
        return '\n'.join(call.args[0] for call in printed.call_args_list)

    def test_live_follows_the_first_spare_handoff_and_not_a_fresh_microvm_started_for_a_chat(self):
        start = READY.timestamp()
        clock = [start + 60]
        logs = RuntimeLogs(clock)
        logs.microvm('old-spare', start - 600, request=start + 70)
        logs.microvm('fresh', start + 81, request=start + 82.3)
        logs.microvm('spare', start + 239, request=start + 289)
        logs.microvm('later-spare', start + 240)
        self.assertEqual(self.wait(logs, clock), 'Runtime version 208 handed off its first spare microVM 239 s after READY')
        self.assertEqual(clock[0], start + 260)
        self.assertEqual(set(logs.filters), {'/aws/bedrock-agentcore/runtimes/rt-1-DEFAULT'})

    def test_no_spare_within_5_minutes_falls_back_to_live_with_a_warning_naming_the_version_and_wait(self):
        start = READY.timestamp()
        clock = [start + 60]
        logs = RuntimeLogs(clock)
        logs.microvm('fresh', start + 120, request=start + 121.7)
        logs.microvm('fresh-just-started', start + 295)
        self.assertEqual(self.wait(logs, clock), '::warning::Runtime version 208 handed off no spare microVM in 300 s after READY; '
                         'reporting Live while new chats start fresh microVMs (about 29 s each)')
        self.assertEqual(clock[0], start + 300)

    def test_unpark_reports_live_only_after_the_spare_wait_and_park_does_not_wait(self):
        for action in ('unpark', 'park'):
            with self.subTest(action=action):
                run = Mock(report=dict)
                with patch.dict(transition['transition'].__globals__, {'Run': Mock(return_value=run), 'CredentialWatch': MagicMock()}), \
                        patch.dict('os.environ', {'RUNNER_TEMP': '/tmp'}), patch.dict('sys.modules', {'boto3': MagicMock()}), \
                        patch('builtins.print'):
                    transition['transition'](action)
                steps = [call.args[0] for call in run.step.call_args_list]
                self.assertEqual(steps[-1] == 'await first spare handoff', action == 'unpark')
                self.assertEqual('await first spare handoff' in steps, action == 'unpark')


class LegacyFilesExportTests(unittest.TestCase):
    def test_origin_removes_legacy_imports_before_storage_exports_can_be_deleted(self):
        for names, expected in ((['ChatStorage:ExportsOutputFnGetAttFilesFileSystemFileSystemId'], 1),
                                (['ChatStorage:FilesEfsArn'], 0)):
            with self.subTest(names=names):
                cloudformation = Mock()
                cloudformation.get_paginator.return_value.paginate.return_value = [
                    {'Exports': [{'Name': name} for name in names]}]
                command = Mock()
                with patch.dict(transition['remove_legacy_files_imports'].__globals__, {'run': command}), \
                        patch.dict('sys.modules', {'boto3': Mock(client=Mock(return_value=cloudformation))}):
                    transition['remove_legacy_files_imports']('live')
                self.assertEqual(command.call_count, expected)
                if expected:
                    self.assertEqual(command.call_args.args, (
                        './node_modules/.bin/cdk', 'deploy', 'PreviewOrigin', '--exclusively', '-c',
                        'previewOrigin=true', '-c', 'parked=false', '--require-approval', 'never'))

    def test_export_discovery_failure_stops_the_transition(self):
        cloudformation = Mock()
        cloudformation.get_paginator.return_value.paginate.side_effect = RuntimeError('export discovery denied')
        with patch.dict('sys.modules', {'boto3': Mock(client=Mock(return_value=cloudformation))}), \
                self.assertRaisesRegex(RuntimeError, 'export discovery denied'):
            transition['remove_legacy_files_imports']('live')
