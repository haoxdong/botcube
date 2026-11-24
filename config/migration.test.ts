import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load.js';

function file(text: string, name = 'botcube.yaml'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'botcube-yaml-')), name);
  writeFileSync(path, text);
  return path;
}

const REQUIRED: Record<string, unknown> = JSON.parse(readFileSync(fileURLToPath(new URL('../tests/required-keys.json', import.meta.url)), 'utf8'));

/** The YAML text after the keys every BotCube Config gives, each as a flow collection. */
const deployment = (text: string): string => `${Object.entries(REQUIRED).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('')}${text}`;

describe('BotCube Config migration', () => {
  it('loads YAML 1.2 and fills integration and network defaults', () => {
    const config = loadConfig(file(deployment('tags:\n  team: yes\nnetwork:\n  natGateways: 0\n')));
    expect(config.tags).toEqual({ team: 'yes' });
    expect(loadConfig(file(deployment('tags:\n  team: 2026-11-21\n'))).tags).toEqual({ team: '2026-11-21' });
    expect(config.integrations.signIn).toEqual({ kind: 'botcube-accounts' });
    expect(config.integrations.modelGateway).toEqual({ kind: 'bedrock' });
    expect(config.integrations.proxy).toEqual({ kind: 'none' });
    expect(config.network).toEqual({ natGateways: 0 });
  });

  it.each([
    ['identity', 'integrations.signIn'], ['models', 'integrations.modelGateway'],
    ['turnCredentials', 'integrations.awsAccess'], ['harnessAuth', 'integrations.harnessAuth'],
    ['telemetry', 'integrations.telemetry'], ['imageRegistry', 'integrations.imageRegistry'],
    ['supplied', 'existing'], ['proxy', 'integrations.proxy'], ['corsOrigins', 'domains.web and domains.webAliases'],
    ['bot', '/bot/bot.yaml'], ['web', 'domains.web and domains.webAliases'],
    ['productName', "productName in /bot/bot.yaml, the Bot Image's bot settings"],
    ['productService', "productService in /bot/bot.yaml, the Bot Image's bot settings"],
  ])('rejects %s and names %s', (key, replacement) => {
    expect(() => loadConfig(file(`${key}: {}\n`))).toThrow(`${key}: renamed to ${replacement}`);
  });

  it.each([
    ['network.proxy', 'network:\n  proxy: { kind: none }\n', 'integrations.proxy'],
    ['network.corsOrigins', 'network:\n  corsOrigins: [https://chat.example.com]\n', 'domains.web and domains.webAliases'],
    ['existing.network', 'existing:\n  network: {}\n', 'existing.vpc, with network.natGateways 0'],
    ['integrations.proxy.noProxy', 'integrations:\n  proxy: { kind: forward, url: "http://proxy.example.com:3128", noProxy: [.example.com] }\n', 'proxy: integrations.proxy on each endpoint the proxy carries; every other destination goes direct'],
    ['integrations.modelGateway.wire', 'integrations:\n  modelGateway: { wire: responses }\n', "each model's provider in /bot/bot.yaml, anthropic or openai"],
    ['integrations.modelGateway.cacheMarkers', 'integrations:\n  modelGateway: { cacheMarkers: claude }\n', "each Claude model's provider anthropic in /bot/bot.yaml, whose calls carry cache markers"],
  ])('rejects the nested %s and names its replacement', (key, text, replacement) => {
    expect(() => loadConfig(file(text))).toThrow(`${key}: renamed to ${replacement}`);
  });

  it.each([
    ['integrations.telemetry.credential.secretArn', 'integrations:\n  telemetry:\n    kind: otlp\n    url: https://collector.example.com/v1/traces\n    credential: { kind: secret, secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:key" }\n'],
    ['integrations.signIn.clients.0.clientSecret.secretArn', 'integrations:\n  signIn:\n    kind: oidc\n    clients: [{ clientSecret: { kind: secret, secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:key" } }]\n'],
  ])("rejects a Credential Source's secretArn at %s and names secretId", (key, text) => {
    expect(() => loadConfig(file(text))).toThrow(`${key}: renamed to secretId, the secret's name or ARN`);
  });

  it.each(['arn:aws:secretsmanager:us-east-1:000000000000:secret:key', 'botcube/oidc-client-secret'])('reads a secret Credential Source by its secretId, %s', (secretId) => {
    const config = loadConfig(file(deployment(`integrations:\n  telemetry:\n    kind: otlp\n    url: https://collector.example.com/v1/traces\n    credential: { kind: secret, secretId: "${secretId}" }\n`)));
    expect(config.integrations.telemetry).toMatchObject({ credential: { kind: 'secret', secretId } });
  });

  it('rejects the old filename even when its contents use the new shape', () => {
    expect(() => loadConfig(file('{}', 'deployment-config.json'))).toThrow('deployment-config.json: renamed to botcube.yaml');
  });

  it('names the path of an unknown nested key', () => {
    expect(() => loadConfig(file('integrations:\n  signIn:\n    kind: botcube-accounts\n    typo: true\n'))).toThrow('integrations.signIn.typo: Unrecognized key');
  });

  it('rejects a YAML 1.1 directive', () => {
    expect(() => loadConfig(file('%YAML 1.1\n---\ntags:\n  team: yes\n'))).toThrow('expected YAML 1.2');
  });

  it('rejects duplicate keys', () => {
    expect(() => loadConfig(file('tags:\n  team: First\n  team: Second\n'))).toThrow('not YAML 1.2');
  });
});
