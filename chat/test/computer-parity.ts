import { Hono } from 'hono';
import { AccountResources } from '../src/account-resources.js';
import { agentComputers, type AgentComputerBrowser } from '../src/agent-computer.js';
import { BrowserSessionEnded } from '../src/browser-sessions.js';
import { HttpError } from '../src/cartridge.js';
import { computerFilesRoutes } from '../src/computer-files-routes.js';
import type { AccountFiles } from '../src/files.js';
import { memoryDocuments } from './memory-documents.js';
import { startInProcess } from './in-process.js';
import { inProcessBrowser } from './in-process-browser.js';
import { expect, vi } from 'vitest';

type Cookie = { name: string; value: string; domain: string; path: string };

export async function computerParity() {
  const store = new AccountResources('chat', memoryDocuments());
  const sessions = new Map<string, { cookies: Cookie[]; profile: string | null; stopped: boolean }>();
  const profiles = new Map<string, { profileId: string; cookies: Cookie[]; saves: number }>();
  const session = (id: string) => {
    const found = sessions.get(id);
    if (!found || found.stopped) throw new BrowserSessionEnded('Browser ended');
    return found;
  };
  const browser: AgentComputerBrowser = {
    browserId: 'test-browser',
    async start(profile) {
      const id = stack.agentcore.startBrowser();
      sessions.set(id, { cookies: [...(profiles.get(profile ?? '')?.cookies ?? [])], profile, stopped: false });
      return id;
    },
    screenshot: async (id) => `data:image/jpeg;base64,${Buffer.from(`jpeg screenshot of ${id}`).toString('base64')}`,
    beforeProfileSave: async () => {},
    createProfile: async (owner) => `profile-${owner}`,
    async saveProfile(profileId, id) {
      profiles.set(profileId, { profileId, cookies: [...session(id).cookies], saves: (profiles.get(profileId)?.saves ?? 0) + 1 });
    },
    async deleteProfile(id) { profiles.delete(id); },
    async stop(id) { const found = sessions.get(id); if (found) found.stopped = true; },
    automationStream: async () => { throw new Error('No CDP connection in this lifecycle fixture'); },
    control: async (id) => { session(id); return stack.agentcore.controlChanges(id).at(-1) === 'DISABLED' ? 'user' : 'agent'; },
    async handBack(id) { stack.agentcore.controlChanges(id).push('ENABLED'); },
  };
  const unused = async () => { throw new Error('Only the Files mount is used'); };
  const files: AccountFiles = {
    mount: async (owner) => ({ accessPointArn: `access-${owner}`, fileSystemArn: 'files', mountPath: '/mnt/files' }),
    list: unused, uploadUrl: unused, downloadUrl: unused, remove: unused, rename: unused,
    recoverCleanup: unused, mountBinding: unused, transfer: unused, delete: unused,
  };
  const makeComputers = () => agentComputers({ browser: () => browser, records: () => store, seed: async () => {}, files: () => files, idleSeconds: 1 });
  const computers = makeComputers();
  const routes = new Hono();
  routes.route('/', computerFilesRoutes({
    requester: async (c) => ({ owner: c.req.header('x-test-owner') ?? '' }),
    history: { owns: (owner, id) => stack.history.owns(owner, id) },
    computers: { state: (owner, id) => computers.state(owner, id), wake: (owner, id) => computers.wake(owner, id) },
    files: () => files,
  }));
  const stack = await startInProcess({ cartridge: {
    routes,
    authorizeBrowserLiveView: async (id, c) => {
      const owner = c.req.header('x-test-owner');
      const records = owner ? await store.runningAgentComputers(owner) : [];
      if (!records.some((record) => record.sessionId === id)) throw new HttpError(403, "Not this account's Agent Computer browser");
      return browser.browserId;
    },
  } });
  return {
    browser() {
      const client = inProcessBrowser(stack);
      return client;
    },
    agentcore: {
      agentComputerSessions: () => [...sessions.keys()],
      isStopped: (id: string) => sessions.get(id)?.stopped ?? false,
      timeOut: (id: string) => { const found = sessions.get(id); if (found) found.stopped = true; stack.agentcore.expireBrowser(id); },
      addCookie: (id: string, cookie: Cookie) => session(id).cookies.push(cookie),
      startedFromProfile: (id: string) => session(id).profile,
      cookies: (id: string) => session(id).cookies,
      savedProfiles: () => [...profiles.values()],
      controlChanges: (id: string) => stack.agentcore.controlChanges(id),
    },
    async asleep(owner: string, id: string) {
      await vi.waitFor(async () => expect((await store.runningAgentComputer(owner, id))?.sessionId).toBeUndefined(), { timeout: 3000 });
    },
    async stop() {
      await computers.sleepAll().slept;
      await Promise.all([...sessions.keys()].map((id) => browser.stop(id)));
      await stack.stop();
    },
  };
}
