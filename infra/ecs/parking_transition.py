"""Lambda operations for the durable production parking transition."""
import json
import os
import runpy
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError

from botocore.exceptions import ClientError
from deploy_identity import load_identity

IDENTITY = load_identity()
STACKS = {'egress': IDENTITY['aws']['ecs']['privateEgress']['stackName'],
          'origin': IDENTITY['aws']['ecs']['previewOriginStackName'],
          'health': IDENTITY['aws']['ecs']['apiHealth']['stackName']}
STEPS = {
    'parked': ('health', 'origin', 'capacity', 'egress', 'verify', 'store'),
    'egress': ('health', 'egress', 'origin', 'capacity', 'verify', 'store'),
    'credential': ('health', 'egress', 'origin', 'capacity', 'verify', 'store'),
    'live': ('egress', 'capacity', 'refresh', 'origin', 'health', 'verify', 'origin-proof', 'alarm-proof', 'spares', 'store'),
}
SETTLED = {'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE'}


class TransientServiceError(RuntimeError):
    pass


def handler(event, context, **ports):
    try:
        return operate(event, context, **ports)
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


def operate(event, context, *, cloudformation=None, ssm=None, verify=None, capacity=None, refresh=None, spares=None, executions=None):
    import boto3
    cloudformation = cloudformation or boto3.client('cloudformation')
    if event.get('op') == 'backstop':
        return backstop(event, ssm or boto3.client('ssm'), executions or boto3.client('stepfunctions'))
    if event.get('op') == 'state':
        stored = event.get('stored') or (ssm or boto3.client('ssm')).get_parameter(Name=IDENTITY['ssm']['parkState'])['Parameter']['Value']
        return production_state(cloudformation, stored)
    action = event.get('mode') or {'park': 'parked', 'unpark': 'live'}.get(event.get('action'))
    if action not in STEPS or event.get('op') not in ('start', 'advance'):
        raise ValueError(f'Unknown transition {event}')
    if event['op'] == 'start':
        return start(action, cloudformation, executions or boto3.client('stepfunctions'), ssm or boto3.client('ssm'))
    return advance(event, cloudformation, ssm, verify, capacity, refresh, spares, action)


def production_state(cloudformation, stored):
    if stored not in STEPS:
        raise ValueError(f'Invalid park state {stored}')
    target = stored
    for name in STACKS.values():
        stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
        _, value = mode_parameter(stack)
        if value != target or stack['StackStatus'] not in SETTLED:
            return {'state': 'transition incomplete'}
    return {'state': stored}


def mode_parameter(stack):
    parameters = {item['ParameterKey']: item['ParameterValue'] for item in stack['Parameters']}
    if 'productionMode' in parameters:
        return 'productionMode', parameters['productionMode']
    if parameters.get('parked') in ('true', 'false'):
        return 'parked', 'parked' if parameters['parked'] == 'true' else 'live'
    raise RuntimeError('Stack has neither productionMode nor a valid legacy parked parameter')


def advance(event, cloudformation, ssm, verify, capacity, refresh, spares, action: str):
    index = event.get('index', 0)
    if index == 0 and not event.get('started'):
        preflight(cloudformation, action)
    target = action
    step = STEPS[action][index]
    state = {**event, 'startedAt': event.get('startedAt', time.time())}
    if step in STACKS:
        waiting = update_stack(cloudformation, STACKS[step], target, event.get('started', False))
        if waiting:
            return {**state, 'started': True, 'waiting': True, 'done': False}
    else:
        runtime = perform(step, target, cloudformation, ssm, verify, capacity, refresh, spares, event.get('runtime'))
        if runtime is not None:
            state['runtime'] = runtime_snapshot(runtime)
    done = index == len(STEPS[action]) - 1
    result = {**state, 'index': index + 1, 'started': False, 'waiting': False, 'done': done}
    print(json.dumps({'action': action, 'step': step, 'seconds': round(time.time() - state['startedAt'], 1), 'done': done}))
    return result


def runtime_snapshot(runtime):
    return {'agentRuntimeId': runtime['agentRuntimeId'], 'agentRuntimeVersion': runtime['agentRuntimeVersion'],
            'lastUpdatedAt': runtime['lastUpdatedAt'].timestamp()}


def start(action, cloudformation, executions, ssm):
    arn = os.environ['TRANSITION_STATE_MACHINE']
    if executions.list_executions(stateMachineArn=arn, statusFilter='RUNNING', maxResults=1)['executions']:
        raise RuntimeError('A production transition is already running')
    preflight(cloudformation, action)
    if action in ('live', 'parked'):
        ssm.put_parameter(Name=IDENTITY['ssm']['parkState'] + '/backstop', Value='none', Type='String', Overwrite=True)
    result = executions.start_execution(stateMachineArn=arn, input=json.dumps({'mode': action, 'op': 'advance'}))
    if action in ('egress', 'credential'):
        lease = str(time.time_ns())
        ssm.put_parameter(Name=IDENTITY['ssm']['parkState'] + '/backstop', Value=lease, Type='String', Overwrite=True)
        executions.start_execution(stateMachineArn=os.environ['BACKSTOP_STATE_MACHINE'],
                                   input=json.dumps({'op': 'backstop', 'lease': lease}))
    return {'executionArn': result['executionArn']}


def backstop(event, ssm, executions):
    lease = ssm.get_parameter(Name=IDENTITY['ssm']['parkState'] + '/backstop')['Parameter']['Value']
    if lease != event['lease']:
        return {'expired': False}
    arn = os.environ['TRANSITION_STATE_MACHINE']
    running = executions.list_executions(stateMachineArn=arn, statusFilter='RUNNING', maxResults=1)['executions']
    if running:
        raise TransientServiceError('Production transition still running at backstop deadline')
    result = executions.start_execution(stateMachineArn=arn, input=json.dumps({'mode': 'parked', 'op': 'advance'}))
    return {'executionArn': result['executionArn']}


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


def update_stack(cloudformation, name, target, started):
    stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
    status = stack['StackStatus']
    if started and status.endswith('_IN_PROGRESS'):
        return True
    if status not in SETTLED or (started and status != 'UPDATE_COMPLETE'):
        raise RuntimeError(f'{name} transition failed: {status}')
    parameters = stack['Parameters']
    key, mode = mode_parameter(stack)
    value = ('true' if target == 'parked' else 'false') if key == 'parked' else target
    if mode == target:
        return False
    if started:
        raise RuntimeError(f'{name} completed without the requested productionMode parameter')
    cloudformation.update_stack(
        StackName=name, UsePreviousTemplate=True,
        Parameters=[{'ParameterKey': item['ParameterKey'], **(
            {'ParameterValue': value}
            if item['ParameterKey'] == key else {'UsePreviousValue': True})} for item in parameters],
        Capabilities=['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'])
    return True


def perform(step, target, cloudformation, ssm, verify, capacity, refresh, spares, runtime):
    import boto3
    if step == 'store':
        (ssm or boto3.client('ssm')).put_parameter(
            Name=IDENTITY['ssm']['parkState'], Value=target, Type='String', Overwrite=True)
        if target in ('live', 'parked'):
            (ssm or boto3.client('ssm')).put_parameter(
                Name=IDENTITY['ssm']['parkState'] + '/backstop', Value='none', Type='String', Overwrite=True)
    elif step in ('verify', 'origin-proof', 'alarm-proof'):
        (verify or verify_production)(target, **({} if verify else {'cloudformation': cloudformation, 'step': step}))
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
            transition.await_spare_handoff({**runtime, 'lastUpdatedAt': datetime.fromtimestamp(runtime['lastUpdatedAt'], UTC)})
    return None


def verify_production(target, cloudformation, step):
    import boto3
    os.environ.setdefault('RUNNER_TEMP', '/tmp')
    secret = boto3.client('secretsmanager').get_secret_value(SecretId=IDENTITY['aws']['ecs']['originTokenSecretName'])
    os.environ['CLOUDFLARE_ORIGIN_API_TOKEN'] = secret['SecretString']
    outputs = {name: {item['OutputKey']: item['OutputValue'] for item in
                     cloudformation.describe_stacks(StackName=name)['Stacks'][0].get('Outputs', [])}
               for name in STACKS.values()}
    output_path = Path(os.environ['RUNNER_TEMP']) / 'parking-outputs.json'
    output_path.write_text(json.dumps(outputs))
    if step == 'verify':
        invoke_script('verify-park', [target, str(output_path)])
    elif step == 'origin-proof':
        invoke_script('verify-origin', ['production', str(output_path)])
        invoke_script('verify-origin', ['verify', str(output_path)])
    elif step == 'alarm-proof':
        invoke_script('verify-alarms', [str(output_path)])


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
