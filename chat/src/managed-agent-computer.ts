import { Hono, type Context } from 'hono';
import type { AccountStore } from './account-store.js';
import { AGENT_COMPUTER_IDLE_SECONDS, agentComputerBrowserFromEnv, agentComputers } from './agent-computer.js';
import { agentComputerCdp } from './agent-computer-cdp.js';
import type { AgentComputerStarted } from './agent-computer-started.js';
import { agentComputerAccess } from './agent-computer-token.js';
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
export function managedAgentComputer({ history, requester, env, store, files, started, profileOmitsCookieDomains, accountKey }: {
  history: Pick<AccountHistory, 'owns' | 'ownsMainChat'>;
  requester: (c: Context) => Promise<Requester>;
  env: NodeJS.ProcessEnv;
  store: () => AccountStore;
  files: () => AccountFiles;
  /** Told of each browser started (`agent-computer-started.ts`); unset, nothing is. */
  started: AgentComputerStarted | undefined;
  /** The bot settings' `agentComputer.profileOmitsCookieDomains`. */
  profileOmitsCookieDomains: readonly string[];
  /** The bot settings' `accountKey`. */
  accountKey: string;
}) {
  const browser = agentComputerBrowserFromEnv(env, { profileOmitsCookieDomains, accountKey });
  const computers = agentComputers({
    browser,
    records: store,
    started,
    files,
    idleSeconds: AGENT_COMPUTER_IDLE_SECONDS,
    draining: ecsTaskDraining(env.ECS_CONTAINER_METADATA_URI_V4),
  });
  const { requireOwner, verify, forwardedProps } = agentComputerAccess(history, env);
  return {
    /** The `/agent-computer/cdp` route; the Chat Service's own routes serve the live view and Take-over. */
    routes: new Hono().get('/agent-computer/cdp', agentComputerCdp({ computers, browser, verify })),
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
    forwardedProps,
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
