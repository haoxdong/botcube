import { templateFiles, templateFileContent } from './files.js';
import { computerFilesRoutes } from 'botcube-chat/computer-files-routes';
import { agentDocumentTemplates, HttpError, type CartridgeFactory } from 'botcube-chat';
import { Hono, type Context } from 'hono';
import type { AccountStore } from 'botcube-chat/account-store';
import { accountRoutes } from 'botcube-chat/accounts';
import { templateAccountStore, templateCookies } from './account.js';
import { siteSignIn } from './sign-in.js';
import { turnCredentialBinding } from 'botcube-chat/credential-service-token';
import { localAgentComputer } from 'botcube-chat/local-agent-computer';
import { loadDeployment } from 'botcube-deployment-config/load';
import type { DeploymentConfig } from 'botcube-deployment-config';
import { oidcClientSecret, oidcSignIn } from 'botcube-chat/oidc-sign-in';
import { corsOriginsFromEnv, LOCAL_UI_ORIGINS } from 'botcube-chat/cors';
import { templateBot } from './bot.js';

const TEMPLATE_ACTOR_ID = 'template-user';

export function templateCartridgeFactory(
  env: NodeJS.ProcessEnv,
  accountStore: AccountStore = templateAccountStore(env)
): CartridgeFactory {
  const deployment = env.BOTCUBE_DEPLOYMENT_CONFIG ? loadDeployment(env.BOTCUBE_DEPLOYMENT_CONFIG) : null;
  const bot = deployment?.bot ?? templateBot(env);
  const store = () => accountStore;
  const identity = deployment ? identityRoutes(deployment.config.identity, env, store) : new Hono();
  return (history) => {
    const signIn = siteSignIn({
      serviceUrl: () => env.BOTCUBE_CREDENTIAL_SERVICE_URL ?? '',
      secret: () => env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '',
      owner: async (c) => {
        const { owner, account } = await accounts.owner(c);
        if (account?.status === 'test') throw new HttpError(403, 'Test Users cannot have Sign-ins');
        return owner;
      },
      store,
    });
    const accounts = accountRoutes({ store, cookies: templateCookies, signIns: (account) => signIn.signIns(account.accountId),
      // The web UI's sign-in: the OIDC provider's, under the `oidc` identity adapter.
      ...(deployment?.config.identity.kind === 'oidc' ? { session: () => ({ signIn: 'oidc' }) } : {}),
      async deleteTestUser(accountId) {
        await history.delete(accountId);
        await accountStore.deleteAccount(accountId);
      },
    });
    const requester = async (c: Context) => {
      const { owner, account } = await accounts.owner(c);
      return { owner, anonymous: account?.status === 'anonymous' };
    };
    // BotCube's local Agent Computer, opened on the fake site's login page when there is one.
    const computer = localAgentComputer({
      history,
      requester,
      env,
      startPage: env.TEMPLATE_SITE_URL ? new URL('/login', env.TEMPLATE_SITE_URL).href : undefined,
    });
    return {
      agentDocuments: agentDocumentTemplates({ ...bot.agentIdentity, soul: bot.soul }),
      models: bot.models,
      memory: bot.memory,
      accountModels: async () => [],
      accountModel: async () => undefined,
      routes: new Hono()
        .route('/', computer.routes)
        .route('/', computerFilesRoutes({ requester, history, computers: computer, files: (c) => templateFiles(c.req.url) }))
        .route('/', templateFileContent(requester))
        .route('/', accounts.routes)
        .route('/', identity)
        .route('/', signIn.routes)
        .get('/auth/template', (c) =>
          c.json({ status: 'ready', actorId: TEMPLATE_ACTOR_ID })
        )
        .get('/files/sample.txt', (c) =>
          c.text(`Hello from ${bot.agentIdentity.name}.\n`)
        ),
      requester,
      filingUserId: (owner) => owner,
      scheduledRequester: async (owner) => ({ owner }),
      signInNeeded: async (owner, outputs) => {
        const message = 'Template site sign-in needed.';
        if (!outputs.some((output) => output.split('\n').some((line) => line === message || line === `[stderr] ${message}`))) return null;
        await accountStore.markSignInNeeded(owner);
        return message;
      },
      invocationPayload: async (input, requester, model) => ({
          ...input,
          forwardedProps: {
            ...input.forwardedProps,
            ...(env.BOTCUBE_CREDENTIAL_SERVICE_URL
              ? turnCredentialBinding(
                  env.BOTCUBE_CREDENTIAL_SERVICE_URL,
                  env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '',
                  requester.owner,
                  input.threadId,
                  model
                )
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

/** How Users sign in under the Deployment Config's identity section: `oidc` adds the provider's sign-in. */
function identityRoutes(identity: DeploymentConfig['identity'], env: NodeJS.ProcessEnv, store: () => AccountStore): Hono {
  if (identity.kind === 'botcube-accounts') return new Hono();
  return oidcSignIn({
    identity: { issuer: identity.issuer, clientId: identity.clientId, clientSecret: oidcClientSecret(env), subjectIsAccountId: identity.subjectIsAccountId },
    store,
    cookies: templateCookies,
    returnOrigins: corsOriginsFromEnv(env) ?? LOCAL_UI_ORIGINS,
    publicOrigin: env.BOTCUBE_PUBLIC_ORIGIN,
  }).routes;
}

export const templateCartridge: CartridgeFactory = templateCartridgeFactory(process.env);
