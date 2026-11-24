import { Hono, type Context } from 'hono';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadBotCube } from 'botcube-config/load';
import { accountCookies } from './account-cookies.js';
import { accountDeletions, serviceHealthy } from './account-deletions.js';
import type { AccountHistory } from './account-history.js';
import { AccountStore } from './account-store.js';
import { accountLifecycle, accountRoutes } from './accounts.js';
import type { AgentComputerState } from './agent-computer.js';
import { agentComputerStartedFromConfig } from './agent-computer-started.js';
import { agentDocumentTemplates } from './agent-documents.js';
import { HttpError } from './http-error.js';
import type { Requester } from './requester.js';
import type { CredentialSource } from './credential-source.js';
import type { TaskStopSleep } from './task-stop.js';
import type { TurnSummary } from './session-metadata.js';
import type { AgentModel } from './models.js';
import type { FinishedTurn } from './turn-summaries.js';
import type { TurnRouteSource } from './turn-preparation.js';
import type { ScheduledRunSource } from './scheduled-runs.js';
import { computerFilesRoutes } from './computer-files-routes.js';
import { chatTable } from './config.js';
import { allowedOrigins } from './cors.js';
import { signCredentialServiceInvocation, signTurnCredential } from './credential-service-token.js';
import { accountFilesFromEnv, filesConfigured } from './files.js';
import { filingUserId } from './filing-user-id.js';
import { localAgentComputer } from './local-agent-computer.js';
import { managedAgentComputer } from './managed-agent-computer.js';
import { oidcIdentity } from './oidc-sign-in.js';
import { planModels } from './plan-models.js';
import { testUserConnectorRoutes } from './test-user-connector.js';
import { tokenIntrospectionRoutes } from './token-introspection.js';

const ACCOUNT_DELETION_SESSION = 'account-deletion';
const ACCOUNT_SESSION = 'account-session';
const CREDENTIAL_SERVICE_TIMEOUT_MS = 30_000;

/** POST to the Credential Service as the account, under an invocation of the given scope. */
async function credentialServiceCall(url: string, secret: string, accountId: string, sessionId: string, scope: string, failure: string): Promise<void> {
  await credentialServiceResponse(url, secret, accountId, sessionId, scope, failure);
}

async function credentialServiceResponse(url: string, secret: string, accountId: string, sessionId: string, scope: string, failure: string): Promise<Response> {
  const token = signCredentialServiceInvocation(secret, accountId, sessionId, { scope });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-botcube-account-id': accountId,
      'x-botcube-session-id': sessionId,
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(CREDENTIAL_SERVICE_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new HttpError(503, `Credential Service request failed: ${String(error)}`);
  });
  if (!response.ok) throw new HttpError(503, `${failure} failed with HTTP ${response.status}`);
  return response;
}

type ComputerStates = Parameters<typeof computerFilesRoutes>[0]['computers'];

/**
 * Under the BotCube Config's `liveView: none`, no client gets the screen: the live-view URL and its frames answer 404.
 * Mounted ahead of the computer's routes, and of the Chat Service's own AgentCore live-view URL, so it covers both.
 */
function refusingLiveView(): Hono {
  const routes = new Hono();
  for (const path of ['/browser-live-view-url', '/agent-computer/view']) {
    routes.get(path, (c) => c.json({ detail: 'This deployment shows no live view' }, 404));
  }
  return routes;
}

/** Under the BotCube Config's `liveView: none`, an awake computer tells the Computer tab to start no live view. */
function withoutLiveView(computers: ComputerStates): ComputerStates {
  const marked = (state: AgentComputerState): AgentComputerState => (state.state === 'awake' ? { ...state, liveView: 'none' } : state);
  return {
    state: async (owner, threadId) => marked(await computers.state(owner, threadId)),
    wake: async (owner, threadId) => marked(await computers.wake(owner, threadId)),
  };
}

function deployment(env: NodeJS.ProcessEnv) {
  const path = env.BOTCUBE_CONFIG;
  if (!path) throw new Error('BOTCUBE_CONFIG is not set: the stock Chat Service serves the BotCube Config it names');
  return loadBotCube(path);
}

/** The accounts of the bot its BotCube Config names, in BOTCUBE_CHAT_TABLE. */
export function stockAccountStore(env: NodeJS.ProcessEnv, documents?: Pick<DynamoDBDocumentClient, 'send'>) {
  const { bot } = deployment(env);
  return new AccountStore(chatTable(env), { key: bot.accountKey, product: bot.agentIdentity.name }, documents);
}

/** BotCube's own Chat, composed from the BotCube Config and its bot settings: what the Chat Service's routes and scheduled runs call. */
export interface StockChat extends TurnRouteSource, ScheduledRunSource {
  /** The bot's own routes (auth and account), mounted at the root. */
  readonly routes: Hono;
  summarizePlanTurn(owner: string, sessionId: string, model: AgentModel, turn: FinishedTurn): Promise<TurnSummary>;
  /**
   * Throw an HttpError unless the request may watch or take over this browser Session;
   * answers the AgentCore browser it runs in when that is not AGENTCORE_BROWSER_ID.
   */
  authorizeBrowserLiveView(sessionId: string, c: Context): Promise<string | void>;
  /** Discover durable authorized account deletions and enqueue their recovery without waiting for Session settlement. */
  recoverAccountDeletions?(): Promise<void>;
  /** The task is stopping: put every awake Agent Computer to sleep before it exits. */
  sleepAgentComputers?(): TaskStopSleep;
  /** The bot's Credential Sources, such as sign-in's client secret: each is read as the Chat Service starts, which an unreadable one stops. */
  readonly startupCredentials?: readonly CredentialSource[];
}

export type StockOverrides = Omit<Partial<StockChat>, 'signInNeeded'> & {
  /** `undefined`: a bot whose runs name no sign-in they may need. */
  signInNeeded?: StockChat['signInNeeded'] | undefined;
};

export interface StockOptions {
  accountStore?: AccountStore;
  /** The page each local Agent Computer opens on; blank unless given. */
  startPage?: string;
  /** The local Agent Computer in place of the deploy's own, such as a test's that starts no browser. */
  agentComputer?: (computer: ReturnType<typeof localAgentComputer>) => ReturnType<typeof localAgentComputer>;
  /** Hooks a test or acceptance check replaces on BotCube's own Chat, or a function of that Chat answering them. */
  overrides?: StockOverrides | ((chat: StockChat) => StockOverrides);
  filesRoot?: string | undefined;
}

/** BotCube's own Chat Service, composed from the BotCube Config and the settings its Bot Image carries (ADR 0091). */
export function stockChatService(env: NodeJS.ProcessEnv, options: StockOptions = {}): (history: AccountHistory) => StockChat {
  const { config, bot } = deployment(env);
  if (bot.userTokenInShell === true && env.BOTCUBE_TURN_IDENTITY_KEYS === undefined) {
    throw new Error('userTokenInShell: the user token is signed with the Turn identity keys; set BOTCUBE_TURN_IDENTITY_KEYS and BOTCUBE_PUBLIC_ORIGIN');
  }
  const accountStore = options.accountStore ?? stockAccountStore(env);
  const store = () => accountStore;
  const cookies = accountCookies(bot.accountKey);
  const identity = config.integrations.signIn.kind === 'oidc' ? oidcIdentity(config.integrations.signIn, env, { store, cookies, returnOrigins: allowedOrigins(config) }) : null;
  const files = accountFilesFromEnv(env, store, config.existing.files, options.filesRoot);
  const started = agentComputerStartedFromConfig(bot.productService?.agentComputerStartedPath, env, async (accountId) => (await accountStore.loadAccount(accountId))?.status !== 'registered');
  const credentialServiceUrl = env.BOTCUBE_CREDENTIAL_SERVICE_URL;
  // A product service that holds the invocation secret checks the Chat's sessions by Token Introspection.
  const invocationSecret = env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET;
  const credentials = credentialServiceUrl
    // Revoke every credential the Credential Service holds for the account, at every provider.
    ? { revoke: (accountId: string) => credentialServiceCall(`${new URL(credentialServiceUrl).origin}/account/revoke`, invocationSecret ?? '', accountId,
      ACCOUNT_DELETION_SESSION, 'credential_revocation', 'Credential Service account revoke') }
    : null;
  const linkedAccounts = credentialServiceUrl
    ? async (accountId: string): Promise<string[]> => {
      const response = await credentialServiceResponse(`${new URL(credentialServiceUrl).origin}/account/linked-accounts`, invocationSecret ?? '', accountId,
        ACCOUNT_SESSION, 'linked_accounts', 'Credential Service Linked Accounts');
      const { linkedAccounts: providers } = await response.json() as { linkedAccounts?: unknown };
      if (!Array.isArray(providers) || !providers.every((provider) => typeof provider === 'string')) {
        throw new HttpError(503, 'Credential Service Linked Accounts answered an invalid body');
      }
      return providers;
    }
    : null;
  const planOwner = config.planUsage?.ownerAccountId;
  const testUserConnector = testUserConnectorRoutes({
    store,
    invocationSecret: credentialServiceUrl && invocationSecret ? invocationSecret : null,
    ownerAccountId: planOwner,
    copy: (testUserId, sessionId) => credentialServiceCall(`${(credentialServiceUrl ?? '').replace(/\/+$/, '')}/auth/test-user-copy`, invocationSecret ?? '', testUserId,
      sessionId, 'test_user_copy', 'Test User Connector copy'),
  });
  const plan = planModels({
    credentialServiceUrl: env.BOTCUBE_CREDENTIAL_SERVICE_URL,
    invocationSecret: env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '',
    ownerAccountId: planOwner,
    store,
  });
  return (history) => {
    const accounts = accountRoutes({ store, cookies, signIns: async () => [],
      session: async (account) => ({
        ...(identity === null ? {} : { signIn: 'oidc' }),
        ...(linkedAccounts === null ? {} : { linkedAccounts: await linkedAccounts(account.accountId) }),
      }),
      deleteTestUser: (accountId) => lifecycle.deleteAccount(accountId),
    });
    const requester = async (c: Context): Promise<Requester> => {
      const { owner, account } = await accounts.owner(c);
      return { owner, anonymous: account?.status === 'anonymous' };
    };
    // The managed AgentCore browser when the deploy names one; a local Chromium only when it names none.
    const computer = env.AGENTCORE_AGENT_COMPUTER_BROWSER_ID?.trim()
      ? managedAgentComputer({ history, requester, env, store, files, started, profileOmitsCookieDomains: bot.agentComputer.profileOmitsCookieDomains, accountKey: bot.accountKey })
      : (options.agentComputer ?? ((local) => local))(localAgentComputer({ history, requester, env, startPage: options.startPage, started }));
    const lifecycle = accountLifecycle({ credentials, history, files: filesConfigured(env) ? files : null, computers: computer, store });
    const deletions = accountDeletions({
      store, deleteAccount: lifecycle.deleteAccount,
      // A waking Credential Service starts beside this one: the first sweep revokes only once it is healthy.
      ...(credentialServiceUrl ? { credentialsReady: () => serviceHealthy(credentialServiceUrl) } : {}),
    });
    let filesRecovery: Promise<void> | undefined;
    const chat: StockChat = {
      agentDocuments: agentDocumentTemplates({ ...bot.agentIdentity, soul: bot.soul }),
      models: bot.models,
      memory: bot.memory,
      async recoverAccountDeletions() {
        if (filesConfigured(env)) {
          filesRecovery ??= Promise.resolve().then(() => files().recoverCleanup()).catch((error: unknown) => {
            console.error('Files cleanup failed; retired-account cleanup remains pending', error);
          }).finally(() => { filesRecovery = undefined; });
        }
        await deletions.recover();
      },
      startupCredentials: identity?.credentials ?? [],
      accountModels: ({ owner }, options) => plan.accountModels(owner, options),
      summarizePlanTurn: plan.summarizeTurn,
      routes: new Hono()
        .route('/', config.liveView.kind === 'none' ? refusingLiveView() : new Hono())
        .route('/', computer.routes)
        .route('/', computerFilesRoutes({ requester, history, computers: config.liveView.kind === 'none' ? withoutLiveView(computer) : computer, files: () => files(), workspace: env.BOTCUBE_WORKSPACE?.trim() || undefined }))
        .route('/account/plan-usage/openai', plan.routes)
        .route('/', accounts.routes)
        .route('/', testUserConnector)
        .route('/', identity?.routes ?? new Hono())
        .route('/', identity?.deletion ?? new Hono())
        .route('/', invocationSecret ? tokenIntrospectionRoutes({ sessions: store, invocationSecret }) : new Hono()),
      requester,
      // Candidate prompts tune the bot on the plan owner's own Turns.
      tunesPrompts: ({ owner }) => planOwner !== undefined && owner === planOwner,
      filingUserId: (owner) => filingUserId(bot.accountKey, owner),
      async scheduledRequester(owner) {
        const account = await accountStore.loadAccount(owner);
        if (account === null) throw new Error(`Scheduled run for a missing ${bot.agentIdentity.name} account ${owner}`);
        if (account.deletionOperationId !== undefined) throw new HttpError(409, 'Account deletion is pending');
        return { owner, anonymous: account.status === 'anonymous' };
      },
      invocationPayload: async (input, requester, model) => ({
        ...input,
        credentialServiceInvocationToken: credentialServiceUrl
          ? signTurnCredential(invocationSecret ?? '', requester.owner, input.threadId, model, await plan.planAccountId(requester.owner, model))
          : undefined,
        forwardedProps: {
          ...input.forwardedProps,
          ...(credentialServiceUrl ? { credentialServiceUrl } : {}),
          ...(await computer.forwardedProps(requester.owner, input.threadId)),
          // The account's Files, mounted as the agent's working directory.
          ...(filesConfigured(env) ? { files: await files().mountBinding(requester.owner) } : {}),
        },
      }),
      credentialProps: ['agentComputerCdpUrl'],
      authorizeBrowserLiveView: computer.authorizeBrowserLiveView,
      warmSession: computer.warmSession,
      turnStarting: computer.turnStarting,
      ...('browserLiveView' in computer ? { browserLiveView: computer.browserLiveView } : {}),
      sleepAgentComputers: computer.sleepAll,
      stopSessionComputer: computer.stopThread,
    };
    const { signInNeeded, ...overrides } = typeof options.overrides === 'function' ? options.overrides(chat) : options.overrides ?? {};
    return { ...chat, ...overrides, ...(signInNeeded === undefined ? {} : { signInNeeded }) };
  };
}

