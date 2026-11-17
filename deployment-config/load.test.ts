import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDeployment } from './load.js';

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}/deployment-config.json`, import.meta.url));

const EXAMPLE_BOT = {
  agentIdentity: { name: 'BotCube', character: 'A template agent', avatar: '🧊' },
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  skills: ['skills/computer'],
  memory: true,
  agentComputer: { enabled: true, liveBrowser: true },
};

const THEME = { agentBody: '#f5d0a9', agentOutline: '#d9915a', agentDeep: '#9a5a2b', agentDeepest: '#4a2810' };

const DEFAULT_SECTIONS = {
  identity: { kind: 'botcube-accounts' },
  models: { kind: 'bedrock' },
  harnessAuth: { kind: 'sigv4' },
  turnCredentials: { kind: 'web-identity' },
  schedules: { kind: 'eventbridge-scheduler' },
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
  baseUrl: 'https://models.example.com/v1',
  apiKey: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube-example/models-api-key' },
  turnSummaryModel: 'example-summary',
};

const OIDC = {
  kind: 'oidc',
  issuer: 'https://login.example.com',
  clientId: 'botcube',
  clientSecret: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/oidc-client-secret' },
};

/** Where the enterprise example leaves the defaults, one section per seam. */
const ENTERPRISE_SECTIONS = {
  identity: OIDC,
  models: ENTERPRISE_MODELS,
  harnessAuth: { kind: 'jwt-bearer', audience: 'botcube-harness' },
  turnCredentials: { kind: 'assume-role' },
  schedules: { kind: 'table-poller' },
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
    expect([config.existing, config.telemetry, config.proxy]).toEqual([undefined, undefined, undefined]);
  });

  it('the enterprise example brings its own resources, collector and proxy', () => {
    const { config } = loadDeployment(example('enterprise'));
    expect(Object.keys(config.existing ?? {})).toEqual(['network', 'kmsKeys', 'tables', 'buckets']);
    expect(config.telemetry).toEqual({ otlpEndpoint: 'http://otel-collector.example.com:4318/v1/traces' });
    expect(config.proxy).toEqual({ url: 'http://proxy.example.com:3128', noProxy: ['.amazonaws.com'] });
  });
});

describe('a Deployment Config', () => {
  it('opens every missing section on its default adapter', () => {
    expect(loadDeployment(configFile({ bot: './bot.json' })).config).toEqual({ bot: './bot.json', ...DEFAULT_SECTIONS });
  });

  it.each<[string, object, string]>([
    ['an unknown key', { bot: './bot.json', identty: { kind: 'botcube-accounts' } }, 'identty: Unrecognized key'],
    ['an unknown key in a section', { bot: './bot.json', schedules: { kind: 'eventbridge-scheduler', table: 'x' } }, 'schedules.table: Unrecognized key'],
    ['an unknown kind', { bot: './bot.json', models: { kind: 'vertex' } }, "models.kind: Invalid discriminator value. Expected 'bedrock' | 'openai-compatible'"],
    ['an OpenAI-compatible endpoint without its API key', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, apiKey: undefined } }, 'models.apiKey: '],
    ['an API key written in place of its secret', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, apiKey: 'sk-live' } }, 'models.apiKey: '],
    ['an OpenAI-compatible endpoint over plain HTTP', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, baseUrl: 'http://models.example.com/v1' } }, 'models.baseUrl: '],
    ['an OpenAI-compatible endpoint without a turn summary model', { bot: './bot.json', models: { ...ENTERPRISE_MODELS, turnSummaryModel: undefined } }, 'models.turnSummaryModel: '],
    ['a section without its kind', { bot: './bot.json', harnessAuth: {} }, "harnessAuth.kind: Invalid discriminator value. Expected 'sigv4' | 'jwt-bearer'"],
    ['a JWT bearer without its audience', { bot: './bot.json', harnessAuth: { kind: 'jwt-bearer' } }, 'harnessAuth.audience: '],
    ...['sts.amazonaws.com', 'botcube-user', 'botcube-chat-service'].map(audience => [
      `a JWT bearer on the reserved audience ${audience}`, { bot: './bot.json', harnessAuth: { kind: 'jwt-bearer', audience } },
      `harnessAuth.audience: The Harness audience ${audience} is reserved for another kind of BotCube token`,
    ] as const),
    ['a missing bot settings file reference', {}, 'bot: '],
    ['an OIDC provider without its client secret', { bot: './bot.json', identity: { ...OIDC, clientSecret: undefined } }, 'identity.clientSecret: '],
    ['a client secret given as its value', { bot: './bot.json', identity: { ...OIDC, clientSecret: 's3cret' } }, 'identity.clientSecret: '],
    ['an OIDC issuer over http beyond this machine', { bot: './bot.json', identity: { ...OIDC, issuer: 'http://login.example.com' } }, 'identity.issuer: '],
    ['an unknown existing resource', { bot: './bot.json', existing: { queues: {} } }, 'existing.queues: Unrecognized key'],
    ['a KMS key that is not an ARN', { bot: './bot.json', existing: { kmsKeys: { vault: 'alias/vault' } } }, 'existing.kmsKeys.vault: '],
    [
      "another table's stream",
      { bot: './bot.json', existing: { tables: { chat: { tableName: 'chat', streamArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/other/stream/2026' } } } },
      "existing.tables.chat.streamArn: The stream is table other's, not chat's",
    ],
    ['a proxy that is not an http(s) URL', { bot: './bot.json', proxy: { url: 'socks5://proxy:1080' } }, 'proxy.url: '],
    ['an OTLP endpoint with no URL', { bot: './bot.json', telemetry: {} }, 'telemetry.otlpEndpoint: '],
  ])('stops on %s and names the field', (_, config, field) => {
    const path = configFile(config);
    expect(() => loadDeployment(path)).toThrow(`Deployment Config ${path}: ${field}`);
  });

  it('takes a stand-in OIDC issuer over http on this machine', () => {
    const identity = { ...OIDC, issuer: 'http://127.0.0.1:9400' };
    expect(loadDeployment(configFile({ bot: './bot.json', identity })).config.identity).toEqual(identity);
  });

  it('stops when its bot settings file is missing', () => {
    const path = configFile({ bot: './absent.json' });
    expect(() => loadDeployment(path)).toThrow(`Deployment Config ${path}: bot: no file at ${join(path, '..', 'absent.json')}`);
  });
});

describe('bot settings', () => {
  it.each([
    ['a missing Agent Identity name', { ...EXAMPLE_BOT, agentIdentity: { character: 'A template agent' } }, 'agentIdentity.name: '],
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
    const { agentIdentity, models } = EXAMPLE_BOT;
    const { bot } = loadDeployment(configFile({ bot: './bot.json' }, { agentIdentity, models }));
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

