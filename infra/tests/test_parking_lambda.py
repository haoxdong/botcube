"""The production parking Lambda changes deployed parameters without a checkout."""
import importlib.util
import json
import os
from datetime import UTC, datetime
from email.message import Message
from pathlib import Path

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
        'Parameters': [{'ParameterKey': 'productionMode', 'ParameterValue': 'live'},
                       {'ParameterKey': 'image', 'UsePreviousValue': True}],
        'Capabilities': ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
    }]


class CloudFormation:
    def __init__(self):
        self.updates = []

    def describe_stacks(self, *, StackName):
        return {'Stacks': [{'StackStatus': 'UPDATE_COMPLETE', 'Parameters': [
            {'ParameterKey': 'productionMode', 'ParameterValue': 'parked'},
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
            {'ParameterKey': 'productionMode', 'ParameterValue': 'parked' if parked else 'live'}]}
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
        if request['Name'].endswith('/backstop'):
            return
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
        state = {'mode': action, 'op': 'advance'} if action in module.STEPS else {'action': action, 'op': 'advance'}
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
    monkeypatch.setenv('BACKSTOP_STATE_MACHINE', 'backstop-machine')
    executions = Executions(running=True)
    with pytest.raises(RuntimeError, match='already running'):
        load().handler({'action': 'unpark', 'op': 'start'}, None,
                       cloudformation=Production(True), executions=executions, ssm=Production(True))
    assert executions.started == []


def test_start_refuses_busy_cloudformation_synchronously_without_losing_the_wake(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    monkeypatch.setenv('BACKSTOP_STATE_MACHINE', 'backstop-machine')
    world, executions = Production(True), Executions()
    world.stacks['bot-cube-preview-origin']['StackStatus'] = 'UPDATE_IN_PROGRESS'
    with pytest.raises(RuntimeError, match='updating'):
        load().handler({'action': 'unpark', 'op': 'start'}, None,
                       cloudformation=world, executions=executions, ssm=world)
    assert executions.started == []
    assert world.effects == []


def test_start_accepts_a_settled_transition_for_durable_execution(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    monkeypatch.setenv('BACKSTOP_STATE_MACHINE', 'backstop-machine')
    world, executions = Production(True), Executions()
    result = load().handler({'action': 'unpark', 'op': 'start'}, None,
                            cloudformation=world, executions=executions, ssm=world)
    assert result == {'executionArn': 'new'}
    assert executions.started == [ {'stateMachineArn': 'state-machine', 'input': '{"mode": "live", "op": "advance"}'}]
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


def test_four_mode_sequence_preserves_resources_and_never_refreshes_production_for_egress():
    world, module = Production(True), load()
    for mode in ('egress', 'credential', 'live', 'parked'):
        world.complete(module, mode)
        assert world.stored == mode
        assert module.production_state(world, mode) == {'state': mode}
    assert world.effects.count('refresh') == 1
    assert world.effects.count('spares') == 1


def test_backstop_returns_partial_mode_to_parked_and_ignores_a_superseded_lease(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    world, executions, module = Production(True), Executions(), load()
    world.stored = 'lease-1'
    assert module.backstop({'lease': 'lease-1'}, world, executions) == {'executionArn': 'new'}
    assert json.loads(executions.started[0]['input']) == {'mode': 'parked', 'op': 'advance'}
    world.stored = 'none'
    assert module.backstop({'lease': 'lease-1'}, world, executions) == {'expired': False}
    assert len(executions.started) == 1


def test_backstop_waits_for_an_inflight_transition_instead_of_overlapping_it(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    world, executions, module = Production(True), Executions(running=True), load()
    world.stored = 'lease-1'
    with pytest.raises(module.TransientServiceError):
        module.backstop({'lease': 'lease-1'}, world, executions)
    assert executions.started == []


def test_workflow_entrypoint_uses_deployed_dispatcher_and_native_waiter_without_lambda_environment(monkeypatch):
    import sys
    from types import SimpleNamespace

    import boto3
    import botocore.waiter
    import transition
    requests, waits = [], []
    monkeypatch.delenv('TRANSITION_STATE_MACHINE', raising=False)
    monkeypatch.delenv('BACKSTOP_STATE_MACHINE', raising=False)
    monkeypatch.setattr(sys, 'argv', ['parking_transition.py', 'egress'])
    monkeypatch.setattr(transition, 'transition', lambda mode: requests.append(mode) or {'executionArn': 'execution-1'})
    monkeypatch.setattr(boto3, 'client', lambda service: service)
    monkeypatch.setattr(botocore.waiter, 'create_waiter_with_client',
                        lambda *args: SimpleNamespace(wait=lambda **kw: waits.append(kw)))
    load().main()
    assert requests == ['egress']
    assert waits == [{'executionArn': 'execution-1'}]


@pytest.mark.parametrize('mixed', [False, True])
def test_legacy_live_stacks_remain_parkable_after_partial_template_deploy(mixed):
    world, module = Production(False), load()
    for index, stack in enumerate(world.stacks.values()):
        if not mixed or index != 0:
            stack['Parameters'] = [{'ParameterKey': 'parked', 'ParameterValue': 'false'}]
    assert module.production_state(world, 'live') == {'state': 'live'}
    world.complete(module, 'parked')
    assert world.stored == 'parked'
    assert module.production_state(world, 'parked') == {'state': 'parked'}
    assert all(module.mode_parameter(stack)[1] == 'parked' for stack in world.stacks.values())


@pytest.mark.parametrize('target', ['live', 'parked'])
def test_nonpartial_start_never_arms_a_backstop(monkeypatch, target):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    monkeypatch.setenv('BACKSTOP_STATE_MACHINE', 'backstop-machine')
    world, executions = Production(True), Executions()
    load().start(target, world, executions, world)
    assert [item['stateMachineArn'] for item in executions.started] == ['state-machine']


def test_rejected_transition_start_cannot_arm_a_live_production_backstop(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    monkeypatch.setenv('BACKSTOP_STATE_MACHINE', 'backstop-machine')
    world, executions = Production(False), Executions()
    def refused(**request):
        executions.started.append(request)
        if request['stateMachineArn'] == 'state-machine':
            raise RuntimeError('start refused')
        return {'executionArn': 'backstop'}
    executions.start_execution = refused
    with pytest.raises(RuntimeError, match='start refused'):
        load().start('egress', world, executions, world)
    assert [item['stateMachineArn'] for item in executions.started] == ['state-machine']


@pytest.mark.parametrize('target', ['egress', 'credential'])
def test_partial_backstop_is_started_only_after_accepted_transition(monkeypatch, target):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    monkeypatch.setenv('BACKSTOP_STATE_MACHINE', 'backstop-machine')
    world, executions = Production(True), Executions()
    load().start(target, world, executions, world)
    assert [item['stateMachineArn'] for item in executions.started] == ['state-machine', 'backstop-machine']


def test_partial_mode_refuses_legacy_templates_before_any_transition(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    world, executions = Production(False), Executions()
    world.stacks['bot-cube-api-health']['Parameters'] = [{'ParameterKey': 'parked', 'ParameterValue': 'false'}]
    with pytest.raises(RuntimeError, match='productionMode template'):
        load().start('egress', world, executions, world)
    assert executions.started == []
    assert world.effects == []


@pytest.mark.parametrize('target', ['live', 'parked'])
@pytest.mark.parametrize('rejected', [False, True])
def test_nonpartial_start_invalidates_existing_egress_lease_even_if_transition_fails(monkeypatch, target, rejected):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    monkeypatch.setenv('BACKSTOP_STATE_MACHINE', 'backstop-machine')
    world, executions, module = Production(True), Executions(), load()
    lease = {'value': 'none'}
    def put(**request):
        lease['value'] = request['Value']
    world.put_parameter = put
    world.get_parameter = lambda **request: {'Parameter': {'Value': lease['value']}}
    module.start('egress', world, executions, world)
    old_lease = lease['value']
    original = executions.start_execution
    def start(**request):
        if request['stateMachineArn'] == 'state-machine' and rejected:
            raise RuntimeError('execution rejected')
        return original(**request)
    executions.start_execution = start
    if rejected:
        with pytest.raises(RuntimeError, match='execution rejected'):
            module.start(target, world, executions, world)
    else:
        module.start(target, world, executions, world)
        # The accepted execution later fails, so no final store invalidates the lease.
    assert lease['value'] == 'none'
    before = list(executions.started)
    assert module.backstop({'lease': old_lease}, world, executions) == {'expired': False}
    assert executions.started == before


def test_parked_to_egress_verifies_equivalent_api_health_without_an_update():
    from botocore.exceptions import ClientError

    world, module = Production(True), load()
    update = world.update_stack

    def update_with_cloudformation_noop(**request):
        if request['StackName'] == 'bot-cube-api-health':
            raise ClientError({'Error': {'Code': 'ValidationError',
                                        'Message': 'No updates are to be performed.'}}, 'UpdateStack')
        return update(**request)

    world.update_stack = update_with_cloudformation_noop
    result = world.complete(module, 'egress')
    assert result['done'] is True
    assert world.stored == 'egress'
    assert world.stacks['bot-cube-api-health']['Parameters'] == [
        {'ParameterKey': 'productionMode', 'ParameterValue': 'parked'}]
    assert world.effects[-2:] == ['verify egress', 'store egress']
    assert module.production_state(world, 'egress') == {'state': 'egress'}
    world.stacks['bot-cube-api-health']['Parameters'] = [
        {'ParameterKey': 'productionMode', 'ParameterValue': 'live'}]
    assert module.production_state(world, 'egress') == {'state': 'transition incomplete'}


def test_equivalent_stack_parameters_do_not_skip_effective_resource_verification():
    world, module = Production(True), load()

    def unhealthy(target):
        raise RuntimeError('API health actions are enabled below Live')

    world.verify = unhealthy
    with pytest.raises(RuntimeError, match='API health actions'):
        world.complete(module, 'egress')
    assert world.stored == 'parked'


@pytest.mark.parametrize('message', ['No updates are to be performed.', 'Invalid template'])
def test_validation_errors_for_different_effective_configuration_still_fail(message):
    from botocore.exceptions import ClientError

    world, module = Production(True), load()

    def rejected(**request):
        raise ClientError({'Error': {'Code': 'ValidationError', 'Message': message}}, 'UpdateStack')

    world.update_stack = rejected
    with pytest.raises(ClientError, match=message):
        world.complete(module, 'live')
    assert world.stored == 'parked'


class OwnNetwork(Production):
    """A deployment in an existing network, which brings its own egress: it has no egress stack to describe or update."""

    def __init__(self, parked):
        super().__init__(parked)
        del self.stacks['bot-cube-private-egress']


def load_without_owned_egress(monkeypatch, tmp_path):
    identity = json.loads((Path(os.environ['CARTRIDGE_DEPLOY_ROOT']) / 'identity.json').read_text())
    del identity['aws']['ecs']['privateEgress']
    (tmp_path / 'identity.json').write_text(json.dumps(identity))
    monkeypatch.setenv('CARTRIDGE_DEPLOY_ROOT', str(tmp_path))
    return load()


@pytest.mark.parametrize(('action', 'parked', 'effects'), [
    ('unpark', True, ['capacity live', 'refresh', 'bot-cube-preview-origin', 'bot-cube-api-health',
                      'verify live', 'verify live', 'verify live', 'spares', 'store live']),
    ('park', False, ['bot-cube-api-health', 'bot-cube-preview-origin', 'capacity parked', 'verify parked', 'store parked']),
])
def test_a_deployment_without_owned_egress_parks_and_unparks_without_a_nat(monkeypatch, tmp_path, action, parked, effects):
    world, module = OwnNetwork(parked), load_without_owned_egress(monkeypatch, tmp_path)
    assert world.complete(module, action)['done'] is True
    assert world.effects == effects
    assert module.production_state(world, world.stored) == {'state': world.stored}


def test_partial_modes_without_owned_egress_change_only_the_origin_and_health(monkeypatch, tmp_path):
    world, module = OwnNetwork(True), load_without_owned_egress(monkeypatch, tmp_path)
    for mode in ('egress', 'credential', 'parked'):
        world.complete(module, mode)
        assert world.stored == mode
    assert 'bot-cube-private-egress' not in world.effects
