import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDeployment } from './load.js';
import { DeploymentConfigError } from './parse.js';

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}/deployment-config.json`, import.meta.url));

const EXAMPLE_BOT = {
  agentIdentity: { name: 'BotCube', character: 'A template agent', avatar: '🧊' },
  accountKey: 'template',
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  skills: ['skills/computer'],
  memory: true,
  agentComputer: { enabled: true, liveBrowser: true },
};

const THEME = { agentBody: '#f5d0a9', agentOutline: '#d9915a', agentDeep: '#9a5a2b', agentDeepest: '#4a2810' };

const DEFAULT_SECTIONS = {
  allowCommandCredentials: false,
  identity: { kind: 'botcube-accounts' },
  models: { kind: 'bedrock' },
  harnessAuth: { kind: 'sigv4' },
  turnCredentials: { kind: 'web-identity' },
  schedules: { kind: 'eventbridge-scheduler' },
  liveView: { kind: 'agentcore-browser' },
  telemetry: { kind: 'xray' },
  proxy: { kind: 'none' },
};

function configFile(config: unknown, bot: unknown = EXAMPLE_BOT): string {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-config-'));
  writeFileSync(join(dir, 'bot.json'), JSON.stringify(bot));
  const path = join(dir, 'deployment-config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const ENTERPRISE_MODELS = {
  kind: 'openai-compatible',
  url: 'https://models.example.com/v1',
  credential: { kind: 'file', path: '/run/secrets/botcube/models-api-key' },
  headers: { 'x-tenant': 'botcube-example' },
  turnSummaryModel: 'example-summary',
};

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube-example/models-api-key';
const COMMAND = { kind: 'command', command: ['/usr/local/bin/token-broker', '--audience', 'models'] };

const OIDC_CLIENT_SECRET = { kind: 'secret', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/oidc-client-secret' };
const OIDC = {
  kind: 'oidc',
  issuer: 'https://login.example.com',
  clients: [{ clientId: 'botcube', clientSecret: OIDC_CLIENT_SECRET }],
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
const ENTERPRISE_SECTIONS = {
  identity: OIDC,
  models: ENTERPRISE_MODELS,
  harnessAuth: { kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] },
  turnCredentials: { kind: 'assume-role' },
  schedules: { kind: 'table-poller' },
  telemetry: { kind: 'otlp' },
  proxy: { kind: 'forward' },
};

describe('the examples', () => {
  it.each([
    ['public', {}],
    ['enterprise', ENTERPRISE_SECTIONS],
  ])('the %s example deploys the example bot on its adapters', (name, sections) => {
    const { bot, config } = loadDeployment(example(name));
    expect(bot).toEqual({ $schema: '../../deployment-config/bot-settings.schema.json', ...EXAMPLE_BOT, agentComputer: { ...EXAMPLE_BOT.agentComputer, profileOmitsCookieDomains: [] } });
    expect(config).toMatchObject({ $schema: '../../deployment-config/deployment-config.schema.json', bot: '../bot/bot.json', ...DEFAULT_SECTIONS, ...sections });
  });

  it('the public example creates its own resources and talks to the internet directly', () => {
    const { config } = loadDeployment(example('public'));
    expect([config.supplied, config.proxy]).toEqual([undefined, { kind: 'none' }]);
    expect(config.imageRegistry).toBe('public.ecr.aws');
  });

  it('the enterprise example supplies its own resources, collector, proxy and image mirror', () => {
    const { config } = loadDeployment(example('enterprise'));
    expect(Object.keys(config.supplied ?? {})).toEqual(['network', 'kmsKeys', 'tables', 'buckets']);
    expect(config.imageRegistry).toBe('mirror.example.com/ecr-public');
    expect(config.telemetry).toEqual({
      kind: 'otlp',
      url: 'http://otel-collector.example.com:4318/v1/traces',
      credential: { kind: 'file', path: '/run/secrets/botcube/telemetry-token' },
      headers: { 'x-tenant': 'botcube-example' },
    });
    expect(config.proxy).toEqual({
      kind: 'forward',
      url: 'http://proxy.example.com:3128',
      noProxy: ['.amazonaws.com'],
      credential: { kind: 'file', path: '/run/secrets/botcube/proxy-token' },
      headers: { 'x-egress-route': 'botcube-example' },
    });
  });
});

describe('a Deployment Config', () => {
  it("stops on a bot whose settings watch the live view the deployment turns off, naming both", () => {
    const path = configFile({ bot: './bot.json', liveView: { kind: 'none' } });
    expect(() => loadDeployment(path)).toThrow(`Deployment Config ${path}: liveView: none, but the bot settings turn agentComputer.liveBrowser on`);
    const off = configFile({ bot: './bot.json', liveView: { kind: 'none' } }, { ...EXAMPLE_BOT, agentComputer: { ...EXAMPLE_BOT.agentComputer, liveBrowser: false } });
    expect(loadDeployment(off).config.liveView).toEqual({ kind: 'none' });
  });

  it('opens every missing section on its default adapter', () => {
    expect(loadDeployment(configFile({ bot: './bot.json' })).config).toEqual({ bot: './bot.json', ...DEFAULT_SECTIONS, imageRegistry: 'public.ecr.aws' });
  });

  it.each<[string, object, string]>([
    ['an unknown key', { bot: './bot.json', identty: { kind: 'botcube-accounts' } }, 'identty: Unrecognized key'],
    ['an unknown key in a section', { bot: './bot.json', schedules: { kind: 'eventbridge-scheduler', table: 'x' } }, 'schedules.table: Unrecognized key'],
    ['an unknown kind', { bot: './bot.json', models: { kind: 'vertex' } }, "models.kind: Invalid discriminator value. Expected 'bedrock' | 'openai-compatible'"],
    ['the deleted API key field', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, apiKey: { secretArn: SECRET_ARN } } }, 'models.apiKey: Unrecognized key'],
    ['an OpenAI-compatible endpoint without its credential', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: undefined } }, 'models.credential: '],
    ['an API key written in place of its source', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: 'sk-live' } }, 'models.credential: '],
    ['an unknown credential source', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { kind: 'vault', path: 'x' } } },
      "models.credential.kind: Invalid discriminator value. Expected 'secret' | 'file' | 'command'"],
    ['an unknown field on a credential source', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { kind: 'file', path: '/run/key', format: 'json' } } },
      'models.credential.format: Unrecognized key'],
    ['a secret named by something other than its ARN', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { kind: 'secret', secretArn: 'models-api-key' } } },
      'models.credential.secretArn: '],
    ['a credential file by a relative path', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { kind: 'file', path: 'secrets/key' } } },
      'models.credential.path: '],
    ['a command with no program', { bot: './bot.json', allowCommandCredentials: true, models: { ...ENTERPRISE_MODELS, credential: { kind: 'command', command: [] } } },
      'models.credential.command.0: '],
    ['a botcube models credential', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { kind: 'botcube', audience: 'models' } } },
      'models.credential: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ['a botcube OIDC client secret', { bot: './bot.json', identity: { kind: 'oidc', issuer: 'https://login.example.com', clients: [{ clientId: 'botcube', clientSecret: { kind: 'botcube', audience: 'login.example.com' } }] } },
      'identity.clients.0.clientSecret: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ...(['tokenEndpoint', 'clientId', 'clientSecret'] as const).map(field => [
      `an OAuth client-credentials source without its ${field}`,
      { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, [field]: undefined } } },
      `models.credential.${field}: `,
    ] as const),
    ['an OAuth client secret given as its value', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, clientSecret: 's3cret' } } },
      'models.credential.clientSecret: '],
    ...([
      ['aws', { kind: 'aws', audience: 'login.example.com' }],
      ['botcube', { kind: 'botcube', audience: 'login.example.com' }],
      ['oauth-client-credentials', OAUTH],
    ] as const).map(([kind, clientSecret]) => [
      `an OAuth client secret from a ${kind} source`, { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, clientSecret } } },
      "models.credential.clientSecret.kind: Invalid discriminator value. Expected 'secret' | 'file' | 'command'",
    ] as const),
    ['an OAuth token endpoint over http beyond this machine', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, tokenEndpoint: 'http://login.example.com/oauth2/token' } } },
      'models.credential.tokenEndpoint: A token endpoint is an https URL'],
    ['an empty OAuth scope list', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, scopes: [] } } }, 'models.credential.scopes: '],
    ['two OAuth scopes in one string', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, scopes: ['models.read models.write'] } } },
      'models.credential.scopes.0: Expected an OAuth scope'],
    ['an OAuth command client secret without the opt-in', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: { ...OAUTH, clientSecret: COMMAND } } },
      'models.credential.clientSecret: A command credential runs only when allowCommandCredentials is true'],
    ['a command source without the opt-in',{ bot: './bot.json', models: { ...ENTERPRISE_MODELS, credential: COMMAND } },
      'models.credential: A command credential runs only when allowCommandCredentials is true'],
    ['a header that is not a header name', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, headers: { 'x tenant': 'a' } } }, 'models.headers.x tenant: '],
    ['an authorization header beside the credential', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, headers: { Authorization: 'Bearer sk-live' } } },
      'models.headers.Authorization: The credential sets Authorization'],
    ['an OpenAI-compatible endpoint over plain HTTP', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, url: 'http://models.example.com/v1' } }, 'models.url: '],
    ['an OpenAI-compatible endpoint without a turn summary model', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, turnSummaryModel: undefined } }, 'models.turnSummaryModel: '],
    ['cache markers in a format BotCube does not write', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, cacheMarkers: 'openai' } }, 'models.cacheMarkers: '],
    ['cache markers turned on as a flag', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, cacheMarkers: true } }, 'models.cacheMarkers: '],
    ['a section without its kind', { bot: './bot.json', harnessAuth: {} }, "harnessAuth.kind: Invalid discriminator value. Expected 'sigv4' | 'jwt-bearer'"],
    ['a JWT bearer without its client', { bot: './bot.json', harnessAuth: { kind: 'jwt-bearer' } }, 'harnessAuth.clients: '],
    ['a JWT bearer on the old audience field', { bot: './bot.json', harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }], audience: 'botcube-harness' } },
      'harnessAuth.audience: Unrecognized key'],
    ...['https://login.example.com', 'http://login.example.com/.well-known/openid-configuration', 'login.example.com/.well-known/openid-configuration'].map(issuer => [
      `a JWT bearer issuer ${issuer}, which is not an https discovery URL`, { bot: './bot.json', harnessAuth: { ...EXTERNAL_HARNESS, issuer } },
      "harnessAuth.issuer: Expected 'botcube' or an https OIDC discovery URL ending in /.well-known/openid-configuration",
    ] as const),
    ['a JWT bearer from a discovery URL without its token', { bot: './bot.json', harnessAuth: { ...EXTERNAL_HARNESS, token: undefined } },
      'harnessAuth.token: An issuer at a discovery URL needs the token Chat sends it, a Credential Source'],
    ['a token beside the botcube issuer', { bot: './bot.json', harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }], token: EXTERNAL_HARNESS.token } },
      'harnessAuth.token: Chat signs its own bearer for the botcube issuer; token is for an issuer at a discovery URL'],
    ['a command Harness token without the opt-in', { bot: './bot.json', harnessAuth: { ...EXTERNAL_HARNESS, token: COMMAND } },
      'harnessAuth.token: A command credential runs only when allowCommandCredentials is true'],
    ['a botcube Harness token', { bot: './bot.json', harnessAuth: { ...EXTERNAL_HARNESS, token: { kind: 'botcube', audience: 'botcube-harness' } } },
      'harnessAuth.token: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ...['sts.amazonaws.com', 'botcube-user', 'botcube-chat-service'].map(audience => [
      `a JWT bearer on the reserved audience ${audience}`, { bot: './bot.json', harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }, { clientId: audience }] } },
      `harnessAuth.clients.1.clientId: The Harness audience ${audience} is reserved for another kind of BotCube token`,
    ] as const),
    ['a missing bot settings file reference', {}, 'bot: '],
    ['an OIDC provider without its client secret', { bot: './bot.json', identity: { ...OIDC, clients: [{ clientId: 'botcube' }] } }, 'identity.clients.0.clientSecret: '],
    ['a client secret given as its value', { bot: './bot.json', identity: { ...OIDC, clients: [{ clientId: 'botcube', clientSecret: 's3cret' }] } }, 'identity.clients.0.clientSecret: '],
    ['a client secret named by its ARN alone', { bot: './bot.json', identity: { ...OIDC, clients: [{ clientId: 'botcube', clientSecret: { secretArn: OIDC_CLIENT_SECRET.secretArn } }] } },
      'identity.clients.0.clientSecret.kind: '],
    ['an OIDC provider with no client', { bot: './bot.json', identity: { ...OIDC, clients: [] } }, 'identity.clients.0: '],
    ['a sign-in client listed twice', { bot: './bot.json', identity: { ...OIDC, clients: [...OIDC.clients, ...OIDC.clients] } },
      'identity.clients.1.clientId: Client botcube is already identity.clients.0.clientId'],
    ...['clientId', 'clientSecret'].map(field => [
      `the old identity.${field} field`, { bot: './bot.json', identity: { ...OIDC, [field]: field === 'clientId' ? 'botcube' : { secretArn: OIDC_CLIENT_SECRET.secretArn } } },
      `identity.${field}: Unrecognized key`,
    ] as const),
    ['a command client secret without the opt-in', { bot: './bot.json', identity: { ...OIDC, clients: [{ clientId: 'botcube', clientSecret: COMMAND }] } },
      'identity.clients.0.clientSecret: A command credential runs only when allowCommandCredentials is true'],
    ['an OIDC issuer over http beyond this machine', { bot: './bot.json', identity: { ...OIDC, issuer: 'http://login.example.com' } }, 'identity.issuer: '],
    ['an unknown supplied resource', { bot: './bot.json', supplied: { queues: {} } }, 'supplied.queues: Unrecognized key'],
    ['the old existing section', { bot: './bot.json', existing: {} }, 'existing: Unrecognized key'],
    ['a KMS key that is not an ARN', { bot: './bot.json', supplied: { kmsKeys: { vault: 'alias/vault' } } }, 'supplied.kmsKeys.vault: '],
    [
      "another table's stream",
      { bot: './bot.json', supplied: { tables: { chat: { tableName: 'chat', streamArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/other/stream/2026' } } } },
      "supplied.tables.chat.streamArn: The stream is table other's, not chat's",
    ],
    ['a proxy that is not an http(s) URL', { bot: './bot.json', proxy: { kind: 'forward', url: 'socks5://proxy:1080' } }, 'proxy.url: '],
    ['a proxy in the old shape, with no kind', { bot: './bot.json', proxy: { url: 'http://proxy:3128' } }, 'proxy.kind: '],
    ['a Proxy-Authorization header beside the proxy credential', { bot: './bot.json', proxy: { kind: 'forward', url: 'http://proxy:3128', headers: { 'Proxy-Authorization': 'Basic x' } } },
      'proxy.headers.Proxy-Authorization: The credential sets Proxy-Authorization'],
    ...([
      ['a secret', { kind: 'secret', secretArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:proxy-token' }],
      ['a command', COMMAND],
      ['a botcube', { kind: 'botcube', audience: 'proxy' }],
    ] satisfies [string, object][]).map(([kind, credential]): [string, object, string] => [
      `${kind} proxy credential`,
      { bot: './bot.json', allowCommandCredentials: true, proxy: { kind: 'forward', url: 'http://proxy:3128', credential } },
      'proxy.credential: A proxy credential is read from a file; any other source would reach out through the proxy it authenticates',
    ]),
    ['an image registry given as a URL', { bot: './bot.json', imageRegistry: 'https://mirror.example.com' }, 'imageRegistry: Expected a registry host and optional path'],
    ['an image registry with a trailing slash', { bot: './bot.json', imageRegistry: 'mirror.example.com/' }, 'imageRegistry: Expected a registry host and optional path'],
    ['an OTLP endpoint with no URL', { bot: './bot.json', telemetry: { kind: 'otlp' } }, 'telemetry.url: '],
    ['the old telemetry.otlpEndpoint field', { bot: './bot.json', telemetry: { otlpEndpoint: 'http://collector:4318/v1/traces' } }, 'telemetry.kind: '],
    ['an authorization header beside the telemetry credential', { bot: './bot.json', telemetry: { kind: 'otlp', url: 'http://collector:4318/v1/traces', headers: { authorization: 'Bearer x' } } },
      'telemetry.headers.authorization: The credential sets Authorization'],
    ['a botcube telemetry credential', { bot: './bot.json', telemetry: { kind: 'otlp', url: 'http://collector:4318/v1/traces', credential: { kind: 'botcube', audience: 'collector' } } },
      'telemetry.credential: A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one'],
    ['a command telemetry credential without the opt-in', { bot: './bot.json', telemetry: { kind: 'otlp', url: 'http://collector:4318/v1/traces', credential: COMMAND } },
      'telemetry.credential: A command credential runs only when allowCommandCredentials is true'],
  ])('stops on %s and names the field', (_, config, field) => {
    const path = configFile(config);
    expect(() => loadDeployment(path)).toThrow(`Deployment Config ${path}: ${field}`);
  });

  it.each([
    ['a Secrets Manager secret', { kind: 'secret', secretArn: SECRET_ARN }],
    ['a mounted file', { kind: 'file', path: '/run/secrets/botcube/models-api-key' }],
  ])('gives the models endpoint its credential from %s', (_, credential) => {
    const models = { ...ENTERPRISE_MODELS, credential };
    expect(loadDeployment(configFile({ bot: './bot.json', models })).config.models).toEqual(models);
  });

  it('marks Claude cache breakpoints on the models endpoint only when the operator turns them on', () => {
    expect(loadDeployment(configFile({ bot: './bot.json', models: ENTERPRISE_MODELS })).config.models).not.toHaveProperty('cacheMarkers');
    const models = { ...ENTERPRISE_MODELS, cacheMarkers: 'claude' };
    expect(loadDeployment(configFile({ bot: './bot.json', models })).config.models).toEqual(models);
  });

  it.each([
    ['a mounted file and no scope', OAUTH],
    ['a Secrets Manager secret and scopes', { ...OAUTH, clientSecret: { kind: 'secret', secretArn: SECRET_ARN }, scopes: ['models.invoke', 'api://botcube/.default'] }],
    ['a stand-in token endpoint on this machine', { ...OAUTH, tokenEndpoint: 'http://127.0.0.1:9400/token' }],
  ])('gives the models endpoint an OAuth client-credentials token from %s', (_, credential) => {
    const models = { ...ENTERPRISE_MODELS, credential };
    expect(loadDeployment(configFile({ bot: './bot.json', models })).config.models).toEqual(models);
  });

  it('runs an opted-in command for an OAuth client secret', () => {
    const credential = { ...OAUTH, clientSecret: COMMAND };
    const config = loadDeployment(configFile({ bot: './bot.json', allowCommandCredentials: true, models: { ...ENTERPRISE_MODELS, credential } })).config;
    expect(config.models).toMatchObject({ credential: { clientSecret: { ...COMMAND, timeoutSeconds: 30 } } });
  });

  it.each([
    ['a Secrets Manager secret', { allowCommandCredentials: false }, { kind: 'secret', secretArn: SECRET_ARN }],
    ['a mounted file', { allowCommandCredentials: false }, { kind: 'file', path: '/run/secrets/botcube/harness-token' }],
    ['an opted-in command', { allowCommandCredentials: true }, { ...COMMAND, timeoutSeconds: 30 }],
  ])('trusts an outside Harness issuer at its discovery URL, with the token from %s', (_, optIn, token) => {
    const harnessAuth = { ...EXTERNAL_HARNESS, token };
    expect(loadDeployment(configFile({ bot: './bot.json', ...optIn, harnessAuth })).config.harnessAuth).toEqual(harnessAuth);
  });

  it('takes a second sign-in client as a list entry', () => {
    const clients = [...OIDC.clients, { clientId: 'botcube-mobile', clientSecret: { kind: 'file', path: '/run/secrets/botcube/mobile-client-secret' } }];
    expect(loadDeployment(configFile({ bot: './bot.json', identity: { ...OIDC, clients } })).config.identity).toMatchObject({ clients });
  });

  it('runs an opted-in command for the models credential, 30 s at most unless it says otherwise', () => {
    const config = loadDeployment(configFile({ bot: './bot.json', allowCommandCredentials: true, models: { ...ENTERPRISE_MODELS, credential: COMMAND } })).config;
    expect(config).toMatchObject({ allowCommandCredentials: true, models: { credential: { ...COMMAND, timeoutSeconds: 30 } } });
  });

  it.each([
    ['a Secrets Manager secret', OIDC_CLIENT_SECRET],
    ['a mounted file', { kind: 'file', path: '/run/secrets/botcube/oidc-client-secret' }],
  ])('signs Users in with the OIDC client secret from %s', (_, clientSecret) => {
    const identity = { ...OIDC, clients: [{ clientId: 'botcube', clientSecret }] };
    expect(loadDeployment(configFile({ bot: './bot.json', identity })).config.identity).toEqual(identity);
  });

  it('takes a stand-in OIDC issuer over http on this machine', () => {
    const identity = { ...OIDC, issuer: 'http://127.0.0.1:9400' };
    expect(loadDeployment(configFile({ bot: './bot.json', identity })).config.identity).toEqual(identity);
  });

  it('stops when its bot settings file is missing', () => {
    const path = configFile({ bot: './absent.json' });
    expect(() => loadDeployment(path)).toThrow(`Deployment Config ${path}: bot: no file at ${join(path, '..', 'absent.json')}`);
  });

  it('stops when there is no file at its path, naming the path', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'deployment-config-')), 'absent.json');
    expect(() => loadDeployment(path)).toThrow(new DeploymentConfigError(`Deployment Config ${path}: no file`));
  });

  it('stops when its file is not JSON, naming the path', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'deployment-config-')), 'deployment-config.json');
    writeFileSync(path, '{ "bot": ');
    expect(() => loadDeployment(path)).toThrow(DeploymentConfigError);
    expect(() => loadDeployment(path)).toThrow(`Deployment Config ${path}: not JSON: `);
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
    ['a Memory gate that is not a switch', { ...EXAMPLE_BOT, memory: 'on' }, 'memory: '],
    ['a live browser without the Agent Computer', { ...EXAMPLE_BOT, agentComputer: { enabled: false, liveBrowser: true } }, 'agentComputer.liveBrowser: The live browser is part of the Agent Computer'],
    ['a profile-omitted cookie domain that is a URL', { ...EXAMPLE_BOT, agentComputer: { profileOmitsCookieDomains: ['https://site.example'] } }, 'agentComputer.profileOmitsCookieDomains.0: Expected a domain such as example.com'],
  ])('stop on %s and name the field', (_, bot, field) => {
    const path = configFile({ bot: './bot.json' }, bot);
    expect(() => loadDeployment(path)).toThrow(`Bot settings ${join(path, '..', 'bot.json')}: ${field}`);
  });

  it('change the theme, the Memory gate and the Agent Computer switches', () => {
    const bot = { ...EXAMPLE_BOT, theme: THEME, memory: false, agentComputer: { enabled: false, liveBrowser: false } };
    expect(loadDeployment(configFile({ bot: './bot.json' }, bot)).bot).toMatchObject({
      theme: { agentBody: '#f5d0a9', agentOutline: '#d9915a', agentDeep: '#9a5a2b', agentDeepest: '#4a2810' },
      memory: false,
      agentComputer: { enabled: false, liveBrowser: false },
    });
  });

  it("leave out the Web UI's, for BotCube's colours, a Memory and the Agent Computer without its live browser", () => {
    const { agentIdentity, accountKey, models } = EXAMPLE_BOT;
    const { bot } = loadDeployment(configFile({ bot: './bot.json' }, { agentIdentity, accountKey, models }));
    expect(bot).not.toHaveProperty('theme');
    expect(bot).toMatchObject({ memory: true, agentComputer: { enabled: true, liveBrowser: false, profileOmitsCookieDomains: [] } });
  });

  it('name a file of bot-wide instructions', () => {
    expect(loadDeployment(configFile({ bot: './bot.json' }, { ...EXAMPLE_BOT, instructions: 'INSTRUCTIONS.md' })).bot).toMatchObject({ instructions: 'INSTRUCTIONS.md' });
  });

  it("name the domains whose cookies the Agent Computer's saved profile omits", () => {
    const bot = { ...EXAMPLE_BOT, agentComputer: { profileOmitsCookieDomains: ['site.example'] } };
    expect(loadDeployment(configFile({ bot: './bot.json' }, bot)).bot.agentComputer).toEqual({ enabled: true, liveBrowser: false, profileOmitsCookieDomains: ['site.example'] });
  });
});

