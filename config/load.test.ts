import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const image = vi.hoisted(() => ({ settings: '' }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: (path: string) => path === '/bot/bot.yaml' ? Boolean(image.settings) : fs.existsSync(path), readFileSync: (path: string, encoding: BufferEncoding) => path === '/bot/bot.yaml' ? image.settings : fs.readFileSync(path, encoding) };
});
import { openEgressProxy } from './deployment.js';
import { loadBotCube, validateBotDeployment } from './load.js';
import { resolveConfig } from './resolved.js';
import { BotCubeConfigError } from './parse.js';

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}/botcube.yaml`, import.meta.url));

const EXAMPLE_BOT = {
  agentIdentity: { name: 'BotCube', character: 'A template agent', avatar: '🧊' },
  accountKey: 'template',
  models: [{ key: 'echo', label: 'Echo', provider: 'openai' }],
  skills: ['skills/computer'],
  writtenMemory: { enabled: true },
  extractedMemory: { enabled: true },
  agentComputer: { enabled: true, liveBrowser: true },
};

const THEME = { agentBody: '#f5d0a9', agentOutline: '#d9915a', agentDeep: '#9a5a2b', agentDeepest: '#4a2810' };

/** The keys every BotCube Config gives; each test's own sections go over them. */
const REQUIRED = JSON.parse(readFileSync(fileURLToPath(new URL('../tests/required-keys.json', import.meta.url)), 'utf8'));

const DEFAULT_SECTIONS = { allowCommandCredentials: false, schedules: { kind: 'eventbridge-scheduler' }, liveView: { kind: 'agentcore-browser' }, integrations: { signIn: { kind: 'botcube-accounts' }, modelGateway: { kind: 'bedrock' }, harnessAuth: { kind: 'sigv4' }, awsAccess: { kind: 'web-identity' }, telemetry: { kind: 'xray' }, proxy: { kind: 'none' } }, network: {} };

const FORWARD = { kind: 'forward', url: 'http://proxy.example.com:3128' };

function configFile(config: unknown, bot: unknown = EXAMPLE_BOT): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-'));
  image.settings = JSON.stringify(bot);
  const path = join(dir, 'botcube.yaml');
  writeFileSync(path, JSON.stringify(withRequired(config)));
  return path;
}

function withRequired(config: unknown): unknown {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return config;
  const { existing, ...sections } = config as { existing?: object };
  return { ...REQUIRED, ...sections, existing: { ...REQUIRED.existing, ...existing } };
}

const ENTERPRISE_MODELS = {
  kind: 'openai-compatible',
  url: 'https://models.example.com/v1',
  credential: { kind: 'file', path: '/run/secrets/botcube/models-api-key' },
  headers: { 'x-tenant': 'botcube-example' },
};

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube-example/models-api-key';
const COMMAND = { kind: 'command', command: ['/usr/local/bin/token-broker', '--audience', 'models'] };
const CREDENTIAL_TARGET_GROUP = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/corp-botcube-credentials/0123456789abcdef';
const CREDENTIAL_ENDPOINT = { url: 'http://credentials.example.com', targetGroupArn: CREDENTIAL_TARGET_GROUP, securityGroupId: 'sg-fixturecredentials' };

const OIDC_CLIENT_SECRET = { kind: 'secret', secretId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/oidc-client-secret' };
const OIDC = {
  kind: 'oidc',
  issuer: 'https://login.example.com',
  clients: [{ clientId: 'botcube', clientSecret: OIDC_CLIENT_SECRET }],
};

const FILES = {
  fileSystemId: 'fs-0a',
  kmsKey: 'arn:aws:kms:us-east-1:000000000000:key/66666666-ffff-4fff-8fff-666666666666',
  accountsAccessPointId: 'fsap-0a',
  accessPoints: [{ accessPointId: 'fsap-0b', rootDirectory: `/accounts/${'a'.repeat(32)}` }],
};

const OAUTH = {
  kind: 'oauth-client-credentials',
  tokenEndpoint: 'https://login.example.com/oauth2/token',
  clientId: 'botcube-models',
  clientSecret: { kind: 'file', path: '/run/secrets/botcube/models-client-secret' },
};

const EXTERNAL_HARNESS = {
  kind: 'jwt-bearer',
  issuer: 'https://login.example.com/realms/platform/.well-known/openid-configuration',
  clients: [{ clientId: 'botcube-harness' }],
  token: { kind: 'file', path: '/run/secrets/botcube/harness-token' },
};

/** Where the enterprise example leaves the defaults, one section per seam. */
const ENTERPRISE_SECTIONS = { schedules: { kind: 'table-poller' }, integrations: { signIn: OIDC, modelGateway: ENTERPRISE_MODELS, harnessAuth: { kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] }, awsAccess: { kind: 'assume-role' }, telemetry: { kind: 'otlp' }, proxy: { kind: 'forward' } } };

describe('the examples', () => {
  it.each([
    ['public', {}],
    ['enterprise', ENTERPRISE_SECTIONS],
  ])('the %s example deploys the example bot on its adapters', (name, sections) => {
    image.settings = JSON.stringify({ $schema: '../../config/bot.schema.json', ...EXAMPLE_BOT });
    const { bot, config } = loadBotCube(example(name));
    expect(bot).toEqual({ $schema: '../../config/bot.schema.json', ...EXAMPLE_BOT, agentComputer: { ...EXAMPLE_BOT.agentComputer, profileOmitsCookieDomains: [] } });
    expect(config).toMatchObject({ $schema: '../../config/botcube.schema.json', ...DEFAULT_SECTIONS, ...sections });
  });

  it('the public example reuses only a VPC, its link browser and slot bucket, and talks to the internet through the NAT it creates', () => {
    const { config } = loadBotCube(example('public'));
    expect([Object.keys(config.existing), config.network.natGateways, config.integrations.proxy]).toEqual([['vpc', 'browsers', 'buckets'], 1, { kind: 'none' }]);
    expect(config.integrations.imageRegistry).toEqual({ url: 'https://public.ecr.aws' });
  });

  it('the enterprise example supplies its own resources, collector, proxy and image mirror', () => {
    const { config } = loadBotCube(example('enterprise'));
    expect(Object.keys(config.existing)).toEqual(['vpc', 'browsers', 'kmsKeys', 'tables', 'buckets', 'files', 'credentialService']);
    expect(config.existing.credentialService).toEqual({
      url: 'http://credentials.example.com',
      targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/corp-botcube-credentials/0123456789abcdef',
      securityGroupId: 'sg-fixturecredentials',
    });
    expect(config.existing.files?.accessPoints).toHaveLength(2);
    expect(config.existing.kmsKeys?.sheet).toBe('arn:aws:kms:us-east-1:000000000000:alias/corp-botcube-sign-in-sheet');
    expect(config.integrations.imageRegistry).toEqual({ url: 'https://mirror.example.com/ecr-public' });
    expect(config.integrations.telemetry).toEqual({
      kind: 'otlp',
      url: 'http://otel-collector.example.com:4318/v1/traces',
      credential: { kind: 'file', path: '/run/secrets/botcube/telemetry-token' },
      headers: { 'x-tenant': 'botcube-example' },
      proxy: 'integrations.proxy',
    });
    expect(config.integrations.modelGateway).toMatchObject({ proxy: 'integrations.proxy' });
    expect(config.integrations.proxy).toEqual({
      kind: 'forward',
      url: 'http://proxy.example.com:3128',
      credential: { kind: 'file', path: '/run/secrets/botcube/proxy-token' },
      headers: { 'x-egress-route': 'botcube-example' },
    });
  });
});

describe('a BotCube Config', () => {
  it.each([
    ['through the proxy it names', { openEgress: { proxy: 'integrations.proxy' } }, FORWARD],
    ['direct when it names none', { openEgress: {} }, { kind: 'none' }],
    ['direct without it', {}, { kind: 'none' }],
  ])("reaches the open egress of the agent's commands and Chromium %s", (_, network, proxy) => {
    const { config } = loadBotCube(configFile({ integrations: { proxy: FORWARD }, network }));
    expect(openEgressProxy(config)).toEqual(proxy);
  });

  it.each([
    ['integrations.telemetry.proxy', { integrations: { telemetry: { kind: 'otlp', url: 'https://collector.example.com/v1/traces', proxy: 'integrations.proxy' } } }],
    ['integrations.modelGateway.proxy', { integrations: { modelGateway: { kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: { kind: 'file', path: '/run/secrets/models' }, proxy: 'integrations.proxy' } } }],
    ['network.openEgress.proxy', { network: { openEgress: { proxy: 'integrations.proxy' } } }],
    ['integrations.signIn.proxy', { integrations: { signIn: { ...OIDC, proxy: 'integrations.proxy' } } }],
    ['integrations.relayProviders.openai.proxy', { integrations: { relayProviders: { openai: { proxy: 'integrations.proxy' } } } }],
  ])('stops on %s naming a proxy the deployment does not have', (field, sections) => {
    const path = configFile(sections);
    expect(() => loadBotCube(path)).toThrow(`BotCube Config ${path}: ${field}: names integrations.proxy, which is none`);
  });

  it("stops on a bot whose settings watch the live view the deployment turns off, naming both", () => {
    const path = configFile({ liveView: { kind: 'none' } });
    expect(() => loadBotCube(path)).toThrow(`BotCube Config ${path}: liveView: none, but the bot settings turn agentComputer.liveBrowser on`);
    const off = configFile({ liveView: { kind: 'none' } }, { ...EXAMPLE_BOT, agentComputer: { ...EXAMPLE_BOT.agentComputer, liveBrowser: false } });
    expect(loadBotCube(off).config.liveView).toEqual({ kind: 'none' });
  });

  it('reaches each provider at its own URL, with its own credential and headers, or at the gateway URL', () => {
    const anthropic = { url: 'https://models.example.com/anthropic', credential: { kind: 'file', path: '/run/secrets/botcube/anthropic-key' }, headers: { 'x-route': 'messages' } };
    const bot = { ...EXAMPLE_BOT, models: [{ key: 'claude-sonnet-5-5', label: 'Sonnet', provider: 'anthropic' }, { key: 'gpt-5', label: 'GPT', provider: 'openai' }] };
    const models = { ...ENTERPRISE_MODELS, providers: { anthropic, openai: {} } };
    expect(loadBotCube(configFile({ integrations: { modelGateway: models } }, bot)).config.integrations.modelGateway)
      .toEqual({ ...models, providers: { anthropic, openai: { useResponsesApi: false } } });
  });

  const reachability: { provider: string; gateway: object; error: string | null }[] = JSON.parse(
    readFileSync(new URL('../tests/fixtures/model-provider-reachability.json', import.meta.url), 'utf8'),
  );
  it.each(reachability)('checks gateway reachability for $provider with $gateway', ({ provider, gateway, error }) => {
    const bot = { ...EXAMPLE_BOT, models: [{ key: 'test-model', label: 'Test', provider }] };
    const modelGateway = { ...ENTERPRISE_MODELS, url: 'https://models.example.com', ...gateway };
    const path = configFile({ integrations: { modelGateway } }, bot);
    if (error === null) {
      expect(loadBotCube(path).bot.models).toHaveLength(1);
    } else {
      expect(() => loadBotCube(path)).toThrow(`BotCube Config ${path}: the bot settings' model test-model is on provider ${provider}, but ${error}`);
    }
  });

  it('names the source and provider when the resolved gateway entry is missing', () => {
    const { config, bot } = loadBotCube(configFile({}));
    const resolved = { ...resolveConfig(config), modelGateway: {} };
    const source = 'Resolved BotCube Config s3://config-bucket/resolved/config.json';
    expect(() => validateBotDeployment(resolved, bot, source))
      .toThrow(new BotCubeConfigError(`${source}: modelGateway has no entry for provider openai`));
  });

  it('reaches a listed provider with no URL of its own at the gateway URL', () => {
    const models = { ...ENTERPRISE_MODELS, providers: { openai: {} } };
    expect(loadBotCube(configFile({ integrations: { modelGateway: models } })).config.integrations.modelGateway).toMatchObject({ providers: { openai: {} } });
  });

  it('stops on a bot model on a provider BotCube does not call', () => {
    const path = configFile({}, { ...EXAMPLE_BOT, models: [{ key: 'claude', label: 'Claude', provider: 'anthropic/messages' }] });
    expect(() => loadBotCube(path)).toThrow("Bot settings /bot/bot.yaml: models.0.provider: Invalid option: expected one of \"anthropic\"|\"openai\"|\"deepseek\"|\"echo\"");
  });

  it('runs a bot model on any provider on Bedrock, with no output ceiling of its own unless it gives one', () => {
    const bot = { ...EXAMPLE_BOT, models: [{ key: 'deepseek-v3.2', label: 'DeepSeek', provider: 'deepseek' }] };
    expect(loadBotCube(configFile({}, bot)).bot.models).toEqual(bot.models);
  });

  it('names the images its services run, each an OCI reference pinned by a tag or a digest', () => {
    const chatService = { image: `mirror.example.com/acme/chat@sha256:${'a'.repeat(64)}` };
    const credentialService = { image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/credentials:1.2' };
    expect(loadBotCube(configFile({ services: { chatService, credentialService } })).config.services).toEqual({ chatService, credentialService });
  });

  it('opens every missing section on its default adapter', () => {
    expect(loadBotCube(configFile({  })).config).toEqual({ ...REQUIRED, ...DEFAULT_SECTIONS, integrations: { ...DEFAULT_SECTIONS.integrations, imageRegistry: { url: 'https://public.ecr.aws' } } });
  });

  it.each<[string, (config: typeof REQUIRED) => void]>([
    ['name', (config) => delete config.name],
    ['env', (config) => delete config.env],
    ['domains', (config) => delete config.domains],
    ['domains.web', (config) => delete config.domains.web],
    ['domains.chatService', (config) => delete config.domains.chatService],
    ['existing', (config) => delete config.existing],
    ['existing.vpc', (config) => delete config.existing.vpc],
  ])('stops without %s, naming it as the Python loader does', (key, leaveOut) => {
    const config = structuredClone(REQUIRED);
    leaveOut(config);
    const path = join(mkdtempSync(join(tmpdir(), 'config-')), 'botcube.yaml');
    writeFileSync(path, JSON.stringify(config));
    expect(() => loadBotCube(path)).toThrow(new BotCubeConfigError(`BotCube Config ${path}: ${key}: '${key.split('.').at(-1)}' is a required property`));
  });

  it('stops on an empty file, naming each key a deployment gives', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'config-')), 'botcube.yaml');
    writeFileSync(path, '{}');
    expect(() => loadBotCube(path)).toThrow(new BotCubeConfigError(['name', 'env', 'domains', 'existing'].map((key) => `BotCube Config ${path}: ${key}: '${key}' is a required property`).join('\n')));
  });

  it.each<[string, object, string]>([
    ['an unknown key', { identty: { kind: 'botcube-accounts' } }, 'identty: Unrecognized key'],
    ['an unknown key in a section', { schedules: { kind: 'eventbridge-scheduler', table: 'x' } }, 'schedules.table: Unrecognized key'],
    ['an unknown kind', { integrations: { modelGateway: { kind: 'vertex' } } }, "integrations.modelGateway.kind: Invalid discriminator value. Expected 'bedrock' | 'openai-compatible'"],
    ['a provider URL for a provider BotCube does not call', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, providers: { deepseek: { url: 'https://models.example.com/deepseek' } } } } }, 'integrations.modelGateway.providers'],
    ['the deleted API key field', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, apiKey: { secretId: SECRET_ARN } } } }, 'integrations.modelGateway.apiKey: Unrecognized key'],
    ['an OpenAI-compatible endpoint without its credential', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: undefined } } }, 'integrations.modelGateway.credential: '],
    ['an API key written in place of its source', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: 'sk-live' } } }, 'integrations.modelGateway.credential: '],
    ['an unknown credential source', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { kind: 'vault', path: 'x' } } } },
      "integrations.modelGateway.credential.kind: Invalid discriminator value. Expected 'secret' | 'file' | 'command'"],
    ['an unknown field on a credential source', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { kind: 'file', path: '/run/key', format: 'json' } } } },
      'integrations.modelGateway.credential.format: Unrecognized key'],
    ['a secret named by something other than its name or ARN', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { kind: 'secret', secretId: 'models api key' } } } },
      'integrations.modelGateway.credential.secretId: Expected a Secrets Manager secret name or ARN'],
    ['a credential file by a relative path', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { kind: 'file', path: 'secrets/key' } } } },
      'integrations.modelGateway.credential.path: '],
    ['a command with no program', { allowCommandCredentials: true, integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { kind: 'command', command: [] } } } },
      'integrations.modelGateway.credential.command.0: '],
    ['a botcube models credential', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { kind: 'botcube', audience: 'models' } } } },
      'integrations.modelGateway.credential: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ['a botcube OIDC client secret', { integrations: { signIn: { kind: 'oidc', issuer: 'https://login.example.com', clients: [{ clientId: 'botcube', clientSecret: { kind: 'botcube', audience: 'login.example.com' } }] } } },
      'integrations.signIn.clients.0.clientSecret: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ...(['tokenEndpoint', 'clientId', 'clientSecret'] as const).map(field => [
      `an OAuth client-credentials source without its ${field}`,
      { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, [field]: undefined } } } },
      `integrations.modelGateway.credential.${field}: `,
    ] as const),
    ['an OAuth client secret given as its value', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, clientSecret: 's3cret' } } } },
      'integrations.modelGateway.credential.clientSecret: '],
    ...([
      ['aws', { kind: 'aws', audience: 'login.example.com' }],
      ['botcube', { kind: 'botcube', audience: 'login.example.com' }],
      ['oauth-client-credentials', OAUTH],
    ] as const).map(([kind, clientSecret]) => [
      `an OAuth client secret from a ${kind} source`, { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, clientSecret } } } },
      "integrations.modelGateway.credential.clientSecret.kind: Invalid discriminator value. Expected 'secret' | 'file' | 'command'",
    ] as const),
    ['an OAuth token endpoint over http beyond this machine', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, tokenEndpoint: 'http://login.example.com/oauth2/token' } } } },
      'integrations.modelGateway.credential.tokenEndpoint: A token endpoint is an https URL'],
    ['an empty OAuth scope list', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, scopes: [] } } } }, 'integrations.modelGateway.credential.scopes: '],
    ['two OAuth scopes in one string', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, scopes: ['integrations.modelGateway.read models.write'] } } } },
      'integrations.modelGateway.credential.scopes.0: Expected an OAuth scope'],
    ['an OAuth command client secret without the opt-in', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, clientSecret: COMMAND } } } },
      'integrations.modelGateway.credential.clientSecret: A command credential runs only when allowCommandCredentials is true'],
    ['a command source without the opt-in',{ integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: COMMAND } } },
      'integrations.modelGateway.credential: A command credential runs only when allowCommandCredentials is true'],
    ['a header that is not a header name', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, headers: { 'x tenant': 'a' } } } }, 'integrations.modelGateway.headers.x tenant: '],
    ['an authorization header beside the credential', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, headers: { Authorization: 'Bearer sk-live' } } } },
      'integrations.modelGateway.headers.Authorization: The credential sets Authorization'],
    ['an OpenAI-compatible endpoint over http beyond this machine', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, url: 'http://models.example.com/v1' } } },
      'integrations.modelGateway.url: A models endpoint is an https URL; only a stand-in on this machine may use http'],
    ['a section without its kind', { integrations: { harnessAuth: {} } }, "integrations.harnessAuth.kind: Invalid discriminator value. Expected 'sigv4' | 'jwt-bearer'"],
    ['a JWT bearer without its client', { integrations: { harnessAuth: { kind: 'jwt-bearer' } } }, 'integrations.harnessAuth.clients: '],
    ['a JWT bearer on the old audience field', { integrations: { harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }], audience: 'botcube-harness' } } },
      'integrations.harnessAuth.audience: Unrecognized key'],
    ...['https://login.example.com', 'http://login.example.com/.well-known/openid-configuration', 'login.example.com/.well-known/openid-configuration'].map(issuer => [
      `a JWT bearer issuer ${issuer}, which is not an https discovery URL`, { integrations: { harnessAuth: { ...EXTERNAL_HARNESS, issuer } } },
      "integrations.harnessAuth.issuer: Expected 'botcube' or an https OIDC discovery URL ending in /.well-known/openid-configuration",
    ] as const),
    ['a JWT bearer from a discovery URL without its token', { integrations: { harnessAuth: { ...EXTERNAL_HARNESS, token: undefined } } },
      'integrations.harnessAuth.token: An issuer at a discovery URL needs the token Chat sends it, a Credential Source'],
    ['a token beside the botcube issuer', { integrations: { harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }], token: EXTERNAL_HARNESS.token } } },
      'integrations.harnessAuth.token: Chat signs its own bearer for the botcube issuer; token is for an issuer at a discovery URL'],
    ['a command Harness token without the opt-in', { integrations: { harnessAuth: { ...EXTERNAL_HARNESS, token: COMMAND } } },
      'integrations.harnessAuth.token: A command credential runs only when allowCommandCredentials is true'],
    ['a botcube Harness token', { integrations: { harnessAuth: { ...EXTERNAL_HARNESS, token: { kind: 'botcube', audience: 'botcube-harness' } } } },
      'integrations.harnessAuth.token: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ...['sts.amazonaws.com', 'botcube-user', 'botcube-chat-service'].map(audience => [
      `a JWT bearer on the reserved audience ${audience}`, { integrations: { harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }, { clientId: audience }] } } },
      `integrations.harnessAuth.clients.1.clientId: The Harness audience ${audience} is reserved for another kind of BotCube token`,
    ] as const),
    ['an OIDC provider without its client secret', { integrations: { signIn: { ...OIDC, clients: [{ clientId: 'botcube' }] } } }, 'integrations.signIn.clients.0.clientSecret: '],
    ['a client secret given as its value', { integrations: { signIn: { ...OIDC, clients: [{ clientId: 'botcube', clientSecret: 's3cret' }] } } }, 'integrations.signIn.clients.0.clientSecret: '],
    ['a client secret named by its ARN alone', { integrations: { signIn: { ...OIDC, clients: [{ clientId: 'botcube', clientSecret: { secretId: OIDC_CLIENT_SECRET.secretId } }] } } },
      'integrations.signIn.clients.0.clientSecret.kind: '],
    ['an OIDC provider with no client', { integrations: { signIn: { ...OIDC, clients: [] } } }, 'integrations.signIn.clients.0: '],
    ['a sign-in client listed twice', { integrations: { signIn: { ...OIDC, clients: [...OIDC.clients, ...OIDC.clients] } } },
      'integrations.signIn.clients.1.clientId: Client botcube is already identity.clients.0.clientId'],
    ...['clientId', 'clientSecret'].map(field => [
      `the old identity.${field} field`, { integrations: { signIn: { ...OIDC, [field]: field === 'clientId' ? 'botcube' : { secretId: OIDC_CLIENT_SECRET.secretId } } } },
      `integrations.signIn.${field}: Unrecognized key`,
    ] as const),
    ['a command client secret without the opt-in', { integrations: { signIn: { ...OIDC, clients: [{ clientId: 'botcube', clientSecret: COMMAND }] } } },
      'integrations.signIn.clients.0.clientSecret: A command credential runs only when allowCommandCredentials is true'],
    ['an OIDC issuer over http beyond this machine', { integrations: { signIn: { ...OIDC, issuer: 'http://login.example.com' } } }, 'integrations.signIn.issuer: '],
    ['an unknown existing resource', { existing: { queues: {} } }, 'existing.queues: Unrecognized key'],
    ['existing Files without their access points', { existing: { files: { fileSystemId: FILES.fileSystemId, kmsKey: FILES.kmsKey, accountsAccessPointId: FILES.accountsAccessPointId } } },
      'existing.files.accessPoints: '],
    ['existing Files with no access point', { existing: { files: { ...FILES, accessPoints: [] } } }, 'existing.files.accessPoints: '],
    ['an unknown existing Files field', { existing: { files: { ...FILES, mountTargets: [] } } }, 'existing.files.mountTargets: Unrecognized key'],
    ['a existing access point outside the Users\' directories', { existing: { files: { ...FILES, accessPoints: [{ accessPointId: 'fsap-0b', rootDirectory: '/users/alice' }] } } },
      'existing.files.accessPoints.0.rootDirectory: '],
    ['one access point existing twice', { existing: { files: { ...FILES, accessPoints: [FILES.accessPoints[0], { ...FILES.accessPoints[0], rootDirectory: `/accounts/${'b'.repeat(32)}` }] } } },
      'existing.files.accessPoints.1.accessPointId: Access point fsap-0b is already existing.files.accessPoints.0'],
    ['one directory existing twice', { existing: { files: { ...FILES, accessPoints: [FILES.accessPoints[0], { ...FILES.accessPoints[0], accessPointId: 'fsap-0c' }] } } },
      `existing.files.accessPoints.1.rootDirectory: Directory /accounts/${'a'.repeat(32)} is already existing.files.accessPoints.0`],
    ['the shared access point leased to a User', { existing: { files: { ...FILES, accessPoints: [{ ...FILES.accessPoints[0], accessPointId: FILES.accountsAccessPointId }] } } },
      'existing.files.accessPoints.0.accessPointId: Access point fsap-0a is already existing.files.accountsAccessPointId'],
    ['a KMS key that is not an ARN', { existing: { kmsKeys: { vault: 'alias/vault' } } }, 'existing.kmsKeys.vault: '],
    [
      'a sheet key named by its key ARN, not an alias',
      { existing: { kmsKeys: { sheet: 'arn:aws:kms:us-east-1:000000000000:key/sheet' } } },
      'existing.kmsKeys.sheet: Expected a KMS alias ARN, such as arn:aws:kms:us-east-1:123456789012:alias/sign-in-sheet, so the key rotates by moving the alias',
    ],
    ['a sheet key with its KeySpec', { existing: { kmsKeys: { sheet: { keyArn: 'arn:aws:kms:us-east-1:000000000000:key/sheet', keySpec: 'RSA_2048' } } } }, 'existing.kmsKeys.sheet: '],
    [
      "another table's stream",
      { existing: { tables: { chat: { tableName: 'chat', streamArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/other/stream/2026' } } } },
      "existing.tables.chat.streamArn: The stream is table other's, not chat's",
    ],
    ...([
      ['a Credential Service Endpoint that is not an http(s) URL', { ...CREDENTIAL_ENDPOINT, url: 'ftp://credentials.example.com' }, 'existing.credentialService.url: '],
      ['a Credential Service Endpoint with no target group', { url: CREDENTIAL_ENDPOINT.url, securityGroupId: CREDENTIAL_ENDPOINT.securityGroupId }, 'existing.credentialService.targetGroupArn: '],
      ['a Credential Service target group that is not a target group ARN', { ...CREDENTIAL_ENDPOINT, targetGroupArn: 'corp-botcube-credentials' }, 'existing.credentialService.targetGroupArn: '],
      ['a Credential Service Endpoint with no load balancer security group', { url: CREDENTIAL_ENDPOINT.url, targetGroupArn: CREDENTIAL_TARGET_GROUP }, 'existing.credentialService.securityGroupId: '],
      ['a load balancer security group that is not a security group id', { ...CREDENTIAL_ENDPOINT, securityGroupId: 'corp-load-balancer' }, 'existing.credentialService.securityGroupId: '],
      ['a Credential Service Endpoint with a bearer credential', { ...CREDENTIAL_ENDPOINT, credential: { kind: 'file', path: '/run/secrets/x' } },
        'existing.credentialService.credential: Unrecognized key'],
    ] satisfies [string, object, string][]).map(([name, credentialService, field]): [string, object, string] => [name, { existing: { credentialService } }, field]),
    ['a proxy that is not an http(s) URL', { integrations: { proxy: { kind: 'forward', url: 'socks5://proxy:1080' } } }, 'integrations.proxy.url: '],
    ['a proxy in the old shape, with no kind', { integrations: { proxy: { url: 'http://proxy:3128' } } }, 'integrations.proxy.kind: '],
    ['a Proxy-Authorization header beside the proxy credential', { integrations: { proxy: { kind: 'forward', url: 'http://proxy:3128', headers: { 'Proxy-Authorization': 'Basic x' } } } },
      'integrations.proxy.headers.Proxy-Authorization: The credential sets Proxy-Authorization'],
    ['a proxy for the models Relay provider, which the model gateway names', { integrations: { relayProviders: { models: { proxy: 'integrations.proxy' } } } },
      'integrations.relayProviders.models: The models Relay provider is integrations.modelGateway: name the proxy at integrations.modelGateway.proxy'],
    ...([
      ['a secret', { kind: 'secret', secretId: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:proxy-token' }],
      ['a command', COMMAND],
      ['a botcube', { kind: 'botcube', audience: 'proxy' }],
    ] satisfies [string, object][]).map(([kind, credential]): [string, object, string] => [
      `${kind} proxy credential`,
      { allowCommandCredentials: true, integrations: { proxy: { kind: 'forward', url: 'http://proxy:3128', credential } } },
      'integrations.proxy.credential: A proxy credential is read from a file; any other source would reach out through the proxy it authenticates',
    ]),
    ['a Runtime image outside Amazon ECR, which AgentCore cannot run', { agentCore: { runtime: { containerUri: 'public.ecr.aws/acme/bot:1' } } }, 'agentCore.runtime.containerUri: Expected an Amazon ECR image URI'],
    ['a Runtime image with neither tag nor digest', { agentCore: { runtime: { containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/bot' } } }, 'agentCore.runtime.containerUri: Expected an Amazon ECR image URI'],
    ['a Chat Service image with neither tag nor digest', { services: { chatService: { image: 'mirror.example.com/acme/chat' } } }, 'services.chatService.image: Expected an OCI image reference'],
    ['a Credential Service image outside Amazon ECR, which its audit-copy Lambda cannot run', { services: { credentialService: { image: 'public.ecr.aws/acme/credentials:1' } } },
      'services.credentialService.image: Expected an Amazon ECR image URI'],
    ['an image registry given as a bare host, its old shape', { integrations: { imageRegistry: 'mirror.example.com/ecr-public' } }, 'integrations.imageRegistry: '],
    ['an image registry over http', { integrations: { imageRegistry: { url: 'http://mirror.example.com' } } }, 'integrations.imageRegistry.url: '],
    ['an image registry URL with a trailing slash', { integrations: { imageRegistry: { url: 'https://mirror.example.com/' } } }, 'integrations.imageRegistry.url: Expected a registry base URL, https and a host with an optional path, no trailing /'],
    ['an image registry URL with a query', { integrations: { imageRegistry: { url: 'https://mirror.example.com/ecr?x=1' } } }, 'integrations.imageRegistry.url: Expected a registry base URL, https and a host with an optional path, no trailing /'],
    ['an image registry credential, which the puller brings', { integrations: { imageRegistry: { url: 'https://mirror.example.com', credential: { kind: 'file', path: '/run/token' } } } }, 'integrations.imageRegistry.credential: Unrecognized key'],
    ['an OTLP endpoint with no URL', { integrations: { telemetry: { kind: 'otlp' } } }, 'integrations.telemetry.url: '],
    ['the old telemetry.otlpEndpoint field', { integrations: { telemetry: { otlpEndpoint: 'http://collector:4318/v1/traces' } } }, 'integrations.telemetry.kind: '],
    ['an authorization header beside the telemetry credential', { integrations: { telemetry: { kind: 'otlp', url: 'http://collector:4318/v1/traces', headers: { authorization: 'Bearer x' } } } },
      'integrations.telemetry.headers.authorization: The credential sets Authorization'],
    ['a botcube telemetry credential', { integrations: { telemetry: { kind: 'otlp', url: 'http://collector:4318/v1/traces', credential: { kind: 'botcube', audience: 'collector' } } } },
      'integrations.telemetry.credential: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ['a command telemetry credential without the opt-in', { integrations: { telemetry: { kind: 'otlp', url: 'http://collector:4318/v1/traces', credential: COMMAND } } },
      'integrations.telemetry.credential: A command credential runs only when allowCommandCredentials is true'],
    ['a product name, which the bot settings carry', { productName: 'Example Bot' }, "productName: renamed to productName in /bot/bot.yaml, the Bot Image's bot settings"],
    ['a web alias with a path', { domains: { web: 'https://chat.example.com', webAliases: ['https://chat.example.com/chat'], chatService: 'https://api.chat.example.com' } },
      'domains.webAliases.0: Expected a web origin: a scheme and host, no path (RFC 6454)'],
    ['a product service, which the bot settings carry', { productService: { agentComputerStartedPath: '/me/agent-computer/seed' } }, "productService: renamed to productService in /bot/bot.yaml, the Bot Image's bot settings"],
    ['a Plan Usage owner that is no Account', { planUsage: { ownerAccountId: '123456789012' } },
      'planUsage.ownerAccountId: Expected an Account id, acct_ and its token'],
    ['an empty automation user agent', { parking: { automationUserAgents: [''] } }, 'parking.automationUserAgents.0: '],
  ])('stops on %s and names the field', (_, config, field) => {
    const path = configFile(config);
    expect(() => loadBotCube(path)).toThrow(`BotCube Config ${path}: ${field}`);
  });

  it.each([
    ['a Secrets Manager secret', { kind: 'secret', secretId: SECRET_ARN }],
    ['a mounted file', { kind: 'file', path: '/run/secrets/botcube/models-api-key' }],
  ])('gives the models endpoint its credential from %s', (_, credential) => {
    const models = { ...ENTERPRISE_MODELS, credential };
    expect(loadBotCube(configFile({ integrations: { modelGateway: models } })).config.integrations.modelGateway).toEqual(models);
  });

  it.each([
    ['a mounted file and no scope', OAUTH],
    ['a Secrets Manager secret and scopes', { ...OAUTH, clientSecret: { kind: 'secret', secretId: SECRET_ARN }, scopes: ['integrations.modelGateway.invoke', 'api://botcube/.default'] }],
    ['a stand-in token endpoint on this machine', { ...OAUTH, tokenEndpoint: 'http://127.0.0.1:9400/token' }],
  ])('gives the models endpoint an OAuth client-credentials token from %s', (_, credential) => {
    const models = { ...ENTERPRISE_MODELS, credential };
    expect(loadBotCube(configFile({ integrations: { modelGateway: models } })).config.integrations.modelGateway).toEqual(models);
  });

  it('runs an opted-in command for an OAuth client secret', () => {
    const credential = { ...OAUTH, clientSecret: COMMAND };
    const config = loadBotCube(configFile({ allowCommandCredentials: true, integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential } } })).config;
    expect(config.integrations.modelGateway).toMatchObject({ credential: { clientSecret: { ...COMMAND, timeoutSeconds: 30 } } });
  });

  it.each([
    ['a Secrets Manager secret', { allowCommandCredentials: false }, { kind: 'secret', secretId: SECRET_ARN }],
    ['a mounted file', { allowCommandCredentials: false }, { kind: 'file', path: '/run/secrets/botcube/harness-token' }],
    ['an opted-in command', { allowCommandCredentials: true }, { ...COMMAND, timeoutSeconds: 30 }],
  ])('trusts an outside Harness issuer at its discovery URL, with the token from %s', (_, optIn, token) => {
    const harnessAuth = { ...EXTERNAL_HARNESS, token };
    expect(loadBotCube(configFile({ ...optIn, integrations: { harnessAuth: harnessAuth } })).config.integrations.harnessAuth).toEqual(harnessAuth);
  });

  it('takes a second sign-in client as a list entry', () => {
    const clients = [...OIDC.clients, { clientId: 'botcube-mobile', clientSecret: { kind: 'file', path: '/run/secrets/botcube/mobile-client-secret' } }];
    expect(loadBotCube(configFile({ integrations: { signIn: { ...OIDC, clients } } })).config.integrations.signIn).toMatchObject({ clients });
  });

  it('runs an opted-in command for the models credential, 30 s at most unless it says otherwise', () => {
    const config = loadBotCube(configFile({ allowCommandCredentials: true, integrations: { modelGateway: { ...ENTERPRISE_MODELS, credential: COMMAND } } })).config;
    expect(config).toMatchObject({ allowCommandCredentials: true, integrations: { modelGateway: { credential: { ...COMMAND, timeoutSeconds: 30 } } } });
  });

  it.each([
    ['a Secrets Manager secret', OIDC_CLIENT_SECRET],
    ['a mounted file', { kind: 'file', path: '/run/secrets/botcube/oidc-client-secret' }],
  ])('signs Users in with the OIDC client secret from %s', (_, clientSecret) => {
    const identity = { ...OIDC, clients: [{ clientId: 'botcube', clientSecret }] };
    expect(loadBotCube(configFile({ integrations: { signIn: identity } })).config.integrations.signIn).toEqual(identity);
  });

  it.each(['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1'])('takes a stand-in models endpoint over http on this machine at %s', (url) => {
    const models = { ...ENTERPRISE_MODELS, url };
    expect(loadBotCube(configFile({ integrations: { modelGateway: models } })).config.integrations.modelGateway).toEqual(models);
  });

  it("takes the product's web origins, the Plan Usage owner and the automation user agents parking skips", () => {
    const product = {
      domains: { web: 'https://chat.example.com', webAliases: ['https://preview.chat.example.com', 'http://localhost:3001'], chatService: 'https://api.chat.example.com' },
      planUsage: { ownerAccountId: 'acct_plan_owner_0000000000' },
      parking: { automationUserAgents: ['-Verification/', 'collective-automation'] },
    };
    expect(loadBotCube(configFile({ ...product })).config).toMatchObject(product);
  });


  it('takes a stand-in OIDC issuer over http on this machine', () => {
    const identity = { ...OIDC, issuer: 'http://127.0.0.1:9400' };
    expect(loadBotCube(configFile({ integrations: { signIn: identity } })).config.integrations.signIn).toEqual(identity);
  });

  it('stops when the image has no /bot/bot.yaml', () => {
    const path = configFile({});
    image.settings = '';
    expect(() => loadBotCube(path)).toThrow('Bot settings /bot/bot.yaml: no file');
  });

  it('stops when there is no file at its path, naming the path', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'config-')), 'absent.json');
    expect(() => loadBotCube(path)).toThrow(new BotCubeConfigError(`BotCube Config ${path}: no file`));
  });

  it('stops when its file is not YAML 1.2, naming the path', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'config-')), 'botcube.yaml');
    writeFileSync(path, '{ "bot": ');
    expect(() => loadBotCube(path)).toThrow(BotCubeConfigError);
    expect(() => loadBotCube(path)).toThrow(`BotCube Config ${path}: not YAML 1.2: `);
  });
});

describe('Endpoint TLS', () => {
  const FILES = { certificate: '/run/spiffe/svid.pem', key: '/run/spiffe/svid-key.pem' };
  const CERTIFICATE_COMMAND = { command: ['/usr/local/bin/svid-broker', '--audience', 'models'] };
  const IDENTITY = 'spiffe://example.org/ns/egress/sa/proxy';
  const PROXY = { kind: 'forward', url: 'https://proxy.example.com:3129' };
  const COLLECTOR = { kind: 'otlp', url: 'https://collector.example.com/v1/traces' };

  it.each([
    ['a client certificate from a file pair', { clientCertificate: FILES }],
    ['an expected server identity', { serverIdentity: IDENTITY }],
    ['both', { clientCertificate: FILES, serverIdentity: 'https://models.example.com/gateway' }],
  ])('gives the models Endpoint, the proxy and the OTLP Endpoint %s', (_, tls) => {
    const { config } = loadBotCube(configFile({ integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls }, telemetry: { ...COLLECTOR, tls }, proxy: { ...PROXY, tls } } }));
    expect([config.integrations.modelGateway, config.integrations.proxy, config.integrations.telemetry]).toEqual([{ ...ENTERPRISE_MODELS, tls }, { ...PROXY, tls }, { ...COLLECTOR, tls }]);
  });

  it('runs an opted-in command for a client certificate, 30 s at most unless it says otherwise', () => {
    const tls = { clientCertificate: CERTIFICATE_COMMAND };
    const { config } = loadBotCube(configFile({ allowCommandCredentials: true, integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls }, telemetry: { ...COLLECTOR, tls }, proxy: { ...PROXY, tls } } }));
    const expected = { clientCertificate: { ...CERTIFICATE_COMMAND, timeoutSeconds: 30 } };
    expect([config.integrations.modelGateway, config.integrations.proxy, config.integrations.telemetry]).toMatchObject([{ tls: expected }, { tls: expected }, { tls: expected }]);
  });

  it.each([
    ['a client certificate command without the opt-in', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls: { clientCertificate: CERTIFICATE_COMMAND } } } },
      'integrations.modelGateway.tls.clientCertificate: A command client certificate runs only when allowCommandCredentials is true'],
    ["a proxy client certificate command without the opt-in", { integrations: { proxy: { ...PROXY, tls: { clientCertificate: CERTIFICATE_COMMAND } } } },
      'integrations.proxy.tls.clientCertificate: A command client certificate runs only when allowCommandCredentials is true'],
    ['a relative certificate path', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls: { clientCertificate: { ...FILES, key: 'svid-key.pem' } } } } }, 'integrations.modelGateway.tls.clientCertificate'],
    ['a certificate without its key', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls: { clientCertificate: { certificate: FILES.certificate } } } } }, 'integrations.modelGateway.tls.clientCertificate'],
    ['a server identity that is not a URI', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls: { serverIdentity: 'integrations.proxy.example.com' } } } }, 'integrations.modelGateway.tls.serverIdentity: '],
    ['an empty TLS block', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls: {} } } }, 'integrations.modelGateway.tls: '],
    ['an unknown TLS field, such as a CA bundle', { integrations: { modelGateway: { ...ENTERPRISE_MODELS, tls: { serverIdentity: IDENTITY, trustBundle: '/run/bundle.pem' } } } }, 'integrations.modelGateway.tls.trustBundle: Unrecognized key'],
    ['TLS on a proxy reached over http', { integrations: { proxy: { kind: 'forward', url: 'http://proxy.example.com:3128', tls: { serverIdentity: IDENTITY } } } },
      'integrations.proxy.tls: TLS needs the proxy at an https URL'],
    ['an OTLP client certificate command without the opt-in', { integrations: { telemetry: { ...COLLECTOR, tls: { clientCertificate: CERTIFICATE_COMMAND } } } },
      'integrations.telemetry.tls.clientCertificate: A command client certificate runs only when allowCommandCredentials is true'],
    ['TLS on an OTLP Endpoint reached over http', { integrations: { telemetry: { ...COLLECTOR, url: 'http://collector.example.com:4318/v1/traces', tls: { serverIdentity: IDENTITY } } } },
      'integrations.telemetry.tls: TLS needs the OTLP Endpoint at an https URL'],
  ])('stops on %s and names the field', (_, sections, field) => {
    const path = configFile({ ...sections });
    expect(() => loadBotCube(path)).toThrow(`BotCube Config ${path}: ${field}`);
  });
});

describe('bot settings', () => {
  it.each([
    ['a missing Agent Identity name', { ...EXAMPLE_BOT, agentIdentity: { character: 'A template agent' } }, 'agentIdentity.name: '],
    ['a missing account key', (({ accountKey: _, ...bot }) => bot)(EXAMPLE_BOT), 'accountKey: '],
    ['an account key that cannot name a cookie', { ...EXAMPLE_BOT, accountKey: 'Acme Bot' }, 'accountKey: '],
    ['an unknown key', { ...EXAMPLE_BOT, colour: 'blue' }, 'colour: Unrecognized key'],
    ['no models', { ...EXAMPLE_BOT, models: [] }, 'models.0: Invalid input: expected object, received undefined'],
    ['two models with one key', { ...EXAMPLE_BOT, models: [...EXAMPLE_BOT.models, { key: 'echo', label: 'Echo again', provider: 'echo' }] }, 'models.1.key: Model key "echo" is already models.0.key'],
    ['a theme colour that is not #rrggbb', { ...EXAMPLE_BOT, theme: { ...THEME, agentDeep: 'navy' } }, 'theme.agentDeep: Expected a colour as #rrggbb'],
    ['a theme with three of the four colours', { ...EXAMPLE_BOT, theme: { agentBody: '#aabbcc', agentOutline: '#aabbcc', agentDeep: '#aabbcc' } }, 'theme.agentDeepest: '],
    ['a theme reaching past the agent colours', { ...EXAMPLE_BOT, theme: { ...THEME, '--color-blue': '#2563eb' } }, 'theme.--color-blue: Unrecognized key'],
    ['instructions naming no file', { ...EXAMPLE_BOT, instructions: '' }, 'instructions: '],
    ['a Written Memory gate that is not a switch', { ...EXAMPLE_BOT, writtenMemory: { enabled: 'on' } }, 'writtenMemory.enabled: '],
    ['an Extracted Memory gate that is not a switch', { ...EXAMPLE_BOT, extractedMemory: { enabled: 'on' } }, 'extractedMemory.enabled: '],
    ['a live browser without the Agent Computer', { ...EXAMPLE_BOT, agentComputer: { enabled: false, liveBrowser: true } }, 'agentComputer.liveBrowser: The live browser is part of the Agent Computer'],
    ['an empty product name', { ...EXAMPLE_BOT, productName: ' ' }, 'productName: '],
    ['a started path relative to nothing', { ...EXAMPLE_BOT, productService: { agentComputerStartedPath: 'me/agent-computer/seed' } },
      'productService.agentComputerStartedPath: Expected a path starting with /'],
    ['a profile-omitted cookie domain that is a URL', { ...EXAMPLE_BOT, agentComputer: { profileOmitsCookieDomains: ['https://site.example'] } }, 'agentComputer.profileOmitsCookieDomains.0: Expected a domain such as example.com'],
  ])('stop on %s and name the field', (_, bot, field) => {
    const path = configFile({  }, bot);
    expect(() => loadBotCube(path)).toThrow(`Bot settings /bot/bot.yaml: ${field}`);
  });

  it('stop on userTokenInShell and name environment as its replacement', () => {
    const path = configFile({  }, { ...EXAMPLE_BOT, userTokenInShell: true });
    expect(() => loadBotCube(path)).toThrow('Bot settings /bot/bot.yaml: userTokenInShell: renamed to environment, ');
  });

  it('stop on memory and name writtenMemory and extractedMemory as its replacements', () => {
    const path = configFile({  }, { ...EXAMPLE_BOT, memory: true });
    expect(() => loadBotCube(path)).toThrow('Bot settings /bot/bot.yaml: memory: renamed to writtenMemory.enabled and extractedMemory.enabled');
  });

  it('change the theme, the Memory gates and the Agent Computer switches', () => {
    const bot = { ...EXAMPLE_BOT, theme: THEME, writtenMemory: { enabled: false }, extractedMemory: { enabled: false }, agentComputer: { enabled: false, liveBrowser: false } };
    expect(loadBotCube(configFile({  }, bot)).bot).toMatchObject({
      theme: { agentBody: '#f5d0a9', agentOutline: '#d9915a', agentDeep: '#9a5a2b', agentDeepest: '#4a2810' },
      writtenMemory: { enabled: false },
      extractedMemory: { enabled: false },
      agentComputer: { enabled: false, liveBrowser: false },
    });
  });

  it("leave out the Web UI's, for BotCube's colours, both kinds of Memory and the Agent Computer without its live browser", () => {
    const { agentIdentity, accountKey, models } = EXAMPLE_BOT;
    const { bot } = loadBotCube(configFile({  }, { agentIdentity, accountKey, models }));
    expect(bot).not.toHaveProperty('theme');
    expect(bot).toMatchObject({ writtenMemory: { enabled: true }, extractedMemory: { enabled: true }, agentComputer: { enabled: true, liveBrowser: false, profileOmitsCookieDomains: [] } });
  });

  it("name the product and the path its service is called on as an Agent Computer's browser starts", () => {
    const product = { productName: 'Example Bot', productService: { agentComputerStartedPath: '/me/agent-computer/seed' } };
    expect(loadBotCube(configFile({  }, { ...EXAMPLE_BOT, ...product })).bot).toMatchObject(product);
  });

  it('name a file of bot-wide instructions', () => {
    expect(loadBotCube(configFile({  }, { ...EXAMPLE_BOT, instructions: 'INSTRUCTIONS.md' })).bot).toMatchObject({ instructions: 'INSTRUCTIONS.md' });
  });

  it("name the domains whose cookies the Agent Computer's saved profile omits", () => {
    const bot = { ...EXAMPLE_BOT, agentComputer: { profileOmitsCookieDomains: ['site.example'] } };
    expect(loadBotCube(configFile({  }, bot)).bot.agentComputer).toEqual({ enabled: true, liveBrowser: false, profileOmitsCookieDomains: ['site.example'] });
  });
});
