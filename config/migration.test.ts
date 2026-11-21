import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load.js';

function file(text: string, name = 'botcube.yaml'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'botcube-yaml-')), name);
  writeFileSync(path, text);
  return path;
}

describe('BotCube Config migration', () => {
  it('loads YAML 1.2 and fills integration and network defaults', () => {
    const config = loadConfig(file('productName: yes\nnetwork:\n  corsOrigins: [https://chat.example.com]\n'));
    expect(config.productName).toBe('yes');
    expect(loadConfig(file('productName: 2026-11-21\n')).productName).toBe('2026-11-21');
    expect(config.integrations.signIn).toEqual({ kind: 'botcube-accounts' });
    expect(config.integrations.modelGateway).toEqual({ kind: 'bedrock' });
    expect(config.network).toEqual({ proxy: { kind: 'none' }, corsOrigins: ['https://chat.example.com'] });
  });

  it.each([
    ['identity', 'integrations.signIn'], ['models', 'integrations.modelGateway'],
    ['turnCredentials', 'integrations.awsAccess'], ['harnessAuth', 'integrations.harnessAuth'],
    ['telemetry', 'integrations.telemetry'], ['imageRegistry', 'integrations.imageRegistry'],
    ['supplied', 'existing'], ['proxy', 'network.proxy'], ['corsOrigins', 'network.corsOrigins'],
    ['bot', '/bot/bot.yaml'], ['web', 'network.corsOrigins'],
  ])('rejects %s and names %s', (key, replacement) => {
    expect(() => loadConfig(file(`${key}: {}\n`))).toThrow(`${key}: renamed to ${replacement}`);
  });

  it('rejects the old filename even when its contents use the new shape', () => {
    expect(() => loadConfig(file('{}', 'deployment-config.json'))).toThrow('deployment-config.json: renamed to botcube.yaml');
  });

  it('names the path of an unknown nested key', () => {
    expect(() => loadConfig(file('integrations:\n  signIn:\n    kind: botcube-accounts\n    typo: true\n'))).toThrow('integrations.signIn.typo: Unrecognized key');
  });

  it('rejects a YAML 1.1 directive', () => {
    expect(() => loadConfig(file('%YAML 1.1\n---\nproductName: yes\n'))).toThrow('expected YAML 1.2');
  });

  it('rejects duplicate keys', () => {
    expect(() => loadConfig(file('productName: First\nproductName: Second\n'))).toThrow('not YAML 1.2');
  });
});
