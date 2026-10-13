import type { RunAgentInput } from '@ag-ui/client';
import { Hono } from 'hono';
import { HttpError, type AccountHistory } from 'botcube-chat';
import { describe, expect, it } from 'vitest';
import { memoryDocuments } from '../../../chat/test/memory-documents.js';
import { templateAccountStore } from './account.js';
import { templateCartridge, templateCartridgeFactory } from './cartridge.js';

const history: AccountHistory = { delete: async () => undefined, transfer: async () => undefined, ownsMainChat: async () => false,
      owns: async () => true };

describe('the template Chat Service Cartridge', () => {
  it('offers the echo model, which the template Harness answers, and no others', async () => {
    const cartridge = templateCartridge(history);

    expect(cartridge.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }]);
    expect(await cartridge.accountModels({ owner: 'template-user' })).toEqual([]);
    await expect(cartridge.accountModel({ owner: 'template-user' }, 'openai-plan:gpt-5.5')).resolves.toBeUndefined();
  });

  it('mounts its auth route through the Chat Service seam', async () => {
    const response = await templateCartridge(history).routes.request('/auth/template');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', actorId: 'template-user' });
  });

  it("files each request under the browser's account and forwards the Turn with its Agent Computer", async () => {
    const cartridge = templateCartridgeFactory({}, templateAccountStore({}, memoryDocuments()))(history);
    const input = {
      threadId: 'session-1', runId: 'run-1', state: {}, messages: [], tools: [], context: [],
      forwardedProps: { model: 'echo' },
    } as RunAgentInput;

    const route = new Hono()
      .onError((error, c) => c.json({ detail: error instanceof HttpError ? error.detail : error.message }, 500))
      .route('/', cartridge.routes)
      .get('/requester', async (c) => c.json(await cartridge.requester(c)));
    expect(await (await route.request('/requester')).json()).toEqual({ detail: 'Missing template account cookie' });
    const session = await route.request('/account/session');
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toMatch(/^template_account_id=acct_/);
    const requester = await (await route.request('/requester', { headers: { Cookie: cookie } })).json() as { owner: string };

    expect(requester).toEqual({ owner: (await session.json() as { accountId: string }).accountId });
    expect(cartridge.filingUserId(requester.owner)).toBe(requester.owner);
    expect(await cartridge.invocationPayload(input, requester, cartridge.models[0])).toEqual({
      ...input,
      forwardedProps: { model: 'echo', agentComputerCdpUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:8123\/agent-computer\/cdp\?token=/) },
    });
  });
});

it("replaces a client-supplied CDP endpoint with its own Agent Computer's", async () => {
  const cartridge = templateCartridgeFactory({ BOTCUBE_AGENT_COMPUTER_CDP_URL: 'ws://chat-service:8123/agent-computer/cdp' })(history);
  const input = { threadId: 'session-1', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: { model: 'echo', agentComputerCdpUrl: 'ws://untrusted.invalid' } } as RunAgentInput;
  expect(await cartridge.invocationPayload(input, { owner: 'owner' }, cartridge.models[0])).toEqual({
    ...input,
    forwardedProps: { model: 'echo', agentComputerCdpUrl: expect.stringMatching(/^ws:\/\/chat-service:8123\/agent-computer\/cdp\?token=/) },
  });
});

it("opens its Agent Computer on the fake site's login page, which must be a URL", () => {
  expect(() => templateCartridgeFactory({ TEMPLATE_SITE_URL: 'not-a-url' })(history)).toThrow('Invalid URL');
});
