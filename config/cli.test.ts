import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { main } from './footprint-cli.js';

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
