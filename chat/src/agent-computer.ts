import { computerTrace, traceSelector, traceFailure } from './agent-computer-trace.js';
import { createHash, randomUUID } from 'node:crypto';
import { agentCoreEndpointFromEnv } from './upstream.js';
import { awsFetch } from './aws.js';
import { HttpError } from './cartridge.js';
import { BrowserSessions } from './browser-sessions.js';
import type { Cdp } from './cdp.js';
import type { AgentComputerRecord } from './account-resources.js';
import type { AccountFiles, FilesMount } from './files.js';

/** An Agent Computer browser nobody touches for this long sleeps. */
const DEFAULT_IDLE_SECONDS = 600;
/** AgentCore's ceiling: a browser the Chat Service lost track of stops on its own by then. */
const SESSION_TIMEOUT_SECONDS = 8 * 60 * 60;
/** The name every Agent Computer browser Session carries. */
const SESSION_NAME = 'botcube-agent-computer';
/**
 * The display the live view draws (its 1280x720 default): a narrow pane shrinks page text 1.5x less than at 1920x1080,
 * and AgentCore's own default, 1456x819, would leave the rest black.
 */
const VIEWPORT = { width: 1280, height: 720 };

/** The AgentCore operations an Agent Computer browser needs. */
export interface AgentComputerBrowser {
  /** The AgentCore browser its Sessions run in. */
  readonly browserId: string;
  /**
   * Start a browser Session, from the browser profile when there is one, with
   * the account's Files mounted as Chrome's download directory; answers its ID.
   */
  start(profileId: string | null, files: FilesMount): Promise<string>;
  /** The page as a JPEG data URL. */
  screenshot(sessionId: string): Promise<string>;
  /** Run the Cartridge's trusted cleanup before a browser profile is saved. */
  beforeProfileSave(sessionId: string): Promise<void>;
  /** Create the account's browser profile; answers its ID. */
  createProfile(accountId: string): Promise<string>;
  /** Save the browser's cookies and local storage into the profile; the last save wins. */
  saveProfile(profileId: string, sessionId: string): Promise<void>;
  /** Delete the account's browser profile; one already gone counts as deleted, so a retried deletion goes on. */
  deleteProfile(profileId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  /** The browser's CDP automation stream, with the headers that open it. */
  automationStream(sessionId: string): Promise<{ endpoint: string; headers: Record<string, string> }>;
  /** Who drives the browser: the user once they have taken it over, else the agent. */
  control(sessionId: string): Promise<BrowserControl>;
  /** End the user's Take-over: the agent drives the browser again. */
  handBack(sessionId: string): Promise<void>;
}

type BrowserControl = 'user' | 'agent';

/** The sleep of every browser at task stop: each step on its own in `sleeps`, and `slept` over them all. */
export interface TaskStopSleep {
  /** The browser Sessions put to sleep, or the first failure (ADR 0030). */
  slept: Promise<readonly string[]>;
  /** Every sleep and stop at task stop, each settling on its own. */
  sleeps: readonly Promise<void>[];
}

/** Where an account's Agent Computer keeps its browser profile, and each Session its last screenshot. */
export interface AgentComputerRecords {
  agentComputer(accountId: string): Promise<AgentComputerRecord>;
  saveAgentComputer(accountId: string, record: AgentComputerRecord): Promise<void>;
  agentComputerScreenshot(accountId: string, threadId: string): Promise<string | null>;
  saveAgentComputerScreenshot(accountId: string, threadId: string, screenshot: string): Promise<void>;
  /** The account's Agent Computer record and every Session's screenshot. */
  deleteAgentComputer(accountId: string): Promise<void>;
}

/** The Session's last screenshot comes with either state: it stands in until the live view shows the browser. */
export type AgentComputerState =
  | { state: 'awake'; browserSessionId: string; control: BrowserControl; screenshot: string | null }
  | { state: 'starting' | 'asleep'; screenshot: string | null };

/** A wake's answer: the browser is awake once it returns. */
type AwakeComputer = Extract<AgentComputerState, { state: 'awake' }>;

/** What a browser Session id still being started reads as, raced against it. */
const STARTING = Symbol('starting');

/** A Session's running browser. */
interface Awake {
  accountId: string;
  threadId: string;
  key: string;
  sessionId: Promise<string>;
  timer: NodeJS.Timeout | undefined;
}

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
        filesystemConfigurations: [{ s3FilesConfiguration: files }],
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
    stop: async (sessionId) => void (await sessions.stop(sessionId)),
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
 * Running browsers live in this Chat Service task's memory.
 */
export function agentComputers({
  browser,
  records,
  seed,
  files,
  idleSeconds,
}: {
  browser: () => AgentComputerBrowser;
  records: () => AgentComputerRecords;
  /** Seed the account's Session Credential into a browser it just started (ADR 0075 decision 5). */
  seed: (accountId: string, threadId: string, browserSessionId: string) => Promise<void>;
  files: () => AccountFiles;
  idleSeconds: number;
}) {
  const awake = new Map<string, Awake>();
  /**
   * Each Session's last sleep, until its next wake or state read: that caller fails with a sleep that
   * failed, even one the idle timer ran alone, unless its browser could not be stopped and is awake again.
   * A later wake starts afresh, or finds the browser that could not be stopped.
   */
  const sleeping = new Map<string, { accountId: string; done: Promise<void>; ended: boolean }>();
  async function sleepFinished(key: string): Promise<void> {
    const sleep = sleeping.get(key);
    if (sleep === undefined) return;
    try {
      await sleep.done;
    } catch (error) {
      if (!awake.has(key)) throw error;
    } finally {
      if (sleeping.get(key) === sleep) sleeping.delete(key);
    }
  }
  /**
   * Each Session's warm-up until its next wake, which joins it and raises one that failed (ADR 0077 decision 1,
   * ADR 0030); the wake after that, or another warm-up, starts afresh.
   */
  const warmups = new Map<string, { accountId: string; done: Promise<unknown> }>();
  async function warmupFinished(key: string): Promise<void> {
    const warmup = warmups.get(key);
    if (warmup === undefined) return;
    warmups.delete(key);
    await warmup.done;
  }
  const owners = new Map<string, Awake>();
  /** How each agent channel lets go of a browser Session's automation stream, which takes one client at a time. */
  const streamClaims = new Map<string, Set<() => Promise<void>>>();
  const keyOf = (accountId: string, threadId: string) => JSON.stringify([accountId, threadId]);
  /** A browser whose Sign-in failed and whose stop failed: retry cleanup before another wake or account deletion. */
  const failedStarts = new Map<string, { accountId: string; sessionId: string }>();

  let stopping = false;

  /** A browser's Session; none for one that failed to start, which answered its wake with the failure. */
  const startedSession = (running: Awake) => running.sessionId.catch(() => null);

  async function stopFailedStart(key: string): Promise<void> {
    const failed = failedStarts.get(key);
    if (failed === undefined) return;
    await browser().stop(failed.sessionId);
    if (failedStarts.get(key) === failed) failedStarts.delete(key);
  }

  function arm(running: Awake): void {
    clearTimeout(running.timer);
    running.timer = setTimeout(() => {
      idle(running).catch((error: unknown) => console.error('Agent Computer sleep failed', error));
    }, idleSeconds * 1000);
    // Stryker disable next-line all: unref only lets the process exit while a timer waits
    running.timer.unref();
  }

  /**
   * Sleep a browser nobody used for the idle period, unless its user has taken it over: their
   * input reaches it through the live view, never `use`, so it stays awake until they hand it back.
   */
  async function idle(running: Awake): Promise<void> {
    const { timer } = running;
    // A use, a wake or a revocation while control was read decides instead.
    const superseded = () => running.timer !== timer || awake.get(running.key) !== running;
    let control: BrowserControl;
    try {
      control = await browser().control(await running.sessionId);
    } catch (error) {
      // Look again after another idle period.
      if (!superseded()) arm(running);
      throw error;
    }
    if (superseded()) return;
    if (control === 'user') return arm(running);
    await retire(running, sleep);
  }

  /** Take a browser out of the awake ones and end it; the Session wakes or reports state only once that is done. */
  function retire(running: Awake, end: (running: Awake) => Promise<void>): Promise<void> {
    clearTimeout(running.timer);
    awake.delete(running.key);
    computerTrace(running.threadId)('lifecycle.retire');
    const done = end(running);
    const sleep = { accountId: running.accountId, done, ended: false };
    const over = () => void (sleep.ended = true);
    done.then(over, over);
    sleeping.set(running.key, sleep);
    return done;
  }

  /** Put a browser to sleep, first handing it back from any Take-over when `handBack` is set. */
  async function sleep(running: Awake, { handBack = false } = {}): Promise<void> {
    const sessionId = await running.sessionId;
    owners.delete(sessionId);
    const client = browser();
    try {
      // The agent's channel lets go of the automation stream first, or AgentCore refuses the screenshot's.
      await Promise.all([...(streamClaims.get(sessionId) ?? [])].map((letGo) => letGo()));
      // A Take-over turns that stream off, and the screenshot and beforeProfileSave need it; handing back a
      // browser the agent already drives changes nothing.
      if (handBack) await client.handBack(sessionId);
      const screenshot = await client.screenshot(sessionId);
      await client.beforeProfileSave(sessionId);
      await records().saveAgentComputerScreenshot(running.accountId, running.threadId, screenshot);
      const profileId =
        (await records().agentComputer(running.accountId)).profileId ?? (await client.createProfile(running.accountId));
      await records().saveAgentComputer(running.accountId, { profileId });
      await client.saveProfile(profileId, sessionId);
    } finally {
      await stop(running, sessionId);
    }
  }

  /** Stop a retired browser; one that cannot be stopped stays awake, so the next idle period or revocation tries again. */
  async function stop(running: Awake, sessionId: string): Promise<void> {
    owners.delete(sessionId);
    const trace = computerTrace(running.threadId);
    trace('lifecycle.stop-start', { browser: traceSelector(sessionId) });
    try {
      await browser().stop(sessionId);
      trace('lifecycle.stop-done');
      // Stryker disable next-line all: only frees the claims of a browser that has stopped
      streamClaims.delete(sessionId);
    } catch (error) {
      owners.set(sessionId, running);
      awake.set(running.key, running);
      arm(running);
      throw error;
    }
  }

  /** An awake browser, and who drives it: its browser Session knows, so a reloaded page still shows a Take-over. */
  const awakeState = async ({ accountId, threadId }: Awake, browserSessionId: string): Promise<AwakeComputer> => ({
    state: 'awake',
    browserSessionId,
    control: await browser().control(browserSessionId),
    screenshot: await records().agentComputerScreenshot(accountId, threadId),
  });

  async function start(accountId: string, threadId: string): Promise<string> {
    const trace = computerTrace(threadId);
    trace('lifecycle.start');
    const { profileId } = await records().agentComputer(accountId);
    const client = browser();
    const sessionId = await client.start(profileId, await files().mount(accountId));
    trace('lifecycle.browser-started', { browser: traceSelector(sessionId) });
    try {
      trace('lifecycle.seed-start');
      await seed(accountId, threadId, sessionId);
      trace('lifecycle.seed-done');
    } catch (error) {
      trace('lifecycle.seed-error', traceFailure(error));
      // A browser that cannot be signed in is not left running.
      try {
        await client.stop(sessionId);
      } catch (stopError) {
        failedStarts.set(keyOf(accountId, threadId), { accountId, sessionId });
        throw new AggregateError([error, stopError], error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    return sessionId;
  }

  /**
   * Stop every awake browser of the account without saving its profile: removing its Sign-in
   * revokes the Session Credentials they hold (ADR 0076).
   */
  async function revokeAwake(accountId: string): Promise<void> {
    // A warm-up's browser is among the awake ones below; its failure, already logged, has no wake left to raise it.
    for (const [key, warmup] of warmups) if (warmup.accountId === accountId) warmups.delete(key);
    const running = [...awake.values()].filter((computer) => computer.accountId === accountId);
    await Promise.all(
      running.map((computer) =>
        retire(computer, async () => {
          const sessionId = await startedSession(computer);
          if (sessionId !== null) await stop(computer, sessionId);
        }),
      ),
    );
    // A pending start above may have failed its Sign-in and its first cleanup while revocation waited.
    await Promise.all([...failedStarts].filter(([, failed]) => failed.accountId === accountId).map(([key]) => stopFailedStart(key)));
  }

  /** The Session's browser, started from the account's profile unless it is already awake. */
  async function wake(accountId: string, threadId: string): Promise<AwakeComputer> {
    const trace = computerTrace(threadId);
    trace('lifecycle.wake');
    const key = keyOf(accountId, threadId);
    try { await warmupFinished(key); } catch (error) { trace('lifecycle.warm-error', traceFailure(error)); throw error; }
    await sleepFinished(key);
    await stopFailedStart(key);
    let running = awake.get(key);
    trace('lifecycle.browser-lookup', { reused: running !== undefined });
    if (running === undefined) {
      if (stopping) throw new HttpError(503, 'The Chat Service is stopping: wake the Agent Computer again in a moment');
      const started: Awake = { accountId, threadId, key, sessionId: start(accountId, threadId), timer: undefined };
      running = started;
      awake.set(key, started);
      try {
        owners.set(await started.sessionId, started);
      } catch (error) {
        awake.delete(key);
        throw error;
      }
    }
    arm(running);
    return awakeState(running, await running.sessionId);
  }

  async function revoke(accountId: string): Promise<void> {
    await revokeAwake(accountId);
    const sleeps = [...sleeping].filter(([, sleep]) => sleep.accountId === accountId);
    await Promise.all(sleeps.map(([key, sleep]) => sleep.done.then(() => undefined, async (error: unknown) => {
      try {
        await revokeAwake(accountId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Agent Computer revocation failed: ${String(cleanupError)}`);
      } finally {
        if (sleeping.get(key) === sleep) sleeping.delete(key);
      }
      throw error;
    })));
    await revokeAwake(accountId);
  }

  return {
    wake,

    /** Start the Session's browser without waiting for it: a failed start is logged, and the Session's next wake raises it. */
    warm(accountId: string, threadId: string): void {
      const key = keyOf(accountId, threadId);
      // An earlier warm-up's failure was logged; this one starts afresh.
      warmups.delete(key);
      computerTrace(threadId)('lifecycle.warm');
      const done = wake(accountId, threadId);
      const warmup = { accountId, done };
      warmups.set(key, warmup);
      done.then(
        () => {
          if (warmups.get(key) === warmup) warmups.delete(key);
        },
        (error: unknown) => console.error("Agent Computer warm-up failed; the Session's next wake raises it", error),
      );
    },

    /** Whether the Session's browser is awake; starting or asleep shows the Session's last screenshot. */
    async state(accountId: string, threadId: string): Promise<AgentComputerState> {
      const key = keyOf(accountId, threadId);
      await sleepFinished(key);
      const screenshot = () => records().agentComputerScreenshot(accountId, threadId);
      const running = awake.get(key);
      if (running === undefined) return { state: 'asleep', screenshot: await screenshot() };
      // A browser still starting answers at once, so the Computer tab shows its last screenshot meanwhile (ADR 0077).
      const sessionId = await Promise.race<string | typeof STARTING>([running.sessionId, STARTING]);
      if (sessionId === STARTING) return { state: 'starting', screenshot: await screenshot() };
      return awakeState(running, sessionId);
    },

    revoke,

    /**
     * The task is stopping: every awake browser sleeps, all at once, so its screenshot and profile are
     * saved and none runs on to AgentCore's session timeout; one the user has taken over is handed back first. One
     * whose save fails is still stopped. `slept` fails with the first that did not sleep; the others go on sleeping.
     */
    sleepAll(): TaskStopSleep {
      stopping = true;
      const slept: string[] = [];
      // A browser whose sleep could not stop it is back awake, and is stopped outright: its save was already tried.
      const stopIfAwake = async (key: string) => {
        const running = awake.get(key);
        if (running !== undefined) await retire(running, async () => stop(running, await running.sessionId));
      };
      const sleeps: Promise<void>[] = [
        // A sleep still running answers here, its lost save included. One that ended before the task stopped has
        // already been answered.
        ...[...sleeping.values()].filter(({ ended }) => !ended).map(({ done }) => done),
        // Retiring every awake browser at once cancels its idle timer, so no idle sleep starts behind these.
        ...[...awake.values()].map((running) =>
          retire(running, async () => {
            const sessionId = await startedSession(running);
            // A start still pending may fail its Sign-in and its first cleanup meanwhile.
            if (sessionId === null) return stopFailedStart(running.key);
            await sleep(running, { handBack: true });
            slept.push(sessionId);
          }),
        ),
        ...[...failedStarts.keys()].map((key) => stopFailedStart(key)),
      ];
      const keys = [...new Set([...sleeping.keys(), ...awake.keys()])];
      const all = [...sleeps, ...keys.map((key) => Promise.allSettled(sleeps).then(() => stopIfAwake(key)))];
      return { slept: Promise.all(all).then(() => slept), sleeps: all };
    },

    /**
     * Account deletion (ADR 0037 decision 5): stop the account's browsers, then delete its browser
     * profile, which holds every other site's cookies, and its records, screenshots included.
     */
    async erase(accountId: string): Promise<void> {
      await revoke(accountId);
      for (const [key, sleep] of sleeping) {
        if (sleep.accountId === accountId) sleeping.delete(key);
      }
      const { profileId } = await records().agentComputer(accountId);
      if (profileId !== null) await browser().deleteProfile(profileId);
      await records().deleteAgentComputer(accountId);
    },

    /** Whether the account's Agent Computer runs this browser Session; using it keeps it awake. */
    use(accountId: string, sessionId: string): boolean {
      const running = owners.get(sessionId);
      if (running?.accountId !== accountId) return false;
      arm(running);
      return true;
    },

    /**
     * Claim the browser Session's automation stream for an agent channel, which `letGo` closes; none once the
     * browser is no longer the account's, as while it goes to sleep. Answers how to give the claim back.
     */
    claimStream(accountId: string, sessionId: string, letGo: () => Promise<void>): (() => void) | null {
      const owner = owners.get(sessionId);
      if (owner?.accountId !== accountId) return null;
      const trace = computerTrace(owner.threadId);
      const claims = streamClaims.get(sessionId) ?? new Set();
      trace('lifecycle.claim', { browser: traceSelector(sessionId), priorClaims: claims.size });
      streamClaims.set(sessionId, claims.add(letGo));
      return () => { trace('lifecycle.release', { browser: traceSelector(sessionId), claims: claims.size }); claims.delete(letGo); };
    },
  };
}

export const agentComputerIdleSeconds = (env: NodeJS.ProcessEnv) =>
  Number(env.BOTCUBE_AGENT_COMPUTER_IDLE_SECONDS ?? DEFAULT_IDLE_SECONDS);
