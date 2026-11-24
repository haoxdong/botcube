import { CfnCondition, CfnParameter, CfnResource, Fn, Stack, Token } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

export function parkState(scope: Construct) {
  const stack = Stack.of(scope);
  const parameter = stack.node.tryFindChild('ProductionMode') ?? new CfnParameter(stack, 'ProductionMode', {
    type: 'String', allowedValues: ['parked', 'egress', 'credential', 'live'], description: 'Production resource mode.',
  });
  if (!(parameter instanceof CfnParameter)) throw new Error('ProductionMode must be a CloudFormation parameter');
  parameter.overrideLogicalId('productionMode');
  const condition = (name: string, expression: import('aws-cdk-lib').ICfnConditionExpression) => {
    const found = stack.node.tryFindChild(name) ?? new CfnCondition(stack, name, { expression });
    if (!(found instanceof CfnCondition)) throw new Error(`Invalid ${name} condition`);
    return found;
  };
  const live = condition('Live', Fn.conditionEquals(parameter.valueAsString, 'live'));
  const parked = condition('Parked', Fn.conditionNot(live));
  const egress = condition('EgressEnabled', Fn.conditionNot(Fn.conditionEquals(parameter.valueAsString, 'parked')));
  const credential = condition('CredentialEnabled', Fn.conditionOr(
    Fn.conditionEquals(parameter.valueAsString, 'credential'), Fn.conditionEquals(parameter.valueAsString, 'live')));
  return {
    parkedCondition: parked,
    liveCondition: live,
    egressCondition: egress,
    credentialCondition: credential,
    credentialNumber: (enabled: number, disabled: number) => Token.asNumber(Fn.conditionIf(credential.logicalId, enabled, disabled)),
    number: (whenLive: number, whenParked: number) => Token.asNumber(Fn.conditionIf(live.logicalId, whenLive, whenParked)),
    string: (whenLive: string, whenParked: string) => Token.asString(Fn.conditionIf(live.logicalId, whenLive, whenParked)),
  };
}

export function originState(scope: Construct) {
  const stack = Stack.of(scope);
  const state = parkState(scope);
  const parameter = stack.node.tryFindChild('PrepareOrigin') ?? new CfnParameter(stack, 'PrepareOrigin', {
    type: 'String', allowedValues: ['false', 'true'], default: 'false', description: 'Prepare origin ingress without activating services or the public edge.',
  });
  if (!(parameter instanceof CfnParameter)) throw new Error('PrepareOrigin must be a CloudFormation parameter');
  parameter.overrideLogicalId('prepareOrigin');
  const infrastructure = stack.node.tryFindChild('OriginInfrastructureEnabled') ?? new CfnCondition(stack, 'OriginInfrastructureEnabled', {
    expression: Fn.conditionOr(state.liveCondition, Fn.conditionEquals(parameter.valueAsString, 'true')),
  });
  if (!(infrastructure instanceof CfnCondition)) throw new Error('Invalid origin infrastructure condition');
  return { ...state, infrastructureCondition: infrastructure };
}

export function conditionalResource(scope: Construct, resource: Construct, condition = parkState(scope).liveCondition) {
  const cfn = resource instanceof CfnResource ? resource : resource.node.defaultChild;
  if (!(cfn instanceof CfnResource)) throw new Error(`${resource.node.path} has no CloudFormation resource`);
  cfn.cfnOptions.condition = condition;
}

export function parkServiceIngress(service: ecs.FargateService, target: elb.ApplicationTargetGroup, origin: Stack, containerName: string, port: number, retainOrigin: boolean) {
  const infrastructure = retainOrigin ? undefined : originState(origin).infrastructureCondition;
  const cfnService = service.node.defaultChild as ecs.CfnService;
  cfnService.node.removeDependency(target.loadBalancerAttached);
  const attachment = [{ ContainerName: containerName, ContainerPort: port, TargetGroupArn: target.targetGroupArn }];
  cfnService.addPropertyOverride('LoadBalancers', infrastructure ? Fn.conditionIf(infrastructure.logicalId, attachment, []) : attachment);
  for (const resource of origin.node.findAll()) {
    if (resource instanceof elb.CfnListenerRule) {
      if (infrastructure) resource.cfnOptions.condition = infrastructure;
      const listener = infrastructure ? Token.asString(Fn.conditionIf(infrastructure.logicalId, resource.ref, 'parked')) : resource.ref;
      cfnService.tags.setTag(`ParkingListener${origin.getLogicalId(resource)}`, listener);
    }
  }
}
