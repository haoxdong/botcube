import type { RunAgentInput } from '@ag-ui/client';
import { Hono } from 'hono';
import type { AccountHistory } from 'botcube-chat';
import { describe, expect, it } from 'vitest';
import { templateCartridge, templateCartridgeFactory } from './cartridge.js';

const history: AccountHistory = { delete: async () => undefined, transfer: async () => undefined, ownsMainChat: async () => false,
      owns: async () => true };

describe('the template Chat Service Cartridge', () => {
  it('names its browser live-view event for BotCube', () => {
    expect(templateCartridge(history).browserEventName).toBe('botcube:browser-live-view');
  });

  it('offers the echo model, which the template Harness answers, and no others', async () => {
    const cartridge = templateCartridge(history);

    expect(cartridge.models).toEqual([{ key: 'echo', label: 'Echo', provider: 'echo' }]);
    expect(await cartridge.accountModels({ owner: 'template-user' })).toEqual([]);
  });

  it('mounts its auth route through the Chat Service seam', async () => {
    const response = await templateCartridge(history).routes.request('/auth/template');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', actorId: 'template-user' });
  });

  it('files every request under the one local actor and forwards the Turn unchanged', async () => {
    const cartridge = templateCartridge(history);
    const input = {
      threadId: 'session-1', runId: 'run-1', state: {}, messages: [], tools: [], context: [],
      forwardedProps: { model: 'echo' },
    } as RunAgentInput;

    let requester: { owner: string } = { owner: '' };
    const route = new Hono().get('/', async (c) => { requester = await cartridge.requester(c); return c.json(requester); });
    const session = await route.request('/');
    expect(session.headers.get('set-cookie')).toContain('template_session=');

    expect(requester.owner).toMatch(/^template-/);
    expect(cartridge.filingUserId(requester.owner)).toBe(requester.owner);
    expect(await cartridge.invocationPayload(input, requester, cartridge.models[0])).toEqual(input);
  });
});

it('discards a client-supplied CDP endpoint when the server computer is disabled', async () => {
  const cartridge = templateCartridgeFactory({}, () => undefined)(history);
  const input = { threadId: 'session-1', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: { model: 'echo', agentComputerCdpUrl: 'ws://untrusted.invalid' } } as RunAgentInput;
  expect(await cartridge.invocationPayload(input, { owner: 'owner' }, cartridge.models[0])).toEqual({ ...input, forwardedProps: { model: 'echo' } });
});
