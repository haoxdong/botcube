import { Hono, type Context } from 'hono';
import { BedrockAgentCoreClient, GetResourceOauth2TokenCommand, GetWorkloadAccessTokenForUserIdCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { BotCubeConfig, BotSettings } from 'botcube-config';
import { openEgressProxy } from 'botcube-config/deployment';
import { loadBotSettings, validateBotDeployment } from 'botcube-config/load';
import { loadResolvedConfig, type ResolvedConfig } from 'botcube-config/resolved';
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
import type { AgentModel } from './models.js';
import type { TurnRouteSource } from './turn-preparation.js';
import type { ScheduledRunSource } from './scheduled-runs.js';
import { computerFilesRoutes } from './computer-files-routes.js';
import { allowedOrigins, chatTable } from './config.js';
import { credentialServiceRequest } from './credential-service-request.js';
import { signCredentialServiceInvocation, signTurnCredential } from './credential-service-token.js';
import { accountFilesFromEnv, filesConfigured } from './files.js';
import { filingUserId } from './filing-user-id.js';
import { localAgentComputer } from './local-agent-computer.js';
import { managedAgentComputer } from './managed-agent-computer.js';
import { oidcIdentity } from './oidc-sign-in.js';
import { isRecord } from './payload.js';
import { planModels } from './plan-models.js';
import { testUserConnectorRoutes } from './test-user-connector.js';
import { tokenIntrospectionRoutes } from './token-introspection.js';

async function postCredentialService(
  url: string, secret: string, accountId: string, sessionId: string, scope: string, step: string,
  read: 'status' | 'success-json' = 'status',
): Promise<unknown> {
  const token = signCredentialServiceInvocation(secret, accountId, sessionId, { scope });
  const { ok, status, body } = await credentialServiceRequest(url, { token, accountId, sessionId }, step, read, {
    method: 'POST', body: '{}',
  });
  if (!ok) throw new HttpError(503, `${step} failed with HTTP ${status}`);
  return body;
}

function connectorRevocation(
  config: BotCubeConfig['integrations']['connectorIdentity'], env: NodeJS.ProcessEnv, accountKey: string, store: AccountStore,
) {
  if (config === undefined) return undefined;
  const { workloadName, providers } = config;
  const identity = new BedrockAgentCoreClient({
    ...(env.AWS_REGION && { region: env.AWS_REGION }),
    ...(env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE && { endpoint: env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE }),
  });

  return async (accountId: string, name?: string): Promise<void> => {
    const targets = name === undefined ? providers : providers.filter(provider => provider.name === name);
    if (targets.length === 0) return;
    const account = await store.loadAccount(accountId);
    if (account === null) return;
    const userId = account.oidc?.subject ?? filingUserId(accountKey, accountId);
    const { workloadAccessToken } = await identity.send(new GetWorkloadAccessTokenForUserIdCommand({ workloadName, userId }),
      { abortSignal: AbortSignal.timeout(10_000) });
    if (!workloadAccessToken) throw new HttpError(503, 'AgentCore Identity did not return a workload token');

    const results = await Promise.allSettled(targets.map(async ({ providerName, scopes, revocationEndpoint }) => {
      const { accessToken, authorizationUrl } = await identity.send(new GetResourceOauth2TokenCommand({
        workloadIdentityToken: workloadAccessToken,
        resourceCredentialProviderName: providerName,
        scopes,
        oauth2Flow: 'USER_FEDERATION',
      }), { abortSignal: AbortSignal.timeout(10_000) });
      if (!accessToken) {
        if (authorizationUrl) return;
        throw new HttpError(503, 'AgentCore Identity did not return an access token or consent URL');
      }
      const response = await fetch(revocationEndpoint, {
        method: 'POST',
        body: new URLSearchParams({ token: accessToken }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new HttpError(503, `Connector revocation failed with HTTP ${response.status}`);
    }));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  };
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

function deployment(env: NodeJS.ProcessEnv, artifact?: ResolvedConfig) {
  const path = env.BOTCUBE_CONFIG;
  if (!path) throw new Error('BOTCUBE_CONFIG is not set: the stock Chat Service serves the BotCube Config it names');
  const resolved = artifact ?? loadResolvedConfig(path);
  const bot = loadBotSettings('/bot/bot.yaml');
  validateBotDeployment(resolved, bot, `Resolved BotCube Config ${path}`);
  return { ...resolved, bot };
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
  resolved?: ResolvedConfig | undefined;
  /** The page each local Agent Computer opens on; blank unless given. */
  startPage?: string;
  /** The local Agent Computer in place of the deploy's own, such as a test's that starts no browser. */
  agentComputer?: (computer: ReturnType<typeof localAgentComputer>) => ReturnType<typeof localAgentComputer>;
  /** Hooks a test or acceptance check replaces on BotCube's own Chat, or a function of that Chat answering them. */
  overrides?: StockOverrides | ((chat: StockChat) => StockOverrides);
  filesRoot?: string | undefined;
}

/** A bot model as Users pick it: its output ceiling is the Harness's alone. */
function withoutOutputCeiling({ maxTokens: _ceiling, ...model }: BotSettings['models'][number]): AgentModel {
  return model;
}

/** BotCube's own Chat Service, composed from the BotCube Config and the settings its Bot Image carries (ADR 0091). */
export function stockChatService(env: NodeJS.ProcessEnv, options: StockOptions = {}): (history: AccountHistory) => StockChat {
  const { config, bot, webOrigins } = deployment(env, options.resolved);
  const accountStore = options.accountStore ?? new AccountStore(chatTable(env), { key: bot.accountKey, product: bot.agentIdentity.name });
  const store = () => accountStore;
  const revokeLinkedAccounts = connectorRevocation(config.integrations.connectorIdentity, env, bot.accountKey, accountStore);
  const cookies = accountCookies(bot.accountKey);
  const identity = config.integrations.signIn.kind === 'oidc' ? oidcIdentity(config.integrations.signIn, env, { store, cookies, returnOrigins: allowedOrigins(webOrigins), proxy: config.integrations.proxy }) : null;
  const files = accountFilesFromEnv(env, store, config.existing?.files, options.filesRoot);
  const started = agentComputerStartedFromConfig(bot.productService?.agentComputerStartedPath, env, async (accountId) => (await accountStore.loadAccount(accountId))?.status !== 'registered');
  const credentialServiceUrl = env.BOTCUBE_CREDENTIAL_SERVICE_URL;
  // A product service that holds the invocation secret checks the Chat's sessions by Token Introspection.
  const invocationSecret = env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '';
  const credentialOrigin = credentialServiceUrl ? new URL(credentialServiceUrl).origin : undefined;
  const credentials = credentialOrigin
    // Revoke every credential the Credential Service holds for the account, at every provider.
    ? {
      async revoke(accountId: string) {
        await postCredentialService(`${credentialOrigin}/account/revoke`, invocationSecret, accountId,
          'account-deletion', 'credential_revocation', 'Credential Service account revoke');
      },
    }
    : null;
  const linkedAccounts = credentialOrigin
    ? async (accountId: string): Promise<string[]> => {
      const body = await postCredentialService(`${credentialOrigin}/account/linked-accounts`, invocationSecret, accountId,
        'account-session', 'linked_accounts', 'Credential Service Linked Accounts', 'success-json');
      const providers = isRecord(body) ? body.linkedAccounts : undefined;
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
    async copy(testUserId, sessionId) {
      await postCredentialService(`${(credentialServiceUrl ?? '').replace(/\/+$/, '')}/auth/test-user-copy`, invocationSecret, testUserId,
        sessionId, 'test_user_copy', 'Test User Connector copy');
    },
  });
  const plan = planModels({
    credentialServiceUrl,
    invocationSecret,
    ownerAccountId: planOwner,
    store,
  });
  return (history) => {
    const accounts = accountRoutes({ store, cookies, signIns: async () => [],
      ...(revokeLinkedAccounts && { revokeLinkedAccounts }),
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
      : (options.agentComputer ?? ((local) => local))(localAgentComputer({ history, requester, env, startPage: options.startPage, started, proxy: openEgressProxy(config) }));
    const lifecycle = accountLifecycle({ credentials, history, files: filesConfigured(env) ? files : null, computers: computer, store, ...(revokeLinkedAccounts && { revokeLinkedAccounts }) });
    const deletions = accountDeletions({
      store, deleteAccount: lifecycle.deleteAccount,
      // A waking Credential Service starts beside this one: the first sweep revokes only once it is healthy.
      ...(credentialServiceUrl ? { credentialsReady: () => serviceHealthy(credentialServiceUrl) } : {}),
    });
    let filesRecovery: Promise<void> | undefined;
    const chat: StockChat = {
      agentDocuments: agentDocumentTemplates({ ...bot.agentIdentity, soul: bot.soul }),
      models: [withoutOutputCeiling(bot.models[0]), ...bot.models.slice(1).map(withoutOutputCeiling)],
      extractedMemory: bot.extractedMemory.enabled,
      writtenMemory: bot.writtenMemory.enabled,
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
      routes: new Hono()
        .route('/', config.liveView.kind === 'none' ? refusingLiveView() : new Hono())
        .route('/', computer.routes)
        .route('/', computerFilesRoutes({ requester, history, computers: config.liveView.kind === 'none' ? withoutLiveView(computer) : computer, files: () => files(), workspace: env.BOTCUBE_WORKSPACE?.trim() || undefined, writtenMemory: bot.writtenMemory.enabled }))
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
          ? signTurnCredential(invocationSecret, requester.owner, input.threadId, model, await plan.planAccountId(requester.owner, model))
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

