"""One idempotently admitted Fargate probe and proof tied to its wake and NAT."""
from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, TypedDict

import boto3
from deploy_identity import load_deployment, owned_egress, required

if TYPE_CHECKING:
    from types_boto3_ec2 import EC2Client
    from types_boto3_ecs import ECSClient

RESOLVED = load_deployment()
NAMES = RESOLVED['physicalNames']
IDENTITY = RESOLVED['config']

EGRESS = owned_egress(RESOLVED)
PREFIX = 'parking-egress-'


class RunningProbe(TypedDict):
    attemptId: str
    startedAt: float
    launchedAt: float
    taskArn: str
    taskDefinitionArn: str
    natGatewayId: str
    allocationId: str
    expectedIp: str


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
                 clock: Callable[[], float] = time.time):
        self.ecs, self.ec2 = ecs or boto3.client('ecs'), ec2 or boto3.client('ec2')
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
        if EGRESS is None:
            raise RuntimeError('Egress proof requires an owned NAT')
        expected_ip = EGRESS['publicIp']
        nat_id, allocation = self.network(outputs)
        origin = outputs[NAMES['previewOriginStackName']]
        response = self.ecs.run_task(
            cluster=NAMES['clusterName'], launchType='FARGATE', taskDefinition=origin['ReaperTaskDefinitionArn'],
            clientToken=hashlib.sha256(attempt_id.encode()).hexdigest(), startedBy=owner(attempt_id),
            networkConfiguration={'awsvpcConfiguration': {
                'subnets': [subnet['subnetId'] for subnet in IDENTITY['existing']['vpc']['privateSubnets']],
                'securityGroups': [origin['ReaperSecurityGroupId']], 'assignPublicIp': 'DISABLED'}},
            overrides={'containerOverrides': [{'name': 'reaper', 'command': [
                'node', '--input-type=module', '-e',
                "const response = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(20000) });"
                " if (!response.ok) throw new Error(`HTTP ${response.status}`);"
                " const actual = (await response.text()).trim();"
                f" if (actual !== {json.dumps(expected_ip)}) throw new Error(`Unexpected egress IP: ${{actual}}`);"]}]},
        )
        if response.get('failures') or len(response['tasks']) != 1:
            raise RuntimeError('Egress probe task did not start')
        task = response['tasks'][0]
        return {'attemptId': attempt_id, 'startedAt': started_at,
                'launchedAt': required(task.get('createdAt'), 'egress task createdAt').timestamp(),
                'taskArn': required(task.get('taskArn'), 'egress task taskArn'),
                'taskDefinitionArn': origin['ReaperTaskDefinitionArn'], 'natGatewayId': nat_id,
                'allocationId': allocation, 'expectedIp': expected_ip}

    def observe(self, probe: RunningProbe) -> EgressProof | None:
        response = self.ecs.describe_tasks(cluster=NAMES['clusterName'], tasks=[probe['taskArn']])
        if response.get('failures') or len(response['tasks']) != 1:
            raise RuntimeError('Egress probe task lookup failed')
        task = response['tasks'][0]
        if task.get('startedBy') != owner(probe['attemptId']) or task.get('taskDefinitionArn') != probe['taskDefinitionArn']:
            raise RuntimeError('Egress task differs from its wake attempt')
        if task['lastStatus'] == 'STOPPED':
            stopped_at = required(task.get('stoppedAt'), 'egress probe task stoppedAt').timestamp()
            if stopped_at - probe['launchedAt'] <= 300:
                containers = required(task.get('containers'), 'egress probe task containers')
                if len(containers) != 1 or containers[0].get('exitCode') != 0:
                    raise RuntimeError('Egress probe task failed: ' + task.get('stoppedReason', 'no reason'))
                return {**probe, 'observedIp': probe['expectedIp'], 'observedAt': stopped_at}
            raise RuntimeError('Egress probe task exceeded 300 seconds')
        if self.clock() - probe['launchedAt'] >= 300:
            self.ecs.stop_task(cluster=NAMES['clusterName'], task=probe['taskArn'], reason='Egress probe deadline exceeded')
            raise RuntimeError(f"Egress probe task exceeded 300 seconds in {task['lastStatus']}")
        return None

    def verify(self, proof: EgressProof, outputs: Mapping[str, Mapping[str, str]], attempt_id: str, started_at: float) -> str:
        if proof['attemptId'] != attempt_id or proof['startedAt'] != started_at or proof['observedAt'] < started_at:
            raise RuntimeError('Egress proof belongs to another attempt')
        if EGRESS is None:
            raise RuntimeError('Egress proof requires an owned NAT')
        expected, origin = outputs[EGRESS['stackName']], outputs[NAMES['previewOriginStackName']]
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
            for page in self.ecs.get_paginator('list_tasks').paginate(cluster=NAMES['clusterName'], family=family, desiredStatus=status):
                pending = self.stop_owned(page['taskArns']) or pending
        return pending

    def stop_owned(self, arns: list[str]) -> bool:
        if not arns:
            return False
        response = self.ecs.describe_tasks(cluster=NAMES['clusterName'], tasks=arns)
        if response.get('failures'):
            raise RuntimeError('Owned egress probe cleanup lookup failed')
        pending = False
        for task in response['tasks']:
            if not task.get('startedBy', '').startswith(PREFIX) or task['lastStatus'] == 'STOPPED':
                continue
            if task.get('desiredStatus') != 'STOPPED':
                self.ecs.stop_task(cluster=NAMES['clusterName'], task=task['taskArn'], reason='Production parking drains owned egress probes')
            pending = True
        return pending
