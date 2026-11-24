from datetime import UTC, datetime

import pytest

from deploy_script_support import load_deploy_script


class ECS:
    def __init__(self):
        self.tasks = {}
        self.stopped = False
        self.containers = [{'exitCode': 0}]
        self.desired = 'RUNNING'

    def run_task(self, **request):
        token = request['clientToken']
        self.tasks.setdefault(token, {
            'taskArn': 'arn:aws:ecs:us-east-1:123456789012:task/probe',
            'taskDefinitionArn': request['taskDefinition'], 'startedBy': request['startedBy'],
            'createdAt': datetime(2026, 11, 18, tzinfo=UTC),
        })
        return {'tasks': [self.tasks[token]]}

    def describe_tasks(self, **_request):
        task = next(iter(self.tasks.values()))
        return {'tasks': [{**task, 'desiredStatus': self.desired, 'lastStatus': 'STOPPED' if self.stopped else 'RUNNING',
                           'stoppedAt': datetime(2026, 11, 18, 0, 0, 1, tzinfo=UTC) if self.stopped else None,
                           **({'containers': self.containers if self.stopped else []} if self.containers is not None else {})}]}


class EC2:
    state = 'available'

    def describe_nat_gateways(self, **_request):
        return {'NatGateways': [{'NatGatewayId': 'nat-fixture', 'State': self.state,
                                'NatGatewayAddresses': [{'AllocationId': 'eipalloc-fixture'}]}]}

    def describe_route_tables(self, **_request):
        return {'RouteTables': [{'Routes': [{'DestinationCidrBlock': '0.0.0.0/0', 'NatGatewayId': 'nat-fixture', 'State': 'active'}]}]}


def fixture():
    module = load_deploy_script('egress_probe', 'egress_probe.py')
    outputs = {
        module.NAMES['previewOriginStackName']: {
            'ReaperTaskDefinitionArn': 'arn:aws:ecs:us-east-1:123456789012:task-definition/reaper:1',
            'ReaperSecurityGroupId': 'sg-fixture',
        },
        module.EGRESS['stackName']: {'PrivateNatGatewayId': 'nat-fixture', 'PrivateNatAllocationId': 'eipalloc-fixture'},
    }
    ecs, ec2 = ECS(), EC2()
    return module, module.EgressProbe(ecs=ecs, ec2=ec2, clock=lambda: 1794960002), ecs, ec2, outputs


def test_probe_is_nonblocking_and_replay_admits_only_one_task():
    _module, probe, ecs, _ec2, outputs = fixture()
    first = probe.start('wake-fixture', outputs, 1794960000)
    replay = probe.start('wake-fixture', outputs, 1794960000)
    assert first == replay
    assert len(ecs.tasks) == 1
    assert probe.observe(first) is None
    ecs.stopped = True
    result = probe.observe(first)
    assert result['observedIp'] == '192.0.2.1'
    assert probe.verify(result, outputs, 'wake-fixture', 1794960000) == '192.0.2.1'


def test_pending_probe_at_deadline_is_stopped_and_fails_the_transition():
    module, probe, ecs, _ec2, outputs = fixture()
    transition = load_deploy_script('parking_transition', 'parking_transition.py')
    running = probe.start('wake-fixture', outputs, 1794960000)
    probe.clock = lambda: running['launchedAt'] + 300
    stopped = []
    ecs.stop_task = lambda **request: stopped.append(request['task'])
    with pytest.raises(RuntimeError, match='exceeded 300 seconds in RUNNING'):
        transition.live_dependencies({'probe': running}, 'verify', None, probe)
    assert stopped == [running['taskArn']]
    assert module.EGRESS is not None


def test_probe_never_starts_before_nat_is_available():
    _module, probe, ecs, ec2, outputs = fixture()
    ec2.state = 'pending'
    with pytest.raises(RuntimeError, match='NAT'):
        probe.start('wake-fixture', outputs, 1794960000)
    assert not ecs.tasks


def test_old_attempt_or_replaced_nat_cannot_supply_live_proof():
    _module, probe, ecs, _ec2, outputs = fixture()
    running = probe.start('wake-fixture', outputs, 1794960000)
    ecs.stopped = True
    proof = probe.observe(running)
    with pytest.raises(RuntimeError, match='attempt'):
        probe.verify(proof, outputs, 'other-wake', 1794960000)
    outputs[_module.EGRESS['stackName']]['PrivateNatGatewayId'] = 'nat-replaced'
    with pytest.raises(RuntimeError, match='network'):
        probe.verify(proof, outputs, 'wake-fixture', 1794960000)


def test_stopped_probe_without_containers_fails_loud():
    _module, probe, ecs, _ec2, outputs = fixture()
    running = probe.start('wake-fixture', outputs, 1794960000)
    ecs.stopped, ecs.containers = True, None
    with pytest.raises(RuntimeError, match='lacks egress probe task containers'):
        probe.observe(running)


def test_drain_stops_only_owned_probes_and_waits_for_stopped():
    module, probe, ecs, _ec2, outputs = fixture()
    running = probe.start('wake-fixture', outputs, 1794960000)
    stopped = []

    class Pages:
        def paginate(self, **request):
            return [{'taskArns': [running['taskArn']] if request['desiredStatus'] == ecs.desired else []}]

    ecs.get_paginator = lambda _name: Pages()
    def stop_task(**request):
        stopped.append(request['task'])
        ecs.desired = 'STOPPED'

    ecs.stop_task = stop_task
    assert probe.pending(outputs[module.NAMES['previewOriginStackName']])
    assert stopped == [running['taskArn']]
    assert probe.pending(outputs[module.NAMES['previewOriginStackName']])
    ecs.stopped = True
    assert not probe.pending(outputs[module.NAMES['previewOriginStackName']])
    assert stopped == [running['taskArn']]


def test_transition_proof_handoff_through_verify_park_main(tmp_path, monkeypatch):
    import json
    import sys

    import boto3

    from test_preview_parking import live

    module, probe, ecs, ec2, outputs = fixture()
    transition = load_deploy_script('parking_transition', 'parking_transition.py')
    verifier = load_deploy_script('verify_park_handoff', 'verify-park.py')
    outputs[module.NAMES['apiHealthStackName']] = {}
    outputs[module.NAMES['previewOriginStackName']]['ReaperRuleName'] = 'fixture-rule'
    running = probe.start('wake-fixture', outputs, 1794960000)
    ecs.stopped = True
    proof = probe.observe(running)
    facts = live()

    class CloudFormation:
        def describe_stacks(self, StackName):
            return {'Stacks': [{'Outputs': [{'OutputKey': key, 'OutputValue': value}
                                           for key, value in outputs[StackName].items()]}]}

    class Secrets:
        def get_secret_value(self, **_request):
            return {'SecretString': 'fixture-origin-token'}

    class Events:
        def describe_rule(self, **_request):
            return {'State': 'ENABLED'}

    clients = {'cloudformation': CloudFormation(), 'ec2': ec2, 'ecs': ecs, 'secretsmanager': Secrets(), 'events': Events(), 'elbv2': object(),
               'route53': object(), 'cloudwatch': object()}
    monkeypatch.setattr(boto3, 'client', lambda name: clients[name])
    monkeypatch.setenv('RUNNER_TEMP', str(tmp_path))
    monkeypatch.setattr(verifier, 'stack_facts', lambda _cfn, name: (
        'UPDATE_COMPLETE', facts['servingResources'] if name == module.NAMES['previewOriginStackName'] else facts['natResources']))
    monkeypatch.setattr(verifier, 'monitoring_facts', lambda *_: (False, facts['alarmActions']))
    monkeypatch.setattr(verifier, 'service_facts', lambda *_: facts['services'])
    monkeypatch.setattr(verifier, 'response_facts', lambda *_: facts['responses'])
    monkeypatch.setattr(verifier, 'network_facts', lambda *_: (
        [{'NatGatewayId': 'nat-fixture', 'State': 'active'}],
        [{'NatGatewayId': 'nat-fixture', 'State': 'available', 'AllocationIds': ['eipalloc-fixture']}]))
    monkeypatch.setattr(verifier, 'address_facts', lambda *_: {'AllocationId': 'eipalloc-fixture', 'AssociationId': 'association'})
    monkeypatch.setattr(verifier, 'health_facts', lambda *_: facts['health'])
    monkeypatch.setattr(transition.runpy, 'run_path', lambda *_args, **_kwargs: verifier.main(sys.argv[1:]))
    state = {'attemptId': 'wake-fixture', 'startedAt': 1794960000, 'probe': proof}
    transition.verify_production('live', clients['cloudformation'], 'verify', state)
    report = json.loads((tmp_path / 'production-park-evidence.json').read_text())
    assert report['failures'] == []
    assert report['facts']['egressIp'] == '192.0.2.1'
    assert len(ecs.tasks) == 1
    state['attemptId'] = 'another-wake'
    with pytest.raises(RuntimeError, match='another attempt'):
        transition.verify_production('live', clients['cloudformation'], 'verify', state)
