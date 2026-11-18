"""One idempotently admitted Fargate probe and proof tied to its wake and NAT."""
from __future__ import annotations

import hashlib
import time
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, TypedDict

import boto3
from deploy_identity import load_identity, required

if TYPE_CHECKING:
    from types_boto3_ec2 import EC2Client
    from types_boto3_ecs import ECSClient
    from types_boto3_logs import CloudWatchLogsClient

IDENTITY = load_identity()
ECS = IDENTITY['aws']['ecs']
EGRESS = ECS.get('privateEgress')
PREFIX = 'parking-egress-'


class RunningProbe(TypedDict):
    attemptId: str
    startedAt: float
    launchedAt: float
    taskArn: str
    taskDefinitionArn: str
    natGatewayId: str
    allocationId: str
    logGroup: str


class EgressProof(RunningProbe):
    observedIp: str
    observedAt: float


class WakeEgressProof(TypedDict):
    attemptId: str
    startedAt: float
    probe: EgressProof


def owner(attempt_id: str) -> str:
    return PREFIX + hashlib.sha256(attempt_id.encode()).hexdigest()[:20]


class EgressProbe:
    def __init__(self, *, ecs: ECSClient | None = None, ec2: EC2Client | None = None,
                 logs: CloudWatchLogsClient | None = None, clock: Callable[[], float] = time.time):
        self.ecs, self.ec2, self.logs = ecs or boto3.client('ecs'), ec2 or boto3.client('ec2'), logs or boto3.client('logs')
        self.clock = clock

    def network(self, outputs: Mapping[str, Mapping[str, str]]) -> tuple[str, str]:
        if EGRESS is None:
            raise RuntimeError('Egress proof requires an owned NAT')
        expected = outputs[EGRESS['stackName']]
        nat_id, allocation = expected['PrivateNatGatewayId'], expected['PrivateNatAllocationId']
        gateways = self.ec2.describe_nat_gateways(NatGatewayIds=[nat_id])['NatGateways']
        table = self.ec2.describe_route_tables(RouteTableIds=[EGRESS['routeTableId']])['RouteTables'][0]
        routes = [route for route in table['Routes'] if route.get('DestinationCidrBlock') == '0.0.0.0/0']
        if (len(gateways) != 1 or gateways[0]['State'] != 'available'
                or {a['AllocationId'] for a in gateways[0]['NatGatewayAddresses']} != {allocation}
                or len(routes) != 1 or routes[0].get('NatGatewayId') != nat_id or routes[0]['State'] != 'active'):
            raise RuntimeError('Production NAT and its default route are not ready')
        return nat_id, allocation

    def start(self, attempt_id: str, outputs: Mapping[str, Mapping[str, str]], started_at: float) -> RunningProbe:
        nat_id, allocation = self.network(outputs)
        origin = outputs[ECS['previewOriginStackName']]
        response = self.ecs.run_task(
            cluster=ECS['cluster'], launchType='FARGATE', taskDefinition=origin['ReaperTaskDefinitionArn'],
            clientToken=hashlib.sha256(attempt_id.encode()).hexdigest(), startedBy=owner(attempt_id),
            networkConfiguration={'awsvpcConfiguration': {
                'subnets': [subnet['id'] for subnet in IDENTITY['aws']['agentCore']['privateNatBrowser']['subnets']],
                'securityGroups': [origin['ReaperSecurityGroupId']], 'assignPublicIp': 'DISABLED'}},
            overrides={'containerOverrides': [{'name': 'reaper', 'command': [
                'node', '--input-type=module', '-e',
                "const response = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(20000) });"
                " if (!response.ok) throw new Error(`HTTP ${response.status}`);"
                " console.log('egress-ip', (await response.text()).trim());"]}]},
        )
        if response.get('failures') or len(response['tasks']) != 1:
            raise RuntimeError('Egress probe task did not start')
        task = response['tasks'][0]
        return {'attemptId': attempt_id, 'startedAt': started_at,
                'launchedAt': required(task.get('createdAt'), 'egress task createdAt').timestamp(),
                'taskArn': required(task.get('taskArn'), 'egress task taskArn'),
                'taskDefinitionArn': origin['ReaperTaskDefinitionArn'], 'natGatewayId': nat_id,
                'allocationId': allocation, 'logGroup': origin['ReaperLogGroupName']}

    def observe(self, probe: RunningProbe) -> EgressProof | None:
        response = self.ecs.describe_tasks(cluster=ECS['cluster'], tasks=[probe['taskArn']])
        if response.get('failures') or len(response['tasks']) != 1:
            raise RuntimeError('Egress probe task lookup failed')
        task = response['tasks'][0]
        if task.get('startedBy') != owner(probe['attemptId']) or task.get('taskDefinitionArn') != probe['taskDefinitionArn']:
            raise RuntimeError('Egress task differs from its wake attempt')
        if task['lastStatus'] == 'STOPPED':
            containers = required(task.get('containers'), 'egress probe task containers')
            if len(containers) != 1 or containers[0].get('exitCode') != 0:
                raise RuntimeError('Egress probe task failed: ' + task.get('stoppedReason', 'no reason'))
            stream = 'reaper/reaper/' + probe['taskArn'].rsplit('/', 1)[1]
            events = self.logs.filter_log_events(logGroupName=probe['logGroup'], logStreamNames=[stream],
                                                filterPattern='"egress-ip"')['events']
            if events:
                event = events[-1]
                return {**probe, 'observedIp': required(event.get('message'), 'egress log message').split()[-1],
                        'observedAt': required(event.get('timestamp'), 'egress log timestamp') / 1000}
        if self.clock() - probe['launchedAt'] > 300:
            raise RuntimeError('Egress probe did not complete and print its IP within 300 seconds')
        return None

    def verify(self, proof: EgressProof, outputs: Mapping[str, Mapping[str, str]], attempt_id: str, started_at: float) -> str:
        if proof['attemptId'] != attempt_id or proof['startedAt'] != started_at or proof['observedAt'] < started_at:
            raise RuntimeError('Egress proof belongs to another attempt')
        if EGRESS is None:
            raise RuntimeError('Egress proof requires an owned NAT')
        expected, origin = outputs[EGRESS['stackName']], outputs[ECS['previewOriginStackName']]
        if ((proof['natGatewayId'], proof['allocationId']) != (expected['PrivateNatGatewayId'], expected['PrivateNatAllocationId'])
                or proof['taskDefinitionArn'] != origin['ReaperTaskDefinitionArn']):
            raise RuntimeError('Egress proof belongs to another network or task definition')
        self.network(outputs)
        observed = self.observe(proof)
        if observed is None or observed['observedIp'] != proof['observedIp'] or observed['observedIp'] != EGRESS['publicIp']:
            raise RuntimeError('Egress proof does not confirm the retained production IP')
        return observed['observedIp']

    def pending(self, origin: Mapping[str, str]) -> bool:
        family = origin['ReaperTaskDefinitionArn'].rsplit('/', 1)[-1].rsplit(':', 1)[0]
        pending = False
        for status in ('RUNNING', 'STOPPED'):
            for page in self.ecs.get_paginator('list_tasks').paginate(cluster=ECS['cluster'], family=family, desiredStatus=status):
                pending = self.stop_owned(page['taskArns']) or pending
        return pending

    def stop_owned(self, arns: list[str]) -> bool:
        if not arns:
            return False
        response = self.ecs.describe_tasks(cluster=ECS['cluster'], tasks=arns)
        if response.get('failures'):
            raise RuntimeError('Owned egress probe cleanup lookup failed')
        pending = False
        for task in response['tasks']:
            if not task.get('startedBy', '').startswith(PREFIX) or task['lastStatus'] == 'STOPPED':
                continue
            if task.get('desiredStatus') != 'STOPPED':
                self.ecs.stop_task(cluster=ECS['cluster'], task=task['taskArn'], reason='Production parking drains owned egress probes')
            pending = True
        return pending
