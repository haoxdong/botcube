import { expect, it } from 'vitest';
import { eventually } from '../test/eventually.js';
import { catalogPlan, mainChat, owner, planCatalogs, posted, request, scheduler, stack, stream, text } from '../test/scheduled-run-fixture.js';

it.each([
  ['same provider after a run', true, 'thorough'],
  ['another provider after a run', true, catalogPlan.key],
  ['another provider before the first run', false, catalogPlan.key],
] as const)('accepts a supported model edit for %s', async (_name, alreadyRan, model) => {
  const account = owner();
  planCatalogs.set(account, []);
  const main = await mainChat(account);
  const prompt = `Supported provider edit ${account}`;
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  stack.agentcore.scriptPrompt(prompt, {
    ...stream(...text('answer', 'Rates brief.')),
    ...(alreadyRan ? { hold: completion } : {}),
  });
  const created = await request(account, '/scheduled-tasks', {
    method: 'POST',
    body: { title: 'Provider brief', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt, model: 'quick' },
  });
  expect(created.status).toBe(201);
  const { id } = await created.json();
  if (alreadyRan) {
    await scheduler.fire(id);
    await eventually(() => expect(stack.agentcore.invocations().some(({ body }) => body.includes(prompt))).toBe(true));
    const completed = completedPosts(main);
    release();
    expect(await completed).toHaveLength(1);
  }
  planCatalogs.set(account, [catalogPlan]);
  const changed = await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { model } });
  expect(changed.status).toBe(200);
  expect((await changed.json()).model).toBe(model);
  await scheduler.fire(id);
  expect(await completedPosts(main)).toHaveLength(alreadyRan ? 2 : 1);
  expect((await posted(main)).at(-1)?.content).toBe('Scheduled task "Provider brief": Rates brief.');
});

async function completedPosts(main: string) {
  await eventually(async () => expect(await scheduler.queued()).toBe(0));
  return posted(main);
}
