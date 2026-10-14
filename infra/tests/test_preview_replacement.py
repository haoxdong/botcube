"""Offline provider observations: successful replacement and rejected evidence."""
import json
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

from botocore.exceptions import EndpointConnectionError

from deploy_script_support import load_deploy_script

r = load_deploy_script('replacement', 'verify-replacement.py')


def task(arn: str, deployment: str, ip: str) -> dict[str, Any]:
    return {'taskArn': arn, 'taskDefinitionArn': 'revision:1', 'startedBy': deployment,
            'lastStatus': 'RUNNING', 'desiredStatus': 'RUNNING', 'containers': [{'imageDigest': 'sha256:abc',
            'networkInterfaces': [{'privateIpv4Address': ip}]}]}


OLD = task('old-task', 'old-deployment', '10.0.0.1')
NEW = task('new-task', 'new-deployment', '10.0.0.2')
DEPLOYMENT = {'id': 'new-deployment', 'taskDefinition': 'revision:1', 'status': 'PRIMARY', 'rolloutState': 'IN_PROGRESS'}
SERVICE = {'taskDefinition': 'revision:1', 'desiredCount': 1, 'runningCount': 2, 'pendingCount': 0,
           'deploymentConfiguration': {'minimumHealthyPercent': 100, 'maximumPercent': 200,
                                       'deploymentCircuitBreaker': {'enable': True, 'rollback': True}},
           'deployments': [DEPLOYMENT]}
NOW = '2026-09-24T12:00:00+00:00'


def targets(old: str = 'healthy', new: str = 'healthy') -> list[dict[str, Any]]:
    return [{'Target': {'Id': ip, 'Port': 8123}, 'TargetHealth': {'State': state}}
            for ip, state in [('10.0.0.1', old), ('10.0.0.2', new)]]


class ReplacementTest(unittest.TestCase):
    def setUp(self):
        self.report = {}
        self.tracker = r.Replacement(r.task_identity(OLD), DEPLOYMENT, 'revision:1', self.report)
        self.tasks = {'old-task': deepcopy(OLD), 'new-task': deepcopy(NEW)}
        self.service = deepcopy(SERVICE)

    def observe(self, health: list[dict[str, Any]] | None = None) -> bool:
        return self.tracker.observe(self.service, self.tasks, targets() if health is None else health, NOW)

    def test_exact_replacement_with_overlap_drain_stop_and_completion(self):
        self.assertFalse(self.observe())
        self.assertFalse(self.observe(targets(old='draining')))
        self.tasks['old-task'].update(lastStatus='STOPPED', desiredStatus='STOPPED', stoppingAt=datetime(2026, 9, 24, 12, 0, 1, tzinfo=UTC),
                                      stoppedAt=datetime(2026, 9, 24, 12, 0, 2, tzinfo=UTC))
        self.service.update(runningCount=1)
        self.service['deployments'][0]['rolloutState'] = 'COMPLETED'
        self.assertTrue(self.observe(targets(old='draining')))
        self.assertFalse(self.report['taskDefinitionChanged'])
        self.assertFalse(self.report['imageChanged'])
        self.assertEqual(self.report['newTask']['taskArn'], 'new-task')
        self.assertEqual(len(self.report['observations']), 3)

    def test_completed_deployment_requires_proven_stop_initiation_not_terminal_shutdown(self):
        self.observe()
        self.observe(targets(old='draining'))
        fixture = json.loads((Path(__file__).resolve().parents[3] / 'contract/regressions/preview-replacement-completion-before-stop.json').read_text())
        self.service.update(runningCount=fixture['runningCount'], pendingCount=fixture['pendingCount'])
        self.service['deployments'][0]['rolloutState'] = fixture['deploymentState']
        self.tasks['old-task'].update(lastStatus=fixture['oldTaskStatus'], desiredStatus='STOPPED',
                                      stoppingAt=datetime(2026, 9, 24, 12, 0, 1, tzinfo=UTC))
        self.assertTrue(self.observe(targets(old=fixture['oldTargetState'], new=fixture['newTargetState'])))
        self.assertFalse(self.report['oldTaskTerminallyStopped'])
        self.assertEqual(self.report['oldTaskStatus'], 'DEACTIVATING')
        self.assertNotIn('oldStoppedAt', self.report)
        del self.tasks['old-task']['stoppingAt']
        with self.assertRaisesRegex(RuntimeError, 'stopping time'):
            self.observe(targets(old='draining'))

    def test_deactivation_can_precede_observed_target_draining(self):
        self.observe()
        fixture = json.loads((Path(__file__).resolve().parents[3] / 'contract/regressions/preview-replacement-deactivation-before-draining.json').read_text())
        self.tasks['old-task'].update(lastStatus=fixture['oldTaskStatus'], desiredStatus=fixture['oldDesiredStatus'],
                                      stoppingAt=datetime(2026, 9, 24, 12, 0, 1, tzinfo=UTC))
        self.service['runningCount'] = 1
        self.service['deployments'][0]['rolloutState'] = 'COMPLETED'
        self.assertFalse(self.observe(targets(old=fixture['oldTargetStates'][0])))
        self.assertTrue(self.observe(targets(old=fixture['oldTargetStates'][1])))
        self.assertFalse(self.report['oldTaskTerminallyStopped'])

    def test_noop_request_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'no-op'):
            r.Replacement(r.task_identity(OLD), {**DEPLOYMENT, 'id': 'old-deployment'}, 'revision:1', {})

    def test_replacement_requested_to_stop_cannot_complete(self):
        self.observe()
        self.observe(targets(old='draining'))
        self.tasks['old-task'].update(lastStatus='DEACTIVATING', desiredStatus='STOPPED',
                                      stoppingAt=datetime(2026, 9, 24, 12, 0, 1, tzinfo=UTC))
        self.tasks['new-task']['desiredStatus'] = 'STOPPED'
        self.service['runningCount'] = 1
        self.service['deployments'][0]['rolloutState'] = 'COMPLETED'
        with self.assertRaisesRegex(RuntimeError, 'Replacement task stop was requested'):
            self.observe(targets(old='draining'))
        self.assertNotIn('completed', self.report)

    def test_replacement_desired_status_is_required_before_tracking(self):
        del self.tasks['new-task']['desiredStatus']
        with self.assertRaisesRegex(RuntimeError, 'lacks ECS task desiredStatus'):
            self.observe()
        self.assertIsNone(self.tracker.new)

    def test_wrong_identity_revision_failure_and_rollback_rejected(self):
        for field, value in [('startedBy', 'unrelated'), ('taskDefinitionArn', 'revision:2'), ('lastStatus', 'STOPPED')]:
            with self.subTest(field=field):
                self.setUp()
                self.tasks['new-task'][field] = value
                with self.assertRaises(RuntimeError):
                    self.observe()
        for field, value in [('id', 'old-deployment'), ('rolloutState', 'FAILED'), ('taskDefinition', 'revision:2')]:
            with self.subTest(field=field):
                self.setUp()
                self.service['deployments'][0][field] = value
                with self.assertRaises(RuntimeError):
                    self.observe()

    def test_draining_without_healthy_overlap_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'before observed healthy overlap'):
            self.observe(targets(old='draining', new='initial'))

    def test_wrong_target_port_cannot_establish_overlap(self):
        health = targets(old='draining')
        health[1]['Target']['Port'] = 9999
        with self.assertRaisesRegex(RuntimeError, 'before observed healthy overlap'):
            self.observe(health)

    def test_stopped_without_draining_and_missing_old_rejected(self):
        self.observe()
        self.tasks['old-task']['lastStatus'] = 'STOPPED'
        with self.assertRaisesRegex(RuntimeError, 'without overlap and draining'):
            self.observe()
        del self.tasks['old-task']
        with self.assertRaisesRegex(RuntimeError, 'Old task observation missing'):
            self.observe()

    def test_second_replacement_and_missing_new_rejected(self):
        self.observe()
        self.tasks['new-task']['taskArn'] = 'another-task'
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            self.observe()
        del self.tasks['new-task']
        with self.assertRaisesRegex(RuntimeError, 'Replacement task observation missing'):
            self.observe()

    def test_final_health_alone_does_not_pass(self):
        self.service['deployments'][0]['rolloutState'] = 'COMPLETED'
        self.service['runningCount'] = 1
        self.assertFalse(self.observe())
        self.assertNotIn('completed', self.report)

    def test_timestamp_contradicting_overlap_rejected(self):
        self.observe()
        self.observe(targets(old='draining'))
        self.tasks['old-task'].update(lastStatus='STOPPED', desiredStatus='STOPPED', stoppingAt=datetime(2026, 9, 24, 11, 59, tzinfo=UTC))
        with self.assertRaisesRegex(RuntimeError, 'precedes observed healthy overlap'):
            self.observe()

    def test_provider_circuit_breaker_extensions_preserve_required_flags(self):
        fixture = json.loads((Path(__file__).resolve().parents[3] / 'contract/regressions/preview-replacement-circuit-breaker.json').read_text())
        self.service['deploymentConfiguration']['deploymentCircuitBreaker'] = fixture['deploymentCircuitBreaker']
        self.assertFalse(self.observe())
        for flag in ('enable', 'rollback'):
            with self.subTest(flag=flag):
                self.service['deploymentConfiguration']['deploymentCircuitBreaker'][flag] = False
                with self.assertRaisesRegex(RuntimeError, 'configuration differs'):
                    self.observe()
                self.service['deploymentConfiguration']['deploymentCircuitBreaker'][flag] = True

    def test_configuration_drift_rejected(self):
        self.service['deploymentConfiguration']['minimumHealthyPercent'] = 0
        with self.assertRaisesRegex(RuntimeError, 'configuration differs'):
            self.observe()

    def test_a_task_missing_a_field_the_verdict_reads_fails_loud(self):
        del self.tasks['old-task']['startedBy']
        with self.assertRaisesRegex(RuntimeError, 'lacks ECS task startedBy'):
            self.observe()

    def test_a_target_group_attribute_without_its_value_fails_loud(self):
        ecs, elb = Mock(), Mock()
        before = deepcopy(SERVICE)
        before.update(runningCount=1)
        before['deployments'] = [{**DEPLOYMENT, 'id': 'old-deployment', 'rolloutState': 'COMPLETED'}]
        ecs.describe_services.return_value = {'services': [before]}
        ecs.get_paginator.return_value.paginate.return_value = [{'taskArns': ['old-task']}]
        ecs.describe_tasks.return_value = {'tasks': [OLD]}
        elb.describe_target_health.return_value = {'TargetHealthDescriptions': targets(new='unused')[:1]}
        elb.describe_target_group_attributes.return_value = {'Attributes': [{'Key': 'deregistration_delay.timeout_seconds'}]}
        outputs = {'ClusterName': 'cluster', 'ServiceName': 'service', 'TaskDefinitionArn': 'revision:1', 'TargetGroupArn': 'target', 'LoadBalancerArn': 'alb'}
        with self.assertRaisesRegex(RuntimeError, 'lacks target group attribute Value'):
            r.exercise(outputs, ecs, elb, {})
        ecs.update_service.assert_not_called()

    def test_deadline_expires_without_replacement_observations(self):
        ecs, elb = Mock(), Mock()
        before = deepcopy(SERVICE)
        before.update(runningCount=1)
        before['deployments'] = [{**DEPLOYMENT, 'id': 'old-deployment', 'rolloutState': 'COMPLETED'}]
        ecs.describe_services.return_value = {'services': [before]}
        ecs.get_paginator.return_value.paginate.return_value = [{'taskArns': ['old-task']}]
        ecs.describe_tasks.return_value = {'tasks': [OLD]}
        ecs.update_service.return_value = {'service': SERVICE}
        elb.describe_target_health.return_value = {'TargetHealthDescriptions': targets()}
        elb.describe_target_group_attributes.return_value = {'Attributes': [{'Key': 'deregistration_delay.timeout_seconds', 'Value': '3600'}]}
        elb.describe_load_balancer_attributes.return_value = {'Attributes': [{'Key': 'idle_timeout.timeout_seconds', 'Value': '3600'}]}
        outputs = {'ClusterName': 'cluster', 'ServiceName': 'service', 'TaskDefinitionArn': 'revision:1', 'TargetGroupArn': 'target', 'LoadBalancerArn': 'alb'}
        with self.assertRaisesRegex(RuntimeError, 'Initial stream task changed'):
            r.exercise(outputs, ecs, elb, {}, expected_old={**r.task_identity(OLD), 'taskArn': 'wrong'})
        with self.assertRaisesRegex(RuntimeError, 'Competing healthy target'):
            r.exercise(outputs, ecs, elb, {}, expected_old=r.task_identity(OLD))
        ecs.update_service.assert_not_called()
        with patch.object(r.time, 'monotonic', side_effect=[0, 0, 4501, 4501]), self.assertRaisesRegex(RuntimeError, 'did not stabilize within the exercise deadline'):
            r.exercise(outputs, ecs, elb, {})
        ecs.update_service.assert_called_once_with(cluster='cluster', service='service', forceNewDeployment=True)
        # An uncertain trigger is never retried; stabilization retains failure.
        ecs.update_service.reset_mock()
        ecs.update_service.side_effect = RuntimeError('uncertain trigger')
        stopped = {**OLD, 'lastStatus': 'DEACTIVATING', 'desiredStatus': 'STOPPED',
                   'stoppingAt': datetime(2026, 9, 24, 12, 0, 1, tzinfo=UTC)}
        ecs.describe_tasks.side_effect = [{'tasks': [OLD]}, EndpointConnectionError(endpoint_url='https://ecs.invalid'), {'tasks': [stopped]}]
        after = deepcopy(before)
        after['deployments'][0]['id'] = 'new-deployment'
        ecs.describe_services.side_effect = [{'services': [before]}, EndpointConnectionError(endpoint_url='https://ecs.invalid'),
                                             {'services': [before]}, {'services': [after]}, {'services': [after]}]
        report = {}
        with patch.object(r.time, 'monotonic', return_value=0), patch.object(r.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'uncertain trigger'):
            r.exercise(outputs, ecs, elb, report)
        self.assertTrue(report['recovery']['stable'])
        self.assertEqual(report['recovery']['deploymentId'], 'new-deployment')
        self.assertEqual([e['errorType'] for e in report['recovery']['readFailures']], ['EndpointConnectionError', 'EndpointConnectionError'])
        self.assertFalse(report['completed'])
        ecs.update_service.assert_called_once()
        # A successful trigger followed by observation failure must also reject
        # a stale old stable response during recovery.
        ecs.update_service.side_effect = None
        ecs.describe_tasks.side_effect = [{'tasks': [OLD]}, {'tasks': [OLD]}, {'tasks': [stopped]}]
        ecs.describe_services.side_effect = [{'services': [before]}, {'services': [before]},
                                             {'services': [before]}, {'services': [after]}]
        report = {}
        with patch.object(r.time, 'monotonic', return_value=0), patch.object(r.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'Unexpected deployment or rollback'):
            r.exercise(outputs, ecs, elb, report)
        self.assertTrue(report['recovery']['stable'])
        self.assertEqual(report['recovery']['deploymentId'], 'new-deployment')



if __name__ == '__main__':
    unittest.main()
