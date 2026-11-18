import { Hono, type Context } from 'hono';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadDeployment } from 'botcube-deployment-config/load';
import { accountCookies } from './account-cookies.js';
import { AccountStore } from './account-store.js';
import { accountRoutes } from './accounts.js';
import { agentDocumentTemplates } from './agent-documents.js';
import type { CartridgeFactory } from './cartridge.js';
import { computerFilesRoutes } from './computer-files-routes.js';
import { chatTable } from './config.js';
import { turnCredentialBinding } from './credential-service-token.js';
import { accountFilesFromEnv } from './files.js';
import { localAgentComputer } from './local-agent-computer.js';
import { oidcIdentity } from './oidc-sign-in.js';
import { planModels } from './plan-models.js';
import { serveChatService } from './server.js';

const ACCOUNT_KEY = 'template';
const cookies = accountCookies(ACCOUNT_KEY);

function deployment(env: NodeJS.ProcessEnv) {
  const path = env.BOTCUBE_DEPLOYMENT_CONFIG;
  if (!path) throw new Error('BOTCUBE_DEPLOYMENT_CONFIG is not set: the stock Chat Service serves the Deployment Config it names');
  return loadDeployment(path);
}

/** The accounts of the bot its Deployment Config names, in BOTCUBE_CHAT_TABLE. */
export const stockAccountStore = (env: NodeJS.ProcessEnv, documents?: Pick<DynamoDBDocumentClient, 'send'>) =>
  new AccountStore(chatTable(env), { key: ACCOUNT_KEY, product: deployment(env).bot.agentIdentity.name }, documents);

export interface StockOptions {
  accountStore?: AccountStore;
  /** The page each Agent Computer opens on; blank unless given. */
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
  const identity = config.identity.kind === 'oidc' ? oidcIdentity(config.identity, env, { store, cookies }) : null;
  const files = accountFilesFromEnv(env, store);
  const plan = planModels({
    credentialServiceUrl: env.BOTCUBE_CREDENTIAL_SERVICE_URL,
    invocationSecret: env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '',
    ownerAccountId: env.BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID?.trim() || undefined,
    store,
  });
  return (history) => {
    const accounts = accountRoutes({ store, cookies, signIns: async () => [],
      ...(identity === null ? {} : { session: () => ({ signIn: 'oidc' }) }),
      async deleteTestUser(accountId) {
        await history.delete(accountId);
        await accountStore.deleteAccount(accountId);
      },
    });
    const requester = async (c: Context) => {
      const { owner, account } = await accounts.owner(c);
      return { owner, anonymous: account?.status === 'anonymous' };
    };
    const computer = localAgentComputer({ history, requester, env, startPage: options.startPage });
    return {
      agentDocuments: agentDocumentTemplates({ ...bot.agentIdentity, soul: bot.soul }),
      models: bot.models,
      memory: bot.memory,
      accountModels: ({ owner }, options) => plan.accountModels(owner, options),
      accountModel: ({ owner }, key) => plan.accountModel(owner, key),
      routes: new Hono()
        .route('/', computer.routes)
        .route('/', computerFilesRoutes({ requester, history, computers: computer, files: () => files() }))
        .route('/account/plan-usage/openai', plan.routes)
        .route('/', accounts.routes)
        .route('/', identity?.routes ?? new Hono()),
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
      browserLiveView: computer.browserLiveView,
      sleepAgentComputers: computer.sleepAll,
      stopSessionComputer: computer.stopThread,
    };
  };
}

/** Serve the stock Chat Service on $PORT. */
export const serveStockChatService = (env: NodeJS.ProcessEnv = process.env) => serveChatService(stockChatService(env), env);
