"""Park or unpark production, or print its stored park state (docs/runbooks/production-parking.md).

usage: transition.py state | park | unpark

park and unpark store the target state, deploy the ECS CDK app with that
`parked` flag, then verify it. Re-running either finishes a half-done
transition. Every deploy of the app reads the stored state, so only these two
commands change it.
"""
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
from typing import Any, TypeVar

from deploy_identity import load_identity

ROOT = Path(os.environ['CARTRIDGE_REPOSITORY_ROOT']).resolve()
DEPLOY = Path(__file__).resolve().parent
CDK = DEPLOY / 'cdk'
IDENTITY = load_identity()
PARAMETER = IDENTITY['ssm']['parkState']
TARGETS = {'park': 'parked', 'unpark': 'live'}
T = TypeVar('T')


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value


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


def credential_start(tasks: Iterable[Mapping[str, Any]], since: datetime, seen: datetime):
    """Pull and start-to-healthy seconds of the Credential Service task this deploy
    created, once it is seen HEALTHY at `seen`; None before that."""
    for task in tasks:
        if task['createdAt'] >= since and task.get('healthStatus') == 'HEALTHY':
            return {'task': task['taskArn'],
                    'pullSeconds': (task['pullStoppedAt'] - task['pullStartedAt']).total_seconds(),
                    'startToHealthySeconds': (seen - task['startedAt']).total_seconds()}
    return None


class CredentialWatch(threading.Thread):
    """Polls ECS every 2 s during the deploy, since ECS records no time a task turned healthy."""

    def __init__(self, since: datetime):
        super().__init__(daemon=True)
        self.since, self.done, self.result, self.error = since, threading.Event(), None, None

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
                if stopping:
                    return
                self.done.wait(2)
        except Exception as error:
            self.error = error

    def stop(self):
        """The measurement, or None when the deploy started no Credential Service task."""
        self.done.set()
        self.join()
        if self.error:
            raise self.error
        return self.result


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
    watch = CredentialWatch(datetime.now(UTC))
    watch.start()
    steps.step('deploy', lambda: run(
        './node_modules/.bin/cdk', 'deploy', 'ChatStorage', 'PrivateEgress', 'PreviewOrigin', 'ApiHealth',
        '-c', 'previewOrigin=true', '-c', f"parked={'true' if target == 'parked' else 'false'}",
        '--require-approval', 'never', '--outputs-file', str(outputs), cwd=CDK))
    steps.step('measure credential service start', lambda: setattr(steps, 'credential_start', watch.stop()))
    steps.step(f'verify {target}', lambda: run(python, str(DEPLOY / 'verify-park.py'), target, str(outputs)))
    if target == 'live':
        steps.step('verify production origin', lambda: run(python, str(DEPLOY / 'verify-origin.py'), 'production', str(outputs)))
        steps.step('verify preview origin', lambda: run(python, str(DEPLOY / 'verify-origin.py'), 'verify', str(outputs)))
        steps.step('verify alarms', lambda: run(python, str(DEPLOY / 'verify-alarms.py'), str(outputs)))
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
