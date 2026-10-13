"""Explicit preview failure exercise; invoke only under the preview-origin job lock."""
from __future__ import annotations

import argparse
import json
import os
import runpy
import time
from copy import deepcopy
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

import boto3
from botocore.config import Config

if TYPE_CHECKING:
    from types_boto3_ecr import ECRClient
    from types_boto3_ecs import ECSClient
    from types_boto3_ecs.type_defs import ServiceDeploymentTypeDef, ServiceTypeDef
    from types_boto3_elbv2 import ElasticLoadBalancingv2Client

HERE = Path(__file__).resolve().parent
normal = runpy.run_path(str(HERE / 'verify-service.py'))
replacement = runpy.run_path(str(HERE / 'verify-replacement.py'))
require = normal['require']
utc = replacement['utc']
MISSING_DIGEST = 'sha256:' + '0' * 64
T = TypeVar('T')


class ObserverInterrupted(RuntimeError):
    """An intentional failed verdict whose recovery and replay are still checked."""


def write_report(path: Path, report: dict[str, Any]) -> None:
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(report, stream, indent=2, default=str)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value


def revision_arn(deployment: ServiceDeploymentTypeDef) -> str:
    target = required(deployment.get('targetServiceRevision'), 'service deployment targetServiceRevision')
    return required(target.get('arn'), 'target service revision arn')


def deployment_status(deployment: ServiceDeploymentTypeDef) -> str:
    return required(deployment.get('status'), 'service deployment status')


def automatic_rollback(deployment: ServiceDeploymentTypeDef, baseline_revision: str, diagnostic_revision: str) -> None:
    """Only provider rollback provenance can establish automatic recovery."""
    require(revision_arn(deployment) == diagnostic_revision,
            'Rollback evidence belongs to another diagnostic service revision')
    require(deployment.get('status') == 'ROLLBACK_SUCCESSFUL', 'Automatic rollback did not succeed')
    breaker = deployment.get('deploymentCircuitBreaker', {})
    failure_count = required(breaker.get('failureCount'), 'circuit breaker failureCount')
    threshold = required(breaker.get('threshold'), 'circuit breaker threshold')
    require(breaker.get('status') == 'TRIGGERED' and failure_count >= threshold,
            'Circuit breaker failure is unproven')
    rollback = deployment.get('rollback', {})
    require(rollback.get('serviceRevisionArn') == baseline_revision, 'Automatic rollback selected the wrong baseline')
    require(rollback.get('reason'), 'Automatic rollback reason is missing')


def diagnostic_definition(ecs: ECSClient, ecr: ECRClient | None, baseline: dict[str, Any], family: str, owner: str) -> dict[str, Any]:
    if ecr is None:
        raise RuntimeError('Diagnostic image proof needs an ECR client')
    definition = ecs.describe_task_definition(taskDefinition=baseline['taskDefinitionArn'])['taskDefinition']
    input_shape = ecs.meta.service_model.operation_model('RegisterTaskDefinition').input_shape
    if input_shape is None:
        raise RuntimeError('RegisterTaskDefinition has no input shape')
    allowed = input_shape.members
    result: dict[str, Any] = {key: deepcopy(value) for key, value in definition.items() if key in allowed}
    require(len(result['containerDefinitions']) == 1, 'Diagnostic requires the single preview container')
    container = result['containerDefinitions'][0]
    require(container['essential'], 'Preview container must be essential')
    repository = container['image'].split('@')[0].rsplit(':', 1)[0]
    absent = ecr.batch_get_image(repositoryName=repository.split('/', 1)[1], imageIds=[{'imageDigest': MISSING_DIGEST}])
    require(not absent['images'] and len(absent['failures']) == 1
            and absent['failures'][0].get('failureCode') == 'ImageNotFound'
            and absent['failures'][0].get('imageId') == {'imageDigest': MISSING_DIGEST},
            'Diagnostic image absence is not proven')
    container['image'] = repository + '@' + MISSING_DIGEST
    result.update(family=family, tags=[{'key': 'preview-rollback-owner', 'value': owner}])
    return result


class Exercise:
    def __init__(self, outputs: dict[str, str], ecs: ECSClient, elb: ElasticLoadBalancingv2Client, report: dict[str, Any], path: Path, *,
                 ecr: ECRClient | None = None) -> None:
        self.outputs, self.ecs, self.elb, self.report, self.path = outputs, ecs, elb, report, path
        self.ecr = ecr
        self.cluster, self.name = outputs['ClusterName'], outputs['ServiceName']
        require(self.name == 'chat-service-preview' and self.cluster == normal['IDENTITY']['aws']['ecs']['cluster'],
                'Rollback is restricted to the configured preview service')

    def save(self):
        write_report(self.path, self.report)

    def service(self) -> ServiceTypeDef:
        response = self.ecs.describe_services(cluster=self.cluster, services=[self.name])
        require(not response.get('failures') and len(response['services']) == 1, 'Preview lookup failed')
        return response['services'][0]

    def histories(self) -> list[ServiceDeploymentTypeDef]:
        arns: list[str] = []
        params: dict[str, Any] = {'cluster': self.cluster, 'service': self.name}
        while True:
            page = self.ecs.list_service_deployments(**params)
            arns.extend(required(summary.get('serviceDeploymentArn'), 'service deployment summary serviceDeploymentArn')
                        for summary in page['serviceDeployments'])
            token = page.get('nextToken')
            if not token:
                break
            params['nextToken'] = token
        histories: list[ServiceDeploymentTypeDef] = []
        for start in range(0, len(arns), 20):
            response = self.ecs.describe_service_deployments(serviceDeploymentArns=arns[start:start + 20])
            require(not response.get('failures'), 'Deployment history lookup failed')
            histories.extend(response['serviceDeployments'])
        return histories

    def prepare(self):
        baseline = normal['verify_deployment'](self.outputs, self.ecs, self.elb)
        current = self.service()
        replacement['configuration'](current, baseline['taskDefinitionArn'])
        deployment_id = replacement['primary'](current)['id'].split('/')[-1]
        matches = [item for item in self.histories()
                   if revision_arn(item).endswith('/' + deployment_id) and deployment_status(item) == 'SUCCESSFUL']
        require(len(matches) == 1, 'Completed baseline service revision is missing')
        owner = os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
        self.report.update(outputs=self.outputs, baseline=baseline,
                           baselineServiceRevision=revision_arn(matches[0]),
                           family=normal['IDENTITY']['aws']['ecs']['rollbackTaskFamilyPrefix'] + owner, owner=owner,
                           preparedAt=utc(), sourceRevision=os.environ['GITHUB_SHA'],
                           completed=False, manualRestore=False)
        self.save()

    def owned_revisions(self) -> list[str]:
        result: list[str] = []
        for status in ('ACTIVE', 'INACTIVE'):
            for page in self.ecs.get_paginator('list_task_definitions').paginate(familyPrefix=self.report['family'], status=status):
                for arn in page['taskDefinitionArns']:
                    if arn.split('/')[-1].rsplit(':', 1)[0] != self.report['family']:
                        continue
                    response = self.ecs.describe_task_definition(taskDefinition=arn, include=['TAGS'])
                    require({'key': 'preview-rollback-owner', 'value': self.report['owner']} in response['tags'],
                            'Diagnostic ownership tag differs')
                    result.append(arn)
        require(len(result) <= 1, 'Multiple diagnostic revisions require investigation')
        return result

    def diagnostic_history(self) -> ServiceDeploymentTypeDef | None:
        histories = self.histories()
        for item in histories:
            target = revision_arn(item)
            if target == self.report['baselineServiceRevision']:
                continue
            response = self.ecs.describe_service_revisions(serviceRevisionArns=[target])
            require(not response.get('failures') and len(response['serviceRevisions']) == 1,
                    'Service revision lookup failed')
            if required(response['serviceRevisions'][0].get('taskDefinition'), 'service revision taskDefinition') == self.report['diagnosticRevision']:
                return item
        return None

    def baseline_healthy(self):
        current = self.service()
        allowed = {self.report['baseline']['taskDefinitionArn'], self.report.get('diagnosticRevision')}
        revision = required(current.get('taskDefinition'), 'ECS service taskDefinition')
        require(revision in allowed
                and all(required(item.get('taskDefinition'), 'ECS deployment taskDefinition') in allowed
                        for item in required(current.get('deployments'), 'ECS service deployments')),
                'Unrelated deployment prevents automatic intervention')
        if revision != self.report['baseline']['taskDefinitionArn'] or not replacement['stable'](current):
            return False
        replacement['configuration'](current, self.report['baseline']['taskDefinitionArn'])
        identity = normal['verify_deployment'](self.outputs, self.ecs, self.elb)
        require(identity['imageDigest'] == self.report['baseline']['imageDigest'], 'Recovered image differs from baseline')
        self.report['recoveredTask'] = identity
        return True

    def stopped_diagnostics(self):
        arns = set()
        for status in ('RUNNING', 'STOPPED'):
            for page in self.ecs.get_paginator('list_tasks').paginate(cluster=self.cluster, family=self.report['family'], desiredStatus=status):
                arns.update(page['taskArns'])
        tasks = []
        for start in range(0, len(arns), 100):
            response = self.ecs.describe_tasks(cluster=self.cluster, tasks=sorted(arns)[start:start + 100])
            require(not response.get('failures'), 'Diagnostic task lookup failed')
            tasks.extend(response['tasks'])
        require(all(task['taskDefinitionArn'] == self.report['diagnosticRevision'] for task in tasks),
                'Diagnostic task revision differs')
        self.report['diagnosticTasks'] = [
            {**{key: task.get(key) for key in ('taskArn', 'taskDefinitionArn', 'lastStatus', 'healthStatus', 'stopCode', 'stoppedReason',
                                             'createdAt', 'startedAt', 'stoppingAt', 'stoppedAt')},
             'containers': [{key: container.get(key) for key in ('name', 'exitCode', 'healthStatus', 'reason', 'imageDigest')}
                            for container in task['containers']]} for task in tasks]
        return all(task['lastStatus'] == 'STOPPED' for task in tasks)

    def recover(self, *, automatic_seconds: float = 0, restore_seconds: float = 900) -> None:
        self.report['recovery'] = {'completed': False, 'startedAt': utc()}
        self.save()
        owned = self.owned_revisions()
        if owned:
            self.report['diagnosticRevision'] = owned[0]
            self.report['registrationAttempted'] = True
        require(not self.report.get('registrationAttempted') or owned,
                'Uncertain registration has no visible revision; reconcile the saved unique family before retrying')
        deadline = self.report.setdefault('automaticRecoveryDeadlineMonotonicSeconds', time.monotonic() + automatic_seconds)
        cleanup_deadline = self.report.setdefault('resourceRecoveryDeadlineMonotonicSeconds', deadline + restore_seconds)
        self.save()
        self.await_automatic_recovery(owned, deadline)
        while not self.baseline_healthy() or (owned and not self.stopped_diagnostics()):
            require(time.monotonic() < cleanup_deadline, 'Preview recovery or diagnostic task cleanup exceeded deadline')
            self.save()
            time.sleep(10)
        for arn in owned:
            definition = self.ecs.describe_task_definition(taskDefinition=arn)['taskDefinition']
            if required(definition.get('status'), 'task definition status') == 'ACTIVE':
                self.ecs.deregister_task_definition(taskDefinition=arn)
            require(required(self.ecs.describe_task_definition(taskDefinition=arn)['taskDefinition'].get('status'), 'task definition status') == 'INACTIVE',
                    'Diagnostic task definition remains active')
        self.report['recovery'].update(completed=True, finishedAt=utc(), inactiveRevisions=owned)
        self.save()

    def await_automatic_recovery(self, owned: list[str], deadline: float) -> None:
        while True:
            history = self.diagnostic_history() if owned else None
            if history:
                self.report['diagnosticDeployment'] = history
                self.report.setdefault('updateAttemptedAt', 'reconciled from provider history')
            settled = not self.report.get('updateAttemptedAt') or (
                history is not None and deployment_status(history) in {'ROLLBACK_SUCCESSFUL', 'ROLLBACK_FAILED', 'SUCCESSFUL', 'STOPPED'})
            if self.baseline_healthy() and (settled or self.report['manualRestore']):
                return
            self.save()
            if time.monotonic() >= deadline:
                self.restore_manually(history)
                return
            time.sleep(10)

    def restore_manually(self, history: ServiceDeploymentTypeDef | None) -> None:
        require(not self.report.get('manualRestoreRequestedAt'), 'Previously attempted restoration remains unresolved')
        require(history is not None, 'Uncertain update has no deployment history; mutation remains unresolved')
        self.report['manualRestore'] = True
        self.report['manualRestoreRequestedAt'] = utc()
        self.save()  # Persist intent before the single restoration attempt.
        self.ecs.update_service(cluster=self.cluster, service=self.name,
                                taskDefinition=self.report['baseline']['taskDefinitionArn'], desiredCount=1)

    def run(self, *, interrupt: bool = False) -> None:
        require(not self.report.get('registrationAttempted'), 'Use recovery, never replay a mutation record')
        require(self.baseline_healthy(), 'Prepared baseline is no longer healthy')
        require(self.report['recoveredTask'] == self.report['baseline'], 'Prepared baseline task changed')
        require(not self.owned_revisions(), 'Diagnostic family already exists')
        definition = diagnostic_definition(self.ecs, self.ecr, self.report['baseline'], self.report['family'], self.report['owner'])
        self.report['diagnosticImage'] = definition['containerDefinitions'][0]['image']
        deadline = time.monotonic() + 3600
        try:
            self.report['registrationAttempted'] = True
            self.save()
            registered = self.ecs.register_task_definition(**definition)['taskDefinition']
            self.report['diagnosticRevision'] = required(registered.get('taskDefinitionArn'), 'registered task definition taskDefinitionArn')
            self.save()
            self.report['updateAttemptedAt'] = utc()
            self.save()
            response = self.ecs.update_service(cluster=self.cluster, service=self.name,
                                               taskDefinition=self.report['diagnosticRevision'])
            requested = replacement['primary'](response['service'])
            require(requested['taskDefinition'] == self.report['diagnosticRevision'], 'Diagnostic update was not accepted')
            self.report['requestedDeploymentId'] = requested['id']
            self.save()
            if interrupt:
                self.report['controlledInterruption'] = True
                raise ObserverInterrupted('Controlled observer interruption after acknowledged diagnostic update')
            while True:
                history = self.diagnostic_history()
                if history:
                    self.report['diagnosticDeployment'] = history
                    self.save()
                    if deployment_status(history) == 'ROLLBACK_SUCCESSFUL':
                        automatic_rollback(history, self.report['baselineServiceRevision'], revision_arn(history))
                        break
                    require(deployment_status(history) not in {'SUCCESSFUL', 'ROLLBACK_FAILED', 'STOPPED'},
                            'Diagnostic did not produce the intended automatic rollback')
                require(time.monotonic() < deadline, 'Automatic rollback observation deadline expired')
                time.sleep(10)
        finally:
            remaining = max(0, deadline - time.monotonic())
            self.recover(automatic_seconds=min(60, remaining) if self.report.get('controlledInterruption') else remaining)
        require(not self.report['manualRestore'], 'Manual restoration cannot pass automatic rollback acceptance')
        require(any('CannotPullContainerError' in (task.get('stoppedReason') or '')
                    and 'not found' in task['stoppedReason'].lower()
                    and MISSING_DIGEST in task['stoppedReason'] for task in self.report['diagnosticTasks']),
                'Intended missing-image startup failure was not observed')
        self.report['automaticRollbackVerified'] = True
        self.save()


def check_conversation(result: dict[str, Any]) -> None:
    require(all(result.get(key) is True for key in
                ('completeAnswer', 'terminalSuccess', 'historyReplay', 'isolated',
                 'foreignDeleteRejected', 'invalidInvocationRejected'))
            and result['timing'].get('conversationDeleted') is True, 'Incomplete rollback conversation acceptance')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['exercise', 'recover'])
    parser.add_argument('outputs')
    parser.add_argument('--interrupt', action='store_true')
    args = parser.parse_args()
    path = Path(os.environ['RUNNER_TEMP']) / 'preview-rollback-evidence.json'
    require(args.mode != 'exercise' or not path.exists(), 'Use recovery, never replay a mutation record')
    report = json.loads(path.read_text()) if args.mode == 'recover' else {}
    config = Config(connect_timeout=10, read_timeout=20, retries={'total_max_attempts': 1})
    outputs = json.loads(Path(args.outputs).read_text())[normal['IDENTITY']['aws']['ecs']['previewOriginStackName']]
    exercise = Exercise(outputs, boto3.client('ecs', config=config), boto3.client('elbv2', config=config), report, path,
                        ecr=boto3.client('ecr', config=config))
    try:
        if args.mode == 'recover':
            if report.get('registrationAttempted'):
                require(report['outputs'] == outputs, 'Recovery outputs differ from recorded preview owner')
                exercise.recover()
        else:
            exercise.prepare()
            retained_timing = {}
            report['retainedConversation'] = {'timing': retained_timing}
            def before_replay():
                try:
                    exercise.run(interrupt=args.interrupt)
                except ObserverInterrupted:
                    # This intentionally failed probe retains its failed verdict after
                    # separately checking recovery, history and cleanup below.
                    require(report['recovery']['completed'], 'Interrupted probe did not recover')
            # The completed answer exists before failure injection; replay and cleanup follow recovery.
            retained = normal['verify_conversation'](timing=retained_timing, before_replay=before_replay)
            check_conversation(retained)
            report['retainedConversation'] = retained
            before = normal['verify_deployment'](outputs, exercise.ecs, exercise.elb)
            require(before == report['recoveredTask'], 'Recovered task changed before chat acceptance')
            fresh_timing = {}
            report['postRecoveryConversation'] = {'timing': fresh_timing}
            fresh = normal['verify_conversation'](timing=fresh_timing, observation_seconds=180)
            check_conversation(fresh)
            require(normal['verify_deployment'](outputs, exercise.ecs, exercise.elb) == before,
                    'Recovered task changed during chat acceptance')
            report['postRecoveryConversation'] = fresh
            if report.get('controlledInterruption'):
                raise ObserverInterrupted('Controlled observer interruption; recovery and conversation acceptance passed')
            report['completed'] = True
    except Exception as error:
        report['errorType'] = type(error).__name__
        raise
    finally:
        report['finishedAt'] = utc()
        exercise.save()
    print(json.dumps({'completed': report.get('completed'), 'recovery': report.get('recovery')}))


if __name__ == '__main__':
    main()
