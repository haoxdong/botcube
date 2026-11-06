import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';

it.each([false, true])('records an answered image Turn in Activity when accompanying text is %s', async (withText) => {
  const stack = await startInProcess();
  const sessionId = 'image-activity';
  const content = [
    ...(withText ? [{ type: 'text', text: 'Describe this image' }] : []),
    { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } },
  ];
  stack.agentcore.script(sessionId, { kind: 'stream', frames: [
    'data: {"type":"RUN_STARTED","threadId":"image-activity","runId":"run"}',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"The image shows a blue circle."}',
    'data: {"type":"RUN_FINISHED","threadId":"image-activity","runId":"run"}',
  ] });
  try {
    await stack.allocate('account-1', sessionId);
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: 'run', state: {},
        messages: [{ id: 'image-question', role: 'user', content }], tools: [], context: [], forwardedProps: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('The image shows a blue circle.');
    expect(await stack.sessionMetadata.get('account-1', sessionId)).not.toHaveProperty('turn_running_since');
    await vi.waitFor(async () => {
      const activity = await (await stack.app.request('/activity')).json() as { tasks: unknown[] };
      expect(activity.tasks).toHaveLength(1);
    });
  } finally { await stack.stop(); }
});

it('records an image-only Turn that ends in a run error as failed in Activity', async () => {
  const stack = await startInProcess();
  stack.agentcore.script('failed-image', { kind: 'stream', frames: [
    'data: {"type":"RUN_STARTED","threadId":"failed-image","runId":"run"}',
    'data: {"type":"RUN_ERROR","message":"Model overloaded","code":"INTERNAL_ERROR"}',
  ] });
  try {
    await stack.allocate('account-1', 'failed-image');
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'failed-image', runId: 'run', state: {},
        messages: [{ id: 'image-question', role: 'user', content: [
          { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } },
        ] }], tools: [], context: [], forwardedProps: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Model overloaded');
    await vi.waitFor(async () => {
      expect(await (await stack.app.request('/activity')).json()).toEqual({
        tasks: [{ summary: '', failed: 'Model overloaded', completedAt: expect.any(String) }],
      });
    });
    expect(await stack.sessionMetadata.get('account-1', 'failed-image')).not.toHaveProperty('turn_running_since');
  } finally { await stack.stop(); }
});

it.each([false, true])('retains both Activity entries for a full-history image follow-up with text %s', async (withText) => {
  const stack = await startInProcess();
  const firstMessage = { id: 'first-question', role: 'user', content: 'Analyze the first report' };
  const post = async (runId: string, messages: unknown[]) => {
    stack.agentcore.script('image-follow-up', { kind: 'stream', frames: [
      `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'image-follow-up', runId })}`,
      `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: `answer-${runId}`, delta: 'A completed answer' })}`,
      `data: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 'image-follow-up', runId })}`,
    ] });
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'image-follow-up', runId, state: {}, messages, tools: [], context: [], forwardedProps: {} }),
    });
    expect(response.status).toBe(200);
    await response.text();
  };
  const activity = async () => (await (await stack.app.request('/activity')).json()) as { tasks: { title: string }[] };
  try {
    await stack.allocate('account-1', 'image-follow-up');
    stack.bedrock.turnSummary = { title: 'First task', summary: 'First report analyzed' };
    await post('first', [firstMessage]);
    await vi.waitFor(async () => { expect((await activity()).tasks).toMatchObject([{ title: 'First task' }]); });
    stack.bedrock.turnSummary = { title: 'Image task', summary: 'Image described' };
    await post('image', [firstMessage,
      { id: 'answer-first', role: 'assistant', content: 'A completed answer' },
      { id: 'image-question', role: 'user', content: [
        ...(withText ? [{ type: 'text', text: 'Describe the new image' }] : []),
        { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } },
      ] },
    ]);
    await vi.waitFor(async () => {
      const tasks = (await activity()).tasks;
      expect(tasks).toHaveLength(2);
      expect(tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'First task' }), expect.objectContaining({ title: 'Image task' }),
      ]));
    });
  } finally { await stack.stop(); }
});
