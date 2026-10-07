import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export const accountsNeedingSignIn = new Set<string>();

const sessions = new Map<string, { owner: string; expires: number }>();

export async function templateRequester(c: Context): Promise<{ owner: string }> {
  const now = Date.now();
  const cookie = getCookie(c, 'template_session');
  const current = cookie ? sessions.get(cookie) : undefined;
  if (current && current.expires > now) return { owner: current.owner };
  for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
  const token = randomUUID();
  const owner = `template-${randomUUID()}`;
  sessions.set(token, { owner, expires: now + 24 * 60 * 60 * 1000 });
  setCookie(c, 'template_session', token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 86400 });
  return { owner };
}
