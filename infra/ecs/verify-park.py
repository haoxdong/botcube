"""Verify Parked or Live deployment (scripts/production/production-parking.md).

Read-only except the Live egress probe, which runs one reaper-image task that
prints its public IP. Every mismatch is named; nothing is logged from secrets.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError
from deploy_check import user_agent
from deploy_identity import load_identity, required
from ecs_service_state import service_facts
from egress_probe import EgressProbe, WakeEgressProof

if TYPE_CHECKING:
    from types_boto3_cloudformation import CloudFormationClient
    from types_boto3_cloudwatch import CloudWatchClient
    from types_boto3_ec2 import EC2Client
    from types_boto3_ecs import ECSClient
    from types_boto3_elbv2 import ElasticLoadBalancingv2Client
    from types_boto3_logs import CloudWatchLogsClient
    from types_boto3_route53 import Route53Client


IDENTITY = load_identity()
os.environ.update({
    'ORIGIN_OWNERSHIP': IDENTITY['aws']['ecs']['originOwnership'],
    'PARKED_WORKER_NAME': IDENTITY['aws']['ecs']['parkedWorkerName'],
})
sys.path.insert(0, str(Path(__file__).parent / 'origin-provider'))
handler = importlib.import_module('handler')
OWNER, Cloudflare = handler.OWNER, handler.Cloudflare
ECS = IDENTITY['aws']['ecs']
EGRESS = ECS.get('privateEgress')
API_HEALTH = ECS['apiHealth']
# Alarms that would breach at zero tasks. Parked silences the first two and has
# no ALB, so the ALB alarms do not exist; Live has all of them on.
SILENCED_ALARMS = (API_HEALTH['alarmName'], f"{ECS['cluster']}-preview-task-deficit")
ALB_ALARMS = tuple(f"{ECS['cluster']}-preview-{suffix}" for suffix in ('alb-5xx', 'target-5xx', 'unhealthy-hosts'))
HOSTS = [IDENTITY['domains'][key].removeprefix('https://') for key in ('chatService', 'chatServicePreview')]
PARKED_DNS_TARGET = ECS['parkedDnsTarget']
WEB = IDENTITY['domains']['web']
# origin-provider/parked-worker.mjs, as the web UI reads it from its own origin.
PARKED_RESPONSE = {'status': 503, 'body': {'status': 'parked'}, 'allowOrigin': WEB, 'allowCredentials': 'true'}
LIVE_RESPONSE = {'status': 200, 'body': {'status': 'ok'}, 'allowOrigin': WEB, 'allowCredentials': 'true'}
# The Chat Service target group stays while Parked, so park can drop its drain first.
SERVING_TYPES = {'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::Listener',
                 'AWS::ElasticLoadBalancingV2::ListenerRule'}
NAT_TYPES = {'AWS::EC2::NatGateway', 'AWS::EC2::Route'}
SETTLED = {'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'}


def common_failures(facts: Mapping[str, Any]):
    return [f'stack {name} is {status}' for name, status in facts['stacks'].items() if status not in SETTLED]


def service_failures(services: Mapping[str, Mapping[str, Any]], desired: int, running: int, summary: str):
    return [f'{name} is not {summary}: ' + describe(service) for name, service in services.items()
            if (service['desired'], service['running'], service['pending'], service['rollout']) != (desired, running, 0, 'COMPLETED')]


def parked_edge_failures(facts: Mapping[str, Any]):
    # A Cloudflare Worker route only runs on a proxied hostname, so the record must survive.
    owned_cname = {'type': 'CNAME', 'content': PARKED_DNS_TARGET, 'proxied': True, 'owned': True}
    failures = [f'{host} DNS is not an owned proxied CNAME to {PARKED_DNS_TARGET}'
                for host, record in facts['dns'].items() if record != owned_cname]
    return failures + [f'{host} does not answer the parked 503 to the web UI: {response}'
                       for host, response in facts['responses'].items() if response != PARKED_RESPONSE]


def egress_failures(mode: str, facts: Mapping[str, Any], expected: Mapping[str, str | None] | None):
    if expected is None:
        return []
    nat, allocation = expected['natGatewayId'], expected['allocationId']
    route = [{'NatGatewayId': nat, 'State': 'active'}]
    available = facts['natGateways'] == [{'NatGatewayId': nat, 'State': 'available', 'AllocationIds': [allocation]}]
    retained = bool(facts['address']) and facts['address']['AllocationId'] == allocation
    if mode == 'live':
        checks = [(facts['defaultRoutes'] == route, f'private default route is not active through {nat}'),
                  (available, f'NAT Gateway {nat} is not available on {allocation}'),
                  (facts['egressIp'] == expected['publicIp'], f"egress left through {facts['egressIp']}, not {expected['publicIp']}")]
    elif mode == 'parked':
        checks = [(not facts['natResources'], 'NAT Gateway still in the egress stack'),
                  (not facts['defaultRoutes'], 'private default route still exists'),
                  (not facts['natGateways'], 'NAT Gateway still billed'),
                  (retained, f"Elastic IP {expected['publicIp']} is not retained")]
    else:
        checks = [(retained, f"Elastic IP {expected['publicIp']} is not retained"),
                  (bool(nat) and facts['defaultRoutes'] == route, 'Egress mode has no active production NAT route'),
                  (available, 'Production NAT is not available on the retained allocation')]
    return [message for passed, message in checks if not passed]


def idle_failures(facts: Mapping[str, Any]):
    failures = common_failures(facts)
    if facts['servingResources']:
        failures.append('ALB still exists')
    failures += service_failures(facts['services'], 0, 0, 'at 0 tasks')
    if facts['reaper'] != 'DISABLED':
        failures.append(f"reaper schedule is {facts['reaper']}")
    if not facts['healthCheckDisabled']:
        failures.append('API health check is enabled')
    failures += alarm_failures(facts['alarmActions'], {}, 'absent')
    return failures + parked_edge_failures(facts)


def parked_failures(facts: Mapping[str, Any], expected: Mapping[str, str | None] | None):
    return idle_failures(facts) + egress_failures('parked', facts, expected)


def partial_failures(facts: Mapping[str, Any], expected: Mapping[str, str | None] | None, mode: str):
    services = dict(facts['services'])
    if mode == 'credential':
        services.pop('credential-service')
    failures = idle_failures({**facts, 'services': services}) + egress_failures(mode, facts, expected)
    if mode == 'credential':
        failures += service_failures({'credential-service': facts['services']['credential-service']}, 1, 1, 'steady at 1 task')
    return failures


def health_failures(health: Mapping[str, list[str]]) -> list[str]:
    failures: list[str] = []
    for name, states in health.items():
        # ALB can keep showing an old target as draining after deregistration;
        # it takes no new requests, so only the remaining targets must be healthy.
        states = [state for state in states if state != 'draining']
        if not states or any(state.lower() != 'healthy' for state in states):
            failures.append(f'{name} tasks are not healthy: ' + ', '.join(states or ['none']))
    return failures


def live_failures(facts: Mapping[str, Any], expected: Mapping[str, str | None] | None):
    failures = common_failures(facts) + egress_failures('live', facts, expected)
    failures += service_failures(facts['services'], 1, 1, 'steady at 1 task')
    failures += health_failures(facts['health'])
    if facts['reaper'] != 'ENABLED':
        failures.append(f"reaper schedule is {facts['reaper']}")
    if facts['healthCheckDisabled']:
        failures.append('API health check is disabled')
    failures += alarm_failures(facts['alarmActions'], dict.fromkeys(SILENCED_ALARMS + ALB_ALARMS, True), 'on')
    return failures + [f'{host} still answers the parked 503' if answers_parked(response)
                       else f'{host} does not answer live readiness to the web UI: {response}'
                       for host, response in facts['responses'].items() if response != LIVE_RESPONSE]


def alarm_failures(actual: Mapping[str, bool], expected: Mapping[str, bool], word: str):
    state = {True: 'on', False: 'off', None: 'missing'}
    wrong = [f'{name} {state[actual.get(name)]}' for name in sorted(set(actual) | set(expected)) if actual.get(name) != expected.get(name)]
    return [f'alarm actions are not {word}: ' + ', '.join(wrong)] if wrong else []


def monitoring_facts(route53: Route53Client, cloudwatch: CloudWatchClient, outputs: Mapping[str, str]):
    check = route53.get_health_check(HealthCheckId=outputs['HealthCheckId'])['HealthCheck']['HealthCheckConfig']
    alarms = cloudwatch.describe_alarms(AlarmNames=list(SILENCED_ALARMS + ALB_ALARMS))['MetricAlarms']
    return required(check.get('Disabled'), 'health check Disabled'), {
        required(alarm.get('AlarmName'), 'alarm AlarmName'): required(alarm.get('ActionsEnabled'), 'alarm ActionsEnabled')
        for alarm in alarms}


def answers_parked(response: Mapping[str, object]):
    return (response['status'], response['body']) == (PARKED_RESPONSE['status'], PARKED_RESPONSE['body'])


def describe(service: Mapping[str, object]):
    return f"desired {service['desired']}, running {service['running']}, pending {service['pending']}, rollout {service['rollout']}"


def stack_facts(cfn: CloudFormationClient, name: str):
    status = cfn.describe_stacks(StackName=name)['Stacks'][0]['StackStatus']
    types = [resource['ResourceType'] for page in cfn.get_paginator('list_stack_resources').paginate(StackName=name)
             for resource in page['StackResourceSummaries'] if resource['ResourceStatus'] != 'DELETE_COMPLETE']
    return status, types


def address_facts(ec2: EC2Client):
    try:
        addresses = ec2.describe_addresses(PublicIps=[EGRESS['publicIp']])['Addresses']
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'InvalidAddress.NotFound':
            return None  # A truthful probe: the retained address is gone.
        raise
    return {key: value for key, value in addresses[0].items() if key in ('AllocationId', 'AssociationId')}


def network_facts(ec2: EC2Client) -> tuple[list[dict[str, str | None]], list[dict[str, object]]]:
    table = ec2.describe_route_tables(RouteTableIds=[EGRESS['routeTableId']])['RouteTables'][0]
    routes = [{'NatGatewayId': route.get('NatGatewayId'), 'State': route.get('State')}
              for route in required(table.get('Routes'), 'egress route table Routes') if route.get('DestinationCidrBlock') == '0.0.0.0/0']
    gateways = ec2.describe_nat_gateways(Filters=[
        {'Name': 'tag:Name', 'Values': [EGRESS['natGateway']['name']]},
        {'Name': 'state', 'Values': ['pending', 'available', 'deleting']}])['NatGateways']
    return routes, [{'NatGatewayId': required(gateway.get('NatGatewayId'), 'NAT gateway NatGatewayId'),
                     'State': required(gateway.get('State'), 'NAT gateway State'),
                     'AllocationIds': [required(address.get('AllocationId'), 'NAT gateway address AllocationId')
                                       for address in required(gateway.get('NatGatewayAddresses'), 'NAT gateway NatGatewayAddresses')]}
                    for gateway in gateways]


def dns_facts() -> dict[str, dict[str, object] | None]:
    cf = Cloudflare(os.environ['CLOUDFLARE_ORIGIN_API_TOKEN'])
    zone = cf.zone(IDENTITY['aws']['ecs']['originZone'])
    facts: dict[str, dict[str, object] | None] = {}
    for host in HOSTS:
        records = cf.records(zone, host)
        facts[host] = None if len(records) != 1 else {
            'type': records[0].get('type'), 'content': records[0].get('content'),
            'proxied': records[0].get('proxied'), 'owned': records[0].get('comment') == OWNER}
    return facts


def response_facts(parked: bool) -> dict[str, dict[str, object]]:
    """What each API hostname answers the web UI, once the Worker route change has propagated."""
    def probe(host: str) -> dict[str, object]:
        request = urllib.request.Request(f'https://{host}/health', headers={
            'Origin': WEB, 'User-Agent': user_agent('ORIGIN_VERIFICATION_USER_AGENT'), 'Cache-Control': 'no-cache'})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                status, headers, body = response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            status, headers, body = error.code, error.headers, error.read()
        try:
            body = json.loads(body)
        except ValueError:
            body = body.decode(errors='replace')[:200]
        return {'status': status, 'body': body, 'allowOrigin': headers.get('Access-Control-Allow-Origin'),
                'allowCredentials': headers.get('Access-Control-Allow-Credentials')}
    for _ in range(11):
        responses = {host: probe(host) for host in HOSTS}
        if all(response == (PARKED_RESPONSE if parked else LIVE_RESPONSE) for response in responses.values()):
            return responses
        time.sleep(5)
    return {host: probe(host) for host in HOSTS}


def health_facts(ecs: ECSClient, elb: ElasticLoadBalancingv2Client, outputs: Mapping[str, str]):
    chat = elb.describe_target_health(TargetGroupArn=outputs['TargetGroupArn'])['TargetHealthDescriptions']
    arns = ecs.list_tasks(cluster=ECS['cluster'], serviceName='credential-service', desiredStatus='RUNNING')['taskArns']
    tasks = []
    if arns:
        response = ecs.describe_tasks(cluster=ECS['cluster'], tasks=arns)
        if response.get('failures'):
            raise RuntimeError('Credential Service health task lookup failed')
        tasks = response['tasks']
    return {'chat-service-preview': [required(required(target.get('TargetHealth'), 'target TargetHealth').get('State'), 'target TargetHealth State')
                                     for target in chat],
            'credential-service': [task.get('healthStatus', 'UNKNOWN') for task in tasks]}


def egress_ip(ecs: ECSClient, logs: CloudWatchLogsClient, ec2: EC2Client, outputs: Mapping[str, Mapping[str, str]]):
    probe = EgressProbe(ecs=ecs, logs=logs, ec2=ec2)
    running = probe.start(uuid.uuid4().hex, outputs, time.time())
    ecs.get_waiter('tasks_stopped').wait(cluster=ECS['cluster'], tasks=[running['taskArn']], WaiterConfig={'Delay': 6, 'MaxAttempts': 50})
    for _ in range(10):
        result = probe.observe(running)
        if result is not None:
            return result['observedIp']
        time.sleep(3)
    raise RuntimeError('Egress probe printed no IP')


def owned_egress_facts(facts: dict[str, Any], state: str, outputs: Mapping[str, Mapping[str, str]], cfn: CloudFormationClient,
                       ec2: EC2Client, ecs: ECSClient, logs: CloudWatchLogsClient, proof: WakeEgressProof | None = None) -> dict[str, str | None]:
    egress = outputs[EGRESS['stackName']]
    facts['stacks']['egress'], egress_types = stack_facts(cfn, EGRESS['stackName'])
    facts['defaultRoutes'], facts['natGateways'] = network_facts(ec2)
    facts.update({'natResources': sorted(NAT_TYPES & set(egress_types)), 'address': address_facts(ec2)})
    if state == 'live':
        facts['egressIp'] = (EgressProbe(ecs=ecs, ec2=ec2, logs=logs).verify(proof['probe'], outputs, proof['attemptId'], proof['startedAt'])
                             if proof else egress_ip(ecs, logs, ec2, outputs))
    return {'publicIp': EGRESS['publicIp'], 'allocationId': egress['PrivateNatAllocationId'],
            'natGatewayId': egress.get('PrivateNatGatewayId')}


def main(argv: list[str]):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state', choices=['parked', 'egress', 'credential', 'live'])
    parser.add_argument('outputs', help='cdk deploy --outputs-file')
    parser.add_argument('--egress-proof', type=Path)
    args = parser.parse_args(argv)
    if args.egress_proof and args.state != 'live':
        raise RuntimeError('Retained egress proof is only valid for Live verification')
    proof = json.loads(args.egress_proof.read_text()) if args.egress_proof else None
    outputs = json.loads(Path(args.outputs).read_text())
    origin = outputs[ECS['previewOriginStackName']]
    cfn, ec2, ecs, elb = boto3.client('cloudformation'), boto3.client('ec2'), boto3.client('ecs'), boto3.client('elbv2')
    events, logs, route53, cloudwatch = boto3.client('events'), boto3.client('logs'), boto3.client('route53'), boto3.client('cloudwatch')
    origin_status, origin_types = stack_facts(cfn, ECS['previewOriginStackName'])
    health_check_disabled, alarm_actions = monitoring_facts(route53, cloudwatch, outputs[API_HEALTH['stackName']])
    facts = {
        'stacks': {'origin': origin_status},
        'servingResources': sorted(SERVING_TYPES & set(origin_types)),
        'services': service_facts(ecs), 'reaper': events.describe_rule(Name=origin['ReaperRuleName'])['State'],
        'healthCheckDisabled': health_check_disabled, 'alarmActions': alarm_actions,
        'responses': response_facts(args.state != 'live'),
    }
    expected = owned_egress_facts(facts, args.state, outputs, cfn, ec2, ecs, logs, proof) if EGRESS else None
    if args.state != 'live':
        facts['dns'] = dns_facts()
        failures = parked_failures(facts, expected) if args.state == 'parked' else partial_failures(facts, expected, args.state)
    else:
        facts['health'] = health_facts(ecs, elb, origin)
        failures = live_failures(facts, expected)
    report = {'state': args.state, 'verifiedAt': datetime.now(UTC).isoformat(), 'facts': facts,
              'failures': failures, 'sourceRevision': os.environ.get('GITHUB_SHA', '')}
    path = Path(os.environ.get('RUNNER_TEMP', '.')) / 'production-park-evidence.json'
    path.write_text(json.dumps(report, indent=2, default=str) + '\n')
    print(json.dumps(report, indent=2, default=str), flush=True)
    if failures:
        raise RuntimeError(f'Production is not {args.state}: ' + '; '.join(failures))


if __name__ == '__main__':
    main(sys.argv[1:])
