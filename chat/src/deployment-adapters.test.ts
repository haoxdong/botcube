import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatServiceCartridge } from './cartridge.js';
import { deploymentAdapters } from './deployment-adapters.js';
import { serveChatService } from './server.js';

const EXAMPLE_BOT = fileURLToPath(new URL('../../examples/bot/bot.json', import.meta.url));
const ROLE_ARN = 'arn:aws:iam::123456789012:role/bot-cube-user-memory';

/** A Deployment Config with these sections, beside the example bot. */
function deploymentConfig(sections: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'chat-deployment-')), 'deployment-config.json');
  writeFileSync(path, JSON.stringify({ bot: EXAMPLE_BOT, ...sections }));
  return path;
}

describe("the Chat Service's adapters", () => {
  it("are the Deployment Config schema's defaults with no Deployment Config, as a deployment without one runs", () => {
    expect(deploymentAdapters({})).toEqual({
      harnessAuth: { kind: 'sigv4' },
      turnCredentials: { kind: 'web-identity' },
      schedules: { kind: 'eventbridge-scheduler' },
    });
  });

  it("take the Harness auth from the Deployment Config's kind, not the environment", () => {
    const path = deploymentConfig({ harnessAuth: { kind: 'jwt-bearer', clients: [{ clientId: 'botcube-harness' }] } });

    expect(deploymentAdapters({ BOTCUBE_DEPLOYMENT_CONFIG: path }).harnessAuth).toEqual({ kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] });
    expect(deploymentAdapters({ BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({}), BOTCUBE_HARNESS_AUTH: 'jwt-bearer' }).harnessAuth).toEqual({ kind: 'sigv4' });
  });

  it("assume the Memory role only under the Deployment Config's assume-role kind", () => {
    const path = deploymentConfig({ turnCredentials: { kind: 'assume-role' } });

    expect(deploymentAdapters({ BOTCUBE_DEPLOYMENT_CONFIG: path, BOTCUBE_USER_MEMORY_ROLE_ARN: ROLE_ARN }).turnCredentials).toEqual({ kind: 'assume-role', roleArn: ROLE_ARN });
  });

  it.each([
    ['assume-role with no Memory role', { turnCredentials: { kind: 'assume-role' } }, {}, 'turnCredentials.kind: assume-role needs BOTCUBE_USER_MEMORY_ROLE_ARN'],
    ['assume-role with a role that is no IAM role ARN', { turnCredentials: { kind: 'assume-role' } }, { BOTCUBE_USER_MEMORY_ROLE_ARN: 'bot-cube-user-memory' }, 'BOTCUBE_USER_MEMORY_ROLE_ARN must be an IAM role ARN'],
    ['a Memory role under web-identity', {}, { BOTCUBE_USER_MEMORY_ROLE_ARN: ROLE_ARN }, 'turnCredentials: BOTCUBE_USER_MEMORY_ROLE_ARN is set but turnCredentials.kind is web-identity'],
  ])('stop startup on %s, naming the missing or stray value', (_, sections, env, message) => {
    expect(() => deploymentAdapters({ BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig(sections), ...env })).toThrow(message);
  });

  it('stop the Chat Service starting, before it listens, when the chosen kind is missing its environment', () => {
    const cartridge = (): ChatServiceCartridge => { throw new Error('the Cartridge is built after the adapters'); };

    expect(() => serveChatService(cartridge, { PORT: '0', BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({ turnCredentials: { kind: 'assume-role' } }) }))
      .toThrow('turnCredentials.kind: assume-role needs BOTCUBE_USER_MEMORY_ROLE_ARN');
  });
});
