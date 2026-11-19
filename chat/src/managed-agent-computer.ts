import { Hono, type Context } from 'hono';
import type { AccountStore } from './account-store.js';
import { agentComputerBrowserFromEnv, agentComputerIdleSeconds, agentComputers } from './agent-computer.js';
import { agentComputerCdp } from './agent-computer-cdp.js';
import { agentComputerStartedFromEnv } from './agent-computer-started.js';
import { agentComputerCdpUrls } from './agent-computer-token.js';
import type { AccountHistory } from './account-history.js';
import { HttpError } from './http-error.js';
import type { Requester } from './requester.js';
import type { AccountFiles } from './files.js';
import { ecsTaskDraining } from './scheduled-runs.js';

/**
 * The stock Chat Service's Agent Computer in its own AgentCore browser, AGENTCORE_AGENT_COMPUTER_BROWSER_ID (ADR 0077):
 * each Session's browser wakes from the account's browser profile with its Files mounted, as a bot's does. It
 * answers what `localAgentComputer` answers, so the stock Chat Service takes either.
 */
export function managedAgentComputer({ history, requester, env, store, files, profileOmitsCookieDomains, accountKey }: {
  history: Pick<AccountHistory, 'owns' | 'ownsMainChat'>;
  requester: (c: Context) => Promise<Requester>;
  env: NodeJS.ProcessEnv;
  store: () => AccountStore;
  files: () => AccountFiles;
  /** The bot settings' `agentComputer.profileOmitsCookieDomains`. */
  profileOmitsCookieDomains: readonly string[];
  /** The bot settings' `accountKey`. */
  accountKey: string;
}) {
  const browser = agentComputerBrowserFromEnv(env, { profileOmitsCookieDomains, accountKey });
  const computers = agentComputers({
    browser,
    records: store,
    started: agentComputerStartedFromEnv(env, async (accountId) => (await store().loadAccount(accountId))?.status !== 'registered'),
    files,
    idleSeconds: agentComputerIdleSeconds(env),
    draining: ecsTaskDraining(env.ECS_CONTAINER_METADATA_URI_V4),
  });
  const cdpUrls = agentComputerCdpUrls(
    new URL(env.BOTCUBE_AGENT_COMPUTER_CDP_URL?.trim() || `ws://127.0.0.1:${env.PORT || '8123'}/agent-computer/cdp`).href,
    env,
  );
  const authorized = async (owner: string, threadId: string) =>
    (await history.owns(owner, threadId)) || (await history.ownsMainChat(owner, threadId));
  const requireOwner = async (owner: string, threadId: string) => {
    if (!(await authorized(owner, threadId))) throw new HttpError(404, 'This account does not own the Session');
  };
  return {
    /** The `/agent-computer/cdp` route; the Chat Service's own routes serve the live view and Take-over. */
    routes: new Hono().get('/agent-computer/cdp', agentComputerCdp({ computers, browser, verify: cdpUrls.verify })),
    async state(owner: string, threadId: string) {
      await requireOwner(owner, threadId);
      return computers.state(owner, threadId);
    },
    async wake(owner: string, threadId: string) {
      await requireOwner(owner, threadId);
      return computers.wake(owner, threadId);
    },
    erase: computers.erase,
    stopThread: computers.stopThread,
    /** The Turn's `agentComputerCdpUrl`, tokened for the Session; the agent's connection wakes its computer. */
    async forwardedProps(owner: string, threadId: string) {
      await requireOwner(owner, threadId);
      return { agentComputerCdpUrl: await cdpUrls.issue(owner, threadId) };
    },
    /** A Turn starts its Session's computer without waiting for it, so the agent's first command joins it. */
    turnStarting({ owner }: Requester, threadId: string) {
      computers.warm(owner, threadId);
    },
    /** Readying a chat starts its computer without waiting for it; a failed start is the Session's next wake's. */
    async warmSession({ owner }: Requester, threadId: string) {
      await requireOwner(owner, threadId);
      computers.warm(owner, threadId);
    },
    async authorizeBrowserLiveView(sessionId: string, c: Context) {
      if (!(await computers.use((await requester(c)).owner, sessionId))) {
        throw new HttpError(403, "Not this account's Agent Computer browser");
      }
      return browser().browserId;
    },
    sleepAll: computers.sleepAll,
  };
}
