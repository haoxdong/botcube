"""Controlled preview replacement, called only inside the serialized deployment job."""
from __future__ import annotations

import json
import os
import signal
import sys
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType
from typing import TYPE_CHECKING, Any, TypeVar

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ConnectionError, ReadTimeoutError

if TYPE_CHECKING:
    from types_boto3_ecs import ECSClient
    from types_boto3_ecs.type_defs import (
        DeploymentConfigurationOutputTypeDef,
        DeploymentTypeDef,
        ServiceTypeDef,
        TaskTypeDef,
    )
    from types_boto3_elbv2 import ElasticLoadBalancingv2Client
    from types_boto3_elbv2.type_defs import (
        LoadBalancerAttributeTypeDef,
        TargetGroupAttributeTypeDef,
        TargetHealthDescriptionTypeDef,
    )

T = TypeVar('T')


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value


def utc():
    return datetime.now(UTC).isoformat()


def configuration(service: ServiceTypeDef, revision: str) -> DeploymentConfigurationOutputTypeDef:
    require(service.get('taskDefinition') == revision, 'Service revision changed or rolled back')
    config = required(service.get('deploymentConfiguration'), 'ECS service deploymentConfiguration')
    breaker = required(config.get('deploymentCircuitBreaker'), 'deployment configuration deploymentCircuitBreaker')
    require(service.get('desiredCount') == 1 and config.get('minimumHealthyPercent') == 100
            and config.get('maximumPercent') == 200
            and breaker['enable'] is True
            and breaker['rollback'] is True,
            'Preview replacement configuration differs')
    return config


def deployments(service: ServiceTypeDef) -> list[DeploymentTypeDef]:
    return required(service.get('deployments'), 'ECS service deployments')


def deployment_id(deployment: DeploymentTypeDef) -> str:
    return required(deployment.get('id'), 'ECS deployment id')


def deployment_revision(deployment: DeploymentTypeDef) -> str:
    return required(deployment.get('taskDefinition'), 'ECS deployment taskDefinition')


def primary(service: ServiceTypeDef) -> DeploymentTypeDef:
    matches = [d for d in deployments(service) if required(d.get('status'), 'ECS deployment status') == 'PRIMARY']
    require(len(matches) == 1, 'Expected one primary deployment')
    return matches[0]


def stable(service: ServiceTypeDef) -> bool:
    return (len(deployments(service)) == 1 and primary(service).get('rolloutState') == 'COMPLETED'
            and required(service.get('runningCount'), 'ECS service runningCount') == 1
            and required(service.get('pendingCount'), 'ECS service pendingCount') == 0)


def task_arn(task: TaskTypeDef) -> str:
    return required(task.get('taskArn'), 'ECS task taskArn')


def task_revision(task: TaskTypeDef) -> str:
    return required(task.get('taskDefinitionArn'), 'ECS task taskDefinitionArn')


def started_by(task: TaskTypeDef) -> str:
    return required(task.get('startedBy'), 'ECS task startedBy')


def last_status(task: TaskTypeDef) -> str:
    return required(task.get('lastStatus'), 'ECS task lastStatus')


def desired_status(task: TaskTypeDef) -> str:
    return required(task.get('desiredStatus'), 'ECS task desiredStatus')


def task_identity(task: TaskTypeDef) -> dict[str, Any]:
    containers = required(task.get('containers'), 'ECS task containers')
    require(len(containers) == 1, 'Expected one preview container')
    container = containers[0]
    require(container.get('imageDigest', '').startswith('sha256:'), 'Immutable task image missing')
    interfaces = required(container.get('networkInterfaces'), 'container networkInterfaces')
    require(len(interfaces) == 1, 'Expected one private task IP')
    return {'taskArn': task_arn(task), 'taskDefinitionArn': task_revision(task),
            'deploymentId': started_by(task), 'imageDigest': required(container.get('imageDigest'), 'container imageDigest'),
            'target': {'Id': required(interfaces[0].get('privateIpv4Address'), 'network interface privateIpv4Address'), 'Port': 8123}}


def target_endpoint(target: TargetHealthDescriptionTypeDef) -> dict[str, str | int]:
    endpoint = required(target.get('Target'), 'target Target')
    return {'Id': endpoint['Id'], 'Port': required(endpoint.get('Port'), 'target Port')}


def health_state(target: TargetHealthDescriptionTypeDef) -> str:
    return required(required(target.get('TargetHealth'), 'target TargetHealth').get('State'), 'target TargetHealth State')


def target_state(targets: Sequence[TargetHealthDescriptionTypeDef], identity: dict[str, Any]) -> str:
    matches = [t for t in targets if target_endpoint(t) == identity['target']]
    require(len(matches) <= 1, 'Duplicate exact task target')
    return health_state(matches[0]) if matches else 'absent'


def require_only_healthy_target(targets: Sequence[TargetHealthDescriptionTypeDef], old: dict[str, Any]) -> None:
    healthy = [target_endpoint(t) for t in targets if health_state(t) == 'healthy']
    require(healthy == [old['target']], 'Competing healthy target prevents stream attribution')


STOPPING_STATUSES = {'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED'}


class Replacement:
    """Validate observed provider facts; incomplete observations never establish ordering."""
    def __init__(self, old: dict[str, Any], deployment: dict[str, Any], revision: str, report: dict[str, Any]) -> None:
        require(deployment['id'] != old['deploymentId'], 'Replacement request was a no-op')
        require(deployment['taskDefinition'] == revision, 'Requested deployment revision differs')
        self.old, self.deployment, self.revision, self.report = old, deployment['id'], revision, report
        self.new: dict[str, Any] | None = None
        report.update(oldTask=old, requestedDeployment=deployment, observations=[], milestones={})

    def observe(self, service: ServiceTypeDef, tasks: Mapping[str, TaskTypeDef], targets: Sequence[TargetHealthDescriptionTypeDef],
                observed_at: str) -> bool:
        self.report['lastServiceObservation'] = {'observedAt': observed_at,
            'taskDefinition': required(service.get('taskDefinition'), 'ECS service taskDefinition'),
            'runningCount': required(service.get('runningCount'), 'ECS service runningCount'),
            'pendingCount': required(service.get('pendingCount'), 'ECS service pendingCount'),
            'deployments': [{key: d.get(key) for key in ('id', 'status', 'taskDefinition', 'rolloutState')} for d in deployments(service)]}
        config = configuration(service, self.revision)
        requested = self.requested_deployment(service)
        old_task = self.old_task(tasks)
        self.track_new_task(tasks)
        old_state = target_state(targets, self.old)
        new_state = target_state(targets, self.new) if self.new else 'not-running'
        observation = {'observedAt': observed_at, 'sequence': len(self.report['observations']),
                       'oldStatus': last_status(old_task), 'oldDesiredStatus': desired_status(old_task), 'oldTargetState': old_state,
                       'newTask': self.new, 'newTargetState': new_state,
                       'deploymentState': requested.get('rolloutState'),
                       'tasks': [{'taskArn': task_arn(t), 'status': last_status(t), 'deploymentId': started_by(t),
                                  'taskDefinitionArn': task_revision(t)} for t in tasks.values()]}
        self.report['observations'].append(observation)
        self.record_milestones(old_task, old_state, new_state, observation)
        milestones = self.report['milestones']
        if stable(service) and 'oldStopping' in milestones and 'oldDraining' in milestones:
            self.complete(config, old_task, new_state, observed_at)
            return True
        return False

    def requested_deployment(self, service: ServiceTypeDef) -> DeploymentTypeDef:
        requested = primary(service)
        require(deployment_id(requested) == self.deployment, 'Unexpected deployment or rollback')
        require(all(deployment_id(d) in {self.deployment, self.old['deploymentId']} for d in deployments(service)), 'Unexpected concurrent deployment')
        require(not any(d.get('rolloutState') == 'FAILED' for d in deployments(service)), 'Deployment failed')
        require(deployment_revision(requested) == self.revision, 'Deployment revision changed')
        return requested

    def old_task(self, tasks: Mapping[str, TaskTypeDef]) -> TaskTypeDef:
        require(self.old['taskArn'] in tasks, 'Old task observation missing')
        old_task = tasks[self.old['taskArn']]
        require(task_revision(old_task) == self.old['taskDefinitionArn']
                and started_by(old_task) == self.old['deploymentId'], 'Old task identity changed')
        return old_task

    def track_new_task(self, tasks: Mapping[str, TaskTypeDef]) -> None:
        candidates = [task for arn, task in tasks.items() if arn != self.old['taskArn']]
        require(len(candidates) <= 1, 'Unexpected additional replacement task')
        for task in candidates:
            require(started_by(task) == self.deployment and task_revision(task) == self.revision,
                    'Replacement task has wrong deployment or revision')
            require(last_status(task) not in STOPPING_STATUSES, 'Replacement task stopped')
            require(desired_status(task) == 'RUNNING', 'Replacement task stop was requested')
            if last_status(task) == 'RUNNING':
                identity = task_identity(task)
                require(self.new is None or self.new == identity, 'Replacement task identity changed')
                self.new = identity
        if self.new:
            require(self.new['taskArn'] in tasks, 'Replacement task observation missing')

    def record_milestones(self, old_task: TaskTypeDef, old_state: str, new_state: str, observation: dict[str, Any]) -> None:
        milestones = self.report['milestones']
        if new_state == 'healthy' and last_status(old_task) == 'RUNNING':
            milestones.setdefault('healthyOverlap', observation)
        if old_state == 'draining':
            require('healthyOverlap' in milestones, 'Old target drained before observed healthy overlap')
            milestones.setdefault('oldDraining', observation)
        if last_status(old_task) in STOPPING_STATUSES:
            self.record_stopping(old_task, observation)
        if last_status(old_task) == 'STOPPED':
            stopped = old_task.get('stoppedAt')
            if stopped is None:
                raise RuntimeError('Old task stopped timestamp missing')
            self.report['oldStoppedAt'] = stopped.isoformat()
            milestones.setdefault('oldStopped', observation)

    def record_stopping(self, old_task: TaskTypeDef, observation: dict[str, Any]) -> None:
        milestones = self.report['milestones']
        require('healthyOverlap' in milestones, 'Old task stopping initiated without healthy overlap')
        if last_status(old_task) != 'DEACTIVATING':
            require('oldDraining' in milestones, 'Old task stopped without overlap and draining evidence')
        require(desired_status(old_task) == 'STOPPED', 'Old task stop was not requested')
        stopping = old_task.get('stoppingAt')
        if stopping is None or stopping.isoformat() <= milestones['healthyOverlap']['observedAt']:
            raise RuntimeError('Task stopping time precedes observed healthy overlap')
        self.report['oldStoppingAt'] = stopping.isoformat()
        milestones.setdefault('oldStopping', observation)

    def complete(self, config: DeploymentConfigurationOutputTypeDef, old_task: TaskTypeDef, new_state: str, observed_at: str) -> None:
        new = self.new
        if new is None or new_state != 'healthy':
            raise RuntimeError('Deployment completed without full replacement evidence')
        self.report.update(completed=True, completedAt=observed_at, newTask=new,
                           taskDefinitionChanged=self.old['taskDefinitionArn'] != new['taskDefinitionArn'],
                           imageChanged=self.old['imageDigest'] != new['imageDigest'],
                           configuration=config, oldTaskStatus=last_status(old_task),
                           oldTaskTerminallyStopped=last_status(old_task) == 'STOPPED')


class PreviewService:
    """Read-only lookups of the preview service, its tasks and its targets."""
    def __init__(self, outputs: dict[str, str], ecs: ECSClient, elb: ElasticLoadBalancingv2Client) -> None:
        self.outputs, self.ecs, self.elb = outputs, ecs, elb
        self.cluster, self.name = outputs['ClusterName'], outputs['ServiceName']

    def service(self) -> ServiceTypeDef:
        response = self.ecs.describe_services(cluster=self.cluster, services=[self.name])
        require(not response.get('failures') and len(response['services']) == 1, 'Service lookup failed')
        return response['services'][0]

    def tasks(self, arns: set[str]) -> dict[str, TaskTypeDef]:
        response = self.ecs.describe_tasks(cluster=self.cluster, tasks=sorted(arns))
        tasks = {task_arn(t): t for t in response['tasks']}
        require(not response.get('failures') and set(tasks) == arns, 'Task lookup incomplete')
        return tasks

    def running(self):
        pages = self.ecs.get_paginator('list_tasks').paginate(cluster=self.cluster, serviceName=self.name, desiredStatus='RUNNING')
        return {arn for page in pages for arn in page['taskArns']}

    def targets(self) -> list[TargetHealthDescriptionTypeDef]:
        return self.elb.describe_target_health(TargetGroupArn=self.outputs['TargetGroupArn'])['TargetHealthDescriptions']


def stable_old_task(preview: PreviewService, revision: str,
                    expected_old: dict[str, Any] | None) -> tuple[dict[str, Any], set[str]]:
    before = preview.service()
    configuration(before, revision)
    require(stable(before), 'Establish a stable service before replacement')
    arns = preview.running()
    require(len(arns) == 1, 'Expected exactly one stable old task')
    old_task = next(iter(preview.tasks(arns).values()))
    old = task_identity(old_task)
    require(last_status(old_task) == 'RUNNING' and old['deploymentId'] == deployment_id(primary(before))
            and old['taskDefinitionArn'] == revision and target_state(preview.targets(), old) == 'healthy', 'Old task is not stable and healthy')
    if expected_old is not None:
        require(old == expected_old, 'Initial stream task changed before replacement')
        require_only_healthy_target(preview.targets(), old)
    return old, arns


def observe_until_complete(preview: PreviewService, tracker: Replacement, known: set[str], deadline: float,
                           report: dict[str, Any]) -> None:
    while True:
        require(time.monotonic() < deadline, 'Replacement observation deadline expired')
        current = preview.service()
        known.update(preview.running())
        # Query target health first, then verify that the old task is still running.
        target_read_started = time.monotonic()
        health = preview.targets()
        current_tasks = preview.tasks(known)
        completed = tracker.observe(current, current_tasks, health, utc())
        report['observations'][-1].update(targetReadMonotonicSeconds=target_read_started,
                                           observedMonotonicSeconds=time.monotonic())
        if completed:
            return
        time.sleep(2)


def recovered(preview: PreviewService, old: dict[str, Any], recovery: dict[str, Any]) -> bool:
    current = preview.service()
    recovery.update(observedAt=utc(), deploymentId=deployment_id(primary(current)),
                    taskDefinitionArn=required(current.get('taskDefinition'), 'ECS service taskDefinition'))
    # A stale old stable deployment cannot establish recovery.
    if (deployment_id(primary(current)) == old['deploymentId'] or not stable(current)
            or required(current.get('desiredCount'), 'ECS service desiredCount') != 1):
        return False
    old_task = preview.tasks({old['taskArn']})[old['taskArn']]
    recovery['oldTaskStatus'] = last_status(old_task)
    stop_initiated = (desired_status(old_task) == 'STOPPED' and old_task.get('stoppingAt') is not None
                      and last_status(old_task) in STOPPING_STATUSES)
    recovery['oldStopInitiated'] = stop_initiated
    return stop_initiated


def recover(preview: PreviewService, old: dict[str, Any], deadline: float, report: dict[str, Any]) -> None:
    # Preserve the failed verdict while retaining the serialization lock
    # for read-only recovery. Never retry an uncertain mutation.
    recovery: dict[str, Any] = {'stable': False}
    report['recovery'] = recovery
    while time.monotonic() < deadline:
        try:
            if recovered(preview, old, recovery):
                recovery['stable'] = True
                break
        except (ClientError, ConnectionError, ReadTimeoutError) as error:
            # A transient read failure stays in evidence and is retried until the
            # deadline, which raises (ADR 0030); a non-transient one raises now.
            if isinstance(error, ClientError):
                require(error.response.get('ResponseMetadata', {}).get('HTTPStatusCode', 0) >= 500
                        or error.response.get('Error', {}).get('Code') == 'ThrottlingException',
                        'Non-transient recovery lookup failed')
            recovery.setdefault('readFailures', []).append({'observedAt': utc(), 'errorType': type(error).__name__})
        time.sleep(15)
    else:
        raise RuntimeError('Replacement failed and service did not stabilize within the exercise deadline')


def attributes(pairs: Sequence[TargetGroupAttributeTypeDef | LoadBalancerAttributeTypeDef], owner: str) -> dict[str, str]:
    return {required(a.get('Key'), owner + ' attribute Key'): required(a.get('Value'), owner + ' attribute Value') for a in pairs}


def exercise(outputs: dict[str, str], ecs: ECSClient, elb: ElasticLoadBalancingv2Client, report: dict[str, Any], *,
             expected_old: dict[str, Any] | None = None) -> None:
    revision = outputs['TaskDefinitionArn']
    preview = PreviewService(outputs, ecs, elb)
    old, arns = stable_old_task(preview, revision, expected_old)
    tg = attributes(elb.describe_target_group_attributes(TargetGroupArn=outputs['TargetGroupArn'])['Attributes'], 'target group')
    alb = attributes(elb.describe_load_balancer_attributes(LoadBalancerArn=outputs['LoadBalancerArn'])['Attributes'], 'load balancer')
    report.update(startedAt=utc(),
                  deregistrationDelaySeconds=int(required(tg.get('deregistration_delay.timeout_seconds'), 'target group deregistration delay')),
                  idleTimeoutSeconds=int(required(alb.get('idle_timeout.timeout_seconds'), 'load balancer idle timeout')), completed=False)
    deadline = time.monotonic() + 4500
    report['requestedAt'] = utc()
    report['requestedMonotonicSeconds'] = time.monotonic()
    try:
        updated = ecs.update_service(cluster=preview.cluster, service=preview.name, forceNewDeployment=True)['service']
        deployment = primary(updated)
        report['requestedDeployment'] = {'id': deployment_id(deployment), 'taskDefinition': deployment_revision(deployment)}
        tracker = Replacement(old, {'id': deployment_id(deployment), 'taskDefinition': deployment_revision(deployment)}, revision, report)
        # Keep known tasks, including the old one after it leaves ListTasks(RUNNING).
        observe_until_complete(preview, tracker, set(arns), deadline, report)
    finally:
        if not report['completed']:
            recover(preview, old, deadline, report)


def main():
    outputs = json.loads(Path(sys.argv[1]).read_text())[json.loads((Path(os.environ['CARTRIDGE_DEPLOY_ROOT']) / 'identity.json').read_text())['aws']['ecs']['previewOriginStackName']]
    report = {'sourceRevision': os.environ['GITHUB_SHA'], 'workflowRun': os.environ['GITHUB_RUN_ID'],
              'workflowAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'completed': False}
    path = Path(os.environ['RUNNER_TEMP']) / 'preview-replacement-evidence.json'
    config = Config(connect_timeout=10, read_timeout=20, retries={'total_max_attempts': 1})
    def expired(_signal: int, _frame: FrameType | None) -> None:
        raise RuntimeError('Replacement exercise wall deadline expired')
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(4560)
    try:
        exercise(outputs, boto3.client('ecs', config=config), boto3.client('elbv2', config=config), report)
    finally:
        signal.alarm(0)
        report['finishedAt'] = utc()
        path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key not in {'observations', 'milestones'}}, indent=2))


if __name__ == '__main__':
    main()
