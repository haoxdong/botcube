import { ok as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, FileSystem } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { repositoryRoot, caPath, originProviderPath } from './origin-fixture';
import { PreviewOriginStack, type PreviewOriginProps } from '../lib/preview-origin-stack.js';

const props: PreviewOriginProps = {
  hostname: 'preview.example.com',
  production: { hostname: 'api.example.com' },
  env: { account: '123456789012', region: 'us-east-1' },
  repositoryRoot, originProviderPath,
  vpcId: 'vpc-fixture12345678', publicSubnets: [{ id: 'subnet-fixture12345678', availabilityZone: 'us-east-1a' }, { id: 'subnet-fixture23456789', availabilityZone: 'us-east-1b' }],
  cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version',
  tokenSecretName: '/test/token', clientSecretName: '/test/client',
  caPath, corsOrigins: ['https://web.example.com'],
  parked: false, parkedDnsTarget: 'parked.invalid',
};
test('preview requires Cloudflare HTTPS and private mTLS with no HTTP listener', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 443, Protocol: 'HTTPS', MutualAuthentication: { Mode: 'verify', TrustStoreArn: Match.anyValue(), IgnoreClientCertificateExpiry: false },
    DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '503', ContentType: 'text/plain', MessageBody: 'Preview Chat Service unavailable\n' } }],
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: [{ CidrIp: '173.245.48.0/20', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Description: 'Cloudflare HTTPS' }],
  });
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TrustStore', 1);
  template.hasResourceProperties('AWS::CloudFormation::CustomResource', { Kind: 'Dns', Hostname: 'preview.example.com' });
  template.hasResourceProperties('AWS::CloudFormation::CustomResource', { Kind: 'Aop', Hostname: 'preview.example.com', ClientVersion: 'version' });
  expect(JSON.stringify(template.toJSON())).not.toContain('PRIVATE KEY');
});
test('production hostname gets certificate, AOP, and DNS on this origin', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'Production', props));
  const resources = Object.entries(template.findResources('AWS::CloudFormation::CustomResource'));
  const find = (kind: string, hostname: string) => {
    const resource = resources.find(([, r]) => r.Properties.Kind === kind && r.Properties.Hostname === hostname);
    assert(resource, `${kind} for ${hostname}`);
    return resource;
  };
  expect(resources.filter(([, r]) => r.Properties.Hostname === 'api.example.com').map(([, r]) => r.Properties.Kind).sort()).toEqual(['Aop', 'Certificate', 'Dns']);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerCertificate', { Certificates: [{ CertificateArn: Match.anyValue() }] });
  template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ HOSTNAMES: 'preview.example.com,api.example.com' }) } });
  const [dnsId, dns] = find('Dns', 'api.example.com');
  const [aopId, aop] = find('Aop', 'api.example.com');
  expect(Object.keys(dns.Properties).sort()).toEqual(['Hostname', 'Kind', 'ServiceToken', 'Target']);
  expect(template.toJSON().Resources[dnsId].DependsOn).toContain(aopId);
  expect(aop.Properties.CertId).toEqual({ Ref: find('Aop', 'preview.example.com')[0] });
});
test('the origin ALB is internet-facing in the public subnets behind only the Cloudflare ingress group', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  const [ingress] = Object.keys(template.findResources('AWS::EC2::SecurityGroup'));
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing', Subnets: ['subnet-fixture12345678', 'subnet-fixture23456789'], SecurityGroups: [{ 'Fn::GetAtt': [ingress, 'GroupId'] }],
  });
});
test('Cloudflare IPv6 ranges admit HTTPS by IPv6 CIDR', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', { ...props, cloudflareCidrs: ['173.245.48.0/32', '2400:cb00::/128'] }));
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: [
      { CidrIp: '173.245.48.0/32', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Description: 'Cloudflare HTTPS' },
      { CidrIpv6: '2400:cb00::/128', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Description: 'Cloudflare HTTPS' },
    ],
  });
});
test.each([
  ['one public subnet', { publicSubnets: props.publicSubnets.slice(0, 1) }],
  ['no client version', { clientVersion: '' }],
  ['no Cloudflare ranges', { cloudflareCidrs: [] }],
])('rejects %s before synthesizing', (_case, override) => {
  expect(() => new PreviewOriginStack(new App(), 'Bad', { ...props, ...override }))
    .toThrow(new Error('Preview origin requires two public subnets, client version and Cloudflare ranges'));
});
test.each(['0.0.0.0/0', 'bad/20', '1.2.3.4', '1.2.3.4/x', '1.2.3.4/x20', '1.2.3.4/20x','1.2.3.4/33', '2400:cb00::/129', '1.2.3.4/20/1'])('rejects the Cloudflare range %s', range => {
  expect(() => new PreviewOriginStack(new App(), 'Bad', { ...props, cloudflareCidrs: [range] })).toThrow(new Error(`Invalid Cloudflare CIDR: ${range}`));
});

const provider = { 'Fn::GetAtt': ['OriginProviderframeworkonEvent2E9E500B', 'Arn'] };

test('the ingress group allows no outbound traffic', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupEgress: [{ CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic', FromPort: 252, IpProtocol: 'icmp', ToPort: 86 }],
  });
});

test('the ALB drops invalid headers, keeps clients alive a minute and logs connections to a private, TLS-only bucket kept 30 days', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  const [bucketEntry] = Object.entries(template.findResources('AWS::S3::Bucket'));
  assert(bucketEntry);
  const [bucketId, bucket] = bucketEntry;
  expect(bucket).toEqual({
    Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
    Properties: {
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      LifecycleConfiguration: { Rules: [{ ExpirationInDays: 30, Status: 'Enabled' }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    },
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', { PolicyDocument: { Statement: Match.arrayWith([
    Match.objectLike({ Effect: 'Deny', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
  ]) } });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { LoadBalancerAttributes: [
    { Key: 'deletion_protection.enabled', Value: 'false' },
    { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
    { Key: 'client_keep_alive.seconds', Value: '60' },
    { Key: 'connection_logs.s3.enabled', Value: 'true' },
    { Key: 'connection_logs.s3.bucket', Value: { Ref: bucketId } },
    { Key: 'connection_logs.s3.prefix', Value: 'origin' },
  ] });
});

test('the HTTPS listener serves both hostnames certificates under the TLS 1.3 policy', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Certificates: [{ CertificateArn: { 'Fn::GetAtt': ['ServerCertificate', 'Arn'] } }],
    SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-Res-2021-06',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerCertificate', { Certificates: [{ CertificateArn: { 'Fn::GetAtt': ['ProductionCertificate', 'Arn'] } }] });
});

test('the trust store holds the Cloudflare origin-pull CA', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  const ca = FileSystem.fingerprint(path.join(props.repositoryRoot, props.caPath));
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TrustStore', { CaCertificatesBundleS3Key: `${ca}.crt` });
});

test('the provider creates each certificate, AOP and DNS record through one handler', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  const custom = Object.fromEntries(Object.entries(template.findResources('AWS::CloudFormation::CustomResource'))
    .map(([id, resource]) => [id, { ...resource.Properties, DependsOn: resource.DependsOn }]));
  const listener = ['OriginHttpsDefaultCertificates1B8347611', 'OriginHttpsAC81CBD6'];
  const target = { 'Fn::GetAtt': ['OriginBCF5A9D0', 'DNSName'] };
  expect(custom).toEqual({
    ServerCertificate: { ServiceToken: provider, Kind: 'Certificate', Hostname: 'preview.example.com' },
    ProductionCertificate: { ServiceToken: provider, Kind: 'Certificate', Hostname: 'api.example.com' },
    PreviewAop: { ServiceToken: provider, Kind: 'Aop', Hostname: 'preview.example.com', ClientVersion: 'version', DependsOn: listener },
    ProductionAop: { ServiceToken: provider, Kind: 'Aop', Hostname: 'api.example.com', ClientVersion: 'version', CertId: { Ref: 'PreviewAop' }, DependsOn: listener },
    PreviewDns: { ServiceToken: provider, Kind: 'Dns', Hostname: 'preview.example.com', Target: target, DependsOn: ['PreviewAop'] },
    ProductionDns: { ServiceToken: provider, Kind: 'Dns', Hostname: 'api.example.com', Target: target, DependsOn: ['ProductionAop'] },
  });
});

test('the provider polls every 20 seconds for 30 minutes without waiter logs', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  const [machine] = Object.values(template.findResources('AWS::StepFunctions::StateMachine')).map(resource => resource.Properties);
  expect(machine.LoggingConfiguration).toBeUndefined();
  expect(machine.DefinitionString['Fn::Join'][1][0]).toContain('"IntervalSeconds":20,"MaxAttempts":90,');
});

test('each provider handler reads both secrets and both hostnames and may manage only ACM certificates', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  const functions = Object.values(template.findResources('AWS::Lambda::Function')).map(resource => resource.Properties)
    .filter(fn => fn.Handler.startsWith('handler.'));
  const secret = (name: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:secretsmanager:us-east-1:123456789012:secret:${name}-??????`]] });
  expect(functions.map(fn => fn.Handler)).toEqual(['handler.on_event', 'handler.is_complete']);
  for (const fn of functions) {
    expect(fn).toMatchObject({
      Runtime: 'python3.12', Timeout: 120,
      Environment: { Variables: { TOKEN_SECRET: '/test/token', CLIENT_SECRET: '/test/client', HOSTNAMES: 'preview.example.com,api.example.com' } },
    });
    expect(template.toJSON().Resources[fn.LoggingConfig.LogGroup.Ref].Properties).toEqual({ RetentionInDays: 7 });
    const [policy] = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(resource => resource.Properties.Roles[0].Ref === fn.Role['Fn::GetAtt'][0]);
    assert(policy);
    expect(policy.Properties.PolicyDocument.Statement).toEqual([
      { Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], Effect: 'Allow', Resource: secret('/test/token') },
      { Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], Effect: 'Allow', Resource: secret('/test/client') },
      { Action: 'acm:RequestCertificate', Effect: 'Allow', Resource: '*' },
      { Action: ['acm:DescribeCertificate', 'acm:DeleteCertificate', 'acm:AddTagsToCertificate'], Effect: 'Allow',
        Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':acm:us-east-1:123456789012:certificate/*']] } },
    ]);
  }
});

test('the provider bundle ships the handler and parked Worker without tests or bytecode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-provider-'));
  const bundled = ['handler.py', 'parked-worker.mjs'];
  const write = (dir: string, files: string[]) => {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), file);
    }
  };
  write(path.join(root, 'origin-provider'), [...bundled, 'test_handler.py', 'parked-worker.test.ts', '__pycache__/handler.pyc']);
  write(path.join(root, 'expected'), bundled);
  fs.mkdirSync(path.dirname(path.join(root, props.caPath)), { recursive: true });
  fs.copyFileSync(path.join(props.repositoryRoot, props.caPath), path.join(root, props.caPath));
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', { ...props, repositoryRoot: root, originProviderPath: path.join(root, 'origin-provider') }));
  const keys = Object.values(template.findResources('AWS::Lambda::Function')).map(resource => resource.Properties)
    .filter(fn => fn.Handler.startsWith('handler.')).map(fn => fn.Code.S3Key);
  expect(keys).toEqual(Array(2).fill(`${FileSystem.fingerprint(path.join(root, 'expected'))}.zip`));
});

test('the stack outputs the ids later deploy steps read', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'TestOrigin', props));
  expect(template.toJSON().Outputs).toEqual({
    SecurityGroupId: { Value: { 'Fn::GetAtt': ['OriginIngress640B9738', 'GroupId'] } },
    ConnectionLogsBucket: { Value: { Ref: 'ConnectionLogs37703DFE' } },
    ClientCertificateId: { Value: { Ref: 'PreviewAop' } },
    ProductionClientCertificateId: { Value: { Ref: 'ProductionAop' } },
    ListenerArn: { Value: { Ref: 'OriginHttpsAC81CBD6' } },
    LoadBalancerArn: { Value: { Ref: 'OriginBCF5A9D0' } },
    OriginDnsName: { Value: { 'Fn::GetAtt': ['OriginBCF5A9D0', 'DNSName'] } },
  });
});

test('adopters name origin resources and both provider handlers without naming CDK helpers', () => {
  const template = Template.fromStack(new PreviewOriginStack(new App(), 'NamedOrigin', {
    ...props, securityGroupName: 'adopter-ingress', connectionLogsBucketName: 'adopter-origin-logs',
    trustStoreName: 'adopter-trust', loadBalancerName: 'adopter-origin',
    providerNames: {
      on_event: { functionName: 'adopter-event', logGroupName: '/adopter/event', roleName: 'adopter-event-role' },
      is_complete: { functionName: 'adopter-complete', logGroupName: '/adopter/complete', roleName: 'adopter-complete-role' },
    },
  }));
  template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: 'adopter-ingress' });
  template.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'adopter-origin-logs' });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TrustStore', { Name: 'adopter-trust' });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Name: 'adopter-origin' });
  for (const [functionName, logGroupName, roleName] of [
    ['adopter-event', '/adopter/event', 'adopter-event-role'],
    ['adopter-complete', '/adopter/complete', 'adopter-complete-role'],
  ]) {
    template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: functionName });
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: logGroupName });
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: roleName });
  }
});
