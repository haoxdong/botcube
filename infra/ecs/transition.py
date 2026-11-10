"""Park/unpark production per docs/runbooks/production-parking.md."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from deploy_identity import SERVICES, load_identity, required

ROOT = Path(os.environ['CARTRIDGE_REPOSITORY_ROOT']).resolve()
DEPLOY = Path(__file__).resolve().parent
CDK = DEPLOY / 'cdk'
IDENTITY = load_identity()
PARAMETER = IDENTITY['ssm']['parkState']
TARGETS = {'park': 'parked', 'unpark': 'live'}


def parse_state(value: str):
    if value not in TARGETS.values():
        raise SystemExit(f'Stored park state {PARAMETER} must be live or parked, got {value!r}')
    return value


def stored_state():
    import boto3
    ssm = boto3.client('ssm')
    try:
        parameter = ssm.get_parameter(Name=PARAMETER)['Parameter']
    except ssm.exceptions.ParameterNotFound as error:
        raise SystemExit(f'Stored park state {PARAMETER} is missing; bootstrap-deploy-role.sh creates it') from error
    return parse_state(required(parameter.get('Value'), 'stored park state Value'))


class Run:
    """Times each named step; a failure fails the run and names its step (ADR 0030)."""

    def __init__(self, action: str, clock: Callable[[], float] = time.monotonic, evidence: Path | None = None):
        self.action, self.clock, self.evidence, self.steps = action, clock, evidence, []
        self.credential_start = None

    def step(self, name: str, work: Callable[[], object]):
        start = self.clock()
        try:
            work()
        except Exception as error:
            self.record(name, start, error=f'{type(error).__name__}: {error}')
            raise SystemExit(f'{self.action} failed at step "{name}": {type(error).__name__}: {error}') from error
        self.record(name, start)

    def record(self, name: str, start: float, error: str | None = None):
        self.steps.append({'step': name, 'seconds': round(self.clock() - start, 1), 'ok': error is None, **({'error': error} if error else {})})
        if self.evidence:
            self.evidence.write_text(json.dumps(self.report(), indent=2) + '\n')

    def report(self) -> dict[str, object]:
        return {'action': self.action, 'steps': self.steps, 'credentialServiceStart': self.credential_start}


def run(*command: str, cwd: Path = ROOT):
    subprocess.run(command, cwd=cwd, check=True)


def credential_start(tasks: Iterable[Mapping[str, Any]], since: datetime, seen: datetime) -> dict[str, Any] | None:
    """Pull and start-to-healthy seconds of the Credential Service task this deploy
    created, once it is seen HEALTHY at `seen`; None before that. ECS can report a task
    HEALTHY while it is still ACTIVATING, before it sets `startedAt` at RUNNING,
    so such a task is not measured yet."""
    for task in tasks:
        if task['createdAt'] >= since and task.get('healthStatus') == 'HEALTHY' and 'startedAt' in task:
            return {'task': task['taskArn'],
                    'pullSeconds': (task['pullStoppedAt'] - task['pullStartedAt']).total_seconds(),
                    'startToHealthySeconds': (seen - task['startedAt']).total_seconds()}
    return None


def unstarted_task(tasks: Iterable[Mapping[str, Any]], since: datetime) -> str | None:
    """The Credential Service task this deploy created that is HEALTHY but has no `startedAt` yet."""
    return next((task['taskArn'] for task in tasks
                 if task['createdAt'] >= since and task.get('healthStatus') == 'HEALTHY' and 'startedAt' not in task), None)


class CredentialWatch(threading.Thread):
    """Polls ECS every 2 s during the deploy, since ECS records no time a task turned healthy."""

    def __init__(self, since: datetime, grace: float = 60, clock: Callable[[], float] = time.monotonic,
                 pause: Callable[[float], None] = time.sleep):
        super().__init__(daemon=True)
        self.since, self.done = since, threading.Event()
        self.result: dict[str, Any] | None = None
        self.error: Exception | None = None
        self.unstarted: str | None = None
        self.grace, self.clock, self.pause, self.deadline = grace, clock, pause, float('inf')

    def run(self):
        try:
            import boto3
            ecs, cluster = boto3.client('ecs'), IDENTITY['aws']['ecs']['cluster']
            while self.result is None:
                stopping = self.done.is_set()
                arns = ecs.list_tasks(cluster=cluster, serviceName='credential-service')['taskArns']
                response = ecs.describe_tasks(cluster=cluster, tasks=arns) if arns else {'tasks': []}
                if response.get('failures'):
                    raise RuntimeError('Credential Service task lookup failed')
                tasks = response['tasks']
                self.result = credential_start(tasks, self.since, datetime.now(UTC))
                self.unstarted = unstarted_task(tasks, self.since)
                # After the deploy, a HEALTHY task waiting for `startedAt` gets a bounded wait; nothing else does.
                if stopping and (self.unstarted is None or self.clock() >= self.deadline):
                    return
                if stopping:
                    self.pause(2)
                else:
                    self.done.wait(2)
        except Exception as error:
            self.error = error

    def stop(self) -> dict[str, Any] | None:
        """The measurement; `{'task': ..., 'started': False}` when the new task stayed HEALTHY without
        `startedAt` past the grace; or None when the deploy started no Credential Service task."""
        self.deadline = self.clock() + self.grace
        self.done.set()
        self.join()
        if self.error:
            raise self.error
        if self.result is None and self.unstarted is not None:
            print(f'Credential Service task {self.unstarted} is HEALTHY but not started after {self.grace:.0f} s; '
                  'start time not measured', flush=True)
            return {'task': self.unstarted, 'started': False}
        return self.result


SESSION_API_CAPACITY = 'lambda:function:ProvisionedConcurrency'


def session_api_capacity(target: str, autoscaling: Any = None, functions: Any = None,
                         pause: Callable[[float], None] = time.sleep, timeout: float = 600):
    """Parked, the session API alias keeps no provisioned environment, which bills by the hour; Live, it gets its
    scaling minimum back and scaling resumes. Re-running either converges."""
    import boto3
    autoscaling = autoscaling or boto3.client('application-autoscaling')
    functions = functions or boto3.client('lambda')
    agent = IDENTITY['aws']['agentCore']
    function, alias = agent['sessionApiFunction'], agent['sessionApiAlias']
    resource = f'function:{function}:{alias}'
    found = autoscaling.describe_scalable_targets(ServiceNamespace='lambda', ResourceIds=[resource], ScalableDimension=SESSION_API_CAPACITY)['ScalableTargets']
    if not found:
        raise RuntimeError(f'{resource} has no scalable target; deploy the AgentCore stack')
    parked = target == 'parked'
    if not parked:
        provision_alias(functions, function, alias, found[0]['MinCapacity'], pause, timeout)
    autoscaling.register_scalable_target(ServiceNamespace='lambda', ResourceId=resource, ScalableDimension=SESSION_API_CAPACITY, SuspendedState={
        'DynamicScalingInSuspended': parked, 'DynamicScalingOutSuspended': parked, 'ScheduledScalingSuspended': parked})
    configs = functions.list_provisioned_concurrency_configs(FunctionName=function)['ProvisionedConcurrencyConfigs']
    if parked and any(config['FunctionArn'].endswith(f':{alias}') for config in configs):
        functions.delete_provisioned_concurrency_config(FunctionName=function, Qualifier=alias)


WEIGHTED_ALIAS = 'Alias with weights can not be used with Provisioned Concurrency'


def provision_alias(functions: Any, function: str, alias: str, minimum: int, pause: Callable[[float], None], timeout: float):
    """Lambda refuses provisioned concurrency on an alias that routes by weights. An AgentCore deploy's alias update
    leaves the alias weighted for a moment, and a deploy in the `harness` slot can overlap unpark (as
    on 2026-11-05 at 11:24Z), so wait out the weights and try again rather than fail the unpark."""
    deadline, healed = time.monotonic() + timeout, False
    while True:
        try:
            functions.put_provisioned_concurrency_config(FunctionName=function, Qualifier=alias, ProvisionedConcurrentExecutions=minimum)
            return
        except Exception as error:
            if WEIGHTED_ALIAS not in str(error):
                raise
            if time.monotonic() > deadline:
                if healed or not orphaned_weights_cleared(functions, function, alias):
                    raise RuntimeError(f'{function}:{alias} still routes by weights after {timeout:.0f} s; '
                                       're-run unpark once the AgentCore deploy finishes') from error
                deadline, healed = time.monotonic() + timeout, True
                continue
            print(f'{function}:{alias} routes by weights during an AgentCore deploy; waiting to provision it', flush=True)
            pause(10)


def orphaned_weights_cleared(functions: Any, function: str, alias: str) -> bool:
    """Moving a provisioned alias to a new version, Lambda routes to the old one until the new version's environments
    are ready. A park that deletes the provisioning mid-shift leaves the shift unable to finish (2026-11-06 02:42Z), so
    with no provisioning left, point the alias at the version the deploy moved it to, with no weights."""
    configs = functions.list_provisioned_concurrency_configs(FunctionName=function)['ProvisionedConcurrencyConfigs']
    if any(config['FunctionArn'].endswith(f':{alias}') for config in configs):
        return False
    version = functions.get_alias(FunctionName=function, Name=alias)['FunctionVersion']
    functions.update_alias(FunctionName=function, Name=alias, FunctionVersion=version, RoutingConfig={'AdditionalVersionWeights': {}})
    print(f'::warning::{function}:{alias} kept weights with no provisioning to finish its shift; pointed it at version {version} alone', flush=True)
    return True


# UpdateAgentRuntime replaces the whole configuration, so a refresh sends back every field it read. A field Get
# returns that is in neither set is new to this code, and a refresh refuses rather than drop it.
RUNTIME_CONFIGURATION = ('agentRuntimeArtifact', 'roleArn', 'networkConfiguration', 'description', 'authorizerConfiguration',
                         'requestHeaderConfiguration', 'protocolConfiguration', 'lifecycleConfiguration', 'metadataConfiguration',
                         'environmentVariables', 'filesystemConfigurations', 'capacityProviderConfiguration', 'platformVersion')
RUNTIME_STATUS = ('ResponseMetadata', 'agentRuntimeArn', 'agentRuntimeName', 'agentRuntimeId', 'agentRuntimeVersion', 'createdAt',
                  'lastUpdatedAt', 'status', 'failureReason', 'workloadIdentityDetails')


def runtime_update(name: str, current: Mapping[str, Any]) -> dict[str, Any]:
    """The unchanged configuration of a READY runtime, as UpdateAgentRuntime takes it."""
    unknown = sorted(set(current) - set(RUNTIME_CONFIGURATION) - set(RUNTIME_STATUS))
    if unknown:
        raise RuntimeError(f'{name} has runtime fields this refresh would drop: {", ".join(unknown)}')
    if current['status'] != 'READY':
        raise RuntimeError(f'{name} is {current["status"]}, not READY; re-run unpark once its update finishes')
    configuration = {field: current[field] for field in RUNTIME_CONFIGURATION if field in current}
    # Get reports requireServiceS3Endpoint, but an update that sends it is refused on runtimes made since 2026-06-11.
    network = configuration.get('networkConfiguration', {}).get('networkModeConfig')
    if network:
        network.pop('requireServiceS3Endpoint', None)
    return configuration


def refresh_runtime_spares(agentcore: Any = None, pause: Callable[[float], None] = time.sleep, timeout: float = 600):
    """A V1 AgentCore runtime starts its spare microVMs when a version is created, and replaces each one that ends.
    Without the NAT Gateway a microVM can't start, so a version created while Parked, or one whose spares ended
    while Parked, serves every session from a fresh microVM after unpark: a 30-36 s first frame.
    With egress back, an update with the unchanged configuration makes a new version, which starts its spares."""
    import boto3
    agentcore = agentcore or boto3.client('bedrock-agentcore-control')
    name = IDENTITY['aws']['agentCore']['runtime']
    found = [runtime for page in agentcore.get_paginator('list_agent_runtimes').paginate() for runtime in page['agentRuntimes']
             if runtime['agentRuntimeName'] == name]
    if len(found) != 1:
        raise RuntimeError(f'expected one AgentCore runtime named {name}, found {len(found)}')
    runtime_id = found[0]['agentRuntimeId']
    current = agentcore.get_agent_runtime(agentRuntimeId=runtime_id)
    agentcore.update_agent_runtime(agentRuntimeId=runtime_id, **runtime_update(name, current))
    deadline = time.monotonic() + timeout
    while True:
        updated = agentcore.get_agent_runtime(agentRuntimeId=runtime_id)
        if updated['status'] == 'READY' and updated['agentRuntimeVersion'] != current['agentRuntimeVersion']:
            print(f'{name} refreshed: version {current["agentRuntimeVersion"]} -> {updated["agentRuntimeVersion"]}', flush=True)
            return updated
        if updated['status'].endswith('FAILED'):
            raise RuntimeError(f'{name} refresh {updated["status"]}: {updated.get("failureReason")}')
        if time.monotonic() > deadline:
            raise RuntimeError(f'{name} refresh still {updated["status"]} after {timeout:.0f} s')
        pause(5)


# The Harness logs `serve_handoff` when a microVM's process starts serving, and `first_asgi_invocation` at its first
# request. A fresh microVM, started for a request, logged that request 0.1-1.7 s after its handoff; a spare waits
# for one (2026-11-05).
HANDOFF_PATTERN = ('{ $.event = "harness_process_observation" && '
                   '($.stage = "serve_handoff" || $.stage = "first_asgi_invocation") }')
SPARE_IDLE_SECONDS = 15


def first_spare_handoff(events: Iterable[Mapping[str, Any]], now: float) -> float | None:
    """The Unix time the first spare microVM in these runtime log events handed off: a handoff with no request
    in its log stream for SPARE_IDLE_SECONDS."""
    stages: dict[str, dict[str, float]] = {}
    for event in events:
        record = json.loads(event['message'])
        stages.setdefault(event['logStreamName'], {})[record['stage']] = record['atUnixNs'] / 1e9
    return min((seen['serve_handoff'] for seen in stages.values() if 'serve_handoff' in seen
                and seen.get('first_asgi_invocation', now) - seen['serve_handoff'] >= SPARE_IDLE_SECONDS), default=None)


def await_spare_handoff(runtime: Mapping[str, Any], logs: Any = None, clock: Callable[[], float] = time.time,
                        pause: Callable[[float], None] = time.sleep, timeout: float = 300):
    """A refreshed version starts its spares minutes after READY (4 min on 2026-11-05), and a chat before then waits
    about 29 s for a fresh microVM, so unpark reports Live after the first spare handoff, or after `timeout`
    with a warning. The runtime logs carry no version, so a spare handed off since the version's READY counts."""
    import boto3
    logs = logs or boto3.client('logs')
    version, since = runtime['agentRuntimeVersion'], runtime['lastUpdatedAt'].timestamp()
    group = f'/aws/bedrock-agentcore/runtimes/{runtime["agentRuntimeId"]}-DEFAULT'
    while True:
        now = clock()
        events = [event for page in logs.get_paginator('filter_log_events').paginate(
            logGroupName=group, startTime=int(since * 1000), filterPattern=HANDOFF_PATTERN) for event in page['events']]
        handoff = first_spare_handoff(events, now)
        if handoff is not None:
            print(f'Runtime version {version} handed off its first spare microVM {handoff - since:.0f} s after READY', flush=True)
            return
        if now - since >= timeout:
            print(f'::warning::Runtime version {version} handed off no spare microVM in {now - since:.0f} s after READY; '
                  'reporting Live while new chats start fresh microVMs (about 29 s each)', flush=True)
            return
        pause(10)


def restore_service_capacity(ecs: Any = None):
    import boto3
    ecs = ecs or boto3.client('ecs')
    cluster = IDENTITY['aws']['ecs']['cluster']
    for service in SERVICES:
        ecs.update_service(cluster=cluster, service=service, desiredCount=1)
    ecs.get_waiter('services_stable').wait(
        cluster=cluster, services=list(SERVICES), WaiterConfig={'Delay': 15, 'MaxAttempts': 40})


def remove_legacy_files_imports(target: str):
    import boto3
    exports = boto3.client('cloudformation').get_paginator('list_exports').paginate()
    if any(export['Name'].startswith('ChatStorage:') and 'FilesFileSystem' in export['Name']
           for page in exports for export in page['Exports']):
        run('./node_modules/.bin/cdk', 'deploy', 'PreviewOrigin', '--exclusively', '-c', 'previewOrigin=true',
            '-c', f"parked={'true' if target == 'parked' else 'false'}", '--require-approval', 'never', cwd=CDK)


def transition(action: str):
    import boto3
    target = TARGETS[action]
    if not os.environ.get('RUNNER_TEMP'):
        os.environ['RUNNER_TEMP'] = tempfile.mkdtemp(prefix='production-')
    temp = Path(os.environ['RUNNER_TEMP'])
    os.environ['PREVIEW_ORIGIN_INPUT'] = str(temp / 'origin-input.json')
    outputs = temp / 'origin-outputs.json'
    steps = Run(action, evidence=temp / 'production-transition-evidence.json')
    python = sys.executable
    steps.step('build cdk', lambda: (run('pnpm', 'install', '--frozen-lockfile', '--filter', 'botcube-infra-ecs-cdk', cwd=CDK), run('pnpm', 'run', 'build', cwd=CDK)))
    steps.step('store state', lambda: boto3.client('ssm').put_parameter(Name=PARAMETER, Value=target, Type='String', Overwrite=True))
    steps.step('prepare', lambda: run(python, str(DEPLOY / 'prepare-origin.py')))
    if target == 'live':
        steps.step('restore session API capacity', lambda: session_api_capacity(target))
    refreshed: dict[str, Any] = {}
    if target == 'live':
        steps.step('deploy egress', lambda: run(
            './node_modules/.bin/cdk', 'deploy', 'PrivateEgress', '--exclusively', '-c', 'previewOrigin=true', '-c', 'parked=false',
            '--require-approval', 'never', cwd=CDK))
        steps.step('refresh runtime spares', lambda: refreshed.update(refresh_runtime_spares()))
    steps.step('remove legacy Files imports', lambda: remove_legacy_files_imports(target))
    watch = CredentialWatch(datetime.now(UTC))
    watch.start()
    steps.step('deploy', lambda: run(
        './node_modules/.bin/cdk', 'deploy', 'ChatStorage', 'ProductionParking', 'PrivateEgress', 'PreviewOrigin', 'ApiHealth',
        '-c', 'previewOrigin=true', '-c', f"parked={'true' if target == 'parked' else 'false'}",
        '--require-approval', 'never', '--outputs-file', str(outputs), cwd=CDK))
    if target == 'live':
        steps.step('restore service capacity', restore_service_capacity)
    steps.step('measure credential service start', lambda: setattr(steps, 'credential_start', watch.stop()))
    steps.step(f'verify {target}', lambda: run(python, str(DEPLOY / 'verify-park.py'), target, str(outputs)))
    if target == 'parked':
        steps.step('release session API capacity', lambda: session_api_capacity(target))
    if target == 'live':
        steps.step('verify production origin', lambda: run(python, str(DEPLOY / 'verify-origin.py'), 'production', str(outputs)))
        steps.step('verify preview origin', lambda: run(python, str(DEPLOY / 'verify-origin.py'), 'verify', str(outputs)))
        steps.step('verify alarms', lambda: run(python, str(DEPLOY / 'verify-alarms.py'), str(outputs)))
        steps.step('await first spare handoff', lambda: await_spare_handoff(refreshed))
    print(json.dumps({'state': target, **steps.report()}, indent=2), flush=True)


def main(argv: list[str]):
    if argv == ['state']:
        print(stored_state())
    elif len(argv) == 1 and argv[0] in TARGETS:
        transition(argv[0])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
