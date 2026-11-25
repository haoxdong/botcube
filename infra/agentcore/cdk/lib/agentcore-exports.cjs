const { ArnFormat, Duration } = require('aws-cdk-lib');
const { PolicyStatement } = require('aws-cdk-lib/aws-iam');
const { sessionApiScaling } = require('botcube-config/session-api-capacity');

const sessionApiAlias = 'live';

function sessionApiExports(stack, functionName) {
  const functionArn = stack.formatArn({
    service: 'lambda',
    resource: 'function',
    resourceName: functionName,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
  const invokeArn = `${functionArn}:${sessionApiAlias}`;
  return {
    invokeArn,
    capacity: {
      functionName,
      alias: sessionApiAlias,
      resourceId: `function:${functionName}:${sessionApiAlias}`,
      serviceNamespace: 'lambda',
      scalableDimension: 'lambda:function:ProvisionedConcurrency',
    },
    addAlias(fn) {
      const alias = fn.addAlias(sessionApiAlias);
      alias
        .addAutoScaling({ minCapacity: sessionApiScaling.min, maxCapacity: sessionApiScaling.max })
        .scaleOnUtilization({
          utilizationTarget: sessionApiScaling.utilization,
          scaleOutCooldown: Duration.minutes(1),
          scaleInCooldown: Duration.minutes(15),
        });
      return alias;
    },
    grantInvoke(role) {
      role.addToPrincipalPolicy(new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [invokeArn] }));
    },
    grantCapacityControl(role) {
      role.addToPrincipalPolicy(
        new PolicyStatement({
          actions: [
            'lambda:GetProvisionedConcurrencyConfig',
            'lambda:PutProvisionedConcurrencyConfig',
            'lambda:DeleteProvisionedConcurrencyConfig',
            'lambda:ListProvisionedConcurrencyConfigs',
            'lambda:GetAlias',
            'lambda:UpdateAlias',
          ],
          resources: [functionArn, `${functionArn}:*`],
        })
      );
      // RegisterScalableTarget checks alarm permissions (production transition 5e5fb38a).
      role.addToPrincipalPolicy(
        new PolicyStatement({
          actions: [
            'application-autoscaling:DescribeScalableTargets',
            'application-autoscaling:RegisterScalableTarget',
            'cloudwatch:PutMetricAlarm',
            'cloudwatch:DescribeAlarms',
            'cloudwatch:DeleteAlarms',
          ],
          resources: ['*'],
        })
      );
    },
  };
}

module.exports = { sessionApiExports };
