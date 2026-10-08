import { optionalPhysicalName } from './physical-name.js';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rum from 'aws-cdk-lib/aws-rum';
import { Construct } from 'constructs';

export interface WebLatencyStackProps extends StackProps {
  identityPoolName?: string;
  guestRoleName?: string;
  readerRoleName?: string;
  sessionSampleRate?: number;
  appMonitorName: string;
  /** The hostnames whose pages report, each the web's own or its Dev environment's. */
  domains: string[];
  /** The GitHub OIDC subject of the workflow that reads the metrics: the repository's main branch. */
  readerSubject: string;
  /** The moments the web is held to, each its own Latency metric. */
  moments: string[];
}

/** The custom metric namespace; CloudWatch RUM publishes it as `RUM/CustomMetrics/<namespace>`. */
const WEB_LATENCY_NAMESPACE = 'WebLatency';

/**
 * The CloudWatch RUM app monitor the web reports its latency moments to: each `latency` event (botcube/ui/web
 * `latency.ts`) becomes a `Latency` metric, in milliseconds, with the moment as its dimension, named as in the
 * Cartridge's latency-budgets.json. Pages report as guests of a Cognito identity pool that may only put RUM events.
 */
export class WebLatencyStack extends Stack {
  constructor(scope: Construct, id: string, props: WebLatencyStackProps) {
    super(scope, id, props);
    const pool = new cognito.CfnIdentityPool(this, 'Guests', { allowUnauthenticatedIdentities: true, ...optionalPhysicalName('identityPoolName', props.identityPoolName) });
    const guest = new iam.Role(this, 'Guest', {
      ...optionalPhysicalName('roleName', props.guestRoleName),
      assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
        StringEquals: { 'cognito-identity.amazonaws.com:aud': pool.ref },
        'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'unauthenticated' },
      }, 'sts:AssumeRoleWithWebIdentity'),
    });
    guest.addToPolicy(new iam.PolicyStatement({
      actions: ['rum:PutRumEvents'],
      resources: [this.formatArn({ service: 'rum', resource: 'appmonitor', resourceName: props.appMonitorName })],
    }));
    new cognito.CfnIdentityPoolRoleAttachment(this, 'GuestRole', { identityPoolId: pool.ref, roles: { unauthenticated: guest.roleArn } });
    const monitor = new rum.CfnAppMonitor(this, 'AppMonitor', {
      name: props.appMonitorName,
      domainList: props.domains,
      cwLogEnabled: false,
      customEvents: { status: 'ENABLED' },
      appMonitorConfiguration: {
        identityPoolId: pool.ref,
        guestRoleArn: guest.roleArn,
        sessionSampleRate: props.sessionSampleRate ?? 1,
        telemetries: [],
        allowCookies: false,
        enableXRay: false,
        metricDestinations: [{
          destination: 'CloudWatch',
          // RUM accepts a dimension only when the pattern names its field, and a pattern array only with one value.
          metricDefinitions: props.moments.map(moment => ({
            name: 'Latency',
            namespace: WEB_LATENCY_NAMESPACE,
            unitLabel: 'Milliseconds',
            valueKey: 'event_details.durationMs',
            dimensionKeys: { 'event_details.moment': 'Moment' },
            eventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: [moment] } }),
          })),
        }],
      },
    });
    // The daily Latency budgets workflow reads the metrics, and nothing else, from main.
    const reader = new iam.Role(this, 'Reader', {
      ...optionalPhysicalName('roleName', props.readerRoleName),
      assumedBy: new iam.FederatedPrincipal(this.formatArn({ service: 'iam', region: '', resource: 'oidc-provider', resourceName: 'token.actions.githubusercontent.com' }), {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': props.readerSubject },
      }, 'sts:AssumeRoleWithWebIdentity'),
    });
    reader.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics'], resources: ['*'] }));
    new CfnOutput(this, 'AppMonitorId', { value: monitor.attrId });
    new CfnOutput(this, 'IdentityPoolId', { value: pool.ref });
    new CfnOutput(this, 'ReaderRoleArn', { value: reader.roleArn });
  }
}
