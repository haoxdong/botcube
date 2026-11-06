import { expect, it } from 'vitest';
import { eventually } from '../test/eventually.js';
import { mainChat, owner, posted, request, run, scheduler, stack, stream, text } from '../test/scheduled-run-fixture.js';

it('does not accept a model change that makes future scheduled runs fail on the existing Side Chat provider', async () => {
  const account = owner();
  const main = await mainChat(account);
  const { id } = await run(account, stream(...text('answer', 'Rates brief.')), 'Provider brief', { model: 'quick' });
  expect((await completedPosts(main))[0]?.content).toBe('Scheduled task "Provider brief": Rates brief.');
  const changed = await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { model: 'plan' } });
  expect(changed.status).toBe(422);
  const listed = await (await request(account, '/scheduled-tasks')).json();
  expect(listed.tasks.find((task: { id: string }) => task.id === id).model).toBe('quick');
  await scheduler.fire(id);
  expect(await completedPosts(main)).toHaveLength(2);
  expect((await posted(main))[1]?.content).toBe('Scheduled task "Provider brief": Rates brief.');
});

it.each([
  ['same provider after a run', true, 'thorough'],
  ['another provider before the first run', false, 'plan'],
] as const)('accepts a supported model edit for %s', async (_name, alreadyRan, model) => {
  const account = owner();
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
