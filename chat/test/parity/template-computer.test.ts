import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startOnFreePort, type RunningProcess } from '../fakes/process.js';
import { startLocalStack, type LocalStack } from './local-stack.js';
import { frameData, sseFrames } from './browser.js';
import { testChromiumPath } from '../chromium.js';

let site: RunningProcess | undefined;
let stack: LocalStack | undefined;
let temporaryRoot: string | undefined;
afterEach(async () => {
  await stack?.stop();
  await site?.stop();
  vi.unstubAllEnvs();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
  stack = undefined;
  site = undefined;
});

it(
  'opens the actual browser event on a default Echo Turn without a model-generated Session marker',
  { timeout: 120_000 },
  async () => {
    const bin = resolve('templates/always-on/.venv/bin');
    site = await startOnFreePort((port) => ({
      command: `${bin}/template-site`,
      env: { PORT: String(port) },
      url: `http://127.0.0.1:${port}/login`,
      listening: `Template site listening on :${port}`,
    }));
    stack = await startLocalStack({
      chatServiceCommand: `node ${resolve('templates/always-on/chat/dist/main.js')}`,
      chatEnv: {
        TEMPLATE_SITE_URL: new URL(site.url).origin,
        BOTCUBE_CHROMIUM_PATH: testChromiumPath(),
      },
    });
    const owner = stack.browser();
    await owner.openAccountSession();
    const { id: mainChat } = (await (await owner.get('/main-chat')).json()) as { id: string };
    const mainWarmup = await owner.post('/warmup', { mainChat: true });
    expect(await mainWarmup.json()).toEqual({ status: 'ok' });
    expect(await (await owner.get(`/agent-computer?thread_id=${mainChat}`)).json()).toMatchObject({ state: 'awake' });
    const unownedWarmup = await owner.post('/warmup', { threadId: 'echo-computer' });
    expect(unownedWarmup.status).toBe(404);
    expect(await unownedWarmup.json()).toEqual({ detail: 'This account does not own the Session' });
    const echoComputer = await owner.newSideChat();
    const turn = await owner.sendTurn(echoComputer, {
      text: 'Open the template site.',
    });
    const events = sseFrames(await turn.text()).map(frameData);
    expect(events.filter(({ type }) => type === 'RUN_ERROR')).toEqual([]);
    expect(
      events.find(({ type }) => type === 'TEXT_MESSAGE_CONTENT')
    ).toMatchObject({ delta: 'Echo: Open the template site.' });
    const state = (await (
      await owner.get(`/agent-computer?thread_id=${echoComputer}`)
    ).json()) as { state: string; browserSessionId: string };
    expect(state.state).toBe('awake');
    expect(
      events.filter(
        ({ type, name }) =>
          type === 'CUSTOM' && name === 'botcube:browser-live-view'
      )
    ).toEqual([
      {
        type: 'CUSTOM',
        name: 'botcube:browser-live-view',
        value: { open: true, sessionId: state.browserSessionId },
      },
    ]);
    const warm = await owner.post('/warmup', { threadId: echoComputer });
    expect(await warm.json()).toEqual({ status: 'ok' });
    expect(
      await (await owner.get(`/agent-computer?thread_id=${echoComputer}`)).json()
    ).toMatchObject({
      state: 'awake',
      browserSessionId: state.browserSessionId,
    });
  }
);

it(
  'warms the template computer and hands the Harness a working CDP URL for the fake site',
  { timeout: 120_000 },
  async () => {
    temporaryRoot = await mkdtemp(`${tmpdir()}/template-computer-`);
    const deepTemp = resolve(temporaryRoot, 'generated-workspace-with-a-temporary-directory-longer-than-a-unix-socket-path');
    await mkdir(deepTemp);
    vi.stubEnv('TMPDIR', deepTemp);
    const bin = resolve('templates/always-on/.venv/bin');
    site = await startOnFreePort((port) => ({
      command: `${bin}/template-site`,
      env: { PORT: String(port) },
      url: `http://127.0.0.1:${port}/login`,
      listening: `Template site listening on :${port}`,
    }));
    stack = await startLocalStack({
      chatServiceCommand: `node ${resolve('templates/always-on/chat/dist/main.js')}`,
      harnessCommand: `${bin}/python ${resolve('chat/test/parity/template-computer-model.py')}`,
      harnessEnv: { PATH: `${resolve('harness/deepagents/.tool-dist/bin')}:${resolve('chat/node_modules/.bin')}:${process.env.PATH ?? ''}` },
      chatEnv: {
        TEMPLATE_SITE_URL: new URL(site.url).origin,
        BOTCUBE_CHROMIUM_PATH: testChromiumPath(),
        BOTCUBE_CREDENTIAL_SERVICE_URL: 'http://credential-service.invalid',
        BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'template-computer-fixture-secret',
      },
    });
    const browser = stack.browser();
    const owner = await browser.openAccountSession();
    const computerSession = await browser.newSideChat();
    const turn = await browser.sendTurn(computerSession, {
      text: 'Open the template site.',
    });
    expect(turn.status).toBe(200);
    const events = sseFrames(await turn.text()).map(frameData);
    expect(events.filter(({ type }) => type === 'RUN_ERROR')).toEqual([]);
    expect(
      events.find(({ type }) => type === 'TEXT_MESSAGE_CONTENT')
    ).toMatchObject({
      delta: expect.stringContaining(`Computer opened ${site.url}`),
    });
    expect(
      events.find(({ type }) => type === 'TEXT_MESSAGE_CONTENT')
    ).toMatchObject({
      delta: expect.stringContaining('Heading: Template site'),
    });
    const response = await browser.get(
      `/agent-computer?thread_id=${computerSession}`
    );
    expect(response.status).toBe(200);
    const computer = (await response.json()) as {
      state: string;
      browserSessionId: string;
    };
    expect(computer.state).toBe('awake');
    const view = await browser.get(
      `/agent-computer/view?thread_id=${computerSession}`
    );
    expect(view.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await view.arrayBuffer()).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    const liveView = await browser.get(
      `/browser-live-view-url?session_id=${computer.browserSessionId}`
    );
    expect(liveView.status).toBe(200);
    expect(await liveView.json()).toEqual({
      signedUrl: `${stack.url}/agent-computer/view?thread_id=${computerSession}`,
    });
    expect(
      events.find(
        ({ type, name }) =>
          type === 'CUSTOM' && name === 'botcube:browser-live-view'
      )
    ).toMatchObject({
      value: { open: true, sessionId: computer.browserSessionId },
    });
    const other = stack.browser();
    const otherOwner = await other.openAccountSession();
    expect(otherOwner.accountId).not.toBe(owner.accountId);
    const forbidden = await other.get(
      `/agent-computer/view?thread_id=${computerSession}`
    );
    expect(forbidden.status).toBe(404);
    const forbiddenLiveView = await other.get(
      `/browser-live-view-url?session_id=${computer.browserSessionId}`
    );
    expect(forbiddenLiveView.status).toBe(403);
    const otherWarmup = await other.post('/warmup', { threadId: computerSession });
    expect(otherWarmup.status).toBe(404);
    expect(await otherWarmup.json()).toEqual({ detail: 'This account does not own the Session' });
    const foreign = await other.sendTurn(computerSession, { text: 'Open the template site.' });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ detail: 'Session not found' });
    const independent = await other.sendTurn(await other.newSideChat(), { text: 'Open the template site.' });
    const independentEvents = sseFrames(await independent.text()).map(frameData);
    expect(independentEvents.filter(({ type }) => type === 'RUN_ERROR')).toEqual([]);
    expect(independentEvents.find(({ type }) => type === 'TEXT_MESSAGE_CONTENT')).toMatchObject({ delta: expect.stringContaining('Heading: Template site') });
    expect(site.output()).toContain('GET /login HTTP/1.1" 200');
    const expectWithheld = async (text: string) => {
      const withheld = await browser.sendTurn(computerSession, { text });
      const body = await withheld.text();
      expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
      expect(body).not.toContain('/agent-computer/cdp?token=');
      expect(body).not.toMatch(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    };
    await expectWithheld('Report the private CDP URL.');
    await expectWithheld('Report the private site invocation.');
  }
);
