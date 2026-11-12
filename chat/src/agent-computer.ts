import type { AgentComputerBrowser, AgentComputerRecords, AgentComputerState, AwakeComputer, BrowserControl } from './agent-computer-types.js';
export type { AgentComputerBrowser, AgentComputerRecords, AgentComputerState } from './agent-computer-types.js';
import { startAgentComputer } from './agent-computer-start.js';
import { ScheduledBrowserAdmissionError } from './account-resources.js';
import { createHash, randomUUID } from 'node:crypto';
import { agentCoreEndpointFromEnv } from './upstream.js';
import { awsFetch } from './aws.js';
import { HttpError } from './cartridge.js';
import { BrowserSessions, BrowserSessionEnded } from './browser-sessions.js';
import type { Cdp } from './cdp.js';
import type { RunningAgentComputer, AgentComputerStream } from './account-resources.js';
import type { AccountFiles } from './files.js';
import type { TaskStopSleep } from './task-stop.js';
import { sweepEvery } from './task-drain.js';

const DEFAULT_IDLE_SECONDS = 600;
/** AgentCore's ceiling: a browser the Chat Service lost track of stops on its own by then. */
const SESSION_TIMEOUT_SECONDS = 8 * 60 * 60;
const SESSION_NAME = 'botcube-agent-computer';
/**
 * The display the live view draws (its 1280x720 default): a narrow pane shrinks page text 1.5x less than at 1920x1080,
 * and AgentCore's own default, 1456x819, would leave the rest black.
 */
const VIEWPORT = { width: 1280, height: 720 };

/** A browser profile name AgentCore accepts, one per account. */
const profileName = (accountId: string, profilePrefix: string) =>
  `${profilePrefix}_${createHash('sha256').update(accountId).digest('hex').slice(0, 36)}`;

/**
 * The Agent Computer's own AgentCore browser, AGENTCORE_AGENT_COMPUTER_BROWSER_ID: its
 * execution role mounts Files, which the sign-in browser's must not (ADR 0077).
 */
export function agentComputerBrowserFromEnv(env: NodeJS.ProcessEnv, { beforeProfileSave, sessionName = SESSION_NAME, profilePrefix = 'botcube' }: { beforeProfileSave: (cdp: Cdp) => Promise<void>; sessionName?: string; profilePrefix?: string }): () => AgentComputerBrowser {
  return () => {
    const browserId = env.AGENTCORE_AGENT_COMPUTER_BROWSER_ID?.trim();
    if (!browserId) {
      throw new HttpError(503, 'Agent Computer browser is not configured: AGENTCORE_AGENT_COMPUTER_BROWSER_ID is required');
    }
    const config = { ...agentCoreEndpointFromEnv(env), browserId };
    const policy = { bucket: env.BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET?.trim(), prefix: env.BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY?.trim() };
    if (!policy.bucket || !policy.prefix) {
      throw new HttpError(
        503,
        'Agent Computer browser is not configured: BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET and BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY are required',
      );
    }
    const control = (env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL || `https://bedrock-agentcore-control.${config.region}.amazonaws.com`).replace(/\/+$/, '');
    return agentCoreAgentComputerBrowser(new BrowserSessions(config), control, { bucket: policy.bucket, prefix: policy.prefix }, { beforeProfileSave, sessionName, profilePrefix });
  };
}

function agentCoreAgentComputerBrowser(
  sessions: BrowserSessions,
  controlEndpoint: string,
  /** The Chrome policy file (deploy/agent-computer) that downloads into the Files mount. */
  policy: { bucket: string; prefix: string },
  { beforeProfileSave, sessionName, profilePrefix }: { beforeProfileSave: (cdp: Cdp) => Promise<void>; sessionName: string; profilePrefix: string },
): AgentComputerBrowser {
  const { region, endpoint, browserId } = sessions.config;

  async function send(url: string, body: object, what: string): Promise<Record<string, unknown>> {
    const response = await awsFetch('bedrock-agentcore', region, url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`AgentCore ${what} returned HTTP ${response.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  return {
    browserId,
    start: (profileId, files) =>
      sessions.start({
        name: sessionName,
        sessionTimeoutSeconds: SESSION_TIMEOUT_SECONDS,
        viewPort: VIEWPORT,
        ...(profileId === null ? {} : { profileConfiguration: { profileIdentifier: profileId } }),
        filesystemConfigurations: [{ efsConfiguration: files }],
        enterprisePolicies: [{ type: 'RECOMMENDED', location: { s3: policy } }],
      }).then(({ sessionId }) => sessionId),
    screenshot: (sessionId) =>
      sessions.withBrowser(sessionId, async (cdp) => {
        const page = await cdp.attachToPage();
        const { data } = (await cdp.send('Page.captureScreenshot', {
          params: { format: 'jpeg', quality: 40 },
          sessionId: page,
        })) as { data?: unknown };
        if (typeof data !== 'string' || !data) throw new Error('Agent Computer screenshot returned no image');
        return `data:image/jpeg;base64,${data}`;
      }),
    beforeProfileSave: (sessionId) => sessions.withBrowser(sessionId, beforeProfileSave),
    async createProfile(accountId) {
      const name = profileName(accountId, profilePrefix);
      // The client token is the account's, so a retry after a lost answer gets the same profile.
      const clientToken = createHash('sha256').update(`browser-profile:${accountId}`).digest('hex');
      const response = await send(`${controlEndpoint}/browser-profiles`, { name, clientToken }, 'CreateBrowserProfile');
      if (typeof response.profileId !== 'string' || !response.profileId) {
        throw new Error('AgentCore CreateBrowserProfile answered no profileId');
      }
      return response.profileId;
    },
    async saveProfile(profileId, sessionId) {
      // AgentCore requires a client token; a fresh one per save, since a re-woken Session saves again.
      await send(
        `${endpoint}/browser-profiles/${encodeURIComponent(profileId)}/save`,
        { browserIdentifier: browserId, sessionId, clientToken: randomUUID() },
        'SaveBrowserSessionProfile',
      );
    },
    async deleteProfile(profileId) {
      // AgentCore requires a client token; the profile's, so a retry after a lost answer is the same deletion.
      const clientToken = createHash('sha256').update(`browser-profile-delete:${profileId}`).digest('hex');
      const response = await awsFetch(
        'bedrock-agentcore',
        region,
        `${controlEndpoint}/browser-profiles/${encodeURIComponent(profileId)}?clientToken=${clientToken}`,
        { method: 'DELETE' },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`AgentCore DeleteBrowserProfile returned HTTP ${response.status}: ${await response.text()}`);
      }
    },
    async stop(sessionId) {
      try { await sessions.stop(sessionId); }
      catch (error) { if (!(error instanceof BrowserSessionEnded)) throw error; }
    },
    automationStream: (sessionId) => sessions.automationStream(sessionId),
    async control(sessionId) {
      const status = await sessions.automationStreamStatus(sessionId);
      if (status === 'ENABLED') return 'agent';
      if (status === 'DISABLED') return 'user';
      throw new Error(`AgentCore browser session automation stream is ${status}`);
    },
    handBack: async (sessionId) => void (await sessions.updateAutomationStream(sessionId, 'ENABLED')),
  };
}

/**
 * The account's Agent Computer (ADR 0077 decisions 1 and 2): each Session gets its own
 * browser, woken from the account's browser profile with the account's Files mounted, and put to sleep when idle
 * after saving the profile after the Cartridge cleanup and keeping a last screenshot.
 * Running browsers and idle deadlines live in the shared chat table.
 */
export function agentComputers({ browser, records, seed, files, idleSeconds, draining = async () => false }: {
  browser: () => AgentComputerBrowser;
  records: () => AgentComputerRecords;
  seed: (accountId: string, threadId: string, browserSessionId: string) => Promise<void>;
  files: () => AccountFiles;
  idleSeconds: number;
  draining?: () => Promise<boolean>;
}) {
  const keyOf = (accountId: string, threadId: string) => JSON.stringify([accountId, threadId]);
  const starting = new Map<string, Promise<AwakeComputer>>();
  const warmups = new Map<string, Promise<unknown>>();
  const failures = new Map<string, unknown>();
  const sleeping = new Map<string, { accountId: string; done: Promise<void>; observed: boolean }>();
  const timers = new Map<string, NodeJS.Timeout>();
  const idleRuns = new Map<string, Promise<void>>();
  const revoking = new Set<string>();
  const streams = new Map<string, { record: AgentComputerStream; timer: NodeJS.Timeout }>();
  const streamLeaseMs = 5000;
  const streamClaims = new Map<string, Set<() => Promise<void>>>();
  let stopping = false;
  const deadline = () => Date.now() + idleSeconds * 1000;

  async function raiseSleepFailure(accountId: string, threadId: string): Promise<void> {
    const key = keyOf(accountId, threadId);
    if (!failures.has(key)) return;
    const error = failures.get(key);
    failures.delete(key);
    const record = await records().runningAgentComputer(accountId, threadId);
    if (record?.phase !== 'awake') throw error;
  }

  async function sleepFinished(accountId: string, threadId: string): Promise<void> {
    const key = keyOf(accountId, threadId);
    const pending = sleeping.get(key);
    if (pending !== undefined) {
      const failure = await pending.done.then(() => undefined, (error: unknown) => error);
      pending.observed = true;
      if (sleeping.get(key) === pending) sleeping.delete(key);
      if (failure !== undefined && revoking.has(accountId)) {
        failures.delete(key);
        throw failure;
      }
    }
    await raiseSleepFailure(accountId, threadId);
  }

  function arm(record: RunningAgentComputer): void {
    const key = keyOf(record.accountId, record.threadId);
    clearTimeout(timers.get(key));
    if (stopping) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      idle(record).catch((error: unknown) => console.error('Agent Computer sleep failed', error));
    }, Math.max(0, record.idleDeadline - Date.now()));
    timer.unref();
    timers.set(key, timer);
  }

  async function closeStreams(sessionId: string): Promise<void> {
    const claims = [...(streamClaims.get(sessionId) ?? [])];
    streamClaims.delete(sessionId);
    const stream = streams.get(sessionId);
    streams.delete(sessionId);
    if (stream !== undefined) clearInterval(stream.timer);
    try {
      await Promise.all(claims.map((letGo) => letGo()));
    } finally {
      if (stream !== undefined) await records().releaseAgentComputerStream(sessionId, stream.record.holder);
    }
  }

  async function refreshStream(record: AgentComputerStream): Promise<void> {
    const stillHeld = () => streams.get(record.sessionId)?.record === record;
    try {
      const computer = await records().runningAgentComputer(record.accountId, record.threadId);
      if (!stillHeld()) return;
      if (computer?.phase !== 'awake' || computer.sessionId !== record.sessionId) {
        await closeStreams(record.sessionId);
        return;
      }
      const expiresAt = Date.now() + streamLeaseMs;
      const renewed = await records().renewAgentComputerStream(record.sessionId, record.holder, expiresAt);
      if (renewed && stillHeld()) record.expiresAt = expiresAt;
      if (!renewed && stillHeld()) await closeStreams(record.sessionId);
    } catch (error) {
      if (stillHeld()) await closeStreams(record.sessionId);
      throw error;
    }
  }

  async function drainStreams(sessionId: string): Promise<void> {
    await closeStreams(sessionId);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- the remote task closes its stream after observing sleeping
      const stream = await records().agentComputerStream(sessionId);
      if (stream === null || stream.expiresAt <= Date.now()) return;
      // eslint-disable-next-line no-await-in-loop -- wait for the owning task's next stream heartbeat
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function control(record: RunningAgentComputer): Promise<BrowserControl | null> {
    if (record.sessionId === null) return null;
    try { return await browser().control(record.sessionId); }
    catch (error) {
      if (error instanceof BrowserSessionEnded) return null;
      throw error;
    }
  }

  async function forget(record: RunningAgentComputer): Promise<void> {
    const key = keyOf(record.accountId, record.threadId);
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (record.sessionId !== null) {
      await closeStreams(record.sessionId);
      const stream = await records().agentComputerStream(record.sessionId);
      if (stream !== null) await records().releaseAgentComputerStream(record.sessionId, stream.holder);
    }
    await records().deleteRunningAgentComputer(record.accountId, record.threadId);
  }

  async function confirmScheduledStop(record: RunningAgentComputer, until = Date.now() + 5000): Promise<void> {
    if (await control(record) === null) return;
    if (Date.now() >= until) throw new Error('Scheduled Browser termination is unproved; retain fleet admission');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await confirmScheduledStop(record, until);
  }

  async function stop(record: RunningAgentComputer, confirm = record.scheduledExecution !== undefined): Promise<void> {
    if (confirm && record.sessionId === null) throw new Error('Scheduled Browser start receipt is unproved; retain fleet admission');
    const key = keyOf(record.accountId, record.threadId);
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (record.sessionId !== null) {
      try {
        const phase = record.phase;
        if (phase === 'awake') {
          await records().saveRunningAgentComputer({ ...record, phase: 'sleeping' });
        }
        await closeStreams(record.sessionId);
        await browser().stop(record.sessionId);
        if (confirm) await confirmScheduledStop(record);
      } catch (error) {
        record.idleDeadline = deadline();
        await records().saveRunningAgentComputer(record);
        arm(record);
        throw error;
      }
    }
    await forget(record);
  }

  async function sleep(record: RunningAgentComputer): Promise<void> {
    const { sessionId, accountId, threadId } = record;
    if (sessionId === null || (record.phase !== 'awake' && record.phase !== 'sleeping')) return stop(record);
    const client = browser();
    await records().saveRunningAgentComputer({ ...record, phase: 'sleeping' });
    try {
      await drainStreams(sessionId);
      const screenshot = await client.screenshot(sessionId);
      await client.beforeProfileSave(sessionId);
      await records().saveAgentComputerScreenshot(accountId, threadId, screenshot);
      const profileId = (await records().agentComputer(accountId)).profileId ?? await client.createProfile(accountId);
      await records().saveAgentComputer(accountId, { profileId });
      await client.saveProfile(profileId, sessionId);
    } finally {
      await stop(record);
    }
  }

  async function idle(candidate: RunningAgentComputer): Promise<void> {
    const key = keyOf(candidate.accountId, candidate.threadId);
    const pending = idleRuns.get(key);
    if (pending !== undefined) return pending;
    const done = idleBrowser(candidate);
    idleRuns.set(key, done);
    try { await done; }
    finally { if (idleRuns.get(key) === done) idleRuns.delete(key); }
  }

  async function idleBrowser(candidate: RunningAgentComputer): Promise<void> {
    // Take-over input bypasses Chat. Read control before the lease, then recheck the durable deadline.
    const driver = candidate.sessionId === null || candidate.phase === 'sleeping' ? 'agent' : await control(candidate);
    await records().withAgentComputerLease(candidate.accountId, async () => {
      const record = await records().runningAgentComputer(candidate.accountId, candidate.threadId);
      if (record === null || record.sessionId !== candidate.sessionId || record.idleDeadline > Date.now()) return;
      if (driver === null) return forget(record);
      if (driver === 'user') {
        record.idleDeadline = deadline();
        await records().saveRunningAgentComputer(record);
        arm(record);
        return;
      }
      const done = sleep(record);
      sleeping.set(keyOf(record.accountId, record.threadId), { accountId: record.accountId, done, observed: false });
      try {
        await done;
      } catch (error) {
        failures.set(keyOf(record.accountId, record.threadId), error);
        throw error;
      }
    }, candidate.threadId);
  }

  const stopSweep = sweepEvery(idleSeconds * 1000, draining, () => records().runningAgentComputers().then(async (running) => {
    await Promise.all(running.filter((record) => record.idleDeadline <= Date.now() && !timers.has(keyOf(record.accountId, record.threadId))).map(idle));
  }).catch((error: unknown) => console.error('Agent Computer sleep failed', error)));

  async function awakeState(record: RunningAgentComputer, driver?: BrowserControl): Promise<AwakeComputer> {
    if (record.sessionId === null || record.phase !== 'awake') throw new Error('Agent Computer did not finish starting');
    return {
      state: 'awake', browserSessionId: record.sessionId,
      control: driver ?? await browser().control(record.sessionId),
      screenshot: await records().agentComputerScreenshot(record.accountId, record.threadId),
    };
  }

  async function wake(accountId: string, threadId: string): Promise<AwakeComputer> {
    const key = keyOf(accountId, threadId);
    const warmup = warmups.get(key);
    if (warmup !== undefined) {
      warmups.delete(key);
      await warmup;
    }
    const pending = starting.get(key);
    if (pending !== undefined) return pending;
    await sleepFinished(accountId, threadId);
    const done = records().withAgentComputerLease(accountId, () => records().withAgentComputerLease(accountId, async () => {
      await raiseSleepFailure(accountId, threadId);
      const admission = await records().scheduledBrowserAdmission(accountId, threadId);
      let record = await records().runningAgentComputer(accountId, threadId);
      if (record !== null && admission !== null) record.scheduledExecution = admission.holder;
      const driver = record?.phase === 'awake' ? await control(record) : undefined;
      if (record !== null && driver === null) {
        await forget(record);
        record = null;
      }
      if (record !== null && record.phase !== 'awake') {
        if (record.phase === 'sleeping') await sleep(record);
        else await stop(record);
        record = null;
      }
      if (record === null) {
        if (stopping) throw new HttpError(503, 'The Chat Service is stopping: wake the Agent Computer again in a moment');
        record = await startAgentComputer(accountId, threadId, { records, browser, files, seed, stop, deadline });
      }
      record.idleDeadline = deadline();
      await records().saveRunningAgentComputer(record);
      arm(record);
      return awakeState(record, driver ?? undefined);
    }, threadId));
    starting.set(key, done);
    try { return await done; }
    finally { if (starting.get(key) === done) starting.delete(key); }
  }

  async function use(accountId: string, sessionId: string): Promise<boolean> {
    const owned = (await records().runningAgentComputers(accountId)).find((record) => record.sessionId === sessionId && record.phase === 'awake');
    if (owned === undefined) return false;
    return records().withAgentComputerLease(accountId, async () => {
      const record = (await records().runningAgentComputers(accountId)).find((record) => record.sessionId === sessionId && record.phase === 'awake');
      if (record === undefined) return false;
      record.idleDeadline = deadline();
      await records().saveRunningAgentComputer(record);
      arm(record);
      return true;
    }, owned.threadId);
  }

  async function revoke(accountId: string): Promise<void> {
    const revokeSession = async (threadId: string): Promise<void> => {
      const key = keyOf(accountId, threadId);
      const pending = sleeping.get(key);
      let failure: unknown;
      await pending?.done.catch((error: unknown) => { failure = error; });
      try {
        await records().withAgentComputerLease(accountId, async () => {
          const record = await records().runningAgentComputer(accountId, threadId);
          if (record !== null) await stop(record);
        }, threadId);
      } catch (error) {
        if (failure !== undefined) throw new AggregateError([failure, error], `Agent Computer revocation failed: ${String(error)}`);
        throw error;
      } finally {
        sleeping.delete(key);
        failures.delete(key);
      }
      if (failure !== undefined && !pending?.observed) throw failure;
    };
    revoking.add(accountId);
    try {
      await records().withAgentComputerLease(accountId, async () => {
        const threads = new Set((await records().runningAgentComputers(accountId)).map((record) => record.threadId));
        for (const [key, sleep] of sleeping) {
          if (sleep.accountId === accountId) threads.add((JSON.parse(key) as [string, string])[1]);
        }
        const results = await Promise.allSettled([...threads].map(revokeSession));
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      });
      for (const key of warmups.keys()) if (key.startsWith(JSON.stringify([accountId]).slice(0, -1))) warmups.delete(key);
    } finally { revoking.delete(accountId); }
  }

  async function state(accountId: string, threadId: string): Promise<AgentComputerState> {
    await sleepFinished(accountId, threadId);
    let record = await records().runningAgentComputer(accountId, threadId);
    if (record?.phase === 'sleeping') {
      record = await records().withAgentComputerLease(accountId, () => records().runningAgentComputer(accountId, threadId), threadId);
      await raiseSleepFailure(accountId, threadId);
    }
    if (record?.phase === 'awake') {
      const driver = await control(record);
      if (driver !== null) return awakeState(record, driver);
      const sessionId = record.sessionId;
      await records().withAgentComputerLease(accountId, async () => {
        const current = await records().runningAgentComputer(accountId, threadId);
        if (current?.sessionId === sessionId) await forget(current);
      }, threadId);
      return state(accountId, threadId);
    }
    return {
      state: record?.phase === 'starting' ? 'starting' : 'asleep',
      screenshot: await records().agentComputerScreenshot(accountId, threadId),
    };
  }

  return {
    wake, use, revoke,
    async stopThread(accountId: string, threadId: string): Promise<void> {
      const key = keyOf(accountId, threadId);
      const pending = starting.get(key);
      const [settled] = await Promise.allSettled(pending === undefined ? [] : [pending]);
      if (settled?.status === 'rejected' && !(settled.reason instanceof ScheduledBrowserAdmissionError)) throw settled.reason;
      await records().withAgentComputerLease(accountId, async () => {
        const record = await records().runningAgentComputer(accountId, threadId);
        if (record !== null) await stop(record, true);
      }, threadId);
      warmups.delete(key);
    },
    warm(accountId: string, threadId: string): void {
      const key = keyOf(accountId, threadId);
      warmups.delete(key);
      const done = wake(accountId, threadId);
      warmups.set(key, done);
      done.then(() => {
        if (warmups.get(key) === done) warmups.delete(key);
      }, (error: unknown) => console.error("Agent Computer warm-up failed; the Session's next wake raises it", error));
    },
    state,
    sleepAll(): TaskStopSleep {
      stopping = true;
      stopSweep();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      const sleeps = [
        ...[...streamClaims.keys()].map(closeStreams),
        ...[...starting.values()].map((done) => done.then(() => undefined)),
        ...idleRuns.values(),
      ];
      return { sleeps, slept: Promise.all(sleeps).then(() => []) };
    },
    async erase(accountId: string): Promise<void> {
      await revoke(accountId);
      await records().withAgentComputerLease(accountId, async () => {
        await Promise.all((await records().runningAgentComputers(accountId)).map((record) => stop(record)));
        const { profileId } = await records().agentComputer(accountId);
        if (profileId !== null) await browser().deleteProfile(profileId);
        await records().deleteAgentComputer(accountId);
      });
    },
    async claimStream(accountId: string, sessionId: string, letGo: () => Promise<void>): Promise<(() => void) | null> {
      if (stopping) return null;
      const computer = (await records().runningAgentComputers(accountId)).find((record) => record.sessionId === sessionId && record.phase === 'awake');
      if (computer === undefined) return null;
      return records().withAgentComputerLease(accountId, async () => {
        const current = await records().runningAgentComputer(accountId, computer.threadId);
        if (stopping || current?.phase !== 'awake' || current.sessionId !== sessionId) return null;
        if (!streams.has(sessionId)) {
          const record = { accountId, threadId: computer.threadId, sessionId, holder: randomUUID(), expiresAt: Date.now() + streamLeaseMs };
          if (!await records().claimAgentComputerStream(record)) return null;
          const timer = setInterval(() => {
            const refreshing = record.expiresAt <= Date.now() ? closeStreams(sessionId) : refreshStream(record);
            refreshing.catch((error: unknown) => console.error('Agent Computer stream renewal failed', error));
          }, 1000).unref();
          streams.set(sessionId, { record, timer });
        }
        const claims = streamClaims.get(sessionId) ?? new Set();
        streamClaims.set(sessionId, claims.add(letGo));
        return () => {
          claims.delete(letGo);
          if (claims.size === 0 && streamClaims.get(sessionId) === claims) void closeStreams(sessionId).catch((error: unknown) => console.error('Agent Computer stream release failed', error));
        };
      }, computer.threadId);
    },
  };
}

export const agentComputerIdleSeconds = (env: NodeJS.ProcessEnv) =>
  Number(env.BOTCUBE_AGENT_COMPUTER_IDLE_SECONDS ?? DEFAULT_IDLE_SECONDS);
