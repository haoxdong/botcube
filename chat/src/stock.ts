import { Hono, type Context } from 'hono';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadDeployment } from 'botcube-deployment-config/load';
import { accountCookies } from './account-cookies.js';
import { accountDeletions } from './account-deletions.js';
import { AccountStore } from './account-store.js';
import { accountLifecycle, accountRoutes } from './accounts.js';
import { agentDocumentTemplates } from './agent-documents.js';
import { HttpError, type CartridgeFactory, type Requester } from './cartridge.js';
import { computerFilesRoutes } from './computer-files-routes.js';
import { chatTable } from './config.js';
import { signCredentialServiceInvocation, turnCredentialBinding } from './credential-service-token.js';
import { accountFilesFromEnv, filesConfigured } from './files.js';
import { localAgentComputer } from './local-agent-computer.js';
import { managedAgentComputer } from './managed-agent-computer.js';
import { oidcIdentity } from './oidc-sign-in.js';
import { planModels } from './plan-models.js';
import { serveChatService } from './server.js';
import { tokenIntrospectionRoutes } from './token-introspection.js';

const ACCOUNT_DELETION_SESSION = 'account-deletion';
const CREDENTIAL_SERVICE_TIMEOUT_MS = 30_000;

/** Revoke every credential the Credential Service holds for the account, at every provider. */
async function revokeAccountCredentials(url: string, secret: string, accountId: string): Promise<void> {
  const token = signCredentialServiceInvocation(secret, accountId, ACCOUNT_DELETION_SESSION, { scope: 'credential_revocation' });
  const response = await fetch(`${new URL(url).origin}/account/revoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-botcube-account-id': accountId,
      'x-botcube-session-id': ACCOUNT_DELETION_SESSION,
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(CREDENTIAL_SERVICE_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new HttpError(503, `Credential Service request failed: ${String(error)}`);
  });
  if (!response.ok) throw new HttpError(503, `Credential Service account revoke failed with HTTP ${response.status}`);
}

function deployment(env: NodeJS.ProcessEnv) {
  const path = env.BOTCUBE_DEPLOYMENT_CONFIG;
  if (!path) throw new Error('BOTCUBE_DEPLOYMENT_CONFIG is not set: the stock Chat Service serves the Deployment Config it names');
  return loadDeployment(path);
}

/** The accounts of the bot its Deployment Config names, in BOTCUBE_CHAT_TABLE. */
export function stockAccountStore(env: NodeJS.ProcessEnv, documents?: Pick<DynamoDBDocumentClient, 'send'>) {
  const { bot } = deployment(env);
  return new AccountStore(chatTable(env), { key: bot.accountKey, product: bot.agentIdentity.name }, documents);
}

export interface StockOptions {
  accountStore?: AccountStore;
  /** The page each local Agent Computer opens on; blank unless given. */
  startPage?: string;
}

/** BotCube's own Chat Service, composed from the Deployment Config and the bot settings it names (ADR 0091). */
export function stockChatService(env: NodeJS.ProcessEnv, options: StockOptions = {}): CartridgeFactory {
  const { config, bot } = deployment(env);
  if (bot.userTokenInShell === true && env.BOTCUBE_TURN_IDENTITY_KEYS === undefined) {
    throw new Error('userTokenInShell: the user token is signed with the Turn identity keys; set BOTCUBE_TURN_IDENTITY_KEYS and BOTCUBE_PUBLIC_ORIGIN');
  }
  const accountStore = options.accountStore ?? stockAccountStore(env);
  const store = () => accountStore;
  const cookies = accountCookies(bot.accountKey);
  const identity = config.identity.kind === 'oidc' ? oidcIdentity(config.identity, env, { store, cookies }) : null;
  const files = accountFilesFromEnv(env, store);
  const credentialServiceUrl = env.BOTCUBE_CREDENTIAL_SERVICE_URL;
  // A product service that holds the invocation secret checks the Chat's sessions by Token Introspection.
  const invocationSecret = env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET;
  const credentials = credentialServiceUrl
    ? { revoke: (accountId: string) => revokeAccountCredentials(credentialServiceUrl, env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '', accountId) }
    : null;
  const plan = planModels({
    credentialServiceUrl: env.BOTCUBE_CREDENTIAL_SERVICE_URL,
    invocationSecret: env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '',
    ownerAccountId: env.BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID?.trim() || undefined,
    store,
  });
  return (history) => {
    const accounts = accountRoutes({ store, cookies, signIns: async () => [],
      ...(identity === null ? {} : { session: () => ({ signIn: 'oidc' }) }),
      deleteTestUser: (accountId) => lifecycle.deleteAccount(accountId),
    });
    const requester = async (c: Context): Promise<Requester> => {
      const { owner, account } = await accounts.owner(c);
      return { owner, anonymous: account?.status === 'anonymous' };
    };
    // The managed AgentCore browser when the deploy names one; a local Chromium only when it names none.
    const computer = env.AGENTCORE_AGENT_COMPUTER_BROWSER_ID?.trim()
      ? managedAgentComputer({ history, requester, env, store, files, profileOmitsCookieDomains: bot.agentComputer.profileOmitsCookieDomains, accountKey: bot.accountKey })
      : localAgentComputer({ history, requester, env, startPage: options.startPage });
    const lifecycle = accountLifecycle({ credentials, history, files: filesConfigured(env) ? files : null, computers: computer, store });
    const deletions = accountDeletions({ store, deleteAccount: lifecycle.deleteAccount });
    return {
      agentDocuments: agentDocumentTemplates({ ...bot.agentIdentity, soul: bot.soul }),
      models: bot.models,
      memory: bot.memory,
      recoverAccountDeletions: () => deletions.recover(),
      accountModels: ({ owner }, options) => plan.accountModels(owner, options),
      accountModel: ({ owner }, key) => plan.accountModel(owner, key),
      routes: new Hono()
        .route('/', computer.routes)
        .route('/', computerFilesRoutes({ requester, history, computers: computer, files: () => files() }))
        .route('/account/plan-usage/openai', plan.routes)
        .route('/', accounts.routes)
        .route('/', identity?.routes ?? new Hono())
        .route('/', identity?.deletion ?? new Hono())
        .route('/', invocationSecret ? tokenIntrospectionRoutes({ sessions: store, invocationSecret }) : new Hono()),
      requester,
      filingUserId: (owner) => owner,
      scheduledRequester: async (owner) => ({ owner }),
      invocationPayload: async (input, requester, model) => ({
        ...input,
        forwardedProps: {
          ...input.forwardedProps,
          ...(env.BOTCUBE_CREDENTIAL_SERVICE_URL
            ? turnCredentialBinding(env.BOTCUBE_CREDENTIAL_SERVICE_URL, env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '', requester.owner, input.threadId, model,
              await plan.planAccountId(requester.owner, model))
            : {}),
          ...(await computer.forwardedProps(requester.owner, input.threadId)),
        },
      }),
      credentialProps: ['credentialServiceInvocationToken', 'agentComputerCdpUrl'],
      authorizeBrowserLiveView: computer.authorizeBrowserLiveView,
      warmSession: computer.warmSession,
      turnStarting: computer.turnStarting,
      ...('browserLiveView' in computer ? { browserLiveView: computer.browserLiveView } : {}),
      sleepAgentComputers: computer.sleepAll,
      stopSessionComputer: computer.stopThread,
    };
  };
}

/** Serve the stock Chat Service on $PORT. */
export const serveStockChatService = (env: NodeJS.ProcessEnv = process.env) => serveChatService(stockChatService(env), env);
