"""Prepare non-secret CDK inputs and runtime-only Cloudflare credential storage."""
import ipaddress
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from deploy_identity import load_identity

identity = load_identity()
origin = identity['aws']['ecs']
token = os.environ['CLOUDFLARE_ORIGIN_API_TOKEN']
if not token:
    raise SystemExit('Cloudflare token is missing')

def aws(*args: str):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json']))

# Only explicitly missing secrets are created; permission/provider failures propagate.
with tempfile.NamedTemporaryFile(mode='w', prefix='origin-token-') as secret_file:
    secret_file.write(token)
    secret_file.flush()
    result = subprocess.run(['aws', 'secretsmanager', 'describe-secret', '--secret-id', origin['originTokenSecretName']], capture_output=True, text=True)
    if result.returncode == 0:
        aws('secretsmanager', 'put-secret-value', '--secret-id', origin['originTokenSecretName'], '--secret-string', 'file://' + secret_file.name)
    elif 'ResourceNotFoundException' in result.stderr:
        aws('secretsmanager', 'create-secret', '--name', origin['originTokenSecretName'], '--secret-string', 'file://' + secret_file.name)
    else:
        raise SystemExit('Cannot read origin token secret metadata: ' + result.stderr)
with urllib.request.urlopen('https://api.cloudflare.com/client/v4/ips', timeout=30) as response:
    ranges = json.load(response)
if not ranges.get('success'):
    raise SystemExit('Cloudflare range retrieval failed')
cidrs = ranges['result']['ipv4_cidrs']
if not cidrs or any(ipaddress.ip_network(cidr).version != 4 for cidr in cidrs):
    raise SystemExit('Cloudflare IPv4 ranges missing or invalid')
client = aws('secretsmanager', 'get-secret-value', '--secret-id', origin['originPullClientSecretName'])
runtime_arn = aws('ssm', 'get-parameter', '--name', identity['ssm']['runtimeArn'])['Parameter']['Value']
# A deploy must never create the fixed egress Elastic IP: it is imported once
# (your infrastructure ownership procedure), then owned by the egress stack.
egress = identity['aws']['ecs']['privateEgress']
owner = subprocess.run(['aws', 'cloudformation', 'describe-stack-resource', '--stack-name', egress['stackName'],
                        '--logical-resource-id', 'PrivateNatAddress', '--output', 'json'], capture_output=True, text=True)
if owner.returncode != 0 or json.loads(owner.stdout)['StackResourceDetail']['PhysicalResourceId'] != egress['publicIp']:
    raise SystemExit(f"{egress['stackName']} must own Elastic IP {egress['publicIp']} before deploy; "
                     f"import it per your infrastructure ownership procedure. {owner.stderr.strip()}")
# Likewise the API health check: the observability dashboard reads its ID, so it
# is imported once (your infrastructure ownership procedure), never created.
health = origin['apiHealth']
owner = subprocess.run(['aws', 'cloudformation', 'describe-stack-resource', '--stack-name', health['stackName'],
                        '--logical-resource-id', 'ApiHealthCheck', '--output', 'json'], capture_output=True, text=True)
if owner.returncode != 0:
    raise SystemExit(f"{health['stackName']} must own the API health check before deploy; "
                     f"import it per your infrastructure ownership procedure. {owner.stderr.strip()}")
network = identity['aws']['agentCore']['privateNatBrowser']
route_table = aws('ec2', 'describe-route-tables', '--route-table-ids', egress['routeTableId'])['RouteTables'][0]
associated = {item.get('SubnetId') for item in route_table['Associations']}
if not {subnet['id'] for subnet in network['subnets']} <= associated:
    raise SystemExit('Preview private subnets are not associated with the expected route table')
defaults = [route for route in route_table['Routes'] if route.get('DestinationCidrBlock') == '0.0.0.0/0']
# Parked production has no default route; the unpark deploy recreates it.
if len(defaults) > 1 or (defaults and (defaults[0].get('State') != 'active' or not defaults[0].get('NatGatewayId'))):
    raise SystemExit('Preview private egress must be one active NAT Gateway route, or none while Parked')
nat_state = None
if defaults:
    nat = aws('ec2', 'describe-nat-gateways', '--nat-gateway-ids', defaults[0]['NatGatewayId'])['NatGateways'][0]
    if nat['State'] != 'available' or nat['VpcId'] != network['vpcId']:
        raise SystemExit('Preview NAT Gateway is not available in the configured VPC')
    nat_state = nat['State']
Path(os.environ['PREVIEW_ORIGIN_INPUT']).write_text(json.dumps({
    'cloudflareCidrs': cidrs, 'clientVersion': client['VersionId'], 'runtimeArn': runtime_arn,
    'network': {'routeTableId': egress['routeTableId'], 'subnetIds': sorted(associated - {None}),
                'defaultRoute': defaults[0] if defaults else None, 'natGatewayState': nat_state},
}))
print('Prepared current Cloudflare ranges and client certificate revision')
