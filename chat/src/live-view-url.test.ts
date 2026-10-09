import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, type ChatServiceCartridge } from './cartridge.js';
import { createChatService, type ChatServiceConfig } from './server.js';
import type { AgentDocuments } from './agent-documents.js';
import type { SessionMetadata } from './session-metadata.js';

const cartridge: ChatServiceCartridge = {
  corsOrigins: [],
  agentDocuments: { agentIdentity: { name: 'Test Bot', character: '', vibe: '', avatar: '' }, soul: '' },
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  accountModels: async () => [],
  browserEventName: 'test:browser-live-view',
  routes: new Hono(),
  requester: async () => ({ owner: 'acct_owner' }),
  filingUserId: (owner) => owner,
  scheduledRequester: async (owner) => ({ owner }),
  signInNeeded: async () => null,
  invocationPayload: async () => ({ forwardedProps: {} }),
  credentialProps: [],
  authorizeBrowserLiveView: async (sessionId) => {
    if (sessionId === 'someone-elses') throw new HttpError(401, 'Not your browser');
    return sessionId === 'agent-computer-session' ? 'agent_computer-1' : undefined;
  },
  warmSession: async () => undefined,
};

const unused = async (): Promise<never> => {
  throw new Error('not used');
};
const sessionMetadata: SessionMetadata = {
  checkRuntimeNamespaceReady: async () => undefined,
  createMemoryLease: async () => { throw new Error('not used'); },
  memoryLease: async () => { throw new Error('not used'); },
  endMemoryLease: async () => { throw new Error('not used'); },
  memorySessionActive: async () => { throw new Error('not used'); },
  checkHealth: unused,
  recordTurn: unused,
  beginDispatch: unused,
  assertNoDispatch: unused,
  rejectedDispatches: unused,
  pendingPurges: async () => [],
  completePurge: unused,
  list: unused,
  ownsMainChat: async () => false,
  mainChat: unused,
  get: unused,
  fence: unused,
  fenceOwner: unused,
  transferOwner: unused,
  saveTurnSummary: unused,
  turnSummaries: unused,
  turnEnded: unused,
  turnSummaryFailed: unused,
  turnStarted: unused,
};

const agentDocuments: AgentDocuments = {
  get: unused,
  save: unused,
  memoryEdited: unused,
  picture: unused,
  savePicture: unused,
  delete: unused,
};

const config: ChatServiceConfig = {
  agentCore: null,
  localHarnessUrl: null,
  corsOrigins: null,
  region: 'us-west-2',
  agentCoreEndpoint: 'https://bedrock-agentcore.us-west-2.amazonaws.com',
  browserId: 'custom.browser.v7',
  sessionApi: null,
  warmupTimeoutMs: 10_000,
  turnSummaryModel: { region: 'us-west-2', url: 'https://bedrock-runtime.us-west-2.amazonaws.com/model/unused/converse' },
};

beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const liveViewUrl = (sessionId: string) =>
  createChatService(() => cartridge, config, sessionMetadata, agentDocuments).request(`/browser-live-view-url?session_id=${sessionId}`);

describe('a browser live-view URL', () => {
  it('is presigned for the configured browser', async () => {
    const response = await liveViewUrl('browser-session-1');

    expect(response.status).toBe(200);
    const signed = new URL(((await response.json()) as { signedUrl: string }).signedUrl);
    expect(`${signed.origin}${signed.pathname}`).toBe(
      'https://bedrock-agentcore.us-west-2.amazonaws.com/browser-streams/custom.browser.v7/sessions/browser-session-1/live-view',
    );
    expect(signed.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock-agentcore\//);
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('is presigned for the browser the Cartridge names for the Session', async () => {
    const response = await liveViewUrl('agent-computer-session');

    const { signedUrl } = (await response.json()) as { signedUrl: string };
    expect(new URL(signedUrl).pathname).toBe('/browser-streams/agent_computer-1/sessions/agent-computer-session/live-view');
  });

  it('escapes the Session ID into one path segment', async () => {
    const response = await liveViewUrl(encodeURIComponent('session/with?reserved'));

    const { signedUrl } = (await response.json()) as { signedUrl: string };
    expect(signedUrl).toContain('/sessions/session%2Fwith%3Freserved/live-view?');
  });

  it('is refused when the Cartridge does not authorize the request', async () => {
    const response = await liveViewUrl('someone-elses');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: 'Not your browser' });
  });
});
