import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { HttpFake } from '../test/fakes/http-fake.js';

it('retains the newer retry Activity summary when the earlier attempt summary arrives last', async () => {
  let releaseOld: (() => void) | undefined;
  let oldReady!: () => void;
  const oldSummarizing = new Promise<void>((resolve) => { oldReady = resolve; });
  let calls = 0;
  const summary = await new HttpFake((_request, response) => {
    const title = ++calls === 1 ? 'Old attempt' : 'New attempt';
    const answer = () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output: { message: { content: [
        { toolUse: { name: 'turn_summary', input: { title, summary: title } } },
      ] } } }));
    };
    if (title === 'Old attempt') { releaseOld = answer; oldReady(); }
    else answer();
  }).listen();
  const stack = await startInProcess({ config: { turnSummaryModel: { region: 'us-east-1', url: summary.url } } });
  let oldWritten!: () => void;
  let newWritten!: () => void;
  const oldSaved = new Promise<void>((resolve) => { oldWritten = resolve; });
  const newSaved = new Promise<void>((resolve) => { newWritten = resolve; });
  const save = stack.sessionMetadata.saveTurnSummary.bind(stack.sessionMetadata);
  const writes = vi.spyOn(stack.sessionMetadata, 'saveTurnSummary').mockImplementation(async (...args) => {
    await save(...args);
    if (args[2].summary?.title === 'Old attempt') oldWritten();
    if (args[2].summary?.title === 'New attempt') newWritten();
  });
  const post = async (runId: string) => {
    stack.agentcore.script('retry-summary', { kind: 'stream', frames: [
      `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'retry-summary', runId })}`,
      `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: `answer-${runId}`, delta: `Answer from ${runId}` })}`,
      `data: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 'retry-summary', runId })}`,
    ] });
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'retry-summary', runId, state: {},
        messages: [{ id: 'same-question', role: 'user', content: 'Analyze the report' }], tools: [], context: [], forwardedProps: {} }),
    });
    expect(response.status).toBe(200);
    await response.text();
  };
  try {
    await stack.allocate('account-1', 'retry-summary');
    await post('old-run');
    await oldSummarizing;
    await post('retry-run');
    await newSaved;
    expect(await (await stack.app.request('/activity')).json()).toMatchObject({ tasks: [{ title: 'New attempt' }] });
    releaseOld?.();
    releaseOld = undefined;
    await oldSaved;
    expect(await (await stack.app.request('/activity')).json()).toMatchObject({ tasks: [{ title: 'New attempt' }] });
  } finally {
    releaseOld?.();
    writes.mockRestore();
    await stack.stop();
    await summary.close();
  }
});
