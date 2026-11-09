import { randomUUID } from 'node:crypto';
import type { InProcessStack } from './in-process.js';

export function inProcessBrowser(stack: InProcessStack, accountId = randomUUID()) {
  const request = (path: string, init: RequestInit = {}) => stack.app.request(path, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-test-owner': accountId },
  });
  const post = (path: string, body: unknown) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    request,
    get: (path: string) => request(path),
    post,
    delete: (path: string) => request(path, { method: 'DELETE' }),
    openAccountSession: async () => ({ accountId }),
    async newSideChat(): Promise<string> {
      const response = await request('/threads', { method: 'POST' });
      if (response.status !== 201) throw new Error(`POST /threads: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { id: string }).id;
    },
  };
}
