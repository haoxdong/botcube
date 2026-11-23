"""The production parking Lambda changes deployed parameters without a checkout."""
import importlib.util
import json
import os
import sys
from datetime import UTC, datetime
from email.message import Message
from io import BytesIO
from pathlib import Path
from typing import TypedDict

import deploy_identity
import pytest
from botocore.exceptions import ClientError

from deploy_script_support import DEPLOY_ECS


def test_unpark_starts_egress_with_previous_template_and_preserves_other_parameters():
    spec = importlib.util.spec_from_file_location('parking_transition', DEPLOY_ECS / 'parking_transition.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cloudformation = CloudFormation()
    state = module.handler({'action': 'unpark', 'op': 'advance'}, None, cloudformation=cloudformation)
    assert not cloudformation.updates
    result = module.handler(state, None, cloudformation=cloudformation)
    assert result['waiting'] is True
    assert cloudformation.updates[0] == {
        'StackName': 'bot-cube-private-egress', 'UsePreviousTemplate': True,
        'Parameters': [{'ParameterKey': 'productionMode', 'ParameterValue': 'live'},
                       {'ParameterKey': 'image', 'UsePreviousValue': True}],
        'Capabilities': ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
        'ClientRequestToken': state['attemptId'] + '-egress',
    }
    assert len(cloudformation.updates) == 2


class CloudFormation:
    def __init__(self):
        self.updates = []

    def describe_stacks(self, *, StackName):
        parameters = [{'ParameterKey': 'productionMode', 'ParameterValue': 'parked'},
                      {'ParameterKey': 'image', 'ParameterValue': 'unchanged'}]
        if StackName == 'bot-cube-preview-origin':
            parameters.append({'ParameterKey': 'prepareOrigin', 'ParameterValue': 'false'})
        return {'Stacks': [{'StackStatus': 'UPDATE_COMPLETE', 'Parameters': parameters}]}

    def update_stack(self, **request):
        self.updates.append(request)
        return {'StackId': request['StackName']}


@pytest.fixture(autouse=True)
def monitoring_environment(monkeypatch):
    monkeypatch.setenv('MONITORING_STATE_MACHINE', 'monitoring-machine')


def load():
    spec = importlib.util.spec_from_file_location('parking_transition', DEPLOY_ECS / 'parking_transition.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_prepared_origin_is_not_reported_as_parked():
    cloudformation = CloudFormation()
    original = cloudformation.describe_stacks

    def describe(**request):
        response = original(**request)
        if request['StackName'] == 'bot-cube-preview-origin':
            response['Stacks'][0]['Parameters'][-1]['ParameterValue'] = 'true'
        return response

    cloudformation.describe_stacks = describe
    assert load().production_state(cloudformation, 'parked') == {'state': 'transition incomplete'}


def test_park_clears_origin_preparation_even_when_mode_is_already_parked():
    world = Production(True)
    world.stacks['bot-cube-preview-origin']['Parameters'][1]['ParameterValue'] = 'true'
    world.complete(load(), 'park')
    assert world.stacks['bot-cube-preview-origin']['Parameters'] == [
        {'ParameterKey': 'productionMode', 'ParameterValue': 'parked'},
        {'ParameterKey': 'prepareOrigin', 'ParameterValue': 'false'},
    ]


def test_refuses_before_any_effect_if_any_stack_is_updating():
    cloudformation = CloudFormation()
    original = cloudformation.describe_stacks
    cloudformation.describe_stacks = lambda **kw: ({'Stacks': [{'StackStatus': 'UPDATE_IN_PROGRESS'}]}
        if kw['StackName'] == 'bot-cube-preview-origin' else original(**kw))
    with pytest.raises(RuntimeError, match='updating'):
        load().handler({'action': 'unpark', 'op': 'advance'}, None, cloudformation=cloudformation)
    assert cloudformation.updates == []


class DeployedStack(TypedDict):
    StackStatus: str
    Parameters: list[dict[str, str]]


class Production(CloudFormation):
    def __init__(self, parked):
        super().__init__()
        self.stacks: dict[str, DeployedStack] = {name: {'StackStatus': 'UPDATE_COMPLETE', 'Parameters': [
            {'ParameterKey': 'productionMode', 'ParameterValue': 'parked' if parked else 'live'}]}
            for name in ('bot-cube-private-egress', 'bot-cube-preview-origin', 'bot-cube-api-health')}
        self.stacks['bot-cube-preview-origin']['Parameters'].append({'ParameterKey': 'prepareOrigin', 'ParameterValue': 'false'})
        self.effects = []
        self.stored = 'parked' if parked else 'live'
        self.probe = Probe(self)
        self.monitoring = []
        self.leases: dict[str, str] = {}

    def describe_stacks(self, *, StackName):
        if StackName not in self.stacks:
            raise ClientError({'Error': {'Code': 'ValidationError', 'Message': f'Stack with id {StackName} does not exist'}}, 'DescribeStacks')
        return {'Stacks': [self.stacks[StackName]]}

    def list_objects_v2(self, *, Bucket, Prefix):
        assert (Bucket, Prefix) == ('bot-cube-sessions', 'deploy-leases/')
        return {'Contents': [{'Key': key} for key in self.leases]} if self.leases else {}

    def get_object(self, *, Bucket, Key):
        return {'Body': BytesIO(self.leases[Key].encode())}

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
                              capacity=self.capacity, refresh=self.refresh, spares=self.spares, probe=self.probe, executions=self,
                              leases=self)

    def start_execution(self, **request):
        assert self.stored == 'live'
        self.monitoring.append(request)
        self.effects.append('monitor live')
        return {'executionArn': 'monitoring-execution'}

    def complete(self, module, action):
        state = {'mode': action, 'op': 'advance'} if action in module.STEPS else {'action': action, 'op': 'advance'}
        for _ in range(30):
            state = json.loads(json.dumps(self.advance(module, state)))
            for stack in self.stacks.values():
                stack['StackStatus'] = 'UPDATE_COMPLETE'
            if state.get('done'):
                return state
        raise AssertionError('transition never finished')


def lease(minutes_ago, now=10_000.0):
    at = datetime.fromtimestamp(now - minutes_ago * 60, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    return f'https://github.example/owner/repo/actions/runs/1/attempts/1 {at}'


def test_park_is_refused_by_a_fresh_deploy_lease_before_any_effect(monkeypatch):
    world, module = Production(False), load()
    monkeypatch.setattr(module.time, 'time', lambda: 10_000.0)
    world.leases['deploy-leases/harness'] = lease(5)
    with pytest.raises(sys.modules['deploy_guard'].DeployInFlight, match=r"harness slot's deploy lease s3://bot-cube-sessions/deploy-leases/harness is 5 min old"):
        world.advance(module, {'mode': 'parked', 'op': 'advance'})
    assert world.effects == []
    assert world.stored == 'live'


def test_park_proceeds_past_a_stale_deploy_lease(monkeypatch):
    world, module = Production(False), load()
    monkeypatch.setattr(module.time, 'time', lambda: 10_000.0)
    world.leases['deploy-leases/origin'] = lease(121)
    assert world.complete(module, 'park')['done'] is True
    assert world.stored == 'parked'


@pytest.mark.parametrize('stack', ['AgentCore-bot-cube-default', 'bot-cube-preview-origin', 'bot-cube-web-latency'])
def test_park_is_refused_by_a_deployed_stack_in_update_rollback_failed(stack):
    world, module = Production(False), load()
    world.stacks[stack] = {'StackStatus': 'UPDATE_ROLLBACK_FAILED', 'Parameters': []}
    with pytest.raises(sys.modules['deploy_guard'].DeployInFlight, match=f'{stack} is UPDATE_ROLLBACK_FAILED'):
        world.advance(module, {'mode': 'parked', 'op': 'advance'})
    assert world.effects == []


def test_park_accepts_update_rollback_complete_and_missing_deployed_stacks():
    world, module = Production(False), load()
    world.stacks['AgentCore-bot-cube-default'] = {'StackStatus': 'UPDATE_ROLLBACK_COMPLETE', 'Parameters': []}
    assert world.complete(module, 'park')['done'] is True


def test_wake_is_not_held_by_a_deploy_lease():
    world, module = Production(True), load()
    world.leases['deploy-leases/web'] = lease(0, datetime.now(UTC).timestamp())
    assert world.complete(module, 'unpark')['done'] is True


class Probe:
    def __init__(self, world):
        self.stacks, self.starts, self.ready, self.draining = world.stacks, [], True, False

    def start(self, attempt, outputs, started_at):
        assert self.stacks['bot-cube-private-egress']['StackStatus'] == 'UPDATE_COMPLETE'
        self.starts.append(attempt)
        return {'attemptId': attempt, 'startedAt': started_at, 'taskArn': 'probe-fixture'}

    def observe(self, probe):
        return {**probe, 'observedIp': '192.0.2.1', 'observedAt': probe['startedAt'] + 1} if self.ready else None

    def pending(self, outputs):
        return self.draining


def test_wake_starts_both_stacks_without_waiting_for_nat_completion():
    world, module = Production(True), load()
    state = module.handler({'mode': 'live', 'op': 'advance'}, None, cloudformation=world, ssm=world)
    module.handler(state, None, cloudformation=world, ssm=world)
    assert {request['StackName'] for request in world.updates} == {'bot-cube-private-egress', 'bot-cube-preview-origin'}
    assert world.stacks['bot-cube-preview-origin']['Parameters'] == [
        {'ParameterKey': 'productionMode', 'ParameterValue': 'parked'},
        {'ParameterKey': 'prepareOrigin', 'ParameterValue': 'true'},
    ]
    assert not world.probe.starts
    assert world.stored == 'parked'


@pytest.mark.parametrize(('action', 'parked', 'effects'), [
    ('unpark', True, ['bot-cube-private-egress', 'bot-cube-preview-origin', 'capacity live', 'refresh',
                      'bot-cube-preview-origin', 'bot-cube-api-health', 'verify live', 'verify live', 'verify live', 'spares', 'store live', 'monitor live']),
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
    assert world.effects == ['bot-cube-private-egress', 'bot-cube-preview-origin']
    assert world.stored == 'parked'


def test_stuck_live_wake_fails_before_waiting_indefinitely(monkeypatch):
    world, module = Production(True), load()
    monkeypatch.setattr(module.time, 'time', lambda: 2000)
    world.stacks['bot-cube-preview-origin']['StackStatus'] = 'UPDATE_IN_PROGRESS'
    state = {'mode': 'live', 'op': 'advance', 'index': 3, 'started': True, 'startedAt': 1099}
    with pytest.raises(RuntimeError, match='Live wake exceeded 900 seconds at origin'):
        world.advance(module, state)
    assert world.stored == 'parked'
    assert world.effects == []


@pytest.mark.parametrize(('mode', 'started_at'), [('live', 1100), ('parked', 1000)])
def test_wake_budget_allows_in_budget_work_and_long_park_drains(monkeypatch, mode, started_at):
    world, module = Production(True), load()
    monkeypatch.setattr(module.time, 'time', lambda: 2000)
    world.stacks['bot-cube-preview-origin']['StackStatus'] = 'UPDATE_IN_PROGRESS'
    index = 3 if mode == 'live' else 1
    state = {'mode': mode, 'op': 'advance', 'index': index, 'started': True, 'startedAt': started_at}
    assert world.advance(module, state)['waiting'] is True
    assert world.effects == []
    assert world.stored == 'parked'


def test_rollback_fails_without_starting_services_or_publishing_live():
    world, module = Production(True), load()
    state = world.advance(module, {'action': 'unpark', 'op': 'advance'})
    state = world.advance(module, state)
    world.stacks['bot-cube-private-egress']['StackStatus'] = 'UPDATE_ROLLBACK_COMPLETE'
    with pytest.raises(RuntimeError, match='UPDATE_ROLLBACK_COMPLETE'):
        world.advance(module, state)
    assert world.effects == ['bot-cube-private-egress', 'bot-cube-preview-origin']
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
    assert len(world.updates) == 4



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
    state = world.advance(load(), {'action': 'unpark', 'op': 'advance'})
    world.update_stack = throttled
    with pytest.raises(Exception, match='slow down') as failure:
        world.advance(load(), state)
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
    assert module.backstop({'lease': 'lease-1'}, world, executions, world, world) == {'executionArn': 'new'}
    assert json.loads(executions.started[0]['input']) == {'mode': 'parked', 'op': 'advance'}
    world.stored = 'none'
    assert module.backstop({'lease': 'lease-1'}, world, executions, world, world) == {'expired': False}
    assert len(executions.started) == 1


def test_backstop_waits_for_an_inflight_transition_instead_of_overlapping_it(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    world, executions, module = Production(True), Executions(running=True), load()
    world.stored = 'lease-1'
    with pytest.raises(module.TransientServiceError):
        module.backstop({'lease': 'lease-1'}, world, executions, world, world)
    assert executions.started == []


def test_backstop_waits_out_a_fresh_deploy_lease_then_parks(monkeypatch):
    monkeypatch.setenv('TRANSITION_STATE_MACHINE', 'state-machine')
    world, executions, module = Production(True), Executions(), load()
    world.stored = 'lease-1'
    world.leases['deploy-leases/harness'] = lease(0, module.time.time())
    with pytest.raises(module.TransientServiceError, match="harness slot's deploy lease"):
        module.backstop({'lease': 'lease-1'}, world, executions, world, world)
    assert executions.started == []
    del world.leases['deploy-leases/harness']
    assert module.backstop({'lease': 'lease-1'}, world, executions, world, world) == {'executionArn': 'new'}
    assert json.loads(executions.started[0]['input']) == {'mode': 'parked', 'op': 'advance'}


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
    assert module.backstop({'lease': old_lease}, world, executions, world, world) == {'expired': False}
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
    """The public example with network.natGateways 0, whose VPC brings its own egress."""
    public = Path(__file__).resolve().parents[2] / 'examples/public/botcube.yaml'
    (tmp_path / 'botcube.yaml').write_text(public.read_text().replace('network: { natGateways: 1, publicIp: 192.0.2.1 }', 'network: { natGateways: 0 }'))
    (tmp_path / 'deploy').mkdir()
    monkeypatch.setenv('BOTCUBE_DEPLOY_ROOT', str(tmp_path / 'deploy'))
    assert deploy_identity.owned_egress(deploy_identity.load_deployment()) is None
    return load()


@pytest.mark.parametrize(('action', 'parked', 'effects'), [
    ('unpark', True, ['capacity live', 'refresh', 'bot-cube-preview-origin', 'bot-cube-api-health',
                      'verify live', 'verify live', 'verify live', 'spares', 'store live', 'monitor live']),
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


def settle(world):
    for stack in world.stacks.values():
        stack['StackStatus'] = 'UPDATE_COMPLETE'


def test_nat_gates_activation_and_pending_probe_gates_live_publication():
    world, module = Production(True), load()
    world.probe.ready = False
    state = world.advance(module, {'mode': 'live', 'op': 'advance'})
    state = world.advance(module, state)
    state = world.advance(module, state)
    assert not world.probe.starts
    assert 'capacity live' not in world.effects
    world.stacks['bot-cube-private-egress']['StackStatus'] = 'UPDATE_COMPLETE'
    state = world.advance(module, state)
    assert len(world.probe.starts) == 1
    state = world.advance(module, state)
    state = world.advance(module, state)
    state = world.advance(module, state)
    assert state['waiting']
    assert world.stacks['bot-cube-preview-origin']['Parameters'][0]['ParameterValue'] == 'parked'
    world.stacks['bot-cube-preview-origin']['StackStatus'] = 'UPDATE_COMPLETE'
    state = world.advance(module, state)
    assert world.stacks['bot-cube-preview-origin']['Parameters'] == [
        {'ParameterKey': 'productionMode', 'ParameterValue': 'live'},
        {'ParameterKey': 'prepareOrigin', 'ParameterValue': 'false'},
    ]
    for _ in range(12):
        settle(world)
        state = world.advance(module, state)
    assert world.stored == 'parked'
    assert 'verify live' not in world.effects
    assert len(world.probe.starts) == 1
    world.probe.ready = True
    for _ in range(12):
        settle(world)
        state = world.advance(module, state)
        if state['done']:
            break
    assert state['done'] and world.stored == 'live'


def test_lost_nat_update_response_does_not_admit_a_second_update():
    from botocore.exceptions import ClientError
    world, module = Production(True), load()
    state = world.advance(module, {'mode': 'live', 'op': 'advance'})
    original = world.update_stack
    lost = True

    def update(**request):
        nonlocal lost
        result = original(**request)
        if lost:
            lost = False
            raise ClientError({'Error': {'Code': 'InternalError', 'Message': 'lost reply'}}, 'UpdateStack')
        return result

    world.update_stack = update
    with pytest.raises(module.TransientServiceError):
        world.advance(module, state)
    world.advance(module, state)
    assert [r['StackName'] for r in world.updates] == ['bot-cube-private-egress', 'bot-cube-preview-origin']
    assert world.stored == 'parked'


def test_park_drains_owned_probe_before_removing_nat():
    world, module = Production(False), load()
    world.probe.draining = True
    state = {'mode': 'parked', 'op': 'advance'}
    for _ in range(12):
        state = world.advance(module, state)
        settle(world)
    assert 'bot-cube-private-egress' not in world.effects
    assert world.stored == 'live'
    world.probe.draining = False
    for _ in range(12):
        state = world.advance(module, state)
        settle(world)
        if state['done']:
            break
    assert state['done'] and world.stored == 'parked'


def test_optional_spares_wait_uses_remaining_wake_budget(monkeypatch):
    import transition
    world, module = Production(True), load()
    monkeypatch.setattr(module.time, 'time', lambda: 2000)
    observed = []
    monkeypatch.setattr(transition, 'await_spare_handoff', lambda runtime, **kwargs: observed.append(kwargs['timeout']))
    state = {'mode': 'live', 'op': 'advance', 'index': 8, 'startedAt': 1800,
             'runtime': {'agentRuntimeId': 'runtime-fixture', 'agentRuntimeVersion': '2', 'lastUpdatedAt': 1900}}
    module.handler(state, None, cloudformation=world, ssm=world)
    assert observed == [185]


def test_park_probe_drain_fails_loud_after_60_seconds(monkeypatch):
    world, module = Production(False), load()
    world.probe.draining = True
    now = [2000]
    monkeypatch.setattr(module.time, 'time', lambda: now[0])
    state = {'mode': 'parked', 'op': 'advance', 'startedAt': 1000,
             'index': module.STEPS['parked'].index('probe-drain')}
    state = world.advance(module, state)
    assert state['waiting']
    now[0] += 61
    with pytest.raises(RuntimeError, match='probe drain exceeded 60 seconds'):
        world.advance(module, state)
    assert 'bot-cube-private-egress' not in world.effects


def test_live_finishes_before_monitoring_observation_and_binds_the_wake(monkeypatch, tmp_path):
    world, module = Production(True), load()
    result = world.complete(module, 'live')
    assert 'alarm-configuration' in module.STEPS['live']
    assert 'alarm-proof' not in module.STEPS['live']
    assert result['done'] and world.stored == 'live'
    assert result['monitoringExecutionArn'] == 'monitoring-execution'
    assert len(world.monitoring) == 1
    request = world.monitoring[0]
    assert request['stateMachineArn'] == 'monitoring-machine'
    payload = json.loads(request['input'])
    assert payload['op'] == 'monitor'
    assert payload['wakeStartedAt'] == result['startedAt']
    assert payload['outputs'] == {'bot-cube-preview-origin': {}}
    monkeypatch.setenv('RUNNER_TEMP', str(tmp_path))
    calls = []
    def pending(name, arguments):
        calls.append((name, json.loads(Path(arguments[0]).read_text())))
        raise RuntimeError('metrics did not arrive within ten minutes')
    monkeypatch.setattr(module, 'invoke_script', pending)
    with pytest.raises(RuntimeError, match='within ten minutes'):
        module.handler(payload, None, cloudformation=object(), ssm=object())
    assert calls == [('verify-alarms', payload['outputs'])]
    assert world.stored == 'live'
    assert world.effects[-2:] == ['store live', 'monitor live']
    assert module.production_state(world, 'live') == {'state': 'live'}


def test_monitoring_launch_failure_is_loud_after_live_publication():
    world, module = Production(True), load()
    def unavailable(**request):
        raise RuntimeError('monitoring launch unavailable')
    world.start_execution = unavailable
    with pytest.raises(RuntimeError, match='monitoring launch unavailable'):
        world.complete(module, 'live')
    assert world.stored == 'live'


def test_alarm_configuration_failure_prevents_live_and_continuation():
    world, module = Production(True), load()
    def verify(target, **kwargs):
        if kwargs.get('step') == 'alarm-configuration':
            raise RuntimeError('alarm configuration drift')
    module.verify_production = verify
    state = {'mode': 'live', 'op': 'advance', 'index': module.STEPS['live'].index('alarm-configuration')}
    with pytest.raises(RuntimeError, match='alarm configuration drift'):
        module.handler(state, None, cloudformation=world, ssm=world, executions=world)
    assert world.stored == 'parked'
    assert world.monitoring == []


def test_monitoring_success_returns_evidence_without_writing_state(monkeypatch, tmp_path):
    module = load()
    monkeypatch.setenv('RUNNER_TEMP', str(tmp_path))
    calls = []
    monkeypatch.setattr(module, 'invoke_script', lambda name, arguments: calls.append((name, arguments)))
    result = module.handler({'op': 'monitor', 'wakeStartedAt': 123.5,
                             'outputs': {'bot-cube-preview-origin': {'ClusterName': 'original-cluster'}}},
                            None, cloudformation=object(), ssm=object())
    assert result['monitoringEstablished'] is True
    assert result['wakeStartedAt'] == 123.5
    assert calls[0][0] == 'verify-alarms'
    assert json.loads(Path(calls[0][1][0]).read_text()) == {
        'bot-cube-preview-origin': {'ClusterName': 'original-cluster'}}


def test_monitoring_on_a_fresh_lambda_writes_its_outputs_under_tmp(monkeypatch):
    """The Lambda's environment has no RUNNER_TEMP: a monitoring invocation defaults it, for itself and verify-alarms."""
    module = load()
    monkeypatch.setenv('RUNNER_TEMP', 'restored-after-the-test')
    monkeypatch.delenv('RUNNER_TEMP')
    calls = []
    monkeypatch.setattr(module, 'invoke_script', lambda name, arguments: calls.append((arguments, os.environ.get('RUNNER_TEMP'))))
    module.handler({'op': 'monitor', 'wakeStartedAt': 123.5, 'outputs': {'bot-cube-preview-origin': {}}},
                   None, cloudformation=object(), ssm=object())
    assert calls == [(['/tmp/monitoring-outputs.json'], '/tmp')]


@pytest.mark.parametrize('succeeds', [True, False])
def test_real_alarm_verifier_handoff_is_cold_before_live_and_bounded_after(monkeypatch, tmp_path, succeeds):
    import time

    import boto3

    from test_preview_alarms import OUTPUTS, configured
    world, module = Production(True), load()
    describe = world.describe_stacks
    def stacks(**request):
        result = describe(**request)
        result['Stacks'][0]['Outputs'] = [{'OutputKey': key, 'OutputValue': value} for key, value in OUTPUTS.items()]
        return result
    world.describe_stacks = stacks
    now = [0]
    metric_calls = []
    class CloudWatch:
        def describe_alarms(self, **request):
            values = configured()
            for alarm in values:
                alarm['StateValue'] = 'OK'
            return {'MetricAlarms': values}
        def get_metric_statistics(self, **request):
            metric_calls.append(request)
            return {'Datapoints': [{}] if succeeds and now[0] >= 150 else []}
    class Secrets:
        def get_secret_value(self, **request):
            return {'SecretString': 'fixture-only'}
    class Subscriptions:
        def get_paginator(self, name):
            return self
        def paginate(self, **request):
            return [{'Subscriptions': []}]
    clients = {'cloudwatch': CloudWatch(), 'sns': Subscriptions(), 'secretsmanager': Secrets()}
    monkeypatch.setattr(boto3, 'client', lambda service: clients[service])
    monkeypatch.setenv('RUNNER_TEMP', str(tmp_path))
    monkeypatch.setattr(time, 'monotonic', lambda: now[0])
    def sleep(seconds):
        now[0] += seconds
    monkeypatch.setattr(time, 'sleep', sleep)
    module.verify_production('live', world, 'alarm-configuration', {})
    assert metric_calls == [] and now[0] == 0
    world.complete(module, 'live')
    assert world.stored == 'live' and metric_calls == []
    payload = json.loads(world.monitoring[0]['input'])
    assert payload['outputs']['bot-cube-preview-origin'] == OUTPUTS
    if succeeds:
        assert module.handler(payload, None)['monitoringEstablished'] is True
        assert now[0] == 150
    else:
        with pytest.raises(RuntimeError, match='within ten minutes'):
            module.handler(payload, None)
        assert now[0] == 600
    assert metric_calls and world.stored == 'live'
