import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { eventually } from '../test/eventually.js';

it('retires a completed one-off at its real instant after the spring DST change', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-03-13T12:00:00.000Z'));
  const stack = await startInProcess({ scheduled: true });
  const scheduler = defined(stack.scheduler, 'scheduled queue');
  const request = (path: string, body?: object) => stack.app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const created = await request('/scheduled-tasks', {
      title: 'DST brief', prompt: 'Brief me after the clock changes',
      schedule: 'at(2027-03-14T03:30:00)', timezone: 'America/New_York',
      proposalId: 'spring-once',
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    vi.setSystemTime(new Date('2027-03-14T07:30:30.000Z'));
    await scheduler.fire(id);
    await eventually(async () => expect(await scheduler.queued()).toBe(0));
    expect(await scheduler.schedule(id)).toBeNull();
    expect(stack.agentcore.invocations()).toHaveLength(1);
    expect(stack.sessionApi.events()).toContainEqual(expect.objectContaining({ operation: 'post' }));
    expect(await (await request('/scheduled-tasks')).json()).toEqual({ tasks: [] });
  } finally {
    await stack.stop();
    vi.useRealTimers();
  }
});
