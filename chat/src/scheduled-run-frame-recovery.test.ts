import { expect, it } from 'vitest';
import { mainChat, owner, posted, run, stream } from '../test/scheduled-run-fixture.js';

it('posts the scheduled answer after one malformed data frame', async () => {
  const account = owner();
  const main = await mainChat(account);
  await run(account, stream(
    { type: 'TEXT_MESSAGE_CHUNK', messageId: 'answer', role: 'assistant', delta: 'Recovered ' },
    ': keepalive\r\n\r\ndata: not-json\r\n\r\ndata: {"type":"TEXT_MESSAGE_CHUNK",\r\ndata: "delta":"brief."}',
  ));
  expect(await posted(main)).toEqual([{
    content: 'Scheduled task "Morning brief": Recovered brief.', userId: `filed-${account}`,
  }]);
});
