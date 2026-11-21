import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configAdapters } from './config-adapters.js';
import { serveChatService } from './server.js';

const ROLE_ARN = 'arn:aws:iam::123456789012:role/bot-cube-user-memory';

/** A BotCube Config with these sections, beside the example bot. */
function botcubeConfig(sections: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'chat-deployment-')), 'botcube.yaml');
  writeFileSync(path, JSON.stringify({ ...sections }));
  return path;
}

describe("the Chat Service's adapters", () => {
  it("are the BotCube Config schema's defaults with no BotCube Config, as a deployment without one runs", () => {
    expect(configAdapters({})).toEqual({
      harnessAuth: { kind: 'sigv4' },
      awsAccess: { kind: 'web-identity' },
      schedules: { kind: 'eventbridge-scheduler' },
      telemetry: { kind: 'xray' },
      proxy: { kind: 'none' },
      corsOrigins: null,
      productName: undefined,
      automationUserAgents: [],
      models: { kind: 'bedrock' },
    });
  });

  it("take the web origins, product name and automation User-Agents from the BotCube Config, not the environment", () => {
    const path = botcubeConfig({ productName: 'Quill', parking: { automationUserAgents: ['probe/1'] }, network: { corsOrigins: ['https://quill.example.com'] } });
    const legacy = { BOTCUBE_CORS_ORIGINS: 'https://other.example.com', BOTCUBE_PRODUCT_NAME: 'Other', BOTCUBE_AUTOMATION_USER_AGENTS: 'bot' };

    expect(configAdapters({ BOTCUBE_CONFIG: path, ...legacy })).toMatchObject({
      corsOrigins: ['https://quill.example.com'], productName: 'Quill', automationUserAgents: ['probe/1'],
    });
    expect(configAdapters({ BOTCUBE_CONFIG: botcubeConfig({}), ...legacy }))
      .toMatchObject({ corsOrigins: null, productName: undefined, automationUserAgents: [] });
  });

  it("take the Harness auth from the BotCube Config's kind, not the environment", () => {
    const path = botcubeConfig({ integrations: { harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }] } } });

    expect(configAdapters({ BOTCUBE_CONFIG: path }).harnessAuth).toEqual({ kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] });
    expect(configAdapters({ BOTCUBE_CONFIG: botcubeConfig({}), BOTCUBE_HARNESS_AUTH: 'jwt-bearer' }).harnessAuth).toEqual({ kind: 'sigv4' });
  });

  it("assume the Memory role only under the BotCube Config's assume-role kind", () => {
    const path = botcubeConfig({ integrations: { awsAccess: { kind: 'assume-role' } } });

    expect(configAdapters({ BOTCUBE_CONFIG: path, BOTCUBE_USER_MEMORY_ROLE_ARN: ROLE_ARN }).awsAccess).toEqual({ kind: 'assume-role', roleArn: ROLE_ARN });
  });

  it.each([
    ['assume-role with no Memory role', { integrations: { awsAccess: { kind: 'assume-role' } } }, {}, 'awsAccess.kind: assume-role needs BOTCUBE_USER_MEMORY_ROLE_ARN'],
    ['assume-role with a role that is no IAM role ARN', { integrations: { awsAccess: { kind: 'assume-role' } } }, { BOTCUBE_USER_MEMORY_ROLE_ARN: 'bot-cube-user-memory' }, 'BOTCUBE_USER_MEMORY_ROLE_ARN must be an IAM role ARN'],
    ['a Memory role under web-identity', {}, { BOTCUBE_USER_MEMORY_ROLE_ARN: ROLE_ARN }, 'awsAccess: BOTCUBE_USER_MEMORY_ROLE_ARN is set but awsAccess.kind is web-identity'],
  ])('stop startup on %s, naming the missing or stray value', (_, sections, env, message) => {
    expect(() => configAdapters({ BOTCUBE_CONFIG: botcubeConfig(sections), ...env })).toThrow(message);
  });

  it('stop the Chat Service starting, before it listens, when the BotCube Config its locator names is missing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'chat-deployment-')), 'absent.json');

    expect(() => serveChatService({ PORT: '0', BOTCUBE_CONFIG: path })).toThrow(`BotCube Config ${path}: no file`);
  });

  it('stop the Chat Service starting, before it listens, when the BotCube Config its locator names fails the schema', () => {
    const path = botcubeConfig({ network: { proxy: { kind: 'forward' } } });

    expect(() => serveChatService({ PORT: '0', BOTCUBE_CONFIG: path })).toThrow(`BotCube Config ${path}: network.proxy.url`);
  });

  it('stop the Chat Service starting, before it listens, when the chosen kind is missing its environment', () => {
    expect(() => serveChatService({ PORT: '0', BOTCUBE_CONFIG: botcubeConfig({ integrations: { awsAccess: { kind: 'assume-role' } } }) }))
      .toThrow('awsAccess.kind: assume-role needs BOTCUBE_USER_MEMORY_ROLE_ARN');
  });
});
