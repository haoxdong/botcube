import { afterAll, describe, expect, it } from 'vitest';
import { frameData, sseFrames } from './browser.js';
import { startLocalStack, type LocalStack } from './local-stack.js';

let stack: LocalStack | undefined;
afterAll(() => stack?.stop());

const events = (body: string) => sseFrames(body).map(frameData);

const contents = (messages: unknown[]) =>
  messages.map((message) => (message as { content?: unknown }).content).filter((content) => typeof content === 'string');

describe('against the local Harness', () => {
  it('streams a Turn, replays it, and continues the Session', { timeout: 120_000 }, async () => {
    stack = await startLocalStack({
      chatEnv: {
        BOTCUBE_CREDENTIAL_SERVICE_URL: 'https://credential.example',
        BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'local-stack-secret',
      },
    });
    const browser = stack.browser();
    await browser.openAccountSession();
    const id = await browser.newSideChat();

    stack.bedrock.turnSummary = { title: 'First task', summary: 'Echoed the first turn' };
    const first = await browser.sendTurn(id, { text: 'first turn' });
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const firstEvents = events(await first.text());
    expect(firstEvents.map(({ type }) => type)).toContain('RUN_FINISHED');
    expect(JSON.stringify(firstEvents)).toContain('Echo: first turn');

    const replay = await browser.get(`/threads/${id}`);
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { id: string; title: string; messages: unknown[] };
    expect(replayed).toMatchObject({ id, title: 'first turn' });
    expect(contents(replayed.messages)).toEqual(['first turn', 'Echo: first turn']);

    await expect.poll(() => stack?.bedrock.summarizedTurns().length).toBe(1);
    stack.bedrock.turnSummary = { title: 'Second task', summary: 'Echoed the second turn' };
    const second = await browser.post(
      '/',
      {
        threadId: id,
        runId: `${id}-run-2`,
        state: {},
        messages: [{ id: `${id}-message-2`, role: 'user', content: 'second turn' }],
        tools: [],
        context: [],
        forwardedProps: {},
      },
      { headers: { accept: 'text/event-stream' } },
    );
    expect(second.status).toBe(200);
    const secondEvents = events(await second.text());
    expect(secondEvents.map(({ type }) => type)).toContain('RUN_FINISHED');
    expect(secondEvents.map(({ type }) => type)).not.toContain('MESSAGES_SNAPSHOT');
    expect(JSON.stringify(secondEvents)).toContain('Echo: second turn');

    const continued = (await (await browser.get(`/threads/${id}`)).json()) as { messages: unknown[] };
    expect(contents(continued.messages)).toEqual(['first turn', 'Echo: first turn', 'second turn', 'Echo: second turn']);

    await expect
      .poll(async () => ((await (await browser.get('/activity')).json()) as { tasks: { title?: string; summary: string }[] }).tasks)
      .toEqual([
        expect.objectContaining({ title: 'Second task', summary: 'Echoed the second turn' }),
        expect.objectContaining({ title: 'First task', summary: 'Echoed the first turn' }),
      ]);
    expect(stack.bedrock.summarizedTurns()).toEqual([
      { request: 'first turn', answer: 'Echo: first turn' },
      { request: 'second turn', answer: 'Echo: second turn' },
    ]);
  });
});
