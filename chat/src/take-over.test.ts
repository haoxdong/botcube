import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from './cartridge.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

let stack: InProcessStack;
const authorized: string[] = [];
/** Sessions the Cartridge says run in a browser other than the configured one. */
const inAgentComputer = new Set<string>();
beforeAll(async () => {
  stack = await startInProcess({
    cartridge: {
      authorizeBrowserLiveView: async (sessionId) => {
        if (sessionId === 'not-yours') throw new HttpError(403, 'Not your browser Session');
        authorized.push(sessionId);
        return inAgentComputer.has(sessionId) ? 'agent_computer-1' : undefined;
      },
    },
  });
});
afterAll(() => stack.stop());

describe.each([
  ['/browser-take-over', 'DISABLED'],
  ['/browser-hand-back', 'ENABLED'],
])('POST %s', (route, streamStatus) => {
  it(`sets the browser's automation stream ${streamStatus}`, async () => {
    const browser = stack.agentcore.startBrowser();

    const response = await stack.app.request(`${route}?session_id=${browser}`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(stack.agentcore.controlChanges(browser)).toEqual([streamStatus]);
    expect(authorized).toContain(browser);
  });

  it('changes the stream in the browser the Cartridge names for the Session', async () => {
    const browser = stack.agentcore.startBrowser();
    inAgentComputer.add(browser);

    const response = await stack.app.request(`${route}?session_id=${browser}`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(stack.agentcore.requests.map((request) => request.path)).toContain(
      `/browsers/agent_computer-1/sessions/streams/update?sessionId=${browser}`,
    );
  });

  it('answers 422 without a session_id', async () => {
    const response = await stack.app.request(route, { method: 'POST' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'session_id must not be blank' });
  });

  it('answers 422 for a blank session_id', async () => {
    const response = await stack.app.request(`${route}?session_id=%20`, { method: 'POST' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'session_id must not be blank' });
  });

  it('answers the Cartridge refusal for a browser the request may not control', async () => {
    const response = await stack.app.request(`${route}?session_id=not-yours`, { method: 'POST' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: 'Not your browser Session' });
  });

  it('answers 502 when AgentCore refuses the change', async () => {
    const response = await stack.app.request(`${route}?session_id=gone`, { method: 'POST' });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      detail: 'AgentCore refused the browser control change: HTTP 404',
    });
  });
});
