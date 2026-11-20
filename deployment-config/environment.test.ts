import { describe, expect, it } from 'vitest';
import { commandCredentialOptIn, proxyEnvironment } from './environment.js';
import { modelsDeployment } from './models.js';
import { deploymentConfig, type DeploymentConfig } from './schema.js';
import { telemetryDeployment } from './telemetry.js';

const NO_PROXY = 'localhost,127.0.0.1,::1,169.254.169.254,169.254.170.2,.amazonaws.com';
const forward = (proxy: Partial<Extract<DeploymentConfig['proxy'], { kind: 'forward' }>> = {}): Pick<DeploymentConfig, 'proxy'> => ({
  proxy: { kind: 'forward', url: 'http://proxy.example.com:3128', noProxy: ['.amazonaws.com'], ...proxy },
});
const FILE = { kind: 'file', path: '/run/secrets/proxy-token' } as const;
const COMMAND = { kind: 'command', command: ['/usr/local/bin/proxy-token'], timeoutSeconds: 30 } as const;
const COMMAND_CERTIFICATE = { command: ['/usr/local/bin/svid-broker'], timeoutSeconds: 30 } as const;

describe("the deploy's proxy environment", () => {
  it('sends every process straight to a proxy that takes no credential', () => {
    expect(proxyEnvironment(forward())).toEqual({ HTTP_PROXY: 'http://proxy.example.com:3128', HTTPS_PROXY: 'http://proxy.example.com:3128', NO_PROXY, NODE_USE_ENV_PROXY: '1' });
  });

  it("points every process at its own loopback relay, leaving the proxy's credential and headers to the Deployment Config", () => {
    const environment = proxyEnvironment(forward({ credential: FILE, headers: { 'x-egress-route': 'botcube-example' } }));

    expect(environment).toEqual({ HTTP_PROXY: 'http://127.0.0.1:3128', HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY, NODE_USE_ENV_PROXY: '1' });
  });

  it('relays on the port it is given', () => {
    expect(proxyEnvironment(forward({ credential: FILE }), { relayPort: 40123 })).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:40123' });
  });

  it('relays to a proxy with only TLS, whose client certificate the relay reads from the Deployment Config file', () => {
    const tls = { clientCertificate: { certificate: '/run/spiffe/svid.pem', key: '/run/spiffe/svid-key.pem' }, serverIdentity: 'spiffe://example.org/proxy' };

    expect(proxyEnvironment(forward({ url: 'https://proxy.example.com:3129', tls }))).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:3128', HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY, NODE_USE_ENV_PROXY: '1',
    });
  });

  it('gives nothing without a proxy', () => {
    expect(proxyEnvironment({ proxy: { kind: 'none' } })).toEqual({});
  });
});

describe("the deploy's command credential opt-in", () => {
  const withCommand = deploymentConfig.parse({ bot: './bot.json', allowCommandCredentials: true, models: { kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: COMMAND, turnSummaryModel: 'summary' } });
  const withoutCommand = deploymentConfig.parse({ bot: './bot.json' });

  it('passes BOTCUBE_ALLOW_COMMAND_CREDENTIALS through when the operator sets it in the deploy environment', () => {
    expect(commandCredentialOptIn(withCommand, { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' })).toEqual({ BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' });
    expect(commandCredentialOptIn(withoutCommand, { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' })).toEqual({ BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' });
  });

  it('fails a command credential the operator did not opt in to, naming the variable and the field', () => {
    for (const deployEnvironment of [{}, { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: 'true' }]) {
      expect(() => commandCredentialOptIn(withCommand, deployEnvironment))
        .toThrow('models.credential is a command credential, which runs only when the deploy environment sets BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1');
    }
  });

  it("fails an OAuth client secret's command the operator did not opt in to, naming its field", () => {
    const credential = { kind: 'oauth-client-credentials', tokenEndpoint: 'https://login.example.com/oauth2/token', clientId: 'botcube', clientSecret: COMMAND };
    const config = deploymentConfig.parse({ ...withCommand, models: { ...withCommand.models, credential } });

    expect(() => commandCredentialOptIn(config, {}))
      .toThrow('models.credential.clientSecret is a command credential, which runs only when the deploy environment sets BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1');
  });

  it.each([
    ['models.tls.clientCertificate', { models: { ...withCommand.models, credential: FILE, tls: { clientCertificate: COMMAND_CERTIFICATE } } }],
    ['proxy.tls.clientCertificate', { proxy: { kind: 'forward', url: 'https://proxy.example.com:3129', tls: { clientCertificate: COMMAND_CERTIFICATE } } }],
  ])('fails a client certificate command at %s the operator did not opt in to', (field, sections) => {
    const config = deploymentConfig.parse({ bot: './bot.json', allowCommandCredentials: true, ...sections });

    expect(() => commandCredentialOptIn(config, {}))
      .toThrow(`${field} is a command credential, which runs only when the deploy environment sets BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1`);
  });

  it('gives nothing when the config runs no command and the operator set nothing', () => {
    expect(commandCredentialOptIn(withoutCommand, {})).toEqual({});
  });

  it('is never derived from the Deployment Config by a seam', () => {
    const telemetry = telemetryDeployment({ kind: 'otlp', url: 'http://collector:4318/v1/traces', credential: COMMAND });
    const environments = [telemetry.chatService, telemetry.harness, proxyEnvironment(forward({ credential: FILE }))];
    expect(environments.filter((environment) => 'BOTCUBE_ALLOW_COMMAND_CREDENTIALS' in environment)).toEqual([]);
  });
});

describe("the deploy's secret grants", () => {
  const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:oauth-client-AbCdEf';
  const oauthClient = {
    kind: 'oauth-client-credentials',
    tokenEndpoint: 'https://login.example.com/oauth2/token',
    clientId: 'botcube',
    clientSecret: { kind: 'secret', secretArn: SECRET_ARN },
  } as const;

  it("grants the secret an OAuth client's secret is read from, for models and telemetry", () => {
    const models = modelsDeployment({ kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: oauthClient, turnSummaryModel: 'summary', wire: 'chat-completions' });
    const telemetry = telemetryDeployment({ kind: 'otlp', url: 'https://collector.example.com/v1/traces', credential: oauthClient });

    expect(models?.secretArns).toEqual([SECRET_ARN]);
    expect(telemetry.secretArns).toEqual([SECRET_ARN]);
  });
});
