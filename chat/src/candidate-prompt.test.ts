import { describe, expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';

async function turnWith(tunesPrompts: boolean | undefined, candidates: Record<string, unknown>) {
  const seen: Record<string, unknown>[] = [];
  const stack = await startInProcess({
    cartridge: {
      invocationPayload: async (input) => {
        seen.push(input.forwardedProps as Record<string, unknown>);
        return { ...input, forwardedProps: { ...(input.forwardedProps as Record<string, unknown>) } };
      },
      ...(tunesPrompts === undefined ? {} : { tunesPrompts: () => tunesPrompts }),
    },
  });
  try {
    if (tunesPrompts === true) await stack.allocate('account-1', `candidate-prompt-${String(tunesPrompts)}`);
    const response = await stack.app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: `candidate-prompt-${String(tunesPrompts)}`, runId: 'run-1', state: {}, messages: [], tools: [], context: [],
        forwardedProps: candidates,
      }),
    });
    const session = (await stack.app.request(`/threads/candidate-prompt-${String(tunesPrompts)}`)).status;
    return { status: response.status, body: await response.text(), seen, session };
  } finally {
    await stack.stop();
  }
}

describe.each(['agentSystemPrompt', 'cartridgeSystemPrompt'])('a candidate %s', (prop) => {
  it.each(['Candidate prompt.', ''])('reaches the Harness for the prompt tuner: %j', async (candidate) => {
    const { status, seen } = await turnWith(true, { [prop]: candidate });

    expect(status).toBe(200);
    expect(seen).toEqual([{ [prop]: candidate }]);
  });

  it.each([undefined, false])('is refused before a Session opens when the Cartridge does not let the requester tune prompts: %s', async (tunesPrompts) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body, seen, session } = await turnWith(tunesPrompts, { [prop]: 'Candidate prompt.' });

    expect([status, JSON.parse(body)]).toEqual([403, { detail: `${prop} is only for the prompt tuner` }]);
    expect(seen).toEqual([]);
    expect(session).toBe(404);
  });

  it('is refused unless it is text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body, seen } = await turnWith(true, { [prop]: 42 });

    expect([status, JSON.parse(body)]).toEqual([422, { detail: `${prop} must be text` }]);
    expect(seen).toEqual([]);
  });
});
