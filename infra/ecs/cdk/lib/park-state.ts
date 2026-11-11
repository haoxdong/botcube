import { CfnCondition, CfnParameter, CfnResource, Fn, Stack, Token } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

export function parkState(scope: Construct) {
  const stack = Stack.of(scope);
  const parameter = stack.node.tryFindChild('ParkState') ?? new CfnParameter(stack, 'ParkState', {
    type: 'String', allowedValues: ['true', 'false'], description: 'Production is Parked when true, Live when false.',
  });
  if (!(parameter instanceof CfnParameter)) throw new Error('ParkState must be a CloudFormation parameter');
  parameter.overrideLogicalId('parked');
  const parked = stack.node.tryFindChild('Parked') ?? new CfnCondition(stack, 'Parked', { expression: Fn.conditionEquals(parameter.valueAsString, 'true') });
  if (!(parked instanceof CfnCondition)) throw new Error('Invalid parking condition');
  return {
    parkedCondition: parked,
    get liveCondition() {
      const live = stack.node.tryFindChild('Live') ?? new CfnCondition(stack, 'Live', { expression: Fn.conditionNot(parked) });
      if (!(live instanceof CfnCondition)) throw new Error('Invalid Live condition');
      return live;
    },
    number: (whenLive: number, whenParked: number) => Token.asNumber(Fn.conditionIf(parked.logicalId, whenParked, whenLive)),
    string: (whenLive: string, whenParked: string) => Token.asString(Fn.conditionIf(parked.logicalId, whenParked, whenLive)),
  };
}

export function liveResource(scope: Construct, resource: Construct) {
  const cfn = resource instanceof CfnResource ? resource : resource.node.defaultChild;
  if (!(cfn instanceof CfnResource)) throw new Error(`${resource.node.path} has no CloudFormation resource`);
  cfn.cfnOptions.condition = parkState(scope).liveCondition;
}

export function parkServiceIngress(service: ecs.FargateService, target: elb.ApplicationTargetGroup, origin: Stack, containerName: string, port: number) {
  const state = parkState(origin);
  const cfnService = service.node.defaultChild as ecs.CfnService;
  cfnService.node.removeDependency(target.loadBalancerAttached);
  cfnService.addPropertyOverride('LoadBalancers', Fn.conditionIf(state.parkedCondition.logicalId, [], [{ ContainerName: containerName, ContainerPort: port, TargetGroupArn: target.targetGroupArn }]));
  for (const resource of origin.node.findAll()) {
    if (resource instanceof elb.CfnListenerRule) {
      resource.cfnOptions.condition = state.liveCondition;
      cfnService.tags.setTag(`ParkingListener${origin.getLogicalId(resource)}`, state.string(resource.ref, 'parked'));
    }
  }
}
