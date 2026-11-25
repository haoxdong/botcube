import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { main } from './commands.js';

const publicExample = fileURLToPath(new URL('../examples/public/botcube.yaml', import.meta.url));
const enterpriseExample = fileURLToPath(new URL('../examples/enterprise/botcube.yaml', import.meta.url));
const exampleBot = fileURLToPath(new URL('../examples/bot/bot.yaml', import.meta.url));
const botcube = (...args: string[]) => {
  const printed = { stdout: '', stderr: '' };
  const status = main(args, { stdout: (text) => { printed.stdout += text; }, stderr: (text) => { printed.stderr += text; } });
  return { status, ...printed };
};
const runtimeSection = (printed: string) => /^Created at runtime\n((?: .*\n)*)/m.exec(printed)?.[1];

it('prints the access points the Chat Service creates at runtime by default', () => {
  const { status, stdout } = botcube('footprint', publicExample);
  expect(status).toBe(0);
  expect(runtimeSection(stdout)).toContain('elasticfilesystem:CreateAccessPoint on the Files file system');
});

it.each([['--files-access-point-mode', 'pool'], ['--files-access-point-mode=pool']])('prints none from the deploy-time pool (%s)', (...flag) => {
  const { status, stdout } = botcube('footprint', ...flag, publicExample);
  expect(status).toBe(0);
  expect(runtimeSection(stdout)).toBe('');
});

it.each([['--files-access-point-mode=shared'], ['--files-access-point-mode'], ['--unknown'], [publicExample]])('refuses %s as a usage error', (...flag) => {
  const { status, stderr } = botcube('footprint', publicExample, ...flag);
  expect(status).toBe(2);
  expect(stderr).toContain('--files-access-point-mode <runtime|pool>');
});

it('refuses a missing BotCube Config as a usage error', () => {
  expect(botcube('footprint').status).toBe(2);
});

const modelsSection = (printed: string) => /^Models\n((?: .*\n)*)/m.exec(printed)?.[1];

it("prints each model of the Bot Image's bot settings with its provider", () => {
  const { status, stdout } = botcube('footprint', '--bot', exampleBot, enterpriseExample);
  expect(status).toBe(0);
  expect(modelsSection(stdout)).toBe('  openai-compatible https://models.example.com/v1\n  model echo: openai\n');
});

it('refuses bot settings whose model is on a provider the gateway cannot reach, naming it', () => {
  const bot = join(mkdtempSync(join(tmpdir(), 'bot-')), 'bot.yaml');
  writeFileSync(bot, JSON.stringify({ agentIdentity: { name: 'Bot', character: 'A bot' }, accountKey: 'bot', models: [{ key: 'deepseek-v3.2', label: 'DeepSeek', provider: 'deepseek' }] }));
  const { status, stderr } = botcube('footprint', `--bot=${bot}`, enterpriseExample);
  expect(status).toBe(1);
  expect(stderr).toContain("the bot settings' model deepseek-v3.2 is on provider deepseek, but integrations.modelGateway reaches the providers anthropic and openai");
});

it('resolves the public example with deployment names and section defaults', () => {
  const { status, stdout, stderr } = botcube('resolve', publicExample);
  expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({
    formatVersion: 1,
    config: { integrations: { modelGateway: { kind: 'bedrock' } } },
    physicalNames: { memoryName: 'bot_cube_memory', agentCoreTargetName: 'template', parkStateParameterName: '/bot-cube/production/park-state' },
    webOrigins: ['https://chat.example.invalid', 'https://www.chat.example.invalid'],
    credentialServiceHttpPath: '',
    modelGateway: { anthropic: { route: null, unreachableReason: null } },
  });
});

it('omits the enterprise Anthropic route when its inherited URL is unusable', () => {
  const { status, stdout } = botcube('resolve', enterpriseExample);
  expect(status).toBe(0);
  expect(JSON.parse(stdout).modelGateway).toMatchObject({
    anthropic: {
      route: null,
      unreachableReason: expect.stringContaining('Anthropic'),
    },
    openai: {
      route: {
        url: 'https://models.example.com/v1',
        headers: { 'x-tenant': 'botcube-example' },
        credential: { kind: 'file', path: '/run/secrets/botcube/models-api-key' },
        useResponsesApi: false,
      },
      unreachableReason: null,
    },
  });
});

it('resolves an explicit empty providers object to no gateway routes', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'botcube-')), 'botcube.yaml');
  const config = JSON.parse(readFileSync(enterpriseExample, 'utf8'));
  config.integrations.modelGateway.providers = {};
  writeFileSync(path, JSON.stringify(config));
  const { status, stdout } = botcube('resolve', path);
  expect(status).toBe(0);
  expect(JSON.parse(stdout).modelGateway).toMatchObject({
    anthropic: { route: null, unreachableReason: expect.stringContaining('reaches the providers') },
    openai: { route: null, unreachableReason: expect.stringContaining('reaches the providers') },
  });
});

it('reports a loader error without emitting JSON', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'botcube-')), 'botcube.yaml');
  writeFileSync(path, '{}');
  const { status, stdout, stderr } = botcube('resolve', path);
  expect({ status, stdout }).toEqual({ status: 1, stdout: '' });
  expect(stderr).toContain("name: 'name' is a required property");
});

it('resolves provider overrides and the Credential Service HTTP path', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'botcube-')), 'botcube.yaml');
  const config = JSON.parse(readFileSync(enterpriseExample, 'utf8'));
  config.services.credentialService.http = { path: '/rpc' };
  config.integrations.modelGateway.providers = {
    openai: {
      url: 'https://openai.example.com/v1/',
      credential: { kind: 'file', path: '/run/secrets/openai' },
      headers: {},
      useResponsesApi: true,
    },
  };
  writeFileSync(path, JSON.stringify(config));
  const { status, stdout } = botcube('resolve', path);
  expect(status).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    credentialServiceHttpPath: '/rpc',
    modelGateway: {
      anthropic: { route: null, unreachableReason: 'integrations.modelGateway reaches the providers openai' },
      openai: {
        route: {
          url: 'https://openai.example.com/v1',
          credential: { kind: 'file', path: '/run/secrets/openai' },
          headers: {},
          useResponsesApi: true,
        },
        unreachableReason: null,
      },
    },
  });
});

it('rejects an explicit Anthropic URL that would duplicate the API version in the relay path', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'botcube-')), 'botcube.yaml');
  const config = JSON.parse(readFileSync(enterpriseExample, 'utf8'));
  config.integrations.modelGateway.providers = { anthropic: { url: 'https://models.example.com/anthropic/v1//' } };
  writeFileSync(path, JSON.stringify(config));
  const { status, stdout } = botcube('resolve', path);
  expect(status).toBe(0);
  expect(JSON.parse(stdout).modelGateway.anthropic).toEqual({
    route: null,
    unreachableReason: "integrations.modelGateway.providers.anthropic.url ends in /v1, which Anthropic's API adds itself: remove /v1 from that URL",
  });
});
