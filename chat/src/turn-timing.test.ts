import { afterEach, expect, it, vi } from 'vitest';
import { relayTurn } from './turn-stream.js';
import { TurnTiming } from './turn-timing.js';

afterEach(() => vi.restoreAllMocks());

let now = 0;
const lines = () => vi.mocked(console.info).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{"event":"chat_turn_timing"'));
const clock = () => {
  now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
};
const text = (delta: string) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta });
const turn = { body: '{}', sessionId: 'session', browserEventName: 'live', credentials: [],
  saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined };

it('logs each stage once, in stage order, with e2eMs at the last token relayed and the client that sent the Turn', () => {
  clock();
  const timing = new TurnTiming(100, 'run', 'session', 'Bot-Preview-Verification/1.0');
  timing.model = 'gpt-test';
  now = 110; timing.mark('model');
  now = 105; timing.mark('requester');
  now = 120; timing.mark('model');
  now = 130; timing.observe([{ type: 'RUN_STARTED' }], now);
  now = 140; timing.observe([text('  ')], now);
  timing.emitted([text('  ')]);
  now = 150; timing.observe([text('hi')], now);
  timing.emitted([text('hi')]);
  now = 170; timing.observe([text('there')], now);
  timing.emitted([text('there'), { type: 'RUN_FINISHED' }]);
  now = 200; timing.finish();
  now = 300; timing.finish('gone');
  expect(lines()).toEqual([JSON.stringify({ event: 'chat_turn_timing', runId: 'run', sessionId: 'session', userAgent: 'Bot-Preview-Verification/1.0', model: 'gpt-test', status: 'finished', e2eMs: 70,
    chatMs: { requester: 5, model: 10, firstFrame: 30, firstToken: 50, lastToken: 70, end: 100 } })]);
});

it('runs e2eMs to the end of a failed Turn that relayed no token', () => {
  clock();
  const timing = new TurnTiming(100, 'run', 'session');
  now = 112.34; timing.mark('requester');
  now = 150; timing.finish();
  expect(JSON.parse(lines()[0] ?? '{}')).toEqual({ event: 'chat_turn_timing', runId: 'run', sessionId: 'session', status: 'failed', e2eMs: 50,
    chatMs: { requester: 12.3, end: 50 } });
});

it('times a relayed Turn from invoke to its last token', async () => {
  clock();
  const timing = new TurnTiming(100, 'run', 'session');
  const frames = ['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"one"}\n\n', 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"two"}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n'];
  let index = 0;
  const response = await relayTurn({ label: 'Test', invoke: async () => {
    now = 200;
    return new Response(new ReadableStream({ pull(controller) {
      const frame = frames[index++];
      if (frame === undefined) controller.close();
      else { now += 10; controller.enqueue(new TextEncoder().encode(frame)); }
    } }, { highWaterMark: 0 }));
  } }, { ...turn, timing, finished: () => { now += 500; } });
  expect(await response.text()).toBe(frames.join(''));
  expect(JSON.parse(lines()[0] ?? '{}')).toMatchObject({ status: 'finished', e2eMs: 130, chatMs: { invoke: 0, firstFrame: 110, firstToken: 120, lastToken: 130, end: 640 } });
  expect(lines()).toHaveLength(1);
});

it('logs a Turn whose upstream request fails before the stream opens as failed', async () => {
  clock();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const timing = new TurnTiming(100, 'run', 'session');
  const response = await relayTurn({ label: 'Test', invoke: async () => { now = 250; throw new Error('down'); } }, { ...turn, timing });
  expect(response.status).toBe(502);
  expect(JSON.parse(lines()[0] ?? '{}')).toMatchObject({ status: 'failed', e2eMs: 150, chatMs: { invoke: 0, end: 150 } });
});

it('logs a Turn whose client went away as gone', async () => {
  clock();
  const timing = new TurnTiming(100, 'run', 'session');
  const body = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"one"}\n\ndata: {"type":"RUN_FINISHED"}\n\n';
  const response = await relayTurn({ label: 'Test', invoke: async () => new Response(body) }, { ...turn, timing });
  await response.body?.cancel();
  expect(JSON.parse(lines()[0] ?? '{}')).toMatchObject({ status: 'gone', e2eMs: 0, chatMs: { firstFrame: 0, firstToken: 0, end: 0 } });
  expect(lines()).toHaveLength(1);
});
