import { afterEach, expect, it, vi, inject } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOnFreePort, type RunningProcess } from '../fakes/process.js';
import { HttpFake } from '../fakes/http-fake.js';
import { FIXTURES, HARNESS_BIN, startLocalStack, type LocalStack } from './local-stack.js';
import { frameData, sseFrames } from './browser.js';
import { testChromiumPath } from '../chromium.js';

let site: RunningProcess | undefined;
let stack: LocalStack | undefined;
let temporaryRoot: string | undefined;
let credentialService: HttpFake | undefined;
afterEach(async () => {
  await stack?.stop();
  await site?.stop();
  await credentialService?.close();
  credentialService = undefined;
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
    site = await startOnFreePort((port) => ({
      command: `${HARNESS_BIN}/python ${join(FIXTURES, 'fake-site.py')}`,
      env: { PORT: String(port) },
      url: `http://127.0.0.1:${port}/login`,
      listening: `Fake site listening on :${port}`,
    }));
    stack = await startLocalStack({
      chatServiceCommand: inject('fakeSiteServiceCommand'),
      chatEnv: {
        FAKE_SITE_URL: new URL(site.url).origin,
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
      text: 'Open the fake site.',
    });
    const events = sseFrames(await turn.text()).map(frameData);
    expect(events.filter(({ type }) => type === 'RUN_ERROR')).toEqual([]);
    expect(
      events.find(({ type }) => type === 'TEXT_MESSAGE_CONTENT')
    ).toMatchObject({ delta: 'Echo: Open the fake site.' });
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
  'warms the computer and hands the Harness a working CDP URL for the fake site',
  { timeout: 120_000 },
  async () => {
    temporaryRoot = await mkdtemp(`${tmpdir()}/fake-site-computer-`);
    const deepTemp = resolve(temporaryRoot, 'generated-workspace-with-a-temporary-directory-longer-than-a-unix-socket-path');
    await mkdir(deepTemp);
    vi.stubEnv('TMPDIR', deepTemp);
    site = await startOnFreePort((port) => ({
      command: `${HARNESS_BIN}/python ${join(FIXTURES, 'fake-site.py')}`,
      env: { PORT: String(port) },
      url: `http://127.0.0.1:${port}/login`,
      listening: `Fake site listening on :${port}`,
    }));
    // `/account/session` asks the Credential Service which Linked Accounts the account holds; this account holds none,
    // and nothing else here may reach the Credential Service.
    credentialService = new HttpFake((request, response) => {
      response.writeHead(request.path === '/account/linked-accounts' ? 200 : 404, { 'content-type': 'application/json' });
      response.end(request.path === '/account/linked-accounts' ? JSON.stringify({ linkedAccounts: [] }) : '{}');
    });
    await credentialService.listen();
    stack = await startLocalStack({
      chatServiceCommand: inject('fakeSiteServiceCommand'),
      harnessCommand: `${HARNESS_BIN}/python ${join(FIXTURES, 'fake-site-computer-model.py')}`,
      harnessEnv: { PATH: `${fileURLToPath(new URL('../../node_modules/.bin', import.meta.url))}:${process.env.PATH ?? ''}` },
      chatEnv: {
        FAKE_SITE_URL: new URL(site.url).origin,
        BOTCUBE_CHROMIUM_PATH: testChromiumPath(),
        BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url,
        BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'fake-site-computer-fixture-secret',
      },
    });
    const browser = stack.browser();
    const owner = await browser.openAccountSession();
    const computerSession = await browser.newSideChat();
    const turn = await browser.sendTurn(computerSession, {
      text: 'Open the fake site.',
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
      delta: expect.stringContaining('Heading: Fake site'),
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
    const foreign = await other.sendTurn(computerSession, { text: 'Open the fake site.' });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ detail: 'Session not found' });
    const independent = await other.sendTurn(await other.newSideChat(), { text: 'Open the fake site.' });
    const independentEvents = sseFrames(await independent.text()).map(frameData);
    expect(independentEvents.filter(({ type }) => type === 'RUN_ERROR')).toEqual([]);
    expect(independentEvents.find(({ type }) => type === 'TEXT_MESSAGE_CONTENT')).toMatchObject({ delta: expect.stringContaining('Heading: Fake site') });
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
