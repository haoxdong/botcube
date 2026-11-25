"""Read ECS service facts only after deployments have completed."""
from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from botocore.waiter import WaiterModel, create_waiter_with_client
from deploy_identity import SERVICES, load_deployment, required

if TYPE_CHECKING:
    from types_boto3_ecs import ECSClient
    from types_boto3_ecs.type_defs import DeploymentTypeDef


NAMES = load_deployment()['physicalNames']


def service_facts(ecs: ECSClient, timeout: int = 300) -> dict[str, dict[str, object]]:
    facts = read_service_facts(ecs)
    if all(service['rollout'] == 'COMPLETED' and service['pending'] == 0
           and service['running'] == service['desired'] for service in facts.values()):
        return facts
    model = WaiterModel({'version': 2, 'waiters': {'CompletedRollout': {
        'operation': 'DescribeServices', 'delay': 15, 'maxAttempts': timeout // 15 + 1,
        'acceptors': [
            {'state': 'failure', 'matcher': 'path', 'argument': 'length(failures || `[]`) > `0`', 'expected': True},
            {'state': 'failure', 'matcher': 'path', 'argument': "contains(services[].deployments[].rolloutState, 'FAILED')", 'expected': True},
            {'state': 'success', 'matcher': 'path', 'argument':
             'length(services[?length(deployments) == `1` && deployments[0].rolloutState == `COMPLETED`'
             f' && pendingCount == `0` && runningCount == desiredCount]) == `{len(SERVICES)}`', 'expected': True},
        ],
    }}})
    create_waiter_with_client('CompletedRollout', model, ecs).wait(cluster=NAMES['clusterName'], services=list(SERVICES))
    return read_service_facts(ecs)


def read_service_facts(ecs: ECSClient) -> dict[str, dict[str, object]]:
    response = ecs.describe_services(cluster=NAMES['clusterName'], services=list(SERVICES))
    if response.get('failures') or len(response['services']) != len(SERVICES):
        raise RuntimeError('ECS service lookup failed')
    return {required(service.get('serviceName'), 'ECS service serviceName'): {
        'desired': required(service.get('desiredCount'), 'ECS service desiredCount'),
        'running': required(service.get('runningCount'), 'ECS service runningCount'),
        'pending': required(service.get('pendingCount'), 'ECS service pendingCount'),
        'rollout': rollout(required(service.get('deployments'), 'ECS service deployments')),
    } for service in response['services']}


def rollout(deployments: Sequence[DeploymentTypeDef]):
    return deployments[0].get('rolloutState') if len(deployments) == 1 else f'{len(deployments)} deployments'
