import { optionalPhysicalName } from './physical-name.js';
import * as path from 'node:path';
import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as custom from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { isIP } from 'node:net';

export interface PreviewOriginProps extends StackProps {
  securityGroupName?: string;
  connectionLogsBucketName?: string;
  trustStoreName?: string;
  loadBalancerName?: string;
  /** Names for our handlers; CDK Provider framework helpers keep generated names. */
  providerNames?: Partial<Record<'on_event' | 'is_complete', {
    functionName?: string;
    logGroupName?: string;
    roleName?: string;
  }>>;
  providerTimeoutSeconds?: number;
  providerLogRetention?: logs.RetentionDays;
  connectionLogExpirationDays?: number;
  clientKeepAliveSeconds?: number;
  vpc?: ec2.IVpc;
  subnets?: ec2.SubnetSelection;
  repositoryRoot: string;
  hostname: string;
  /** Production Chat Service hostname, served by this origin. */
  production: { hostname: string };
  vpcId: string;
  publicSubnets: { id: string; availabilityZone: string }[];
  cloudflareCidrs: string[];
  clientVersion: string;
  tokenSecretName: string;
  clientSecretName: string;
  caPath: string;
  /** The Cartridge's origin-provider Lambda source directory. */
  originProviderPath: string;
  /** Web origins the Chat Service grants credentialed CORS; the parked Worker grants the same. */
  corsOrigins: string[];
  /** Parked deletes the ALB; everything that makes it serve again on unpark stays. */
  parked: boolean;
  /** Proxied DNS target while Parked: an RFC 2606 reserved name, so no origin ever answers. */
  parkedDnsTarget: string;
}

export class PreviewOriginStack extends Stack {
  /** Cloudflare-only ingress, kept in both states so its rules don't churn. */
  readonly securityGroup: ec2.SecurityGroup;
  /** Present only while Live. */
  readonly alb?: { loadBalancer: elb.ApplicationLoadBalancer; listener: elb.ApplicationListener };

  constructor(scope: Construct, id: string, props: PreviewOriginProps) {
    super(scope, id, props);
    if (props.publicSubnets.length < 2 || !props.clientVersion || !props.cloudflareCidrs.length) {
      throw new Error('Preview origin requires two public subnets, client version and Cloudflare ranges');
    }
    for (const cidr of props.cloudflareCidrs) {
      const [address, prefix, extra] = cidr.split('/');
      const family = address === undefined ? 0 : isIP(address);
      if (extra !== undefined || !family || !/^\d+$/.test(String(prefix)) || Number(prefix) <= 0 || Number(prefix) > (family === 4 ? 32 : 128)) {
        throw new Error(`Invalid Cloudflare CIDR: ${cidr}`);
      }
    }
    const vpc = props.vpc ?? ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: props.vpcId,
      availabilityZones: props.publicSubnets.map(s => s.availabilityZone),
      publicSubnetIds: props.publicSubnets.map(s => s.id),
    });
    const securityGroup = this.securityGroup = new ec2.SecurityGroup(this, 'OriginIngress', { vpc, allowAllOutbound: false, ...optionalPhysicalName('securityGroupName', props.securityGroupName) });
    for (const cidr of props.cloudflareCidrs) {
      securityGroup.addIngressRule(cidr.includes(':') ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'Cloudflare HTTPS');
    }
    // aws-cdk-lib's Bucket declares `T | undefined` getters where IBucket declares `prop?: T`,
    // which exactOptionalPropertyTypes rejects; the construct is its interface.
    const connectionLogs = new s3.Bucket(this, 'ConnectionLogs', {
      ...optionalPhysicalName('bucketName', props.connectionLogsBucketName),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: Duration.days(props.connectionLogExpirationDays ?? 30) }],
    }) as s3.IBucket;
    const ca = new assets.Asset(this, 'OriginPullCa', { path: path.join(props.repositoryRoot, props.caPath) });
    const trustStore = new elb.TrustStore(this, 'OriginTrust', { bucket: ca.bucket, key: ca.s3ObjectKey, ...optionalPhysicalName('trustStoreName', props.trustStoreName) });
    const token = secrets.Secret.fromSecretNameV2(this, 'CloudflareToken', props.tokenSecretName);
    const client = secrets.Secret.fromSecretNameV2(this, 'OriginClient', props.clientSecretName);
    const providerCode = lambda.Code.fromAsset(props.originProviderPath, {
      exclude: ['__pycache__', 'test_handler.py', 'parked-worker.test.ts'],
    });
    const providerHandler = (handler: 'on_event' | 'is_complete') => {
      const names = props.providerNames?.[handler];
      const fn = new lambda.Function(this, handler, {
        ...optionalPhysicalName('functionName', names?.functionName),
        runtime: lambda.Runtime.PYTHON_3_12, code: providerCode, handler: `handler.${handler}`,
        timeout: Duration.seconds(props.providerTimeoutSeconds ?? 120),
        environment: { TOKEN_SECRET: props.tokenSecretName, CLIENT_SECRET: props.clientSecretName, HOSTNAMES: [props.hostname, props.production.hostname].join(',') },
        logGroup: new logs.LogGroup(this, `${handler}Logs`, { ...optionalPhysicalName('logGroupName', names?.logGroupName), retention: props.providerLogRetention ?? logs.RetentionDays.ONE_WEEK }),
      });
      if (names?.roleName !== undefined) (fn.role?.node.defaultChild as iam.CfnRole).roleName = names.roleName;
      token.grantRead(fn);
      client.grantRead(fn);
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['acm:RequestCertificate'], resources: ['*'] }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['acm:DescribeCertificate', 'acm:DeleteCertificate', 'acm:AddTagsToCertificate'],
        resources: [this.formatArn({ service: 'acm', resource: 'certificate', resourceName: '*' })],
      }));
      return fn;
    };
    const provider = new custom.Provider(this, 'OriginProvider', {
      onEventHandler: providerHandler('on_event'), isCompleteHandler: providerHandler('is_complete'),
      queryInterval: Duration.seconds(20), totalTimeout: Duration.minutes(30),
      disableWaiterStateMachineLogging: true,
    });
    const common = { serviceToken: provider.serviceToken };
    const certificate = new CustomResource(this, 'ServerCertificate', {
      ...common, properties: { Kind: 'Certificate', Hostname: props.hostname },
    });
    const productionCertificate = new CustomResource(this, 'ProductionCertificate', {
      ...common, properties: { Kind: 'Certificate', Hostname: props.production.hostname },
    });
    const aop = new CustomResource(this, 'PreviewAop', {
      ...common, properties: { Kind: 'Aop', Hostname: props.hostname, ClientVersion: props.clientVersion },
    });
    const productionAop = new CustomResource(this, 'ProductionAop', {
      ...common, properties: { Kind: 'Aop', Hostname: props.production.hostname, ClientVersion: props.clientVersion, CertId: aop.ref },
    });
    new CfnOutput(this, 'SecurityGroupId', { value: securityGroup.securityGroupId });
    new CfnOutput(this, 'ConnectionLogsBucket', { value: connectionLogs.bucketName });
    new CfnOutput(this, 'ClientCertificateId', { value: aop.ref });
    new CfnOutput(this, 'ProductionClientCertificateId', { value: productionAop.ref });
    // Records stay proxied while Parked, so a Cloudflare Worker route can still answer.
    const dns = (id: string, hostname: string, dependency: Construct, target: string) => {
      const record = new CustomResource(this, id, { ...common, properties: { Kind: 'Dns', Hostname: hostname, Target: target } });
      record.node.addDependency(dependency);
      return record;
    };
    if (props.parked) {
      // Answers every request with 503 {"status":"parked"}; unpark deletes it after the ALB serves again.
      const worker = new CustomResource(this, 'ParkedWorker', {
        ...common, properties: { Kind: 'ParkedWorker', Hostnames: [props.production.hostname, props.hostname], Origins: props.corsOrigins },
      });
      // The Worker routes before DNS leaves the ALB, so no request meets an unanswered name.
      dns('PreviewDns', props.hostname, aop, props.parkedDnsTarget).node.addDependency(worker);
      dns('ProductionDns', props.production.hostname, productionAop, props.parkedDnsTarget).node.addDependency(worker);
      return;
    }
    const loadBalancer = new elb.ApplicationLoadBalancer(this, 'Origin', {
      vpc, internetFacing: true,
      ...optionalPhysicalName('loadBalancerName', props.loadBalancerName),
      ...(props.subnets ? { vpcSubnets: props.subnets } : {}),
      securityGroup,
      dropInvalidHeaderFields: true, clientKeepAlive: Duration.seconds(props.clientKeepAliveSeconds ?? 60),
    });
    loadBalancer.logConnectionLogs(connectionLogs, 'origin');
    const listener = loadBalancer.addListener('Https', {
      port: 443, open: false,
      certificates: [
        acm.Certificate.fromCertificateArn(this, 'ServerIdentity', certificate.getAttString('Arn')),
        acm.Certificate.fromCertificateArn(this, 'ProductionIdentity', productionCertificate.getAttString('Arn')),
      ],
      sslPolicy: elb.SslPolicy.TLS13_RES,
      mutualAuthentication: { mutualAuthenticationMode: elb.MutualAuthenticationMode.VERIFY, trustStore, ignoreClientCertificateExpiry: false },
      defaultAction: elb.ListenerAction.fixedResponse(503, { contentType: 'text/plain', messageBody: 'Preview Chat Service unavailable\n' }),
    });
    aop.node.addDependency(listener);
    productionAop.node.addDependency(listener);
    dns('PreviewDns', props.hostname, aop, loadBalancer.loadBalancerDnsName);
    dns('ProductionDns', props.production.hostname, productionAop, loadBalancer.loadBalancerDnsName);
    this.alb = { loadBalancer, listener };
    new CfnOutput(this, 'ListenerArn', { value: listener.listenerArn });
    new CfnOutput(this, 'LoadBalancerArn', { value: loadBalancer.loadBalancerArn });
    new CfnOutput(this, 'OriginDnsName', { value: loadBalancer.loadBalancerDnsName });
  }
}
