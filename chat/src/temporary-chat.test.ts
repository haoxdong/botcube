import { afterEach, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { TemporaryChats } from './temporary-chat.js';

const secret = 'only-the-chat-service-holds-this-signing-key';
afterEach(() => { vi.useRealTimers(); });

it('issues separate server-owned chats for each tab without a User identity', async () => {
  const chats = new TemporaryChats(secret);
  const first = await chats.issue();
  const second = await chats.issue();
  expect(first.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(Object.keys(first).sort()).toEqual(['sessionId', 'token']);
  expect(await chats.owns(first.token, first.sessionId)).toBe(true);
  expect(await chats.owns(first.token, second.sessionId)).toBe(false);
  expect(await chats.owns(`${first.token}broken`, first.sessionId)).toBe(false);
  expect(await new TemporaryChats('another-server-secret').owns(first.token, first.sessionId)).toBe(false);
});

it('does not accept another signed capability or an expired temporary chat', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const chats = new TemporaryChats(secret);
  const chat = await chats.issue();
  const foreign = await new SignJWT({}).setSubject(chat.sessionId).setAudience('another-service').setExpirationTime('24h')
    .setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(secret));
  expect(await chats.owns(foreign, chat.sessionId)).toBe(false);
  vi.setSystemTime(new Date(Date.now() + 48 * 60 * 60 * 1000));
  expect(await chats.owns(chat.token, chat.sessionId)).toBe(false);
});
