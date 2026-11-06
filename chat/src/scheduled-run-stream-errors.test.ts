import { expect, it } from 'vitest';
import { mainChat, owner, posted, run, stream } from '../test/scheduled-run-fixture.js';

it('reports an invalid AG-UI event without quoting the frame', async () => {
  const account = owner();
  const main = await mainChat(account);
  await run(account, stream('data: {"message":"private-invalid-event"}'));
  expect(await posted(main)).toEqual([{
    content: 'Scheduled task "Morning brief" failed: The Runtime sent an invalid AG-UI event stream', userId: `filed-${account}`,
  }]);
});
