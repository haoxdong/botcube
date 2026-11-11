"""The production parking Lambda changes deployed parameters without a checkout."""
import importlib.util
import json
from datetime import UTC, datetime
from email.message import Message

import pytest

from deploy_script_support import DEPLOY_ECS


def test_unpark_starts_egress_with_previous_template_and_preserves_other_parameters():
    spec = importlib.util.spec_from_file_location('parking_transition', DEPLOY_ECS / 'parking_transition.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cloudformation = CloudFormation()
    result = module.handler({'action': 'unpark', 'op': 'advance'}, None,
                            cloudformation=cloudformation)
    assert result['waiting'] is True
    assert cloudformation.updates == [{
        'StackName': 'bot-cube-private-egress', 'UsePreviousTemplate': True,
        'Parameters': [{'ParameterKey': 'parked', 'ParameterValue': 'false'},
                       {'ParameterKey': 'image', 'UsePreviousValue': True}],
        'Capabilities': ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
    }]


class CloudFormation:
    def __init__(self):
        self.updates = []

    def describe_stacks(self, *, StackName):
        return {'Stacks': [{'StackStatus': 'UPDATE_COMPLETE', 'Parameters': [
            {'ParameterKey': 'parked', 'ParameterValue': 'true'},
            {'ParameterKey': 'image', 'ParameterValue': 'unchanged'},
        ]}]}

    def update_stack(self, **request):
        self.updates.append(request)
        return {'StackId': request['StackName']}


def load():
    spec = importlib.util.spec_from_file_location('parking_transition', DEPLOY_ECS / 'parking_transition.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_refuses_before_any_effect_if_any_stack_is_updating():
    cloudformation = CloudFormation()
    original = cloudformation.describe_stacks
    cloudformation.describe_stacks = lambda **kw: ({'Stacks': [{'StackStatus': 'UPDATE_IN_PROGRESS'}]}
        if kw['StackName'] == 'bot-cube-preview-origin' else original(**kw))
    with pytest.raises(RuntimeError, match='updating'):
        load().handler({'action': 'unpark', 'op': 'advance'}, None, cloudformation=cloudformation)
    assert cloudformation.updates == []


class Production(CloudFormation):
    def __init__(self, parked):
        super().__init__()
        self.stacks = {name: {'StackStatus': 'UPDATE_COMPLETE', 'Parameters': [
            {'ParameterKey': 'parked', 'ParameterValue': 'true' if parked else 'false'}]}
            for name in ('bot-cube-private-egress', 'bot-cube-preview-origin', 'bot-cube-api-health')}
        self.effects = []
        self.stored = 'parked' if parked else 'live'

    def describe_stacks(self, *, StackName):
        return {'Stacks': [self.stacks[StackName]]}

    def update_stack(self, **request):
        super().update_stack(**request)
        self.effects.append(request['StackName'])
        stack = self.stacks[request['StackName']]
        stack['StackStatus'] = 'UPDATE_IN_PROGRESS'
        stack['Parameters'] = request['Parameters']
        return {'StackId': request['StackName']}

    def get_parameter(self, **request):
        return {'Parameter': {'Value': self.stored}}

    def put_parameter(self, **request):
        self.stored = request['Value']
        self.effects.append('store ' + self.stored)

    def capacity(self, target):
        self.effects.append('capacity ' + target)

    def verify(self, target):
        self.effects.append('verify ' + target)

    def refresh(self):
        self.effects.append('refresh')
        return {'agentRuntimeId': 'runtime-1', 'agentRuntimeVersion': '2',
                'lastUpdatedAt': datetime(2026, 11, 11, tzinfo=UTC)}

    def spares(self):
        self.effects.append('spares')

    def advance(self, module, state):
        return module.handler(state, None, cloudformation=self, ssm=self, verify=self.verify,
                              capacity=self.capacity, refresh=self.refresh, spares=self.spares)

    def complete(self, module, action):
        state = {'action': action, 'op': 'advance'}
        for _ in range(30):
            state = json.loads(json.dumps(self.advance(module, state)))
            for stack in self.stacks.values():
                stack['StackStatus'] = 'UPDATE_COMPLETE'
            if state.get('done'):
                return state
        raise AssertionError('transition never finished')


@pytest.mark.parametrize(('action', 'parked', 'effects'), [
    ('unpark', True, ['bot-cube-private-egress', 'capacity live', 'refresh',
                      'bot-cube-preview-origin', 'bot-cube-api-health', 'verify live', 'verify live', 'verify live', 'spares', 'store live']),
    ('park', False, ['bot-cube-api-health', 'bot-cube-preview-origin', 'capacity parked',
                    'bot-cube-private-egress', 'verify parked', 'store parked']),
])
def test_transition_orders_aws_effects_and_stores_only_verified_state(action, parked, effects):
    world = Production(parked)
    assert world.complete(load(), action)['done'] is True
    assert world.effects == effects


def test_poll_waits_for_its_stack_without_starting_another_update():
    world, module = Production(True), load()
    state = world.advance(module, {'action': 'unpark', 'op': 'advance'})
    assert world.advance(module, state)['waiting'] is True
    assert world.effects == ['bot-cube-private-egress']
    assert world.stored == 'parked'


def test_rollback_fails_without_starting_services_or_publishing_live():
    world, module = Production(True), load()
    state = world.advance(module, {'action': 'unpark', 'op': 'advance'})
    world.stacks['bot-cube-private-egress']['StackStatus'] = 'UPDATE_ROLLBACK_COMPLETE'
    with pytest.raises(RuntimeError, match='UPDATE_ROLLBACK_COMPLETE'):
        world.advance(module, state)
    assert world.effects == ['bot-cube-private-egress']
    assert world.stored == 'parked'


def test_failed_verification_keeps_previous_stored_state_and_can_be_retried():
    world, module = Production(True), load()

    def refused(target):
        raise RuntimeError('unhealthy origin')

    world.verify = refused
    with pytest.raises(RuntimeError, match='unhealthy origin'):
        world.complete(module, 'unpark')
    assert world.stored == 'parked'
    world.verify = lambda target: world.effects.append('verify ' + target)
    world.complete(module, 'unpark')
    assert world.stored == 'live'
    assert len(world.updates) == 3


class Executions:
    def __init__(self, running=False):
        self.running = running
        self.started = []

    def list_executions(self, **request):
        return {'executions': [{'executionArn': 'existing'}] if self.running else []}

    def start_execution(self, **request):
        self.started.append(request)
        return {'executionArn': 'new'}


def test_start_refuses_a_running_transition_before_any_effect(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    executions = Executions(running=True)
    with pytest.raises(RuntimeError, match='already running'):
        load().handler({'action': 'unpark', 'op': 'start'}, None,
                       cloudformation=Production(True), executions=executions)
    assert executions.started == []


def test_start_refuses_busy_cloudformation_synchronously_without_losing_the_wake(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    world, executions = Production(True), Executions()
    world.stacks['bot-cube-preview-origin']['StackStatus'] = 'UPDATE_IN_PROGRESS'
    with pytest.raises(RuntimeError, match='updating'):
        load().handler({'action': 'unpark', 'op': 'start'}, None,
                       cloudformation=world, executions=executions)
    assert executions.started == []
    assert world.effects == []


def test_start_accepts_a_settled_transition_for_durable_execution(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    world, executions = Production(True), Executions()
    result = load().handler({'action': 'unpark', 'op': 'start'}, None,
                            cloudformation=world, executions=executions)
    assert result == {'executionArn': 'new'}
    assert executions.started == [{'stateMachineArn': 'state-machine',
                                   'input': '{"action": "unpark", "op": "advance"}'}]
    assert world.effects == []


@pytest.mark.parametrize(('stored', 'parked', 'expected'), [
    ('parked', True, 'parked'), ('live', False, 'live'),
    ('parked', False, 'transition incomplete'), ('live', True, 'transition incomplete'),
])
def test_status_reports_stack_ssm_disagreement(stored, parked, expected):
    world = Production(parked)
    world.stored = stored
    assert load().handler({'op': 'state'}, None, cloudformation=world, ssm=world) == {'state': expected}


def test_transient_cloudformation_failure_is_retryable_without_committing_state():
    from botocore.exceptions import ClientError
    world = Production(True)
    def throttled(**request):
        raise ClientError({'Error': {'Code': 'Throttling', 'Message': 'slow down'}}, 'UpdateStack')
    world.update_stack = throttled
    with pytest.raises(Exception, match='slow down') as failure:
        world.advance(load(), {'action': 'unpark', 'op': 'advance'})
    assert type(failure.value).__name__ == 'TransientServiceError'
    assert world.stored == 'parked'


@pytest.mark.parametrize('status', [429, 503])
def test_cloudflare_service_failures_during_verification_reach_the_retry_policy(monkeypatch, status):
    import io
    import urllib.error
    import urllib.request
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'testing')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'testing')
    monkeypatch.setenv('ORIGIN_OWNERSHIP', 'test')
    monkeypatch.setenv('PARKED_WORKER_NAME', 'test')
    spec = importlib.util.spec_from_file_location('origin_provider', DEPLOY_ECS / 'origin-provider/handler.py')
    assert spec and spec.loader
    provider = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(provider)
    failure = urllib.error.HTTPError('https://api.cloudflare.com', status, 'unavailable', Message(),
                                     io.BytesIO(b'{"success":false,"errors":[]}'))
    def unavailable(*args, **kwargs):
        raise failure
    monkeypatch.setattr(urllib.request, 'urlopen', unavailable)
    world = Production(True)
    world.verify = lambda target: provider.Cloudflare('token').call('zones')
    with pytest.raises(Exception) as result:
        world.complete(load(), 'unpark')
    assert type(result.value).__name__ == 'TransientServiceError'
    assert world.stored == 'parked'
