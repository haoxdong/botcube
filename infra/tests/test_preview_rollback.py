"""Provider-bound rollback acceptance and recovery; live evidence is separate."""
import json
import os
import tempfile
import unittest
from collections.abc import Callable
from copy import deepcopy
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import boto3

from deploy_script_support import load_deploy_script

r = load_deploy_script('rollback', 'verify-rollback.py')

HISTORY = {'targetServiceRevision': {'arn': 'diagnostic-service-revision'},
           'status': 'ROLLBACK_SUCCESSFUL',
           'deploymentCircuitBreaker': {'status': 'TRIGGERED', 'failureCount': 3, 'threshold': 3},
           'rollback': {'serviceRevisionArn': 'baseline-service-revision', 'reason': 'Circuit breaker triggered'}}
BASELINE = {'taskDefinitionArn': 'baseline:1', 'taskArn': 'healthy-task', 'imageDigest': 'sha256:known'}


class Provider:
    def __init__(self, *, update_error: bool = False) -> None:
        self.definition = None
        self.updated = False
        self.update_error = update_error
        self.updates = []
        self.deregistered = []

    def register_task_definition(self, **definition: object) -> dict[str, Any]:
        self.definition = {'taskDefinitionArn': 'arn:task-definition/bot-cube-preview-rollback-test:1', 'status': 'ACTIVE'}
        return {'taskDefinition': self.definition}

    def update_service(self, **kwargs: object) -> dict[str, Any]:
        self.updates.append(kwargs)
        self.updated = True
        if self.update_error:
            raise RuntimeError('Lost update response after acceptance')
        assert self.definition is not None, 'update_service before register_task_definition'
        return {'service': {'deployments': [{'status': 'PRIMARY', 'id': 'diagnostic-deployment',
                                            'taskDefinition': self.definition['taskDefinitionArn']}]}}

    def describe_task_definition(self, **kwargs: object) -> dict[str, Any]:
        return {'taskDefinition': self.definition}

    def deregister_task_definition(self, **kwargs: object) -> None:
        self.deregistered.append(kwargs['taskDefinition'])
        assert self.definition is not None, 'deregister_task_definition before register_task_definition'
        self.definition['status'] = 'INACTIVE'


class RollbackTest(unittest.TestCase):
    def test_cleanup_policy_matches_observed_provider_resource_requirement(self):
        root = Path(__file__).resolve().parents[3]
        fixture = json.loads((root / 'contract/regressions/preview-rollback-deregister-authorization.json').read_text())
        bootstrap = (root / 'botcube/infra/ecs/bootstrap-rollback-role.sh').read_text()
        policy = json.loads(bootstrap.split('<<EOF\n', 1)[1].split('\nEOF', 1)[0])
        grants = [statement for statement in policy['Statement'] if statement['Action'] == fixture['operation']]
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0]['Resource'], fixture['requiredResource'])

    def test_stopped_container_and_healthy_baseline_do_not_prove_rollback(self):
        fixture = json.loads((Path(__file__).resolve().parents[3] / 'contract/regressions/preview-rollback-startup-exit-pending.json').read_text())
        with self.assertRaisesRegex(RuntimeError, 'Automatic rollback did not succeed'):
            r.automatic_rollback(fixture['deployment'], 'baseline-service-revision', 'diagnostic-service-revision')

    def test_diagnostic_changes_only_image_and_requires_proven_absence(self):
        definition = {'family': 'normal', 'taskDefinitionArn': 'baseline:1', 'revision': 1,
                      'taskRoleArn': 'task-role', 'executionRoleArn': 'execution-role',
                      'networkMode': 'awsvpc', 'cpu': '512', 'memory': '1024',
                      'containerDefinitions': [{'name': 'chat-service', 'essential': True,
                          'image': 'registry/image:immutable-tag', 'environment': [{'name': 'TABLE', 'value': 'chat'}],
                          'portMappings': [{'containerPort': 8123}], 'stopTimeout': 120}]}
        ecs = Mock()
        ecs.meta = boto3.client('ecs', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test').meta
        ecs.describe_task_definition.return_value = {'taskDefinition': deepcopy(definition)}
        ecr = Mock()
        ecr.batch_get_image.return_value = {'images': [], 'failures': [{'imageId': {'imageDigest': r.MISSING_DIGEST}, 'failureCode': 'ImageNotFound'}]}
        diagnostic = r.diagnostic_definition(ecs, ecr, BASELINE, 'owned-family', 'owner')
        self.assertNotIn('taskDefinitionArn', diagnostic)
        self.assertNotIn('revision', diagnostic)
        for key in ('taskRoleArn', 'executionRoleArn', 'networkMode', 'cpu', 'memory'):
            self.assertEqual(diagnostic[key], definition[key])
        container = diagnostic['containerDefinitions'][0]
        self.assertEqual(container, {**definition['containerDefinitions'][0], 'image': 'registry/image@' + r.MISSING_DIGEST})
        self.assertEqual(container['environment'], definition['containerDefinitions'][0]['environment'])
        self.assertEqual(container['stopTimeout'], 120)
        for outcome in ({'images': [{'imageId': {'imageDigest': r.MISSING_DIGEST}}], 'failures': []},
                        {'images': [], 'failures': [{'imageId': {'imageDigest': r.MISSING_DIGEST}, 'failureCode': 'OtherFailure'}]}):
            ecr.batch_get_image.return_value = outcome
            with self.assertRaisesRegex(RuntimeError, 'absence is not proven'):
                r.diagnostic_definition(ecs, ecr, BASELINE, 'owned-family', 'owner')
        self.assertEqual(diagnostic['tags'], [{'key': 'preview-rollback-owner', 'value': 'owner'}])

    def test_requires_failed_diagnostic_and_automatic_return_to_exact_baseline(self):
        r.automatic_rollback(HISTORY, 'baseline-service-revision', 'diagnostic-service-revision')
        cases = [
            ('status', 'SUCCESSFUL'),
            ('status', 'ROLLBACK_FAILED'),
            ('deploymentCircuitBreaker', {'status': 'MONITORING_COMPLETE', 'failureCount': 0, 'threshold': 3}),
            ('deploymentCircuitBreaker', {'status': 'TRIGGERED', 'failureCount': 2, 'threshold': 3}),
            ('rollback', {'serviceRevisionArn': 'wrong', 'reason': 'Circuit breaker triggered'}),
            ('rollback', {'serviceRevisionArn': 'baseline-service-revision'}),
            ('targetServiceRevision', {'arn': 'unrelated'})]
        for key, value in cases:
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                r.automatic_rollback({**HISTORY, key: value}, 'baseline-service-revision', 'diagnostic-service-revision')

    def test_incomplete_conversation_never_passes(self):
        result: dict[str, object] = dict.fromkeys(('completeAnswer', 'terminalSuccess', 'historyReplay', 'isolated', 'foreignDeleteRejected', 'invalidInvocationRejected'), True)
        result['timing'] = {'conversationDeleted': True}
        r.check_conversation(result)
        for key in result:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                r.check_conversation({**result, key: {} if key == 'timing' else False})

    def provider_history(self, deployment: dict[str, Any], revision: dict[str, Any]) -> Any:
        ecs = Mock()
        ecs.list_service_deployments.return_value = {'serviceDeployments': [{'serviceDeploymentArn': 'deployment'}]}
        ecs.describe_service_deployments.return_value = {'serviceDeployments': [deployment]}
        ecs.describe_service_revisions.return_value = {'serviceRevisions': [revision]}
        report = {'baselineServiceRevision': 'baseline-service-revision', 'diagnosticRevision': 'diagnostic:1'}
        return r.Exercise({'ClusterName': r.normal['IDENTITY']['aws']['ecs']['cluster'], 'ServiceName': 'chat-service-preview'},
                          ecs, None, report, Path('unused.json'))

    def test_provider_history_missing_a_field_the_verdict_reads_fails_loud(self):
        deployment = {'targetServiceRevision': {'arn': 'diagnostic-service-revision'}, 'status': 'IN_PROGRESS'}
        self.assertEqual(self.provider_history(deployment, {'taskDefinition': 'diagnostic:1'}).diagnostic_history(), deployment)
        with self.assertRaisesRegex(RuntimeError, 'lacks service revision taskDefinition'):
            self.provider_history(deployment, {}).diagnostic_history()
        with self.assertRaisesRegex(RuntimeError, 'lacks service deployment targetServiceRevision'):
            self.provider_history({'status': 'IN_PROGRESS'}, {}).diagnostic_history()
        with self.assertRaisesRegex(RuntimeError, 'lacks service deployment summary serviceDeploymentArn'):
            exercise = self.provider_history(deployment, {})
            exercise.ecs.list_service_deployments.return_value = {'serviceDeployments': [{}]}
            exercise.histories()

    def exercise(self, provider: Provider, directory: str):
        report = {'baseline': deepcopy(BASELINE), 'baselineServiceRevision': 'baseline-service-revision',
                  'family': 'bot-cube-preview-rollback-test', 'owner': 'test', 'manualRestore': False}
        exercise = r.Exercise({'ClusterName': r.normal['IDENTITY']['aws']['ecs']['cluster'],
                               'ServiceName': 'chat-service-preview'}, provider, None, report, Path(directory) / 'evidence.json')
        def healthy():
            report['recoveredTask'] = deepcopy(BASELINE)
            return True
        exercise.baseline_healthy = healthy
        exercise.owned_revisions = lambda: [provider.definition['taskDefinitionArn']] if provider.definition else []
        exercise.diagnostic_history = lambda: deepcopy(HISTORY) if provider.updated else None
        def stopped():
            report['diagnosticTasks'] = [{'stoppedReason': 'CannotPullContainerError: ' + r.MISSING_DIGEST + ' not found', 'containers': []}]
            return True
        exercise.stopped_diagnostics = stopped
        return exercise

    def test_accepted_update_with_lost_response_recovers_but_does_not_pass_or_retry(self):
        for interrupted, lost in [(False, False), (True, False), (False, True)]:
            with self.subTest(interrupted=interrupted, lost=lost), tempfile.TemporaryDirectory() as directory:
                provider = Provider(update_error=lost)
                exercise = self.exercise(provider, directory)
                with patch.object(r, 'diagnostic_definition', return_value={'containerDefinitions': [{'image': 'missing-image'}]}):
                    if interrupted or lost:
                        with self.assertRaisesRegex(RuntimeError, 'interruption|Lost update'):
                            exercise.run(interrupt=interrupted)
                    else:
                        exercise.run()
                self.assertEqual(len(provider.updates), 1)
                self.assertEqual(len(provider.deregistered), 1)
                self.assertTrue(exercise.report['recovery']['completed'])
                self.assertEqual(exercise.report.get('automaticRollbackVerified', False), not (interrupted or lost))
                with self.assertRaisesRegex(RuntimeError, 'never replay'):
                    exercise.run()

    def test_incomplete_circuit_breaker_evidence_recovers_but_cannot_pass(self):
        for field in ('failureCount', 'threshold'):
            for absent in (True, False):
                with self.subTest(field=field, absent=absent), tempfile.TemporaryDirectory() as directory:
                    provider = Provider()
                    exercise = self.exercise(provider, directory)
                    history = deepcopy(HISTORY)
                    if absent:
                        del history['deploymentCircuitBreaker'][field]
                    else:
                        history['deploymentCircuitBreaker'][field] = None
                    exercise.diagnostic_history = lambda history=history, provider=provider: history if provider.updated else None
                    with patch.object(r, 'diagnostic_definition', return_value={'containerDefinitions': [{'image': 'missing-image'}]}), \
                            self.assertRaisesRegex(RuntimeError, f'lacks circuit breaker {field}'):
                        exercise.run()
                    self.assertEqual(len(provider.updates), 1)
                    self.assertEqual(len(provider.deregistered), 1)
                    saved = json.loads(exercise.path.read_text())
                    self.assertTrue(saved['recovery']['completed'])
                    self.assertNotIn('automaticRollbackVerified', saved)

    def test_missing_recovery_preserves_active_diagnostic_and_failed_verdict(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = Provider()
            exercise = self.exercise(provider, directory)
            provider.register_task_definition()
            exercise.report['registrationAttempted'] = True
            exercise.report['updateAttemptedAt'] = 'now'
            provider.updated = True
            exercise.baseline_healthy = lambda: False
            with patch.object(r.time, 'monotonic', side_effect=[0, 1, 2, 3]), self.assertRaisesRegex(RuntimeError, 'exceeded deadline'):
                exercise.recover(automatic_seconds=0, restore_seconds=0)
            self.assertTrue(exercise.report['manualRestore'])
            self.assertFalse(exercise.report['recovery']['completed'])
            self.assertFalse(provider.deregistered)

    def test_manual_restoration_cannot_pass_even_with_automatic_history(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = Provider()
            exercise = self.exercise(provider, directory)
            healthy = exercise.baseline_healthy
            observations = iter([True, False, True])
            def observe():
                healthy()
                return next(observations)
            exercise.baseline_healthy = observe
            recover = exercise.recover
            exercise.recover = lambda **_kwargs: recover(automatic_seconds=0, restore_seconds=0)
            with patch.object(r, 'diagnostic_definition', return_value={'containerDefinitions': [{'image': 'missing-image'}]}), self.assertRaisesRegex(RuntimeError, 'Manual restoration cannot pass'):
                exercise.run()
            self.assertEqual(len(provider.updates), 2)
            self.assertEqual(provider.updates[-1]['taskDefinition'], 'baseline:1')
            self.assertTrue(exercise.report['recovery']['completed'])
            self.assertTrue(exercise.report['manualRestore'])
            self.assertNotIn('automaticRollbackVerified', exercise.report)

    def test_recovered_task_with_wrong_image_is_rejected_before_intervention(self):
        with tempfile.TemporaryDirectory() as directory:
            ecs = Mock()
            ecs.describe_services.return_value = {'services': [{
                'taskDefinition': 'baseline:1', 'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0,
                'deploymentConfiguration': {'minimumHealthyPercent': 100, 'maximumPercent': 200,
                    'deploymentCircuitBreaker': {'enable': True, 'rollback': True}},
                'deployments': [{'status': 'PRIMARY', 'rolloutState': 'COMPLETED', 'taskDefinition': 'baseline:1'}]}]}
            exercise = r.Exercise({'ClusterName': r.normal['IDENTITY']['aws']['ecs']['cluster'],
                                   'ServiceName': 'chat-service-preview'}, ecs, None,
                                  {'baseline': BASELINE}, Path(directory) / 'evidence.json')
            with patch.dict(r.normal, {'verify_deployment': lambda *_args: {**BASELINE, 'imageDigest': 'sha256:wrong'}}), self.assertRaisesRegex(RuntimeError, 'Recovered image differs'):
                exercise.baseline_healthy()
            ecs.update_service.assert_not_called()

    def test_uncertain_registration_is_not_reported_clean(self):
        with tempfile.TemporaryDirectory() as directory:
            exercise = self.exercise(Provider(), directory)
            exercise.report['registrationAttempted'] = True
            with self.assertRaisesRegex(RuntimeError, 'Uncertain registration'):
                exercise.recover()
            self.assertFalse(exercise.report['recovery']['completed'])

    def test_repeated_recovery_does_not_extend_expired_cleanup_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = Provider()
            exercise = self.exercise(provider, directory)
            provider.register_task_definition()
            exercise.report.update(registrationAttempted=True, automaticRecoveryDeadlineMonotonicSeconds=10,
                                   resourceRecoveryDeadlineMonotonicSeconds=20)
            exercise.stopped_diagnostics = lambda: False
            with patch.object(r.time, 'monotonic', return_value=21), self.assertRaisesRegex(RuntimeError, 'exceeded deadline'):
                exercise.recover()
            self.assertEqual(exercise.report['resourceRecoveryDeadlineMonotonicSeconds'], 20)
            self.assertFalse(provider.deregistered)

    def test_failed_probe_artifact_retains_supported_conversation_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs = {'ClusterName': r.normal['IDENTITY']['aws']['ecs']['cluster'],
                       'ServiceName': 'chat-service-preview', 'ChatTableName': 'chat'}
            output_path = Path(directory) / 'outputs.json'
            output_path.write_text(json.dumps({r.normal['IDENTITY']['aws']['ecs']['previewOriginStackName']: outputs}))
            report_path = Path(directory) / 'preview-rollback-evidence.json'
            exercise_type = r.Exercise
            def factory(*args: object, **kwargs: object):
                exercise = exercise_type(*args, **kwargs)
                exercise.prepare = Mock()
                exercise.run = Mock(side_effect=RuntimeError('diagnostic failure'))
                return exercise
            def conversation(*, timing: dict[str, object], before_replay: Callable[[], object]) -> None:
                try:
                    before_replay()
                finally:
                    timing['conversationDeleted'] = True
            with patch.dict(os.environ, {'RUNNER_TEMP': directory}), patch('sys.argv', ['verify-rollback', 'exercise', str(output_path)]), \
                    patch.object(r, 'Exercise', side_effect=factory), patch.object(r.boto3, 'client'), \
                    patch.object(r.boto3, 'resource'), patch.dict(r.normal, {'verify_conversation': conversation}), self.assertRaisesRegex(RuntimeError, 'diagnostic failure'):
                r.main()
            report = json.loads(report_path.read_text())
            self.assertTrue(report['retainedConversation']['timing']['conversationDeleted'])
            self.assertEqual(report['errorType'], 'RuntimeError')


if __name__ == '__main__':
    unittest.main()
