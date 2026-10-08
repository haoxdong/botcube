import { afterEach, expect, it, vi } from 'vitest';
import { relayTurn } from './turn-stream.js';
import { FirstAnswerTiming } from './first-answer-timing.js';

afterEach(() => vi.restoreAllMocks());

it('attributes first-answer attribution read and emission around readiness without changing answer frames', async () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const timing = new FirstAnswerTiming(100);
  now = 120;
  timing.admitted('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'gpt-test', []);
  now = 150;
  const frames = ['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"TEXT_MESSAGE_START","messageId":"answer-1","role":"assistant"}\n\n', 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer-1","delta":"  "}\n\n', 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer-1","delta":"public answer"}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n'];
  let index = 0;
  const response = await relayTurn({ label: 'Test', invoke: async () => {
    now = 200;
    return new Response(new ReadableStream({ pull(controller) {
      const frame = frames[index++];
      if (frame === undefined) controller.close();
      else { now += 10; controller.enqueue(new TextEncoder().encode(frame)); }
    } }, { highWaterMark: 0 }));
  } }, { body: '{}', sessionId: 'session', browserEventName: 'live', credentials: [], timing,
    started: async () => { now += 50; }, saveAgentDocumentEdit: async () => undefined,
    finished: () => { now += 500; }, ended: async () => undefined, failed: () => undefined });
  expect(await response.text()).toBe(frames.join(''));
  const rows = log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  expect(rows).toContainEqual(expect.objectContaining({ event: 'chat_first_answer_boundary', status: 'complete', publicMessageId: 'answer-1', offsetsMs: expect.objectContaining({ receipt: 0, admissionComplete: 20, invokeDispatch: 50, answerReceived: 190, answerEmitted: 190 }) }));
  expect(JSON.stringify(rows)).not.toContain('public answer');
});

it.each(['missing', 'prior', 'duplicate', 'wrong-role'])('marks %s assistant starts invalid without changing response', async (kind) => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const timing = new FirstAnswerTiming(performance.now());
  timing.admitted('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'gpt-test', kind === 'prior' ? [{ id: 'answer' }] : []);
  const start = `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: 'answer', role: kind === 'wrong-role' ? 'user' : 'assistant' })}\n\n`;
  const content = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"answer"}\n\n';
  const body = (kind === 'missing' ? '' : start) + (kind === 'duplicate' ? start : '') + content + 'data: {"type":"RUN_FINISHED"}\n\n';
  const response = await relayTurn({ label: 'Test', invoke: async () => new Response(body) }, {
    body: '{}', sessionId: 'session', browserEventName: 'live', credentials: [], timing,
    saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined });
  expect(await response.text()).toBe(body);
  expect(log.mock.calls.some(([line]) => String(line).includes('"status":"invalid"'))).toBe(true);
});

it('retains the original answer read through credential-prefix withholding', async () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const timing = new FirstAnswerTiming(now);
  timing.admitted('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'gpt-test', []);
  const chunks = [
    'data: {"type":"TEXT_MESSAGE_START","messageId":"answer","role":"assistant"}\n\n',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"to"}\n\n',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"day"}\n\n',
    'data: {"type":"RUN_FINISHED"}\n\n',
  ];
  let index = 0;
  const response = await relayTurn({ label: 'Test', invoke: async () => new Response(new ReadableStream({ pull(controller) {
    const chunk = chunks[index++];
    if (chunk === undefined) controller.close();
    else { now += index === 3 ? 100 : 10; controller.enqueue(new TextEncoder().encode(chunk)); }
  } }, { highWaterMark: 0 })) }, { body: '{}', sessionId: 'session', browserEventName: 'live', credentials: ['token'], timing,
    saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined });
  expect(await response.text()).toBe(chunks.join(''));
  expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"answerReceived":20,"answerEmitted":120'));
});

it('attributes a fragmented answer to its complete frame read', async () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const timing = new FirstAnswerTiming(now);
  timing.admitted('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'gpt-test', []);
  const chunks = ['data: {"type":"TEXT_MESSAGE_START","messageId":"answer","role":"assistant"}\n\n', 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"frag', 'mented"}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n'];
  let index = 0;
  const response = await relayTurn({ label: 'Test', invoke: async () => new Response(new ReadableStream({ pull(controller) {
    const chunk = chunks[index++];
    if (chunk === undefined) controller.close();
    else { now += 10; controller.enqueue(new TextEncoder().encode(chunk)); }
  } }, { highWaterMark: 0 })) }, { body: '{}', sessionId: 'session', browserEventName: 'live', credentials: [], timing,
    saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined });
  expect(await response.text()).toBe(chunks.join(''));
  expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"answerReceived":30,"answerEmitted":30'));
});

it('propagates a private boundary log failure', async () => {
  const failure = new Error('boundary sink failed');
  vi.spyOn(console, 'info').mockImplementation(() => { throw failure; });
  const timing = new FirstAnswerTiming(performance.now());
  timing.admitted('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'gpt-test', []);
  const body = 'data: {"type":"TEXT_MESSAGE_START","messageId":"answer","role":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"answer"}\n\n';
  const response = await relayTurn({ label: 'Test', invoke: async () => new Response(body) }, { body: '{}', sessionId: 'session', browserEventName: 'live', credentials: [], timing,
    saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined });
  await expect(response.text()).rejects.toBe(failure);
});
