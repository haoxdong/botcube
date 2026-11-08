import { Hono, type Context } from 'hono';
import { agentDocumentTemplates, serveChatService, type CartridgeFactory } from '../../src/index.js';
import { accountRoutes } from '../../src/accounts.js';
import { accountCookies } from '../../src/account-cookies.js';
import { AccountStore } from '../../src/account-store.js';
import { chatTable } from '../../src/config.js';
import { computerFilesRoutes } from '../../src/computer-files-routes.js';
import { accountFilesFromEnv } from '../../src/files.js';
import { agentComputerCdpUrls } from '../../src/agent-computer-token.js';
import { turnCredentialBinding } from '../../src/credential-service-token.js';

const env = process.env;
const store = new AccountStore(chatTable(env), { key: 'template', product: 'BotCube' });
const accounts = accountRoutes({ store: () => store, cookies: accountCookies('template'), signIns: async () => [] });
const requester = async (c: Context) => ({ owner: (await accounts.owner(c)).owner });
const files = accountFilesFromEnv(env, () => store);
const cdp = agentComputerCdpUrls(`ws://127.0.0.1:${env.PORT}/agent-computer/cdp`, env);
const factory: CartridgeFactory = (history) => ({
  agentDocuments: agentDocumentTemplates({ name: 'BotCube', character: 'A template agent', avatar: '🧊' }),
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  accountModels: async () => [],
  accountModel: async () => undefined,
  requester,
  filingUserId: (owner) => owner,
  scheduledRequester: async (owner) => ({ owner }),
  signInNeeded: async () => null,
  routes: new Hono().route('/', accounts.routes).route('/', computerFilesRoutes({
    requester,
    history,
    computers: {
      state: async () => ({ state: 'asleep', screenshot: null }),
      wake: async () => { throw new Error('HTTP parity does not start an Agent Computer'); },
    },
    files: () => files(),
  })),
  async invocationPayload(input, requester, model) {
    return {
      ...input,
      forwardedProps: {
        ...input.forwardedProps,
        ...turnCredentialBinding(env.BOTCUBE_CREDENTIAL_SERVICE_URL ?? '', env.BOTCUBE_CREDENTIAL_INVOCATION_SECRET ?? '', requester.owner, input.threadId, model),
        agentComputerCdpUrl: await cdp.issue(requester.owner, input.threadId),
        files: await files().syncBinding(requester.owner),
      },
    };
  },
  credentialProps: ['credentialServiceInvocationToken', 'agentComputerCdpUrl'],
  authorizeBrowserLiveView: async () => undefined,
  warmSession: async () => {},
});
serveChatService(factory);
