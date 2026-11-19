"""Park/unpark verification names every mismatch and records per-step timings and Credential Service start."""
import json
import os
import runpy
import tempfile
import unittest
import urllib.error
from collections.abc import Iterator
from datetime import UTC, datetime
from email.message import Message
from io import BytesIO
from pathlib import Path
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
        'alarmActions': {},
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


class PartialModeVerificationTests(unittest.TestCase):
    def test_partial_modes_require_nat_without_chat_or_edge(self):
        for mode in ('egress', 'credential'):
            facts = parked()
            active = live()
            for field in ('natResources', 'defaultRoutes', 'natGateways'):
                facts[field] = active[field]
            if mode == 'credential':
                facts['services']['credential-service'] = active['services']['credential-service']
            self.assertEqual(verifier['partial_failures'](facts, EXPECTED, mode), [])
            facts['services']['chat-service-preview'] = active['services']['chat-service-preview']
            self.assertTrue(verifier['partial_failures'](facts, EXPECTED, mode))


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

    def test_parked_serving_alarms_must_be_absent(self):
        facts = parked()
        facts['healthCheckDisabled'] = False
        facts['alarmActions'] = {'bot-cube-api-health': True, 'bot-cube-preview-task-deficit': False,
                                 'bot-cube-preview-alb-5xx': True}
        self.assertEqual(verifier['parked_failures'](facts, EXPECTED), [
            'API health check is enabled',
            'alarm actions are not absent: bot-cube-api-health on, bot-cube-preview-alb-5xx on, bot-cube-preview-task-deficit off'])


NAT_FACTS = ('natResources', 'defaultRoutes', 'natGateways', 'address', 'egressIp')


class WithoutOwnedEgressVerificationTests(unittest.TestCase):
    """An existing network brings its own egress, so verification never looks for BotCube's NAT."""

    def setUp(self):
        identity = json.loads((Path(os.environ['CARTRIDGE_DEPLOY_ROOT']) / 'identity.json').read_text())
        del identity['aws']['ecs']['privateEgress']
        root = Path(tempfile.mkdtemp())
        (root / 'identity.json').write_text(json.dumps(identity))
        with patch.dict(os.environ, {'CARTRIDGE_DEPLOY_ROOT': str(root)}):
            self.verifier = runpy.run_path(str(DEPLOY_ECS / 'verify-park.py'))

    @staticmethod
    def without_nat(facts: dict[str, Any]) -> dict[str, Any]:
        return {**{key: value for key, value in facts.items() if key not in NAT_FACTS}, 'stacks': {'origin': 'UPDATE_COMPLETE'}}

    def test_parked_and_partial_modes_pass_without_a_nat(self):
        self.assertEqual(self.verifier['parked_failures'](self.without_nat(parked()), None), [])
        for mode in ('egress', 'credential'):
            with self.subTest(mode=mode):
                facts = self.without_nat(parked())
                if mode == 'credential':
                    facts['services']['credential-service'] = live()['services']['credential-service']
                self.assertEqual(self.verifier['partial_failures'](facts, None, mode), [])

    def test_live_passes_without_a_nat_or_a_fixed_egress_address(self):
        self.assertEqual(self.verifier['live_failures'](self.without_nat(live()), None), [])

    def test_still_names_every_other_mismatch(self):
        facts = self.without_nat(parked())
        facts['reaper'] = 'ENABLED'
        self.assertEqual(self.verifier['parked_failures'](facts, None), ['reaper schedule is ENABLED'])


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






class TransitionTests(unittest.TestCase):
    def test_states_map_to_the_cdk_flag(self):
        self.assertEqual(transition['MODES'], ('parked', 'egress', 'credential', 'live'))

    def test_stored_state_must_be_live_or_parked(self):
        self.assertEqual(transition['parse_state']('parked'), 'parked')
        self.assertEqual(transition['parse_state']('live'), 'live')
        for value in ('Parked', 'paused', ''):
            with self.subTest(value=value), self.assertRaisesRegex(SystemExit, 'Stored park state'):
                transition['parse_state'](value)



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

    def test_v2_reuses_the_reported_ready_snapshot_without_update_or_wait(self):
        agentcore = AgentCoreProduction()
        agentcore.configuration['platformVersion'] = 'V2'
        current = agentcore.get_agent_runtime('rt-1')
        with patch.object(agentcore, 'get_agent_runtime', return_value=current) as get, patch('builtins.print') as printed:
            pause = Mock(side_effect=AssertionError('V2 must not wait for a refresh'))
            result = transition['refresh_runtime_spares'](agentcore, pause=pause)
        self.assertIs(result, current)
        self.assertEqual(result['agentRuntimeVersion'], '204')
        self.assertEqual(agentcore.updates, [])
        get.assert_called_once_with(agentRuntimeId='rt-1')
        pause.assert_not_called()
        self.assertIn('skipped: V2 restores from its snapshot', printed.call_args.args[0])

    def test_reported_v1_platform_still_updates_and_waits_even_at_a_v2_era_version(self):
        agentcore = AgentCoreProduction()
        agentcore.version = '456'
        current = agentcore.get_agent_runtime('rt-1')
        updating = {**current, 'status': 'UPDATING'}
        ready = {**current, 'agentRuntimeVersion': '457'}
        with patch.object(agentcore, 'get_agent_runtime', side_effect=[current, updating, ready]):
            pause = Mock()
            result = transition['refresh_runtime_spares'](agentcore, pause=pause)
        self.assertEqual(result['agentRuntimeVersion'], '457')
        self.assertEqual(len(agentcore.updates), 1)
        self.assertEqual(agentcore.updates[0]['platformVersion'], 'V1')
        pause.assert_called_once_with(5)

    def test_nonready_v2_still_fails_loud_without_updating(self):
        for status in ('UPDATING', 'UPDATE_FAILED'):
            with self.subTest(status=status):
                agentcore = AgentCoreProduction(status=status)
                agentcore.configuration['platformVersion'] = 'V2'
                with self.assertRaisesRegex(RuntimeError, f'is {status}, not READY'):
                    transition['refresh_runtime_spares'](agentcore, pause=lambda _: None)
                self.assertEqual(agentcore.updates, [])

    def test_v2_wake_snapshot_does_not_enter_the_v1_spare_observation(self):
        from test_parking_lambda import load
        agentcore = AgentCoreProduction(extra={'lastUpdatedAt': READY})
        agentcore.configuration['platformVersion'] = 'V2'
        with patch.object(agentcore, 'update_agent_runtime', side_effect=AssertionError('V2 must not update')):
            current = transition['refresh_runtime_spares'](agentcore, pause=lambda _: None)
        worker = load()
        snapshot = worker.runtime_snapshot(current)
        self.assertEqual(snapshot['platformVersion'], 'V2')
        with patch('boto3.client', side_effect=AssertionError('V2 has no spare logs to inspect')):
            worker.perform('spares', 'live', None, None, None, None, None, None,
                           {'startedAt': READY.timestamp(), 'runtime': snapshot})

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


def test_cli_park_and_unpark_keep_the_deployed_dispatcher_protocol():
    with patch('boto3.client') as client:
        client.return_value.invoke.return_value = {'Payload': BytesIO(b'{"executionArn":"accepted"}')}
        transition['transition']('parked')
        assert json.loads(client.return_value.invoke.call_args.kwargs['Payload']) == {'op': 'park'}
        client.return_value.invoke.return_value = {'Payload': BytesIO(b'{"executionArn":"accepted"}')}
        transition['transition']('live')
        assert json.loads(client.return_value.invoke.call_args.kwargs['Payload']) == {'op': 'unpark'}


class SettledServiceTests(unittest.TestCase):
    def test_running_task_waits_for_completed_rollout(self):
        import boto3
        from botocore.stub import Stubber

        ecs = boto3.client('ecs', region_name='us-east-1', aws_access_key_id='testing', aws_secret_access_key='testing')
        completed = {'services': [
            {'serviceName': name, 'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0,
             'deployments': [{'rolloutState': 'COMPLETED'}]}
            for name in ('chat-service-preview', 'credential-service')]}
        progressing = json.loads(json.dumps(completed))
        progressing['services'][0]['deployments'][0]['rolloutState'] = 'IN_PROGRESS'
        with Stubber(ecs) as stub, patch('botocore.waiter.time.sleep') as sleep:
            stub.add_response('describe_services', progressing)
            stub.add_response('describe_services', progressing)
            stub.add_response('describe_services', completed)
            stub.add_response('describe_services', completed)
            facts = verifier['service_facts'](ecs)
            self.assertEqual(facts, live()['services'])
            sleep.assert_called_once_with(15)
            stub.assert_no_pending_responses()

    def test_rollout_that_never_completes_times_out(self):
        import boto3
        from botocore.exceptions import WaiterError
        from botocore.stub import Stubber

        ecs = boto3.client('ecs', region_name='us-east-1', aws_access_key_id='testing', aws_secret_access_key='testing')
        progressing = {'services': [
            {'serviceName': name, 'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0,
             'deployments': [{'rolloutState': 'IN_PROGRESS'}]}
            for name in ('chat-service-preview', 'credential-service')]}
        with Stubber(ecs) as stub, patch('botocore.waiter.time.sleep') as sleep:
            stub.add_response('describe_services', progressing)
            stub.add_response('describe_services', progressing)
            stub.add_response('describe_services', progressing)
            with self.assertRaises(WaiterError):
                verifier['service_facts'](ecs, timeout=15)
            sleep.assert_called_once_with(15)
            stub.assert_no_pending_responses()

    def test_failed_rollout_is_terminal(self):
        import boto3
        from botocore.exceptions import WaiterError
        from botocore.stub import Stubber

        ecs = boto3.client('ecs', region_name='us-east-1', aws_access_key_id='testing', aws_secret_access_key='testing')
        failed = {'services': [
            {'serviceName': name, 'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0,
             'deployments': [{'rolloutState': 'FAILED'}]}
            for name in ('chat-service-preview', 'credential-service')]}
        with Stubber(ecs) as stub, patch('botocore.waiter.time.sleep') as sleep:
            stub.add_response('describe_services', failed)
            stub.add_response('describe_services', failed)
            with self.assertRaises(WaiterError):
                verifier['service_facts'](ecs)
            sleep.assert_not_called()
            stub.assert_no_pending_responses()
