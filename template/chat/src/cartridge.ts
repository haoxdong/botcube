import { TEMPLATE_IDENTITY } from '../../identity.js';
import { LOCAL_UI_ORIGINS, type CartridgeFactory } from 'botcube-chat';
import { Hono } from 'hono';
import { accountsNeedingSignIn, templateRequester } from './account.js';
import { invocationToken, siteSignInRoutes } from './sign-in.js';
import { templateComputer, templateComputerConfig } from './computer.js';

const TEMPLATE_ACTOR_ID = 'template-user';

export function templateCartridgeFactory(
  env: NodeJS.ProcessEnv,
  onTaskStop: (stop: () => Promise<void>) => void
): CartridgeFactory {
  return (history) => {
    const config = templateComputerConfig(env);
    const computer =
      config &&
      templateComputer({ ...config, history, requester: templateRequester });
    if (computer) onTaskStop(computer.stop);
    return {
      corsOrigins: LOCAL_UI_ORIGINS,
      agentDocuments: {
        agentIdentity: {
          name: TEMPLATE_IDENTITY.name,
          character: 'A template agent',
          vibe: 'Plain and friendly',
          avatar: TEMPLATE_IDENTITY.avatar,
        },
        soul: 'Be helpful and honest. Say so when you do not know.',
      },
      models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
      accountModels: async () => [],
      browserEventName: 'botcube:browser-live-view',
      routes: new Hono()
        .route('/', computer ? computer.routes : new Hono())
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
        .get('/files/download-url', (c) => {
          if (c.req.query('name') !== 'sample.txt')
            return c.json({ error: 'Unknown template file' }, 404);
          return c.json({ url: new URL('/files/sample.txt', c.req.url).href });
        })
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
      invocationPayload: async (input, requester) => {
        const forwardedProps = { ...input.forwardedProps };
        delete forwardedProps.agentComputerCdpUrl;
        return {
          ...input,
          forwardedProps: {
            ...forwardedProps,
            ...(env.TEMPLATE_CREDENTIAL_SERVICE_URL
              ? {
                  credentialServiceUrl: env.TEMPLATE_CREDENTIAL_SERVICE_URL,
                  credentialServiceInvocation: invocationToken(
                    env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '',
                    requester.owner,
                    input.threadId
                  ),
                }
              : {}),
            ...(computer
              ? await computer.forwardedProps(requester.owner, input.threadId)
              : {}),
          },
        };
      },
      credentialProps: ['credentialServiceInvocation', 'agentComputerCdpUrl'],
      authorizeBrowserLiveView: computer
        ? computer.authorizeBrowserLiveView
        : async () => {
            throw new Error('Agent Computer is not configured');
          },
      warmSession: computer ? computer.warmSession : async () => undefined,
      ...(computer ? { browserLiveView: computer.browserLiveView } : {}),
    };
  };
}

export const templateCartridge: CartridgeFactory = templateCartridgeFactory(
  process.env,
  () => undefined
);
