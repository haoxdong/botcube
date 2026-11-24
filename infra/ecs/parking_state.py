"""Read durable production transition and stack state."""
import os

from deploy_guard import SETTLED


def wake_state(executions, ssm, park_state, modes):
    latest = executions.list_executions(stateMachineArn=os.environ['TRANSITION_STATE_MACHINE'], maxResults=1)['executions']
    if latest:
        execution = latest[0]
        if execution['status'] in ('RUNNING', 'PENDING_REDRIVE'):
            return {'state': 'waking', 'since': execution['startDate'].isoformat()}
        if execution['status'] != 'SUCCEEDED':
            return {'state': 'failed', 'stoppedAt': round(execution['stopDate'].timestamp() * 1000)}
    stored = ssm.get_parameter(Name=park_state)['Parameter']['Value']
    if stored not in modes:
        raise ValueError(f'Invalid park state {stored}')
    return {'state': 'live' if stored == 'live' else 'parked'}


def production_state(cloudformation, stored, effective_modes):
    if stored not in next(iter(effective_modes.values())):
        raise ValueError(f'Invalid park state {stored}')
    for name, modes in effective_modes.items():
        stack = cloudformation.describe_stacks(StackName=name)['Stacks'][0]
        if preparation_requested(stack):
            return {'state': 'transition incomplete'}
        _, value = mode_parameter(stack)
        if modes[value] != modes[stored] or stack['StackStatus'] not in SETTLED:
            return {'state': 'transition incomplete'}
    return {'state': stored}


def preparation_requested(stack):
    return any(item['ParameterKey'] == 'prepareOrigin' and item['ParameterValue'] == 'true' for item in stack['Parameters'])


def mode_parameter(stack):
    parameters = {item['ParameterKey']: item['ParameterValue'] for item in stack['Parameters']}
    if 'productionMode' in parameters:
        return 'productionMode', parameters['productionMode']
    if parameters.get('parked') in ('true', 'false'):
        return 'parked', 'parked' if parameters['parked'] == 'true' else 'live'
    raise RuntimeError('Stack has neither productionMode nor a valid legacy parked parameter')
