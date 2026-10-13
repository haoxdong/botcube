import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { onThisTask } from './task-address.js';

/** How long the agent has, from its Turn's start, to connect to its Agent Computer. */
const TTL_SECONDS = 60 * 60;

/**
 * Tokens that let a Turn's agent connect to its Session's Agent Computer. They
 * are signed with a key only this Chat Service process holds, as its Agent
 * Computers live in its memory too.
 */
export function agentComputerTokens(key: Buffer = randomBytes(32)) {
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest('base64url');
  return {
    issue(accountId: string, threadId: string, now = Date.now()): string {
      const payload = Buffer.from(
        JSON.stringify({ accountId, threadId, expiresAt: Math.floor(now / 1000) + TTL_SECONDS }),
      ).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },
    /** The Session a token names, or null when this process did not issue it or it expired. */
    verify(token: string, now = Date.now()): { accountId: string; threadId: string } | null {
      const [payload = '', signature = ''] = token.split('.');
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const { accountId, threadId, expiresAt } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
        accountId: string;
        threadId: string;
        expiresAt: number;
      };
      return expiresAt * 1000 > now ? { accountId, threadId } : null;
    },
  };
}

/**
 * The tokened CDP URLs a Turn's agent reaches its Session's Agent Computer at: `cdpUrl` with
 * this ECS task's own address, looked up when first needed, and a token only this process verifies.
 */
export function agentComputerCdpUrls(cdpUrl: string, env: NodeJS.ProcessEnv) {
  const tokens = agentComputerTokens();
  let taskCdpUrl: Promise<string> | undefined;
  const ownCdpUrl = () =>
    (taskCdpUrl ??= onThisTask(cdpUrl, env).then(
      (url) => url ?? cdpUrl,
      (error: unknown) => {
        taskCdpUrl = undefined;
        throw error;
      }
    ));
  return {
    verify: tokens.verify,
    /** The Turn's `agentComputerCdpUrl`, tokened for the owner's Session. */
    async issue(owner: string, threadId: string): Promise<string> {
      const url = new URL(await ownCdpUrl());
      url.searchParams.set('token', tokens.issue(owner, threadId));
      return url.href;
    },
  };
}
