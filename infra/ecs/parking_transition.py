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
STEPS = {'park': ('health', 'origin', 'capacity', 'egress', 'verify', 'store'),
         'unpark': ('egress', 'capacity', 'refresh', 'origin', 'health', 'verify', 'origin-proof', 'alarm-proof', 'spares', 'store')}
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
    if event.get('op') == 'state':
        stored = event.get('stored') or (ssm or boto3.client('ssm')).get_parameter(Name=IDENTITY['ssm']['parkState'])['Parameter']['Value']
        return production_state(cloudformation, stored)
    action = event['action']
    if action not in STEPS or event.get('op') not in ('start', 'advance'):
        raise ValueError(f'Unknown transition {event}')
    if event['op'] == 'start':
        return start(action, cloudformation, executions or boto3.client('stepfunctions'))
    return advance(event, cloudformation, ssm, verify, capacity, refresh, spares)


def production_state(cloudformation, stored):
    if stored not in ('live', 'parked'):
        raise ValueError(f'Invalid park state {stored}')
    target = 'true' if stored == 'parked' else 'false'
    for name in STACKS.values():
        stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
        value = next((p['ParameterValue'] for p in stack['Parameters'] if p['ParameterKey'] == 'parked'), None)
        if value != target or stack['StackStatus'] not in SETTLED:
            return {'state': 'transition incomplete'}
    return {'state': stored}


def advance(event, cloudformation, ssm, verify, capacity, refresh, spares):
    action = event['action']
    index = event.get('index', 0)
    if index == 0 and not event.get('started'):
        preflight(cloudformation)
    target = 'parked' if action == 'park' else 'live'
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


def start(action, cloudformation, executions):
    arn = os.environ['TRANSITION_STATE_MACHINE']
    if executions.list_executions(stateMachineArn=arn, statusFilter='RUNNING', maxResults=1)['executions']:
        raise RuntimeError('A production transition is already running')
    preflight(cloudformation)
    result = executions.start_execution(stateMachineArn=arn, input=json.dumps({'action': action, 'op': 'advance'}))
    return {'executionArn': result['executionArn']}


def preflight(cloudformation):
    for name in STACKS.values():
        stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
        status = stack['StackStatus']
        if status.endswith('_IN_PROGRESS'):
            raise RuntimeError(f'{name} is updating: {status}')
        if status not in SETTLED:
            raise RuntimeError(f'{name} is not settled: {status}')
        if not any(parameter['ParameterKey'] == 'parked' for parameter in stack['Parameters']):
            raise RuntimeError(f'{name} needs the parameter-flip template deployed from main first')


def update_stack(cloudformation, name, target, started):
    stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
    status = stack['StackStatus']
    if started and status.endswith('_IN_PROGRESS'):
        return True
    if status not in SETTLED or (started and status != 'UPDATE_COMPLETE'):
        raise RuntimeError(f'{name} transition failed: {status}')
    parameters = stack['Parameters']
    parked = next(parameter['ParameterValue'] for parameter in parameters if parameter['ParameterKey'] == 'parked')
    if parked == ('true' if target == 'parked' else 'false'):
        return False
    if started:
        raise RuntimeError(f'{name} completed without the requested parked parameter')
    cloudformation.update_stack(
        StackName=name, UsePreviousTemplate=True,
        Parameters=[{'ParameterKey': item['ParameterKey'], **(
            {'ParameterValue': 'true' if target == 'parked' else 'false'}
            if item['ParameterKey'] == 'parked' else {'UsePreviousValue': True})} for item in parameters],
        Capabilities=['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'])
    return True


def perform(step, target, cloudformation, ssm, verify, capacity, refresh, spares, runtime):
    import boto3
    if step == 'store':
        (ssm or boto3.client('ssm')).put_parameter(
            Name=IDENTITY['ssm']['parkState'], Value=target, Type='String', Overwrite=True)
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
    parser.add_argument('action', choices=STEPS)
    args = parser.parse_args()
    state = {'action': args.action, 'op': 'advance'}
    deadline = time.monotonic() + 7200
    while time.monotonic() < deadline:
        state = handler(state, None)
        if state['done']:
            return
        if state['waiting']:
            time.sleep(15)
    raise TimeoutError('Production transition exceeded two hours')


if __name__ == '__main__':
    main()
