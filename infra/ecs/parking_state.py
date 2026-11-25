"""Read durable production transition and stack state."""
import os

from transition import MODES, stack_mode_mismatch


def wake_state(executions, ssm, park_state):
    latest = executions.list_executions(stateMachineArn=os.environ['TRANSITION_STATE_MACHINE'], maxResults=1)['executions']
    if latest:
        execution = latest[0]
        if execution['status'] in ('RUNNING', 'PENDING_REDRIVE'):
            return {'state': 'waking', 'since': execution['startDate'].isoformat()}
        if execution['status'] != 'SUCCEEDED':
            return {'state': 'failed', 'stoppedAt': round(execution['stopDate'].timestamp() * 1000)}
    stored = ssm.get_parameter(Name=park_state)['Parameter']['Value']
    if stored not in MODES:
        raise ValueError(f'Invalid park state {stored}')
    return {'state': 'live' if stored == 'live' else 'parked'}


def production_state(cloudformation, stored, stack_modes):
    return {'state': 'transition incomplete' if stack_mode_mismatch(cloudformation, stored, stack_modes) else stored}
