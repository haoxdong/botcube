import { describe, expect, it } from 'vitest';
import { AgentCdp } from '../test/agent-cdp.js';
import { cdpChannelFixture } from '../test/cdp-channel-fixture.js';

const { automationStream, channel } = cdpChannelFixture();

/** The agent's end of the channel. */
async function attachedPage(client: AgentCdp): Promise<string> {
  const targets = await client.send('Target.getTargets');
  const [page] = (targets.result?.targetInfos ?? []) as { targetId: string }[];
  const attached = await client.send('Target.attachToTarget', { targetId: page?.targetId, flatten: true });
  return String(attached.result?.sessionId);
}

describe("the agent's CDP channel to its Agent Computer", () => {
  it('never lets the agent read cookies, storage, or network bodies, nor slip past the filter', async () => {
    const stream = await automationStream({ page: true });
    const { url } = await channel(stream.url);
    const client = await AgentCdp.connect(`${url}?token=good`);
    const page = await attachedPage(client);

    const denied: [string, object][] = [
      ['Network.getAllCookies', {}],
      ['Network.getCookies', {}],
      ['Storage.getCookies', {}],
      ['DOMStorage.getDOMStorageItems', {}],
      ['Network.getResponseBody', { requestId: 'r1' }],
      ['Fetch.enable', {}],
      ['Tracing.start', {}],
      ['Target.sendMessageToTarget', { message: '{"id":1,"method":"Network.getAllCookies"}', targetId: 'page-1' }],
      ['Target.exposeDevToolsProtocol', { targetId: 'page-1' }],
      ['Target.attachToTarget', { targetId: 'page-1', flatten: false }],
      ['Page.navigate', { url: 'chrome://settings/cookies' }],
    ];
    for (const [method, params] of denied) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time, as a CDP client sends them
      const answer = await client.send(method, params, page);
      expect(answer.error?.message, method).toBe(`${method} is not allowed on the Agent Computer`);
    }
    client.close();

    expect([...stream.rootMethods, ...stream.received.map((entry) => JSON.parse(entry).method)]).toEqual(['Target.attachToBrowserTarget', 'Target.getTargets', 'Target.attachToTarget']);
  });

  it('refuses a connection without a token the Chat Service issued', async () => {
    const stream = await automationStream();
    const { url } = await channel(stream.url);
    await expect(AgentCdp.connect(`${url}?token=forged`)).rejects.toThrow(
      'refused'
    );
  });
  it('keeps retained agent clients attached independently through the built Chat Service', async () => {
    const stream = await automationStream({ oneClient: true, page: true });
    const { url: channelUrl } = await channel(stream.url);
    const url = `${channelUrl}?token=good`;
    const [first, second] = await Promise.all([AgentCdp.connect(url), AgentCdp.connect(url)]);
    try {
      const [firstPage, secondPage] = await Promise.all([attachedPage(first), attachedPage(second)]);
      expect(firstPage).not.toBe(secondPage);
      const denied = await second.send('Target.detachFromTarget', { sessionId: firstPage }, secondPage);
      expect(denied.error?.message).toBe('CDP session belongs to another browser client');
      first.close();
      await first.closed;
      const targets = await second.send('Target.getTargets');
      expect(targets.result?.targetInfos).toEqual([{ targetId: 'page-1', type: 'page', url: 'about:blank' }]);
    } finally {
      first.close();
      second.close();
    }
  });


});
