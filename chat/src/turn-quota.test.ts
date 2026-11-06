import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

let stack: InProcessStack | undefined;
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-24T12:00:10Z')); });
afterEach(async () => { await stack?.stop(); vi.restoreAllMocks(); });

async function post(target: InProcessStack, id: string, owner = 'alice', ip = '192.0.2.1') {
  const response = await target.app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-owner': owner, 'cf-connecting-ip': ip },
    body: JSON.stringify({ threadId: id, runId: id, messages: [{ id: 'm1', role: 'user', content: 'hello' }], tools: [], context: [], state: {}, forwardedProps: {} }),
  });
  const body = await response.text();
  return { response, body };
}

async function turn(target: InProcessStack, id: string, owner = 'alice', ip = '192.0.2.1') {
  await target.allocate(owner, id);
  return post(target, id, owner, ip);
}

it('refuses an Account across IPs before dispatch and leaves reads available', async () => {
  stack = await startInProcess({ turnQuota: { anonymous: 1, claimed: 2, ip: 3 } });
  expect((await turn(stack, 'first')).response.status).toBe(200);
  const refused = await turn(stack, 'second', 'alice', '192.0.2.2');
  expect(refused.response.status).toBe(429);
  expect(refused.response.headers.get('retry-after')).toMatch(/^[1-6]?[0-9]$/);
  expect(JSON.parse(refused.body)).toMatchObject({ code: 'TURN_QUOTA_EXCEEDED' });
  expect(stack.agentcore.invocations()).toHaveLength(1);
  expect((await stack.app.request('/threads')).status).toBe(200);
  const { Items = [] } = await DynamoDBDocumentClient.from(stack.table.client).send(new ScanCommand({ TableName: stack.table.name }));
  const quotas = Items.filter(({ pk }) => String(pk).startsWith('TURN_QUOTA#'));
  const history = Items.filter(({ pk }) => !String(pk).startsWith('TURN_QUOTA#'));
  expect(quotas).toHaveLength(2);
  expect(history.length).toBeGreaterThan(0);
  for (const quota of quotas) expect(quota.turnQuotaExpiresAt).toEqual(expect.any(Number));
  for (const record of history) expect(record).not.toHaveProperty('turnQuotaExpiresAt');
});

it('limits an IP across Accounts without charging an Account for a refused Turn', async () => {
  stack = await startInProcess({ turnQuota: { anonymous: 1, claimed: 2, ip: 1 } });
  expect((await turn(stack, 'ip-first')).response.status).toBe(200);
  expect((await turn(stack, 'ip-refused', 'bob')).response.status).toBe(429);
  expect((await turn(stack, 'ip-new', 'bob', '192.0.2.2')).response.status).toBe(200);
});

it('grants the claimed Account tier only from server-resolved identity', async () => {
  stack = await startInProcess({
    turnQuota: { anonymous: 1, claimed: 2, ip: 5 },
    cartridge: { requester: async () => ({ owner: 'claimed', rateTier: 'authenticated' }) },
  });
  expect((await turn(stack, 'claimed-first', 'claimed')).response.status).toBe(200);
  expect((await turn(stack, 'claimed-second', 'claimed')).response.status).toBe(200);
  expect((await turn(stack, 'claimed-third', 'claimed')).response.status).toBe(429);
});


it('starts a fresh window even while expired counters await cleanup', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-24T12:00:10Z'));
  stack = await startInProcess({ turnQuota: { anonymous: 1, claimed: 2, ip: 1 } });
  expect((await turn(stack, 'window-first')).response.status).toBe(200);
  const refused = await turn(stack, 'window-refused');
  expect(refused.response.status).toBe(429);
  expect(refused.response.headers.get('retry-after')).toBe('50');
  clock.mockReturnValue(Date.parse('2026-10-24T12:01:00Z'));
  expect((await turn(stack, 'window-next')).response.status).toBe(200);
});

it('admits only one concurrent Turn into the last Account slot', async () => {
  stack = await startInProcess({ turnQuota: { anonymous: 1, claimed: 2, ip: 5 } });
  const results = await Promise.all([turn(stack, 'race-first'), turn(stack, 'race-second')]);
  expect(results.map(({ response }) => response.status).sort()).toEqual([200, 429]);
  expect(stack.agentcore.invocations()).toHaveLength(1);
});

it('fails closed with a classified error when quota storage is unavailable', async () => {
  stack = await startInProcess({ table: 'missing', turnQuota: { anonymous: 1, claimed: 2, ip: 1 } });
  const refused = await post(stack, 'storage-failed');
  expect(refused.response.status).toBe(503);
  expect(JSON.parse(refused.body)).toMatchObject({ code: 'TURN_QUOTA_UNAVAILABLE' });
  expect(stack.agentcore.invocations()).toHaveLength(0);
});


it('shares admission counters across independent Chat Service instances', async () => {
  const limits = { anonymous: 1, claimed: 2, ip: 5 };
  stack = await startInProcess({ turnQuota: limits });
  const other = await startInProcess({ existingTable: stack.table.name, turnQuota: limits });
  try {
    expect((await turn(stack, 'task-first')).response.status).toBe(200);
    expect((await turn(other, 'task-second')).response.status).toBe(429);
    expect(other.agentcore.invocations()).toHaveLength(0);
  } finally {
    await other.stop();
  }
});
