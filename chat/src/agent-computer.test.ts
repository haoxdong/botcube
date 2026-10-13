import { createHash } from 'node:crypto';
import { HttpError } from 'botcube-chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountResources } from './account-resources.js';
import {
  agentComputerBrowserFromEnv,
  agentComputerIdleSeconds,
  agentComputers,
  type AgentComputerBrowser,
} from './agent-computer.js';
import type { AccountFiles, FilesMount } from './files.js';

const ACCOUNT = 'acct_0123456789';
const OTHER_ACCOUNT = 'acct_9876543210';
const IDLE_SECONDS = 10;
const filesOf = (accountId: string): FilesMount => ({
  accessPointArn: `access-point-of-${accountId}`,
  fileSystemArn: 'file-system',
  mountPath: '/mnt/files',
});

/** An AgentCore browser that logs each operation; an operation named in `failing` throws. */
function fakeBrowser() {
  const log: string[] = [];
  const failing = new Set<string>();
  const held = new Map<string, Promise<void>>();
  let started = 0;
  const mounts: FilesMount[] = [];
  /** Browsers the user has taken over. */
  const takenOver = new Set<string>();
  /** Each browser's cookie domains, and each profile's as last saved. */
  const cookies = new Map<string, string[]>();
  const profiles = new Map<string, string[]>();
  const step = async (operation: string, entry?: string) => {
    if (entry !== undefined) log.push(entry);
    await held.get(operation);
    if (failing.has(operation)) throw new Error(`${operation} failed`);
  };
  /** A browser the user has taken over refuses the agent's CDP, as AgentCore does with its automation stream off. */
  const refuseIfTakenOver = (sessionId: string) => {
    if (takenOver.has(sessionId)) throw new Error(`automation stream of ${sessionId} is disabled`);
  };
  const browser: AgentComputerBrowser = {
    browserId: 'agent-computer-browser',
    async start(profileId, files) {
      mounts.push(files);
      await step('start', `start ${profileId}`);
      started += 1;
      return `browser-${started}`;
    },
    async screenshot(sessionId) {
      await step('screenshot', `screenshot ${sessionId}`);
      refuseIfTakenOver(sessionId);
      return `data:image/jpeg;base64,${sessionId}`;
    },
    async beforeProfileSave(sessionId) {
      await step('beforeProfileSave', `beforeProfileSave ${sessionId}`);
      refuseIfTakenOver(sessionId);
      cookies.set(sessionId, (cookies.get(sessionId) ?? []).filter((domain) => domain !== 'site.example'));
    },
    async createProfile(accountId) {
      await step('createProfile', `createProfile ${accountId}`);
      return `profile-of-${accountId}`;
    },
    async saveProfile(profileId, sessionId) {
      await step('saveProfile', `saveProfile ${profileId} ${sessionId}`);
      profiles.set(profileId, cookies.get(sessionId) ?? []);
    },
    deleteProfile: (profileId) => step('deleteProfile', `deleteProfile ${profileId}`),
    stop: (sessionId) => step('stop', `stop ${sessionId}`),
    automationStream: (sessionId) => Promise.resolve({ endpoint: `wss://${sessionId}`, headers: {} }),
    control: async (sessionId) => {
      await step('control');
      return takenOver.has(sessionId) ? 'user' : 'agent';
    },
    async handBack(sessionId) {
      await step('handBack', `handBack ${sessionId}`);
      takenOver.delete(sessionId);
    },
  };
  /** Hold an operation until the returned release is called. */
  const hold = (operation: string) => {
    let release = () => {};
    held.set(operation, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      held.delete(operation);
      release();
    };
  };
  return { browser, log, failing, hold, step, mounts, takenOver, cookies, profiles };
}

function computers() {
  const fake = fakeBrowser();
  const store = new AccountResources('chat', memoryDocuments());
  const files = { mount: async (accountId: string) => filesOf(accountId) } as AccountFiles;
  const computer = agentComputers({
    browser: () => fake.browser,
    records: () => store,
    seed: (accountId, threadId, sessionId) => fake.step('seed', `seed ${accountId} ${threadId} ${sessionId}`),
    files: () => files,
    idleSeconds: IDLE_SECONDS,
  });
  return { ...fake, store, computer };
}

const idle = (seconds = IDLE_SECONDS) => vi.advanceTimersByTimeAsync(seconds * 1000);

describe('an Agent Computer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is asleep with no screenshot before it ever woke', async () => {
    const { computer } = computers();

    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'asleep', screenshot: null });
  });

  it('wakes a browser, then on idle keeps its screen, drops Site, saves a new profile, and stops it', async () => {
    const { computer, log, store } = computers();

    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null });
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null });
    await idle();

    expect(log).toEqual([
      'start null',
      `seed ${ACCOUNT} chat-1 browser-1`,
      'screenshot browser-1',
      'beforeProfileSave browser-1',
      `createProfile ${ACCOUNT}`,
      `saveProfile profile-of-${ACCOUNT} browser-1`,
      'stop browser-1',
    ]);
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({
      state: 'asleep',
      screenshot: 'data:image/jpeg;base64,browser-1',
    });
    expect(await store.agentComputer(ACCOUNT)).toEqual({ profileId: `profile-of-${ACCOUNT}` });
  });

  it("shows each Session's own last screen while asleep", async () => {
    const { computer } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    await computer.wake(ACCOUNT, 'chat-2');

    await idle();

    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'asleep', screenshot: 'data:image/jpeg;base64,browser-1' });
    expect(await computer.state(ACCOUNT, 'chat-2')).toEqual({ state: 'asleep', screenshot: 'data:image/jpeg;base64,browser-2' });
    expect(await computer.state(ACCOUNT, 'chat-3')).toEqual({ state: 'asleep', screenshot: null });
  });

  it('answers who controls an awake browser, as its browser Session says, so a reload keeps a Take-over', async () => {
    const { computer, takenOver } = computers();
    await computer.wake(ACCOUNT, 'chat-1');

    takenOver.add('browser-1');

    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'user', screenshot: null });
    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'user', screenshot: null });
  });

  it("wakes each account's browser with that account's Files mounted", async () => {
    const { computer, mounts } = computers();

    await computer.wake(ACCOUNT, 'chat-1');
    await computer.wake(OTHER_ACCOUNT, 'chat-1');

    expect(mounts).toEqual([filesOf(ACCOUNT), filesOf(OTHER_ACCOUNT)]);
  });

  it("wakes again from the account's profile, and saves into it", async () => {
    const { computer, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    await idle();
    log.length = 0;

    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: 'data:image/jpeg;base64,browser-1' });
    await idle();

    expect(log).toEqual([
      `start profile-of-${ACCOUNT}`,
      `seed ${ACCOUNT} chat-1 browser-2`,
      'screenshot browser-2',
      'beforeProfileSave browser-2',
      `saveProfile profile-of-${ACCOUNT} browser-2`,
      'stop browser-2',
    ]);
  });

  it('stops a browser its Session Credential could not be seeded into, and stays asleep', async () => {
    const { computer, log, failing } = computers();
    failing.add('seed');

    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('seed failed');

    expect(log).toEqual(['start null', `seed ${ACCOUNT} chat-1 browser-1`, 'stop browser-1']);
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'asleep', screenshot: null });
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
  });

  it('stays awake until it has been idle for the whole idle time', async () => {
    const { computer } = computers();
    await computer.wake(ACCOUNT, 'chat-1');

    await idle(IDLE_SECONDS - 1);
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null });

    await idle(1);
    expect((await computer.state(ACCOUNT, 'chat-1')).state).toBe('asleep');
  });

  it("is kept awake by its account's use and by waking it again, not by another account's", async () => {
    const { computer } = computers();
    await computer.wake(ACCOUNT, 'chat-1');

    await idle(6);
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(true);
    await idle(6);
    expect(computer.use(OTHER_ACCOUNT, 'browser-1')).toBe(false);
    await computer.wake(ACCOUNT, 'chat-1');
    await idle(6);
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null });

    await idle(4);
    expect((await computer.state(ACCOUNT, 'chat-1')).state).toBe('asleep');
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
  });

  it('knows no browser it did not start', () => {
    const { computer } = computers();

    expect(computer.use(ACCOUNT, 'agent-started-browser')).toBe(false);
  });

  it('gives each Session its own browser, and one Session one browser however often it wakes', async () => {
    const { computer, log } = computers();

    const states = await Promise.all([
      computer.wake(ACCOUNT, 'chat-1'),
      computer.wake(ACCOUNT, 'chat-1'),
      computer.wake(ACCOUNT, 'chat-2'),
      computer.wake(OTHER_ACCOUNT, 'chat-1'),
    ]);

    expect(states.map((state) => state.browserSessionId)).toEqual([
      'browser-1',
      'browser-1',
      'browser-2',
      'browser-3',
    ]);
    expect(log.filter((entry) => entry.startsWith('start'))).toEqual(['start null', 'start null', 'start null']);
  });

  it('fails a wake whose browser does not start, and starts afresh on the next', async () => {
    const { computer, failing } = computers();
    failing.add('start');

    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('start failed');
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'asleep', screenshot: null });

    failing.delete('start');
    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null });
  });

  it('retries a failed start cleanup on account erasure, and fails erasure until the browser stops', async () => {
    const { computer, failing, log } = computers();
    failing.add('seed');
    failing.add('stop');

    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toMatchObject({
      message: 'seed failed',
      errors: [{ message: 'seed failed' }, { message: 'stop failed' }],
    });
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    await expect(computer.erase(ACCOUNT)).rejects.toThrow('stop failed');
    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(2);

    failing.delete('stop');
    await computer.erase(ACCOUNT);
    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(3);
  });

  it('revokes only its own failed starts, leaving another account for its own revocation', async () => {
    const { computer, failing, log } = computers();
    failing.add('seed');
    failing.add('stop');
    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('seed failed');
    await expect(computer.wake(OTHER_ACCOUNT, 'chat-2')).rejects.toThrow('seed failed');
    failing.delete('stop');

    await computer.revoke(ACCOUNT);

    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(2);
    expect(log.filter((entry) => entry === 'stop browser-2')).toHaveLength(1);
    await computer.revoke(OTHER_ACCOUNT);
    expect(log.filter((entry) => entry === 'stop browser-2')).toHaveLength(2);
  });

  it('answers a poll of a Session whose start cleanup failed without retrying the cleanup', async () => {
    const { computer, failing, log } = computers();
    failing.add('seed');
    failing.add('stop');
    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('seed failed');

    expect(await computer.state(ACCOUNT, 'chat-1')).toMatchObject({ state: 'asleep' });
    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(1);
  });

  it('stops a browser whose start cleanup failed before a later wake starts afresh', async () => {
    const { computer, failing, log } = computers();
    failing.add('seed');
    failing.add('stop');
    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('seed failed');

    failing.delete('seed');
    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('stop failed');
    expect(log.filter((entry) => entry.startsWith('start '))).toHaveLength(1);

    failing.delete('stop');
    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: null });
    expect(log.slice(-3)).toEqual(['stop browser-1', 'start null', `seed ${ACCOUNT} chat-1 browser-2`]);
  });

  it('keeps a newer failed start when concurrent cleanup of the old browser finishes later', async () => {
    const { computer, browser, failing } = computers();
    failing.add('seed');
    failing.add('stop');
    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('seed failed');
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    vi.spyOn(browser, 'stop')
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishSecond = resolve; }));
    const waking = computer.wake(ACCOUNT, 'chat-1').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const erasing = computer.erase(ACCOUNT).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);

    finishFirst();
    expect(await waking).toMatchObject({
      message: 'seed failed',
      errors: [{ message: 'seed failed' }, { message: 'stop failed' }],
    });
    finishSecond();

    expect(await erasing).toMatchObject({ message: 'stop failed' });
  });

  it('logs a failed sleep, still stops the browser, fails the next caller with it, and then wakes afresh', async () => {
    const { computer, failing, log } = computers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('saveProfile');

    await idle();

    expect(logged).toHaveBeenCalledWith('Agent Computer sleep failed', new Error('saveProfile failed'));
    expect(log.at(-1)).toBe('stop browser-1');
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    await expect(computer.state(ACCOUNT, 'chat-1')).rejects.toThrow('saveProfile failed');
    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: 'data:image/jpeg;base64,browser-1' });
  });

  it('answers a browser still starting as starting, with its last screenshot, without waiting for it', async () => {
    const { computer, hold } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    await idle();
    const release = hold('start');

    computer.warm(ACCOUNT, 'chat-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'starting', screenshot: 'data:image/jpeg;base64,browser-1' });

    release();
    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: 'data:image/jpeg;base64,browser-1' });
    expect(await computer.state(ACCOUNT, 'chat-1')).toMatchObject({ state: 'awake', browserSessionId: 'browser-2' });
  });

  it('wakes, and answers its state, only once a sleep in progress is done', async () => {
    const { computer, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('saveProfile');
    await idle();

    const state = computer.state(ACCOUNT, 'chat-1');
    const woken = computer.wake(ACCOUNT, 'chat-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(log.at(-1)).toBe(`saveProfile profile-of-${ACCOUNT} browser-1`);
    release();

    expect(await state).toEqual({ state: 'asleep', screenshot: 'data:image/jpeg;base64,browser-1' });
    expect(await woken).toEqual({ state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: 'data:image/jpeg;base64,browser-1' });
    expect(log.slice(-3)).toEqual(['stop browser-1', `start profile-of-${ACCOUNT}`, `seed ${ACCOUNT} chat-1 browser-2`]);
  });

  it('fails a wake waiting on a sleep that fails, and the next wake starts afresh', async () => {
    const { computer, failing, hold } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('saveProfile');
    failing.add('saveProfile');
    await idle();

    const woken = computer.wake(ACCOUNT, 'chat-1');
    release();

    await expect(woken).rejects.toThrow('saveProfile failed');
    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: 'data:image/jpeg;base64,browser-1' });
  });

  it('keeps a browser it could not stop awake, and stops it after the next idle period', async () => {
    const { computer, failing, log } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('stop');
    await idle();

    expect(computer.use(ACCOUNT, 'browser-1')).toBe(true);
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: 'data:image/jpeg;base64,browser-1' });
    failing.delete('stop');
    await idle();

    expect(log.at(-1)).toBe('stop browser-1');
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
  });

  it('stays awake past its idle time while the user drives it, and sleeps once handed back', async () => {
    const { computer, log, takenOver } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    takenOver.add('browser-1');

    await idle();
    await idle();

    expect(log).not.toContain('stop browser-1');
    takenOver.delete('browser-1');
    await idle();
    expect(log.at(-1)).toBe('stop browser-1');
  });

  it('keeps a recently used browser awake when an older idle control read finishes', async () => {
    const { computer, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('control');
    await idle();

    expect(computer.use(ACCOUNT, 'browser-1')).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(log).not.toContain('stop browser-1');
    await idle();
    expect(log.at(-1)).toBe('stop browser-1');
  });

  it('does not sleep a browser after revocation overtakes its idle control read', async () => {
    const { computer, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('control');
    await idle();
    await computer.revoke(ACCOUNT);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(1);
    expect(log).not.toContain('screenshot browser-1');
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'asleep', screenshot: null });
  });

  it('retries an idle control failure after another idle period', async () => {
    const { computer, failing, log } = computers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('control');
    await idle();

    expect(logged).toHaveBeenCalledWith('Agent Computer sleep failed', new Error('control failed'));
    expect(log).not.toContain('stop browser-1');
    failing.delete('control');
    await idle();

    expect(log.at(-1)).toBe('stop browser-1');
  });

  it('does not rearm a revoked browser when its old control read fails', async () => {
    const { computer, failing, hold, log } = computers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('control');
    await idle();
    await computer.revoke(ACCOUNT);
    failing.add('control');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(logged).toHaveBeenCalledTimes(1);
    await idle();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(1);
  });

  it('withdraws browser use while its profile save or stop is in progress', async () => {
    const { computer, hold } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    const releaseSave = hold('saveProfile');
    await idle();

    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    const releaseStop = hold('stop');
    releaseSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    releaseStop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('cancels an idle timer when revocation stops a browser slowly', async () => {
    const { computer, hold, failing, log } = computers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('stop');
    const revoked = computer.revoke(ACCOUNT);
    await vi.advanceTimersByTimeAsync(0);
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    failing.add('control');
    await idle();

    expect(logged).not.toHaveBeenCalled();
    expect(log).not.toContain('screenshot browser-1');
    release();
    await revoked;
  });

  it('keeps a stop retry armed after the caller reads its restored awake state', async () => {
    const { computer, failing, log } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('stop');
    await idle();
    expect(await computer.state(ACCOUNT, 'chat-1')).toMatchObject({ state: 'awake', browserSessionId: 'browser-1' });
    failing.delete('stop');
    await idle();

    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(2);
    expect(await computer.state(ACCOUNT, 'chat-1')).toMatchObject({ state: 'asleep' });
  });

  it('waits for a new revocation after an older sleep fails to stop the browser', async () => {
    const { computer, browser, log } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failFirstStop = (_error: Error) => {};
    const firstStop = new Promise<void>((_resolve, reject) => { failFirstStop = reject; });
    let finishRevocation = () => {};
    const secondStop = new Promise<void>((resolve) => { finishRevocation = resolve; });
    let stops = 0;
    browser.stop = () => (++stops === 1 ? firstStop : secondStop);
    await computer.wake(ACCOUNT, 'chat-1');
    await idle();
    const firstState = expect(computer.state(ACCOUNT, 'chat-1')).rejects.toThrow('first stop failed');
    let revoked: Promise<void> | undefined;
    void firstStop.catch(() => { revoked = computer.revoke(ACCOUNT); });

    failFirstStop(new Error('first stop failed'));
    await vi.advanceTimersByTimeAsync(0);
    await firstState;
    let woke = false;
    const woken = computer.wake(ACCOUNT, 'chat-1').then((state) => { woke = true; return state; });
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(woke).toBe(false);
      expect(log.filter((entry) => entry.startsWith('start'))).toHaveLength(1);
    } finally {
      finishRevocation();
      await revoked;
      await woken;
    }
  });

  it("stops every awake browser of the account on revocation, saving nothing, and leaves other accounts' alone", async () => {
    const { computer, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    await computer.wake(ACCOUNT, 'chat-2');
    await computer.wake(OTHER_ACCOUNT, 'chat-3');

    await computer.revoke(ACCOUNT);

    expect(log.slice(-2).sort()).toEqual(['stop browser-1', 'stop browser-2']);
    expect(log.some((entry) => entry.startsWith('saveProfile'))).toBe(false);
    expect(computer.use(OTHER_ACCOUNT, 'browser-3')).toBe(true);
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'asleep', screenshot: null });
  });

  it('waits for a sleeping browser to stop before resolving revocation', async () => {
    const { computer, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('screenshot');
    await idle();
    let revoked = false;
    const revocation = computer.revoke(ACCOUNT).then(() => { revoked = true; });
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(revoked).toBe(false);
      expect(log).not.toContain('stop browser-1');
    } finally {
      release();
      await revocation;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(log).toContain('stop browser-1');
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
  });

  it.each(['screenshot', 'beforeProfileSave', 'saveProfile', 'saveAgentComputerScreenshot'])('reports a failed %s to revocation after the browser stops', async (operation) => {
    const { computer, hold, failing, store } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('screenshot');
    await idle();
    const failure = new Error(`${operation} failed`);
    if (operation === 'saveAgentComputerScreenshot') vi.spyOn(store, 'saveAgentComputerScreenshot').mockRejectedValueOnce(failure);
    else failing.add(operation);
    const result = computer.revoke(ACCOUNT).then(() => undefined, (error: unknown) => error);
    release();
    expect(await result).toEqual(failure);
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    await computer.revoke(ACCOUNT);
  });

  it('fails revocation when a sleeping browser with its original credential cannot stop, then retries', async () => {
    const { computer, hold, failing, log } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('screenshot');
    await idle();
    failing.add('screenshot');
    failing.add('stop');
    const revocation = expect(computer.revoke(ACCOUNT)).rejects.toThrow('stop failed');
    release();
    await revocation;
    expect(log).not.toContain('beforeProfileSave browser-1');
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(true);
    failing.delete('stop');
    await computer.revoke(ACCOUNT);
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
  });

  it('stops a restored browser before reporting its failed sleep to revocation', async () => {
    const { computer, browser, hold, failing, log } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    const originalStop = browser.stop;
    let stops = 0;
    browser.stop = async (sessionId) => {
      if (++stops === 1) throw new Error('first stop failed');
      await originalStop(sessionId);
    };
    const release = hold('screenshot');
    await idle();
    failing.add('screenshot');
    const revocation = expect(computer.revoke(ACCOUNT)).rejects.toThrow('first stop failed');
    release();
    await revocation;
    expect(stops).toBe(2);
    expect(log).not.toContain('beforeProfileSave browser-1');
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
  });

  it.each([false, true])('cleans up a restored browser before an unrelated sleep finishes (persistent failure: %s)', async (persistent) => {
    const { computer, browser, takenOver } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    await computer.wake(ACCOUNT, 'chat-2');
    await computer.wake(OTHER_ACCOUNT, 'chat-3');
    takenOver.add('browser-3');
    const screenshot = browser.screenshot;
    let failFirst = () => {};
    let finishSecond = () => {};
    browser.screenshot = (sessionId) => {
      if (sessionId === 'browser-1') return new Promise<string>((_, reject) => { failFirst = () => reject(new Error('screenshot failed')); });
      if (sessionId === 'browser-2') return new Promise<string>((resolve) => { finishSecond = () => resolve('data:image/jpeg;base64,browser-2'); });
      return screenshot(sessionId);
    };
    const stop = browser.stop;
    let firstStops = 0;
    browser.stop = async (sessionId) => {
      if (sessionId === 'browser-1' && (++firstStops === 1 || persistent)) throw new Error('stop failed');
      await stop(sessionId);
    };
    await idle();
    let failure: unknown;
    let settled = false;
    const revocation = computer.revoke(ACCOUNT).then(() => { settled = true; }, (error: unknown) => { failure = error; settled = true; });
    failFirst();
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(firstStops).toBe(2);
      expect(computer.use(ACCOUNT, 'browser-1')).toBe(persistent);
      expect(settled).toBe(true);
      if (persistent) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([new Error('stop failed'), new Error('stop failed')]);
      } else expect(failure).toEqual(new Error('stop failed'));
    } finally {
      finishSecond();
      await revocation;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(computer.use(ACCOUNT, 'browser-2')).toBe(false);
    // Other accounts are untouched by this account's revocation.
    expect(computer.use(OTHER_ACCOUNT, 'browser-3')).toBe(true);
    if (persistent) {
      browser.stop = stop;
      await computer.revoke(ACCOUNT);
      expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    }
  });

  it('revokes an account without waiting for another account to finish sleeping', async () => {
    const { computer, hold } = computers();
    await computer.wake(OTHER_ACCOUNT, 'chat-2');
    const release = hold('screenshot');
    await idle();
    try {
      await computer.revoke(ACCOUNT);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("erases the account's browsers, profile, and screenshots on account deletion, after a sleep in progress, and leaves other accounts' alone", async () => {
    const { computer, log, hold, store } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    await idle();
    await computer.wake(OTHER_ACCOUNT, 'chat-3');
    await idle();
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('saveProfile');
    await computer.wake(ACCOUNT, 'chat-2');
    await idle();

    const erased = computer.erase(ACCOUNT);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.some((entry) => entry.startsWith('deleteProfile'))).toBe(false);
    release();
    await erased;

    expect(log.slice(-3, -1).sort()).toEqual(['stop browser-3', 'stop browser-4']);
    expect(log.at(-1)).toBe(`deleteProfile profile-of-${ACCOUNT}`);
    expect(await store.agentComputer(ACCOUNT)).toEqual({ profileId: null });
    expect(await computer.state(ACCOUNT, 'chat-1')).toEqual({ state: 'asleep', screenshot: null });
    expect(await store.agentComputer(OTHER_ACCOUNT)).toEqual({ profileId: `profile-of-${OTHER_ACCOUNT}` });
    expect(await computer.state(OTHER_ACCOUNT, 'chat-3')).toMatchObject({ state: 'asleep', screenshot: expect.any(String) });
  });

  it('erases the records of an account whose Agent Computer never slept, deleting no profile', async () => {
    const { computer, log, store } = computers();
    await store.saveAgentComputerScreenshot(ACCOUNT, 'chat-0', 'data:image/jpeg;base64,');
    await computer.wake(ACCOUNT, 'chat-1');

    await computer.erase(ACCOUNT);

    expect(log.at(-1)).toBe('stop browser-1');
    expect(await store.agentComputerScreenshot(ACCOUNT, 'chat-0')).toBeNull();
  });

  it('erases an account without waiting for another account to finish sleeping', async () => {
    const { computer, hold, store } = computers();
    await computer.wake(OTHER_ACCOUNT, 'chat-2');
    const release = hold('saveProfile');
    await idle();
    let erased = false;
    const erasure = computer.erase(ACCOUNT).then(() => { erased = true; });
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(erased).toBe(true);
    } finally {
      release();
      await erasure;
    }

    expect(await store.agentComputer(OTHER_ACCOUNT)).toEqual({ profileId: `profile-of-${OTHER_ACCOUNT}` });
    expect(await computer.state(OTHER_ACCOUNT, 'chat-2')).toMatchObject({ state: 'asleep', screenshot: expect.any(String) });
  });

  it('reports a failed sleep before erasure, then retries so the account can later wake afresh', async () => {
    const { computer, failing, log } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('saveProfile');
    await idle();

    await expect(computer.erase(ACCOUNT)).rejects.toThrow('saveProfile failed');
    expect(log.some((entry) => entry.startsWith('deleteProfile'))).toBe(false);
    failing.delete('saveProfile');
    await computer.erase(ACCOUNT);

    expect(await computer.wake(ACCOUNT, 'chat-1')).toEqual({ state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: null });
  });

  it('fails the erasure while a browser whose sleep could not stop it is still running', async () => {
    const { computer, failing, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    const release = hold('saveProfile');
    await idle();
    failing.add('stop');

    const erased = computer.erase(ACCOUNT);
    release();

    await expect(erased).rejects.toThrow('stop failed');
    expect(log.filter((entry) => entry === 'stop browser-1')).toHaveLength(2);
    expect(log.some((entry) => entry.startsWith('deleteProfile'))).toBe(false);
  });
});

describe('the Agent Computers of a stopping task', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sleep a browser whose idle sleep failed while the task drained, saving its screen and profile before stopping it', async () => {
    const { computer, failing, log, store } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('stop');
    await idle();
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(true);
    failing.delete('stop');
    log.length = 0;

    expect(await computer.sleepAll().slept).toEqual(['browser-1']);
    expect(log).toEqual([
      'handBack browser-1',
      'screenshot browser-1',
      'beforeProfileSave browser-1',
      `saveProfile profile-of-${ACCOUNT} browser-1`,
      'stop browser-1',
    ]);
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
    expect(await store.agentComputerScreenshot(ACCOUNT, 'chat-1')).toBe('data:image/jpeg;base64,browser-1');
  });

  it('hand a taken-over browser back, then save its profile without Site cookies and stop it', async () => {
    const { computer, cookies, log, profiles, takenOver } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    takenOver.add('browser-1');
    cookies.set('browser-1', ['site.example', 'example.com']);
    log.length = 0;

    expect(await computer.sleepAll().slept).toEqual(['browser-1']);
    expect(log).toEqual([
      'handBack browser-1',
      'screenshot browser-1',
      'beforeProfileSave browser-1',
      `createProfile ${ACCOUNT}`,
      `saveProfile profile-of-${ACCOUNT} browser-1`,
      'stop browser-1',
    ]);
    expect(profiles.get(`profile-of-${ACCOUNT}`)).toEqual(['example.com']);
  });

  it('sleep all at once', async () => {
    const { computer, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    await computer.wake(OTHER_ACCOUNT, 'chat-2');
    const release = hold('screenshot');

    const { slept } = computer.sleepAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.filter((entry) => entry.startsWith('screenshot'))).toEqual(['screenshot browser-1', 'screenshot browser-2']);
    release();

    await slept;
    expect(log.filter((entry) => entry.startsWith('stop'))).toEqual(['stop browser-1', 'stop browser-2']);
  });

  it('stop a browser whose save fails, and fail with it', async () => {
    const { computer, failing, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('saveProfile');

    const { slept, sleeps } = computer.sleepAll();

    await expect(slept).rejects.toThrow('saveProfile failed');
    await Promise.allSettled(sleeps);
    expect(log.at(-1)).toBe('stop browser-1');
  });

  it('fail with the first browser that did not sleep while the others go on sleeping (ADR 0030)', async () => {
    const { browser, computer, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    await computer.wake(OTHER_ACCOUNT, 'chat-2');
    vi.spyOn(browser, 'screenshot').mockRejectedValueOnce(new Error('screenshot failed'));
    const release = hold('saveProfile');

    const { slept, sleeps } = computer.sleepAll();
    await expect(slept).rejects.toThrow('screenshot failed');
    expect(log.filter((entry) => entry.startsWith('stop'))).toEqual(['stop browser-1']);
    release();

    await Promise.allSettled(sleeps);
    expect(log.slice(-2)).toEqual([`saveProfile profile-of-${OTHER_ACCOUNT} browser-2`, 'stop browser-2']);
  });

  it('wait for a sleep in progress, fail with its lost save, and stop outright the browser it could not stop', async () => {
    const { browser, computer, failing, hold, log } = computers();
    await computer.wake(ACCOUNT, 'chat-1');
    vi.spyOn(browser, 'stop').mockRejectedValueOnce(new Error('stop failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const release = hold('saveProfile');
    failing.add('saveProfile');
    await idle();

    const { slept } = computer.sleepAll();
    release();

    await expect(slept).rejects.toThrow('stop failed');
    expect(log.filter((entry) => entry === 'screenshot browser-1')).toHaveLength(1);
    expect(log.at(-1)).toBe('stop browser-1');
    expect(computer.use(ACCOUNT, 'browser-1')).toBe(false);
  });

  it('leave a sleep that ended before the task stopped to the caller it already failed', async () => {
    const { computer, failing } = computers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await computer.wake(ACCOUNT, 'chat-1');
    failing.add('saveProfile');
    await idle();

    expect(await computer.sleepAll().slept).toEqual([]);
  });

  it('start no browser once the task is stopping', async () => {
    const { computer, log } = computers();
    await computer.sleepAll().slept;

    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('The Chat Service is stopping');
    expect(log).toEqual([]);
  });

  it('stop a browser still starting whose Sign-in and first cleanup fail while the others sleep', async () => {
    const { browser, computer, failing, hold, log } = computers();
    failing.add('seed');
    const release = hold('seed');
    vi.spyOn(browser, 'stop').mockRejectedValueOnce(new Error('stop failed'));
    const starting = computer.wake(ACCOUNT, 'chat-1');
    await vi.advanceTimersByTimeAsync(0);

    const { slept } = computer.sleepAll();
    release();

    await expect(starting).rejects.toThrow('seed failed');
    await slept;
    expect(log.at(-1)).toBe('stop browser-1');
  });

  it('skip a browser still starting whose start then fails, and stop a failed start whose cleanup failed', async () => {
    const { computer, failing, hold, log } = computers();
    failing.add('seed');
    failing.add('stop');
    await expect(computer.wake(ACCOUNT, 'chat-1')).rejects.toThrow('seed failed');
    failing.delete('stop');
    const release = hold('seed');
    const starting = computer.wake(ACCOUNT, 'chat-2');
    await vi.advanceTimersByTimeAsync(0);

    const { slept } = computer.sleepAll();
    release();

    await expect(starting).rejects.toThrow('seed failed');
    await slept;
    expect(log.filter((entry) => entry.startsWith('stop')).sort()).toEqual(['stop browser-1', 'stop browser-1', 'stop browser-2']);
    expect(log.some((entry) => entry.startsWith('screenshot'))).toBe(false);
  });
});

describe('the Agent Computer idle time', () => {
  it('is ten minutes unless BOTCUBE_AGENT_COMPUTER_IDLE_SECONDS sets it', () => {
    expect(agentComputerIdleSeconds({})).toBe(600);
    expect(agentComputerIdleSeconds({ BOTCUBE_AGENT_COMPUTER_IDLE_SECONDS: '5' })).toBe(5);
  });
});

/** AgentCore over HTTP and one CDP automation stream, recording what each is asked. */
function agentCore({
  answers = {},
  cookies = [],
  screenshot = { data: 'c2hvdA==' },
  streamStatus = 'DISABLED',
  commandErrors = {},
}: {
  answers?: Record<string, Response>;
  cookies?: Record<string, unknown>[];
  screenshot?: Record<string, unknown>;
  streamStatus?: 'ENABLED' | 'DISABLED';
  commandErrors?: Record<string, { code: number; message: string }>;
} = {}) {
  const start = { sessionId: 'browser-1', createdAt: '2026-01-01T00:00:00Z', streams: { automationStream: { streamEndpoint: 'wss://stream.test/started' } } };
  const requests: { url: string; method: string; contentType?: string | null; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit & { body?: string }) => {
    requests.push({
      url,
      method: String(init.method),
      ...(init.body === undefined ? {} : { contentType: new Headers(init.headers).get('content-type') }),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const path = new URL(url).pathname;
    if (answers[path]) return answers[path];
    if (path.endsWith('/sessions/start')) return Response.json(start);
    if (path.endsWith('/sessions/get')) {
      return Response.json({
        streams: { automationStream: { streamEndpoint: 'wss://stream.test/looked-up', streamStatus } },
      });
    }
    return Response.json({});
  });
  const streams: string[] = [];
  const commands: { method: string; params?: unknown }[] = [];
  class FakeSocket extends EventTarget {
    constructor(url: string) {
      super();
      streams.push(url);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(data: string) {
      const { id, method, params } = JSON.parse(data) as { id: number; method: string; params?: unknown };
      commands.push({ method, params });
      const results: Record<string, unknown> = {
        'Target.getTargets': { targetInfos: [{ targetId: 'page-1', type: 'page', url: 'https://example.com/' }] },
        'Target.attachToTarget': { sessionId: 'page-session' },
        'Network.getAllCookies': { cookies },
        'Page.captureScreenshot': screenshot,
      };
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(commandErrors[method] ? { id, error: commandErrors[method] } : { id, result: results[method] ?? {} }) })),
      );
    }
    close() {
      closed.push(this);
    }
  }
  const closed: FakeSocket[] = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  return { requests, streams, commands, closed };
}

const ENV = {
  AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: 'http://agentcore.test',
  AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL: 'http://control.test//',
  AGENTCORE_BROWSER_ID: 'siteCookies-login-browser',
  AGENTCORE_AGENT_COMPUTER_BROWSER_ID: ' browser-id ',
  BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET: ' policy-bucket ',
  BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY: ' agent-computer/chrome-policy.json ',
};
const FILES = filesOf(ACCOUNT);
const client = (env: NodeJS.ProcessEnv = ENV) => agentComputerBrowserFromEnv(env, {
  beforeProfileSave: async (cdp) => {
    const page = await cdp.attachToPage();
    const cookies = (await cdp.allCookies(page)).filter(
      (cookie) => typeof cookie.domain === 'string' && (cookie.domain === 'site.example' || cookie.domain.endsWith('.site.example')),
    );
    for (const { name, domain, path } of cookies) {
      // eslint-disable-next-line no-await-in-loop -- one CDP connection, one command at a time
      await cdp.send('Network.deleteCookies', { params: { name, domain, path }, sessionId: page });
    }
  },
})();

describe('the AgentCore browser of Agent Computers', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_SESSION_TOKEN', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('answers 503 until its own browser is configured, never falling back to the Site login browser', () => {
    expect(() => client({ ...ENV, AGENTCORE_AGENT_COMPUTER_BROWSER_ID: ' ' })).toThrow(
      new HttpError(503, 'Agent Computer browser is not configured: AGENTCORE_AGENT_COMPUTER_BROWSER_ID is required'),
    );
  });

  it('answers 503 until the Chrome policy that downloads into Files is configured', () => {
    expect(() => client({ ...ENV, BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY: ' ' })).toThrow(
      new HttpError(
        503,
        'Agent Computer browser is not configured: BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET and BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY are required',
      ),
    );
    expect(() => client({ ...ENV, BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET: undefined })).toThrow(HttpError);
  });

  it("starts a browser Session from the account's profile, for AgentCore's longest timeout, filling the live view's 1280x720 display", async () => {
    const { requests } = agentCore();

    expect(client().browserId).toBe('browser-id');
    expect(await client().start('profile-1', FILES)).toBe('browser-1');
    await client().start(null, FILES);

    expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
      'PUT http://agentcore.test/browsers/browser-id/sessions/start',
      'PUT http://agentcore.test/browsers/browser-id/sessions/start',
    ]);
    const filesAsDownloads = {
      viewPort: { width: 1280, height: 720 },
      filesystemConfigurations: [{ s3FilesConfiguration: FILES }],
      enterprisePolicies: [
        { type: 'RECOMMENDED', location: { s3: { bucket: 'policy-bucket', prefix: 'agent-computer/chrome-policy.json' } } },
      ],
    };
    expect(requests.map(({ body }) => body)).toEqual([
      {
        name: 'botcube-agent-computer',
        sessionTimeoutSeconds: 28_800,
        profileConfiguration: { profileIdentifier: 'profile-1' },
        ...filesAsDownloads,
        clientToken: expect.any(String),
      },
      { name: 'botcube-agent-computer', sessionTimeoutSeconds: 28_800, ...filesAsDownloads, clientToken: expect.any(String) },
    ]);
  });

  it("creates the account's one browser profile, retry-safe, at the control plane", async () => {
    const { requests } = agentCore({ answers: { '/browser-profiles': Response.json({ profileId: 'profile-1' }) } });

    expect(await client().createProfile(ACCOUNT)).toBe('profile-1');

    expect(requests).toEqual([
      {
        url: 'http://control.test/browser-profiles',
        method: 'PUT',
        contentType: 'application/json',
        body: {
          name: 'botcube_8300e9d12ce55ca979c3e7e01a8f7facab49',
          clientToken: '567a7ccb67f2821e91e0b1bb8b898b447cbbf610df6b02e11352ace2c03339a2',
        },
      },
    ]);
  });

  it("uses the region's control plane unless AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL sets one", async () => {
    const { requests } = agentCore({ answers: { '/browser-profiles': Response.json({ profileId: 'profile-1' }) } });

    await client({ ...ENV, AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL: undefined, AGENTCORE_REGION: 'us-west-2' }).createProfile(ACCOUNT);

    expect(requests[0]?.url).toBe('https://bedrock-agentcore-control.us-west-2.amazonaws.com/browser-profiles');
  });

  it.each([
    ['no profileId', Response.json({}), 'AgentCore CreateBrowserProfile answered no profileId'],
    ['an empty profileId', Response.json({ profileId: '' }), 'AgentCore CreateBrowserProfile answered no profileId'],
    [
      'a refusal',
      new Response('{"message":"ConflictException"}', { status: 409 }),
      'AgentCore CreateBrowserProfile returned HTTP 409: {"message":"ConflictException"}',
    ],
  ])('fails loud when profile creation answers %s', async (_case, answer, message) => {
    agentCore({ answers: { '/browser-profiles': answer } });

    await expect(client().createProfile(ACCOUNT)).rejects.toThrow(message);
  });

  it("saves a browser Session into a profile at the data plane, with a fresh client token", async () => {
    const { requests } = agentCore();

    await client().saveProfile('profile/1', 'browser-1');

    expect(requests).toEqual([
      {
        url: 'http://agentcore.test/browser-profiles/profile%2F1/save',
        method: 'PUT',
        contentType: 'application/json',
        body: {
          browserIdentifier: 'browser-id',
          sessionId: 'browser-1',
          clientToken: expect.any(String),
        },
      },
    ]);
  });

  it('saves again with a fresh token after a successful save but failed stop', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answers = { '/browsers/browser-id/sessions/stop': new Response('busy', { status: 503 }) };
    const { requests } = agentCore({ answers, streamStatus: 'ENABLED' });
    const store = new AccountResources('chat', memoryDocuments());
    await store.saveAgentComputer(ACCOUNT, { profileId: 'profile-1' });
    const browser = client();
    const computer = agentComputers({
      browser: () => browser,
      records: () => store,
      seed: async () => {},
      files: () => ({ mount: async (accountId: string) => filesOf(accountId) }) as AccountFiles,
      idleSeconds: IDLE_SECONDS,
    });
    try {
      await computer.wake(ACCOUNT, 'chat-1');
      await idle();
      expect(error).toHaveBeenCalledWith('Agent Computer sleep failed', expect.any(Error));
      expect(await computer.state(ACCOUNT, 'chat-1')).toMatchObject({ state: 'awake', browserSessionId: 'browser-1' });
      answers['/browsers/browser-id/sessions/stop'] = Response.json({});
      await idle();
      expect(await computer.state(ACCOUNT, 'chat-1')).toMatchObject({ state: 'asleep' });
      const saves = requests.filter(({ url }) => url.endsWith('/profile-1/save'));
      expect(saves).toHaveLength(2);
      const first = saves[0]?.body as { clientToken: string };
      const second = saves[1]?.body as { clientToken: string };
      expect(second.clientToken).not.toBe(first.clientToken);
    } finally {
      vi.useRealTimers();
      error.mockRestore();
    }
  });

  it("fails loud when AgentCore refuses a profile save", async () => {
    agentCore({ answers: { '/browser-profiles/profile-1/save': new Response('gone', { status: 404 }) } });

    await expect(client().saveProfile('profile-1', 'browser-1')).rejects.toThrow(
      'AgentCore SaveBrowserSessionProfile returned HTTP 404: gone',
    );
  });

  it("captures the page as a JPEG over the started browser's automation stream", async () => {
    const { streams, commands } = agentCore();
    const browser = client();
    await browser.start(null, FILES);

    expect(await browser.screenshot('browser-1')).toBe('data:image/jpeg;base64,c2hvdA==');
    expect(streams).toEqual(['wss://stream.test/started']);
    expect(commands.at(-1)).toEqual({ method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 40 } });
  });

  it("looks up a browser's automation stream it did not start, and again once it stopped one", async () => {
    const { streams, requests, closed } = agentCore();
    const browser = client();
    await browser.start(null, FILES);
    await browser.stop('browser-1');

    await browser.screenshot('browser-1');
    await browser.beforeProfileSave('browser-1');

    expect(streams).toEqual(['wss://stream.test/looked-up', 'wss://stream.test/looked-up']);
    expect(closed).toHaveLength(2);
    expect(requests.filter(({ method }) => method === 'GET').map(({ url }) => url)).toEqual([
      'http://agentcore.test/browsers/browser-id/sessions/get?sessionId=browser-1',
    ]);
  });

  it.each([
    ['no image', {}],
    ['an empty image', { data: '' }],
    ['an image that is not text', { data: 42 }],
  ])('fails loud when the screenshot has %s', async (_case, screenshot) => {
    agentCore({ screenshot });

    await expect(client().screenshot('browser-1')).rejects.toThrow('Agent Computer screenshot returned no image');
  });

  it.each(['Network.getAllCookies', 'Network.deleteCookies'])(
    'does not save Site credentials into a profile when CDP rejects %s',
    async (method) => {
      vi.useFakeTimers();
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { requests, commands, closed } = agentCore({
        cookies: [{ name: 'synthetic-session', domain: '.app.site.example', path: '/' }],
        commandErrors: { [method]: { code: -32000, message: 'synthetic cleanup failure' } },
        streamStatus: 'ENABLED',
      });
      const store = new AccountResources('chat', memoryDocuments());
      await store.saveAgentComputer(ACCOUNT, { profileId: 'profile-1' });
      const browser = client();
      const computer = agentComputers({
        browser: () => browser,
        records: () => store,
        seed: async () => {},
        files: () => ({ mount: async (accountId: string) => filesOf(accountId) }) as AccountFiles,
        idleSeconds: IDLE_SECONDS,
      });
      try {
        await computer.wake(ACCOUNT, 'chat-1');
        await idle();

        expect(commands.some((command) => command.method === method)).toBe(true);
        expect(requests.some(({ url }) => url.endsWith('/profile-1/save'))).toBe(false);
        expect(requests.some(({ url }) => url.includes('/sessions/stop'))).toBe(true);
        expect(closed).toHaveLength(2);
        await expect(computer.state(ACCOUNT, 'chat-1')).rejects.toThrow(
          `CDP ${method} failed (-32000): synthetic cleanup failure`,
        );
        expect(logged).toHaveBeenCalledWith('Agent Computer sleep failed', expect.any(Error));
      } finally {
        vi.useRealTimers();
        logged.mockRestore();
      }
    },
  );

  it("deletes the browser's site.example cookies and keeps every other site's", async () => {
    const siteCookies = [
      { name: 'SiteRefreshToken', domain: '.site.example', path: '/' },
      { name: 'SiteLogin', domain: 'app.site.example', path: '/s' },
      { name: 'bare', domain: 'site.example', path: '/' },
      { name: 'dotted', domain: '..site.example', path: '/' },
    ];
    const { commands } = agentCore({
      cookies: [
        ...siteCookies,
        { name: 'sid', domain: '.example.com', path: '/' },
        { name: 'lookalike', domain: 'busite.example', path: '/' },
        { name: 'suffix', domain: 'site.example.example.com', path: '/' },
        { name: 'nodomain', path: '/' },
      ],
    });

    await client().beforeProfileSave('browser-1');

    expect(commands.filter(({ method }) => method === 'Network.deleteCookies').map(({ params }) => params)).toEqual(siteCookies);
  });

  it("answers that the user controls a browser Session whose automation stream is disabled", async () => {
    const { requests } = agentCore();

    expect(await client().control('browser-1')).toBe('user');
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET http://agentcore.test/browsers/browser-id/sessions/get?sessionId=browser-1',
    ]);
  });

  it.each([
    ['ENABLED', 'agent'],
    ['DISABLED', 'user'],
  ])('answers control of a browser Session whose automation stream is %s', async (streamStatus, control) => {
    agentCore({
      answers: {
        '/browsers/browser-id/sessions/get': Response.json({ streams: { automationStream: { streamEndpoint: 'wss://x', streamStatus } } }),
      },
    });

    expect(await client().control('browser-1')).toBe(control);
  });

  it('fails loud on an automation stream status it does not know', async () => {
    agentCore({
      answers: {
        '/browsers/browser-id/sessions/get': Response.json({
          streams: { automationStream: { streamEndpoint: 'wss://x', streamStatus: 'PAUSED' } },
        }),
      },
    });

    await expect(client().control('browser-1')).rejects.toThrow('AgentCore browser session automation stream is PAUSED');
  });

  it('fails loud when AgentCore answers no automation stream status', async () => {
    agentCore({
      answers: { '/browsers/browser-id/sessions/get': Response.json({ streams: { automationStream: { streamEndpoint: 'wss://x' } } }) },
    });

    await expect(client().control('browser-1')).rejects.toThrow('AgentCore browser session response missing streamStatus');
  });

  it("deletes the account's browser profile at the control plane, a profile already gone included", async () => {
    const { requests } = agentCore({ answers: { '/browser-profiles/gone': new Response('{}', { status: 404 }) } });

    await client().deleteProfile('profile/1');
    await client().deleteProfile('gone');

    // AgentCore answers 400 to a deletion without a client token.
    const token = (profileId: string) => createHash('sha256').update(`browser-profile-delete:${profileId}`).digest('hex');
    expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
      `DELETE http://control.test/browser-profiles/profile%2F1?clientToken=${token('profile/1')}`,
      `DELETE http://control.test/browser-profiles/gone?clientToken=${token('gone')}`,
    ]);
  });

  it('fails loud when AgentCore refuses a profile deletion', async () => {
    agentCore({ answers: { '/browser-profiles/profile-1': new Response('busy', { status: 409 }) } });

    await expect(client().deleteProfile('profile-1')).rejects.toThrow('AgentCore DeleteBrowserProfile returned HTTP 409: busy');
  });

  it('stops a browser Session', async () => {
    const { requests } = agentCore();

    await client().stop('browser-1');

    expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
      'PUT http://agentcore.test/browsers/browser-id/sessions/stop?sessionId=browser-1',
    ]);
  });

  it("hands a browser Session back by turning its automation stream on", async () => {
    const { requests } = agentCore();

    await client().handBack('browser-1');

    expect(requests.map(({ url, method, body }) => ({ request: `${method} ${url}`, body }))).toEqual([
      {
        request: 'PUT http://agentcore.test/browsers/browser-id/sessions/streams/update?sessionId=browser-1',
        body: { streamUpdate: { automationStreamUpdate: { streamStatus: 'ENABLED' } }, clientToken: expect.any(String) },
      },
    ]);
  });
});
