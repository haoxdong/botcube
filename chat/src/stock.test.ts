import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunAgentInput } from '@ag-ui/client';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { HttpError, type AccountHistory } from './cartridge.js';
import { stockAccountStore, stockChatService } from './stock.js';

const history: AccountHistory = { delete: async () => undefined, transfer: async () => undefined, ownsMainChat: async () => false, owns: async () => true };

const PUBLIC_EXAMPLE = fileURLToPath(new URL('../../examples/public/deployment-config.json', import.meta.url));

function deploymentConfig(bot: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'stock-deployment-'));
  writeFileSync(join(dir, 'bot.json'), JSON.stringify(bot));
  writeFileSync(join(dir, 'deployment-config.json'), JSON.stringify({ bot: './bot.json' }));
  return join(dir, 'deployment-config.json');
}

const turn = (forwardedProps: Record<string, unknown>) =>
  ({ threadId: 'session-1', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps }) as RunAgentInput;

describe('the stock Chat Service', () => {
  it('stops before serving without a Deployment Config', () => {
    expect(() => stockChatService({})).toThrow('BOTCUBE_DEPLOYMENT_CONFIG is not set');
  });

  it('takes its Agent Identity, Soul and models from the bot settings its Deployment Config names', () => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({
      agentIdentity: { name: 'Quill', character: 'A drafting agent', avatar: '🪶' },
      soul: 'Write plainly.',
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }, { key: 'echo-2', label: 'Echo 2', description: 'Also echoes', provider: 'echo' }],
    }) })(history);

    expect(service.agentDocuments).toEqual({ agentIdentity: { name: 'Quill', character: 'A drafting agent', vibe: 'Direct, precise, and calm', avatar: '🪶' }, soul: 'Write plainly.' });
    expect(service.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }, { key: 'echo-2', label: 'Echo 2', description: 'Also echoes', provider: 'echo' }]);
  });

  it.each([[undefined, true], [false, false]])('takes its Memory gate from the bot settings (memory %j)', (memory, kept) => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: deploymentConfig({
      agentIdentity: { name: 'Quill', character: 'A drafting agent' },
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
      ...(memory === undefined ? {} : { memory }),
    }) })(history);

    expect(service.memory).toBe(kept);
  });

  it('stops before serving when its bot settings are wrong, naming the field', () => {
    const path = deploymentConfig({ agentIdentity: { name: 'Quill' }, models: [{ key: 'echo', label: 'Echo', provider: 'echo' }] });
    expect(() => stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: path })).toThrow(`Bot settings ${join(path, '..', 'bot.json')}: agentIdentity.character: `);
  });

  it('offers only the bot settings\' models, with no account models', async () => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE })(history);

    expect(service.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }]);
    expect(await service.accountModels({ owner: 'owner' })).toEqual([]);
    await expect(service.accountModel({ owner: 'owner' }, 'openai-plan:gpt-5.5')).resolves.toBeUndefined();
  });

  it("files each request under the browser's account and forwards the Turn with its Agent Computer", async () => {
    const env = { BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE };
    const service = stockChatService(env, { accountStore: stockAccountStore(env, memoryDocuments()) })(history);
    const route = new Hono()
      .onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, 500))
      .route('/', service.routes)
      .get('/requester', async (c) => c.json(await service.requester(c)));

    expect(await (await route.request('/requester')).json()).toEqual({ detail: 'Missing template account cookie' });
    const session = await route.request('/account/session');
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toMatch(/^template_account_id=acct_/);
    const requester = await (await route.request('/requester', { headers: { Cookie: cookie } })).json() as { owner: string };
    expect(requester).toEqual({ owner: (await session.json() as { accountId: string }).accountId, anonymous: true });
    expect(service.filingUserId(requester.owner)).toBe(requester.owner);
    expect(await (await route.request('/account/sign-ins', { headers: { Cookie: cookie } })).json()).toEqual({ signIns: [] });
    expect(await service.invocationPayload(turn({ model: 'echo' }), requester, service.models[0])).toEqual({
      ...turn({ model: 'echo' }),
      forwardedProps: { model: 'echo', agentComputerCdpUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:8123\/agent-computer\/cdp\?token=/) },
    });
  });

  it("replaces a client-supplied CDP endpoint with its own Agent Computer's", async () => {
    const service = stockChatService({ BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE, BOTCUBE_AGENT_COMPUTER_CDP_URL: 'ws://chat-service:8123/agent-computer/cdp' })(history);
    const input = turn({ model: 'echo', agentComputerCdpUrl: 'ws://untrusted.invalid' });
    expect(await service.invocationPayload(input, { owner: 'owner' }, service.models[0])).toEqual({
      ...input,
      forwardedProps: { model: 'echo', agentComputerCdpUrl: expect.stringMatching(/^ws:\/\/chat-service:8123\/agent-computer\/cdp\?token=/) },
    });
  });

  it('serves Files from EFS, refusing them until EFS is configured', async () => {
    const env = { BOTCUBE_DEPLOYMENT_CONFIG: PUBLIC_EXAMPLE };
    const service = stockChatService(env, { accountStore: stockAccountStore(env, memoryDocuments()) })(history);
    const route = new Hono().onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, error instanceof HttpError ? error.status as 503 : 500)).route('/', service.routes);
    const cookie = (await route.request('/account/session')).headers.get('set-cookie')?.split(';')[0] ?? '';

    const files = await route.request('/files', { headers: { Cookie: cookie } });
    expect(files.status).toBe(503);
    expect(await files.json()).toEqual({ detail: expect.stringContaining('Files on EFS are not configured') });
  });
});
