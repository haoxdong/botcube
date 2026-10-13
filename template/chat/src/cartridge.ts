import { templateFiles, templateFileContent } from './files.js';
import { computerFilesRoutes } from 'botcube-chat/computer-files-routes';
import { TEMPLATE_IDENTITY } from '../../identity.js';
import { agentDocumentTemplates, type CartridgeFactory } from 'botcube-chat';
import { Hono } from 'hono';
import { accountsNeedingSignIn, templateRequester } from './account.js';
import { siteSignInRoutes } from './sign-in.js';
import { turnCredentialBinding } from 'botcube-chat/credential-service-token';
import { localAgentComputer } from 'botcube-chat/local-agent-computer';

const TEMPLATE_ACTOR_ID = 'template-user';

export function templateCartridgeFactory(env: NodeJS.ProcessEnv): CartridgeFactory {
  return (history) => {
    // BotCube's local Agent Computer, opened on the fake site's login page when there is one.
    const computer = localAgentComputer({
      history,
      requester: templateRequester,
      env,
      startPage: env.TEMPLATE_SITE_URL ? new URL('/login', env.TEMPLATE_SITE_URL).href : undefined,
    });
    return {
      agentDocuments: agentDocumentTemplates({
        name: TEMPLATE_IDENTITY.name,
        character: 'A template agent',
        avatar: TEMPLATE_IDENTITY.avatar,
      }),
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
      accountModels: async () => [],
      accountModel: async () => undefined,
      routes: new Hono()
        .route('/', computer.routes)
        .route('/', computerFilesRoutes({ requester: templateRequester, history, computers: computer, files: (c) => templateFiles(c.req.url) }))
        .route('/', templateFileContent)
        .route(
          '/',
          siteSignInRoutes({
            serviceUrl: () => env.TEMPLATE_CREDENTIAL_SERVICE_URL ?? '',
            secret: () => env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '',
          })
        )
        .get('/auth/template', (c) =>
          c.json({ status: 'ready', actorId: TEMPLATE_ACTOR_ID })
        )
        .get('/files/sample.txt', (c) =>
          c.text(`Hello from ${TEMPLATE_IDENTITY.name}.\n`)
        ),
      requester: templateRequester,
      filingUserId: (owner) => owner,
      scheduledRequester: async (owner) => ({ owner }),
      signInNeeded: async (owner, outputs) => {
    const message = 'Template site sign-in needed.';
    if (!outputs.some((output) => output.split('\n').some((line) => line === message || line === `[stderr] ${message}`))) return null;
    accountsNeedingSignIn.add(owner);
    return message;
  },
      invocationPayload: async (input, requester, model) => ({
          ...input,
          forwardedProps: {
            ...input.forwardedProps,
            ...(env.TEMPLATE_CREDENTIAL_SERVICE_URL
              ? turnCredentialBinding(
                  env.TEMPLATE_CREDENTIAL_SERVICE_URL,
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
    };
  };
}

export const templateCartridge: CartridgeFactory = templateCartridgeFactory(process.env);
