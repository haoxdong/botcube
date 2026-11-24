import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandCredentialOptIn, trustEnvironment } from './environment.js';
import { modelGatewayResources } from './models.js';
import { botcubeConfig } from './schema.js';
import { telemetryEnvironment } from './telemetry.js';

/** The keys every BotCube Config gives. */
const REQUIRED = JSON.parse(readFileSync(new URL('../tests/required-keys.json', import.meta.url), 'utf8'));

const FILE = { kind: 'file', path: '/run/secrets/models-token' } as const;
const COMMAND = { kind: 'command', command: ['/usr/local/bin/proxy-token'], timeoutSeconds: 30 } as const;
const COMMAND_CERTIFICATE = { command: ['/usr/local/bin/svid-broker'], timeoutSeconds: 30 } as const;

describe("the deploy's trust roots", () => {
  it("points each runtime's standard variable at the BotCube Config's caBundle", () => {
    const config = botcubeConfig.parse({ ...REQUIRED, caBundle: '/etc/botcube/ca-bundle.pem' });

    expect(trustEnvironment(config)).toEqual({
      SSL_CERT_FILE: '/etc/botcube/ca-bundle.pem', NODE_EXTRA_CA_CERTS: '/etc/botcube/ca-bundle.pem', REQUESTS_CA_BUNDLE: '/etc/botcube/ca-bundle.pem',
    });
  });

  it("leaves each image's own roots without a caBundle", () => {
    expect(trustEnvironment(botcubeConfig.parse(REQUIRED))).toEqual({});
  });

  it('refuses a caBundle that is no absolute path', () => {
    expect(() => botcubeConfig.parse({ ...REQUIRED, caBundle: 'ca-bundle.pem' })).toThrow('Expected an absolute path');
  });
});

describe("the deploy's command credential opt-in", () => {
  const withCommand = botcubeConfig.parse({ ...REQUIRED, allowCommandCredentials: true, integrations: { modelGateway: { kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: COMMAND } } });
  const withoutCommand = botcubeConfig.parse(REQUIRED);

  it('passes BOTCUBE_ALLOW_COMMAND_CREDENTIALS through when the operator sets it in the deploy environment', () => {
    expect(commandCredentialOptIn(withCommand, { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' })).toEqual({ BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' });
    expect(commandCredentialOptIn(withoutCommand, { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' })).toEqual({ BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' });
  });

  it('fails a command credential the operator did not opt in to, naming the variable and the field', () => {
    for (const deployEnvironment of [{}, { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: 'true' }]) {
      expect(() => commandCredentialOptIn(withCommand, deployEnvironment))
        .toThrow('integrations.modelGateway.credential is a command credential, which runs only when the deploy environment sets BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1');
    }
  });

  it("fails an OAuth client secret's command the operator did not opt in to, naming its field", () => {
    const credential = { kind: 'oauth-client-credentials', tokenEndpoint: 'https://login.example.com/oauth2/token', clientId: 'botcube', clientSecret: COMMAND };
    const config = botcubeConfig.parse({ ...withCommand, integrations: { modelGateway: { ...withCommand.integrations.modelGateway, credential } } });

    expect(() => commandCredentialOptIn(config, {}))
      .toThrow('integrations.modelGateway.credential.clientSecret is a command credential, which runs only when the deploy environment sets BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1');
  });

  it.each([
    ['integrations.modelGateway.tls.clientCertificate', { integrations: { modelGateway: { ...withCommand.integrations.modelGateway, credential: FILE, tls: { clientCertificate: COMMAND_CERTIFICATE } } } }],
    ['integrations.proxy.tls.clientCertificate', { integrations: { proxy: { kind: 'forward', url: 'https://proxy.example.com:3129', tls: { clientCertificate: COMMAND_CERTIFICATE } } } }],
  ])('fails a client certificate command at %s the operator did not opt in to', (field, sections) => {
    const config = botcubeConfig.parse({ ...REQUIRED, allowCommandCredentials: true, ...sections });

    expect(() => commandCredentialOptIn(config, {}))
      .toThrow(`${field} is a command credential, which runs only when the deploy environment sets BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1`);
  });

  it('gives nothing when the config runs no command and the operator set nothing', () => {
    expect(commandCredentialOptIn(withoutCommand, {})).toEqual({});
  });

  it('is never derived from the BotCube Config by a seam', () => {
    const telemetry = telemetryEnvironment({ kind: 'otlp', url: 'http://collector:4318/v1/traces', credential: COMMAND });
    const environments = [telemetry.chatService, telemetry.harness, trustEnvironment({ caBundle: '/etc/botcube/ca-bundle.pem' })];
    expect(environments.filter((environment) => 'BOTCUBE_ALLOW_COMMAND_CREDENTIALS' in environment)).toEqual([]);
  });
});

describe("the deploy's secret grants", () => {
  const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:oauth-client-AbCdEf';
  const oauthClient = {
    kind: 'oauth-client-credentials',
    tokenEndpoint: 'https://login.example.com/oauth2/token',
    clientId: 'botcube',
    clientSecret: { kind: 'secret', secretId: SECRET_ARN },
  } as const;

  it("grants the secret an OAuth client's secret is read from, for models and telemetry", () => {
    const models = modelGatewayResources({ kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: oauthClient });
    const telemetry = telemetryEnvironment({ kind: 'otlp', url: 'https://collector.example.com/v1/traces', credential: oauthClient });

    expect(models?.secretIds).toEqual([SECRET_ARN]);
    expect(telemetry.secretIds).toEqual([SECRET_ARN]);
  });
});
