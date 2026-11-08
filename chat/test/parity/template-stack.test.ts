import { afterAll, afterEach, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { testChromiumPath } from '../chromium.js';
import { frameData, sseFrames } from './browser.js';
import { startLocalStack, type LocalStack } from './local-stack.js';
import { startOnFreePort, type RunningProcess } from '../fakes/process.js';

let stack: LocalStack | undefined;
let site: RunningProcess | undefined;
let credentials: RunningProcess | undefined;
let failed = false;
afterEach(({ task }) => { failed = task.result?.state === 'fail'; });
afterAll(async () => {
  try {
    await stack?.stop();
    await credentials?.stop();
    await site?.stop();
  } finally {
    if (failed) console.error(stack?.logs().split('\n').filter((line) => line.startsWith('Chromium startup diagnostic ')).join('\n'));
  }
});

it('runs a confirmed template schedule with the owner site link and reports an unlinked site to Main Chat', { timeout: 120_000 }, async () => {
  const bin = resolve('templates/always-on/.venv/bin');
  site = await startOnFreePort((port) => ({
    command: `${bin}/template-site`,
    env: { PORT: String(port) },
    url: `http://127.0.0.1:${port}/login`,
    listening: `Template site listening on :${port}`,
  }));
  const siteUrl = new URL(site.url).origin;
  credentials = await startOnFreePort((port) => ({
    command: `${bin}/python ${resolve('chat/test/parity/template-credential-service.py')}`,
    env: { PORT: String(port), TEMPLATE_SITE_URL: siteUrl, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'local-secret', AWS_ACCESS_KEY_ID: 'testing', AWS_SECRET_ACCESS_KEY: 'testing', AWS_DEFAULT_REGION: 'us-east-1' },
    url: `http://127.0.0.1:${port}/health`,
    listening: `Uvicorn running on http://127.0.0.1:${port}`,
  }));
  const credentialServiceUrl = new URL(credentials.url).origin;
  stack = await startLocalStack({
    scheduling: true,
    harnessCommand: `${bin}/python ${resolve('chat/test/parity/template-model.py')}`,
    chatServiceCommand: `node ${resolve('templates/always-on/chat/dist/main.js')}`,
    chatEnv: { BOTCUBE_CHROMIUM_PATH: testChromiumPath(), BOTCUBE_CHROMIUM_DIAGNOSTICS: '1', TEMPLATE_SITE_URL: siteUrl, BOTCUBE_CREDENTIAL_SERVICE_URL: credentialServiceUrl, BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'local-secret' },
    harnessEnv: {
      PATH: `${resolve('harness/deepagents/.tool-dist/bin')}:${bin}:${process.env.PATH ?? ''}`,
    },
  });
  const browser = stack.browser();
  expect((await browser.get('/auth/template')).status).toBe(200);
  expect((await browser.get('/account/session')).status).toBe(200);
  const start = await (await browser.post('/account/fake-site-link/start', {})).json();
  expect((await browser.post('/account/fake-site-link/sign-in', start)).status).toBe(200);
  expect((await browser.post('/account/fake-site-link/complete', start)).status).toBe(200);
  const threadId = await browser.newSideChat();
  const response = await browser.sendTurn(threadId, { text: 'Read the template site data.' });
  expect(response.status).toBe(200);
  const events = sseFrames(await response.text()).map(frameData);
  expect(events.map(({ type }) => type)).toContain('RUN_FINISHED');
  const transcript = JSON.stringify(events);
  expect(transcript).toContain('read_file');
  expect(transcript).toContain('template-cli data');
  expect(events.filter(({ type }) => type === 'TOOL_CALL_START').map(({ toolCallName }) => toolCallName)).toEqual(['read_file', 'execute']);
  expect(events.find(({ type }) => type === 'TEXT_MESSAGE_CONTENT')).toMatchObject({
    delta: 'Template data: {"items": [{"name": "Sample item", "value": 42}]}\n\n[Command succeeded with exit code 0]',
  });
  expect(site.output()).toContain('POST /access HTTP/1.1" 200');
  const proposal = await browser.sendTurn(threadId, { text: 'Schedule a template data read.' });
  const proposalEvents = sseFrames(await proposal.text()).map(frameData);
  expect(proposalEvents).toContainEqual(expect.objectContaining({ type: 'TOOL_CALL_START', toolCallName: 'propose_scheduled_task' }));
  expect(proposalEvents).toContainEqual(expect.objectContaining({ type: 'TOOL_CALL_ARGS' }));
  const args = proposalEvents.filter((event) => event.type === 'TOOL_CALL_ARGS').map((event) => event.delta).join('');
  expect(JSON.parse(args)).toEqual({ title: 'Template data', prompt: 'Read the template site data.', frequency: 'daily', time: '09:00' });
  const taskResponse = await browser.post('/scheduled-tasks', {
    title: 'Template data', prompt: 'Read the template site data.', schedule: 'cron(0 9 * * ? *)', proposalId: proposalEvents.find((event) => event.type === 'TOOL_CALL_START')?.toolCallId, timezone: 'UTC',
  });
  expect(taskResponse.status).toBe(201);
  const task = await taskResponse.json();
  const { id: mainChat } = await (await browser.get('/main-chat')).json();
  const scheduler = stack.scheduler;
  if (!scheduler) throw new Error('Template test schedule is missing');
  const posted = async (text: string) => {
    let replay = '';
    await expect.poll(async () => {
      replay = await (await browser.get(`/threads/${mainChat}`)).text();
      return replay;
    }, { timeout: 20_000, interval: 100 }).toContain(text);
    return replay;
  };
  await scheduler.fire(task.id);
  expect(await posted('Scheduled task')).toContain('Sample item');
  const { threads } = await (await browser.get('/threads')).json();
  const scheduled = threads.find((thread: { title: string }) => thread.title === JSON.parse(args).title);
  expect(scheduled).toBeDefined();
  expect(await (await browser.get(`/agent-computer?thread_id=${scheduled.id}`)).json()).toMatchObject({ state: 'awake' });
  expect((await browser.post('/warmup', { threadId: 'unknown-scheduled-session' })).status).toBe(404);
  expect((await browser.post('/account/fake-site-link/unlink', {})).status).toBe(200);
  const unlinked = await browser.sendTurn(threadId, { text: 'Read the template site data.' });
  expect(unlinked.status).toBe(200);
  expect(await unlinked.text()).toContain('sign-in needed');
  await scheduler.fire(task.id);
  expect(await posted('could not finish')).toContain('Template site sign-in needed.');
  const failedRun = await (await browser.get(`/threads/${scheduled.id}`)).json();
  expect(failedRun.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('Template site sign-in needed.') });
  expect(failedRun.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(2);
  expect(failedRun.messages.slice(failedRun.messages.findLastIndex((message: { role: string }) => message.role === 'user'))
    .flatMap((message: { toolCalls?: { function: { name: string } }[] }) => message.toolCalls ?? [])
    .map((call: { function: { name: string } }) => call.function.name)).toEqual(['read_file', 'execute']);
  expect(await (await browser.get('/account/session')).json()).toMatchObject({ signInNeeded: true });
  expect(await (await stack.browser().get('/account/session')).json()).toMatchObject({ signInNeeded: false });
  const relink = await (await browser.post('/account/fake-site-link/start', {})).json();
  expect((await browser.post('/account/fake-site-link/sign-in', relink)).status).toBe(200);
  expect((await browser.post('/account/fake-site-link/complete', relink)).status).toBe(200);
  expect(await (await browser.get('/account/session')).json()).toMatchObject({ signInNeeded: false });
  await scheduler.fire(task.id);
  await expect.poll(async () => {
    const replay = await (await browser.get(`/threads/${mainChat}`)).json();
    return replay.messages.at(-1)?.content;
  }, { timeout: 20_000, interval: 100 }).toBe('Scheduled task "Template data": Template data: {"items": [{"name": "Sample item", "value": 42}]}\n\n[Command succeeded with exit code 0]');
  const recoveredRun = await (await browser.get(`/threads/${scheduled.id}`)).json();
  expect(recoveredRun.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(3);
  expect(recoveredRun.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Template data: {"items": [{"name": "Sample item", "value": 42}]}\n\n[Command succeeded with exit code 0]' });
});
