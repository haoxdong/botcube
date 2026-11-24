"""Lambda operations for the durable production parking transition."""
import json
import os
import runpy
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import NotRequired, TypedDict
from urllib.error import HTTPError

from botocore.exceptions import ClientError
from deploy_guard import SETTLED, require_no_deploy
from deploy_identity import deployment_names, load_deployment, owned_egress
from egress_probe import RunningProbe
from parking_state import (
    mode_parameter,
    preparation_requested,
    production_state,
    wake_state,
)


class RuntimeSnapshot(TypedDict):
    platformVersion: NotRequired[str]
    agentRuntimeId: str
    agentRuntimeVersion: str
    lastUpdatedAt: float


class TransitionState(TypedDict, total=False):
    mode: str
    action: str
    op: str
    index: int
    startedAt: float
    started: bool
    waiting: bool
    done: bool
    attemptId: str
    probeDrainStartedAt: float
    runtime: RuntimeSnapshot
    probe: RunningProbe
    monitoringExecutionArn: str

IDENTITY = load_deployment()
NAMES = deployment_names(IDENTITY)
PARK_STATE = NAMES['parkStateParameterName']
OWNED_EGRESS = owned_egress(IDENTITY)
STACKS = {**({'egress': OWNED_EGRESS['stackName']} if OWNED_EGRESS else {}),
          'origin': NAMES['previewOriginStackName'],
          'health': NAMES['apiHealthStackName']}
EFFECTIVE_MODES = {
    STACKS['health']: {'parked': 'parked', 'egress': 'parked', 'credential': 'parked', 'live': 'live'},
    **({STACKS['egress']: {'parked': 'parked', 'egress': 'egress', 'credential': 'egress', 'live': 'egress'}} if OWNED_EGRESS else {}),
    STACKS['origin']: {'parked': 'parked', 'egress': 'parked', 'credential': 'credential', 'live': 'live'},
}
STEPS = {mode: tuple(step for step in steps if OWNED_EGRESS or step not in ('egress', 'prepare', 'probe-drain')) for mode, steps in {
    'parked': ('health', 'origin', 'capacity', 'probe-drain', 'egress', 'verify', 'store'),
    'egress': ('health', 'egress', 'origin', 'capacity', 'verify', 'store'),
    'credential': ('health', 'egress', 'origin', 'capacity', 'verify', 'store'),
    'live': ('prepare', 'capacity', 'refresh', 'origin', 'health', 'verify', 'origin-proof', 'alarm-configuration', 'spares', 'store'),
}.items()}
SPARE_DEADLINE_SECONDS = 285


class TransientServiceError(RuntimeError):
    pass


def handler(event, context, *, executions=None, ssm=None, **ports):
    try:
        if event.get('op') == 'wake-state':
            import boto3
            return wake_state(executions or boto3.client('stepfunctions'), ssm or boto3.client('ssm'), PARK_STATE, STEPS)
        return operate(event, context, executions=executions, ssm=ssm, **ports)
    except ClientError as error:
        code = error.response['Error']['Code']
        if code in ('Throttling', 'ThrottlingException', 'TooManyRequestsException', 'RequestLimitExceeded',
                    'ServiceUnavailable', 'ServiceUnavailableException', 'InternalError', 'InternalFailure') or error.response.get('ResponseMetadata', {}).get('HTTPStatusCode', 0) >= 500:
            raise TransientServiceError(str(error)) from error
        raise
    except HTTPError as error:
        if error.code == 429 or error.code >= 500:
            raise TransientServiceError(str(error)) from error
        raise


def operate(event, context, *, cloudformation=None, ssm=None, verify=None, capacity=None, refresh=None, spares=None, executions=None, probe=None, leases=None):
    import boto3
    # The Lambda sets no RUNNER_TEMP; ops write evidence there.
    os.environ.setdefault('RUNNER_TEMP', '/tmp')
    if event.get('op') == 'monitor':
        return establish_monitoring(event)
    cloudformation = cloudformation or boto3.client('cloudformation')
    if event.get('op') == 'backstop':
        return backstop(event, ssm or boto3.client('ssm'), executions or boto3.client('stepfunctions'), cloudformation, leases or boto3.client('s3'))
    if event.get('op') == 'state':
        stored = event.get('stored') or (ssm or boto3.client('ssm')).get_parameter(Name=PARK_STATE)['Parameter']['Value']
        return production_state(cloudformation, stored, EFFECTIVE_MODES)
    action = event.get('mode') or {'park': 'parked', 'unpark': 'live'}.get(event.get('action'))
    if action not in STEPS or event.get('op') not in ('start', 'advance'):
        raise ValueError(f'Unknown transition {event}')
    if event['op'] == 'start':
        return start(action, cloudformation, executions or boto3.client('stepfunctions'), ssm or boto3.client('ssm'))
    return advance(event, cloudformation, ssm, verify, capacity, refresh, spares, action, probe, executions, leases)


def advance(event: TransitionState, cloudformation, ssm, verify, capacity, refresh, spares, action: str, probe, executions=None, leases=None) -> TransitionState:
    index = event.get('index', 0)
    if index == 0 and 'startedAt' not in event:
        first_state_checks(cloudformation, leases, action)
    target = action
    step = STEPS[action][index]
    state: TransitionState = {**event, 'startedAt': event.get('startedAt', time.time())}
    if action == 'live' and time.time() - state['startedAt'] > 900:
        raise RuntimeError(f'Live wake exceeded 900 seconds at {step}; inspect the transition and return production to Parked')
    state, waiting = step_dependencies(state, action, step, cloudformation, probe)
    if waiting is not None:
        return {**state, 'waiting': waiting, 'done': False}
    if step in STACKS:
        token = f"{state['attemptId']}-{step}" if action == 'live' and 'attemptId' in state else None
        waiting = update_stack(cloudformation, STACKS[step], target, event.get('started', False), token=token)
        if waiting:
            return {**state, 'started': True, 'waiting': True, 'done': False}
    elif step not in ('prepare', 'probe-drain'):
        runtime = perform(step, target, cloudformation, ssm, verify, capacity, refresh, spares, state)
        if runtime is not None:
            state['runtime'] = runtime_snapshot(runtime)
    done = index == len(STEPS[action]) - 1
    result: TransitionState = {**state, 'index': index + 1, 'started': False, 'waiting': False, 'done': done}
    if done:
        result = finish_transition(action, result, cloudformation, executions)
    print(json.dumps({'action': action, 'step': step, 'seconds': round(time.time() - state['startedAt'], 1), 'done': done}))
    return result


def finish_transition(action, state: TransitionState, cloudformation, executions) -> TransitionState:
    import boto3
    if action != 'live':
        return state
    outputs = stack_outputs(cloudformation)
    request = {'op': 'monitor', 'wakeStartedAt': state['startedAt'],
               'outputs': {STACKS['origin']: outputs[STACKS['origin']]}}
    result = (executions or boto3.client('stepfunctions')).start_execution(
        stateMachineArn=os.environ['MONITORING_STATE_MACHINE'],
        name='wake-' + str(state['startedAt']).replace('.', '-'), input=json.dumps(request))
    return {**state, 'monitoringExecutionArn': result['executionArn']}


def establish_monitoring(event):
    path = Path(os.environ['RUNNER_TEMP']) / 'monitoring-outputs.json'
    path.write_text(json.dumps(event['outputs']))
    invoke_script('verify-alarms', [str(path)])
    return {'wakeStartedAt': event['wakeStartedAt'], 'monitoringEstablished': True}


def step_dependencies(state: TransitionState, action, step, cloudformation, probe) -> tuple[TransitionState, bool | None]:
    if action == 'live' and OWNED_EGRESS:
        return live_dependencies(state, step, cloudformation, probe)
    if step == 'probe-drain':
        from egress_probe import EgressProbe
        probe = probe or EgressProbe()
        state.setdefault('probeDrainStartedAt', time.time())
        if probe.pending(stack_outputs(cloudformation)[STACKS['origin']]):
            if time.time() - state['probeDrainStartedAt'] > 60:
                raise RuntimeError('Owned egress probe drain exceeded 60 seconds; inspect stopped tasks before retrying Parked')
            return state, True
    return state, None


def live_dependencies(state: TransitionState, step, cloudformation, probe) -> tuple[TransitionState, bool | None]:
    if step == 'prepare':
        return prepare_live(state, cloudformation, probe)
    if 'probe' in state and 'observedIp' not in state['probe']:
        from egress_probe import EgressProbe
        probe = probe or EgressProbe()
        observed = probe.observe(state['probe'])
        if observed is not None:
            state['probe'] = observed
    if step == 'origin':
        origin = cloudformation.describe_stacks(StackName=STACKS['origin'])['Stacks'][0]
        if preparation_requested(origin) and update_stack(cloudformation, STACKS['origin'], mode_parameter(origin)[1], True, prepare=True):
            return state, True
    if step == 'verify' and 'observedIp' not in state.get('probe', {}):
        return state, True
    return state, None


def stack_outputs(cloudformation):
    return {name: {item['OutputKey']: item['OutputValue'] for item in
                   cloudformation.describe_stacks(StackName=name)['Stacks'][0].get('Outputs', [])}
            for name in STACKS.values()}


def prepare_live(state: TransitionState, cloudformation, probe) -> tuple[TransitionState, bool | None]:
    origin = cloudformation.describe_stacks(StackName=STACKS['origin'])['Stacks'][0]
    retained = any(item['OutputKey'] == 'RetainOrigin' and item['OutputValue'] == 'true' for item in origin.get('Outputs', []))
    if 'attemptId' not in state:
        if not retained and not any(item['ParameterKey'] == 'prepareOrigin' for item in origin['Parameters']):
            raise RuntimeError('Deploy the origin preparation parameter before requesting Live')
        return {**state, 'attemptId': uuid.uuid4().hex}, False
    token = state['attemptId']
    waiting = update_stack(cloudformation, STACKS['egress'], 'live', state.get('started', False), token=token + '-egress')
    mode = mode_parameter(origin)[1]
    if mode != 'live' and not retained:
        update_stack(cloudformation, STACKS['origin'], mode, state.get('started', False), prepare=True, token=token + '-prepare')
    if not waiting and 'probe' not in state:
        from egress_probe import EgressProbe
        probe = probe or EgressProbe()
        state['probe'] = probe.start(token, stack_outputs(cloudformation), state['startedAt'])
    return {**state, 'started': waiting}, True if waiting else None


def runtime_snapshot(runtime) -> RuntimeSnapshot:
    return {'agentRuntimeId': runtime['agentRuntimeId'], 'agentRuntimeVersion': runtime['agentRuntimeVersion'],
            'lastUpdatedAt': runtime['lastUpdatedAt'].timestamp(), 'platformVersion': runtime.get('platformVersion', 'V1')}


def start(action, cloudformation, executions, ssm):
    arn = os.environ['TRANSITION_STATE_MACHINE']
    if executions.list_executions(stateMachineArn=arn, statusFilter='RUNNING', maxResults=1)['executions']:
        raise RuntimeError('A production transition is already running')
    preflight(cloudformation, action)
    if action in ('live', 'parked'):
        ssm.put_parameter(Name=PARK_STATE + '/backstop', Value='none', Type='String', Overwrite=True)
    result = executions.start_execution(stateMachineArn=arn, input=json.dumps({'mode': action, 'op': 'advance'}))
    if action in ('egress', 'credential'):
        lease = str(time.time_ns())
        ssm.put_parameter(Name=PARK_STATE + '/backstop', Value=lease, Type='String', Overwrite=True)
        executions.start_execution(stateMachineArn=os.environ['BACKSTOP_STATE_MACHINE'],
                                   input=json.dumps({'op': 'backstop', 'lease': lease}))
    return {'executionArn': result['executionArn']}


def backstop(event, ssm, executions, cloudformation, leases):
    lease = ssm.get_parameter(Name=PARK_STATE + '/backstop')['Parameter']['Value']
    if lease != event['lease']:
        return {'expired': False}
    arn = os.environ['TRANSITION_STATE_MACHINE']
    running = executions.list_executions(stateMachineArn=arn, statusFilter='RUNNING', maxResults=1)['executions']
    if running:
        raise TransientServiceError('Production transition still running at backstop deadline')
    # Its retries (1 min x 120) outlast a lease: a deploy delays this park, not cancels it.
    require_no_deploy(cloudformation, leases, time.time(), refusal=TransientServiceError)
    result = executions.start_execution(stateMachineArn=arn, input=json.dumps({'mode': 'parked', 'op': 'advance'}))
    return {'executionArn': result['executionArn']}


def first_state_checks(cloudformation, leases, action):
    if action != 'live':
        import boto3
        require_no_deploy(cloudformation, leases or boto3.client('s3'), time.time())
    preflight(cloudformation, action)


def preflight(cloudformation, target):
    for name in STACKS.values():
        stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
        status = stack['StackStatus']
        if status.endswith('_IN_PROGRESS'):
            raise RuntimeError(f'{name} is updating: {status}')
        if status not in SETTLED:
            raise RuntimeError(f'{name} is not settled: {status}')
        key, _ = mode_parameter(stack)
        if key == 'parked' and target in ('egress', 'credential'):
            raise RuntimeError(f'{name} needs the productionMode template before a partial mode')


def desired_stack_parameters(stack, name, target, prepare):
    key, mode = mode_parameter(stack)
    value = ('true' if target == 'parked' else 'false') if key == 'parked' else target
    desired = {key: value}
    current = {item['ParameterKey']: item['ParameterValue'] for item in stack['Parameters']}
    if name == STACKS['origin'] and 'prepareOrigin' in current:
        desired['prepareOrigin'] = str(prepare).lower()
    elif prepare:
        raise RuntimeError('Deploy the origin preparation parameter before requesting Live')
    matches = EFFECTIVE_MODES[name][mode] == EFFECTIVE_MODES[name][target] and all(
        current[key] == value for key, value in desired.items() if key == 'prepareOrigin')
    parameters = [{'ParameterKey': item['ParameterKey'], **(
        {'ParameterValue': desired[item['ParameterKey']]}
        if item['ParameterKey'] in desired else {'UsePreviousValue': True})} for item in stack['Parameters']]
    return parameters, matches


def update_stack(cloudformation, name, target, started, *, prepare=False, token=None):
    stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
    status = stack['StackStatus']
    parameters, matches = desired_stack_parameters(stack, name, target, prepare)
    if status.endswith('_IN_PROGRESS') and (started or (token and matches)):
        return True
    if status not in SETTLED or (started and status != 'UPDATE_COMPLETE'):
        raise RuntimeError(f'{name} transition failed: {status}')
    if matches:
        return False
    if started:
        raise RuntimeError(f'{name} completed without the requested productionMode parameter')
    cloudformation.update_stack(
        StackName=name, UsePreviousTemplate=True,
        Parameters=parameters,
        Capabilities=['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
        **({'ClientRequestToken': token} if token else {}))
    return True


def perform(step, target, cloudformation, ssm, verify, capacity, refresh, spares, state: TransitionState):
    import boto3
    if step == 'store':
        (ssm or boto3.client('ssm')).put_parameter(
            Name=PARK_STATE, Value=target, Type='String', Overwrite=True)
        if target in ('live', 'parked'):
            (ssm or boto3.client('ssm')).put_parameter(
                Name=PARK_STATE + '/backstop', Value='none', Type='String', Overwrite=True)
    elif step in ('verify', 'origin-proof', 'alarm-configuration'):
        (verify or verify_production)(target, **({} if verify else {'cloudformation': cloudformation, 'step': step, 'state': state}))
    elif step == 'capacity':
        if capacity:
            capacity(target)
        else:
            import transition
            transition.session_api_capacity(target, timeout=300)
    elif step == 'refresh':
        if refresh:
            return refresh()
        import transition
        return transition.refresh_runtime_spares()
    elif step == 'spares':
        if spares:
            spares()
        else:
            import transition
            runtime = state['runtime']
            budget = max(0, min(300, state['startedAt'] + SPARE_DEADLINE_SECONDS - runtime['lastUpdatedAt']))
            transition.await_spare_handoff({**runtime, 'lastUpdatedAt': datetime.fromtimestamp(runtime['lastUpdatedAt'], UTC)}, timeout=budget)
    return None


def verify_production(target, cloudformation, step, state: TransitionState):
    import boto3
    secret = boto3.client('secretsmanager').get_secret_value(SecretId=NAMES['originTokenSecretName'])
    os.environ['CLOUDFLARE_ORIGIN_API_TOKEN'] = secret['SecretString']
    outputs = stack_outputs(cloudformation)
    output_path = Path(os.environ['RUNNER_TEMP']) / 'parking-outputs.json'
    output_path.write_text(json.dumps(outputs))
    if step == 'verify':
        arguments = [target, str(output_path)]
        if target == 'live' and OWNED_EGRESS:
            proof_path = Path(os.environ['RUNNER_TEMP']) / 'wake-egress-proof.json'
            proof_path.write_text(json.dumps({'attemptId': state['attemptId'], 'startedAt': state['startedAt'], 'probe': state['probe']}))
            arguments += ['--egress-proof', str(proof_path)]
        invoke_script('verify-park', arguments)
    elif step == 'origin-proof':
        invoke_script('verify-origin', ['production', str(output_path)])
        invoke_script('verify-origin', ['verify', str(output_path)])
    elif step == 'alarm-configuration':
        invoke_script('verify-alarms', [str(output_path), '--configuration-only'])


def invoke_script(name, arguments):
    previous = sys.argv
    try:
        sys.argv = [name, *arguments]
        runpy.run_path(str(Path(__file__).parent / f'{name}.py'), run_name='__main__')
    finally:
        sys.argv = previous


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=STEPS)
    args = parser.parse_args()
    import boto3
    import transition
    from botocore.waiter import WaiterModel, create_waiter_with_client
    result = transition.transition(args.mode)
    model = WaiterModel({'version': 2, 'waiters': {'Transition': {
        'operation': 'DescribeExecution', 'delay': 60, 'maxAttempts': 125,
        'acceptors': [
            {'state': 'success', 'matcher': 'path', 'argument': 'status', 'expected': 'SUCCEEDED'},
            *[{'state': 'failure', 'matcher': 'path', 'argument': 'status', 'expected': status}
              for status in ('FAILED', 'ABORTED', 'TIMED_OUT')],
        ],
    }}})
    create_waiter_with_client('Transition', model, boto3.client('stepfunctions')).wait(executionArn=result['executionArn'])



if __name__ == '__main__':
    main()
