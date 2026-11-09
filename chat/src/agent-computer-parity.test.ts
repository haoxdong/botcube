import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computerParity } from '../test/computer-parity.js';

type Stack = Awaited<ReturnType<typeof computerParity>>;
type Browser = ReturnType<Stack['browser']>;
type ComputerState =
  | { state: 'awake'; browserSessionId: string; control: 'user' | 'agent' }
  | { state: 'asleep'; screenshot: string | null };
let stack: Stack;
beforeAll(async () => { stack = await computerParity(); });
afterAll(() => stack.stop());
async function wake(user: Browser, threadId: string): Promise<string> {
  const response = await user.post(`/agent-computer/wake?thread_id=${threadId}`, {});
  expect(response.status).toBe(200);
  const body = await response.json() as ComputerState;
  if (body.state !== 'awake') throw new Error(`Wake answered ${JSON.stringify(body)}`);
  return body.browserSessionId;
}
async function computer(user: Browser, threadId: string): Promise<ComputerState> {
  const response = await user.get(`/agent-computer?thread_id=${threadId}`);
  expect(response.status).toBe(200);
  return await response.json() as ComputerState;
}
async function asleep(user: Browser, threadId: string, _browserSessionId: string, fixture = stack) {
  const { accountId } = await user.openAccountSession();
  await fixture.asleep(accountId, threadId);
  const state = await computer(user, threadId);
  expect(state.state).toBe('asleep');
  return state;
}
const EXAMPLE_SIGN_IN = { name: 'sid', value: 'example-session', domain: '.example.com', path: '/' };
it("wakes no browser before the chat's first message, and says the computer starts with it", async () => {
  const user = stack.browser();
  await user.openAccountSession();
  const before = stack.agentcore.agentComputerSessions().length;

  const response = await user.post('/agent-computer/wake?thread_id=chat-never-sent', {});

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ detail: "This chat's computer starts with its first message" });
  expect(stack.agentcore.agentComputerSessions()).toHaveLength(before);
});

describe.concurrent('Agent Computer lifecycle', () => {
  it('answers a taken-over browser as the user\'s after a reload, until they hand it back', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    const chat = await user.newSideChat();
    const browserSessionId = await wake(user, chat);

    expect((await user.post(`/browser-take-over?session_id=${browserSessionId}`, {})).status).toBe(200);
    expect(await computer(user, chat)).toEqual({ state: 'awake', browserSessionId, control: 'user', screenshot: null });
    expect((await user.post(`/browser-hand-back?session_id=${browserSessionId}`, {})).status).toBe(200);
    expect(await computer(user, chat)).toEqual({ state: 'awake', browserSessionId, control: 'agent', screenshot: null });
  });

  it('keeps a taken-over browser awake past the idle period, and sleeps it once handed back', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    const chat = await user.newSideChat();
    const browserSessionId = await wake(user, chat);
    expect((await user.post(`/browser-take-over?session_id=${browserSessionId}`, {})).status).toBe(200);

    const other = stack.browser();
    await other.openAccountSession();
    const unattendedChat = await other.newSideChat();
    const unattendedBrowser = await wake(other, unattendedChat);
    await asleep(other, unattendedChat, unattendedBrowser);
    expect(stack.agentcore.isStopped(unattendedBrowser)).toBe(true);

    expect(stack.agentcore.isStopped(browserSessionId)).toBe(false);
    expect(await computer(user, chat)).toEqual({ state: 'awake', browserSessionId, control: 'user', screenshot: null });
    expect((await user.post(`/browser-hand-back?session_id=${browserSessionId}`, {})).status).toBe(200);
    expect(await asleep(user, chat, browserSessionId)).toMatchObject({ state: 'asleep' });
    expect(stack.agentcore.isStopped(browserSessionId)).toBe(true);
  }, 20_000);

  it("gives each Session its own browser, and both save into the account's one profile", async () => {
    const user = stack.browser();
    await user.openAccountSession();

    const [mainChatId, sideChatId, thirdChatId] = await Promise.all([user.newSideChat(), user.newSideChat(), user.newSideChat()]);
    const [mainChat, sideChat, mainChatAgain] = await Promise.all([
      wake(user, mainChatId),
      wake(user, sideChatId),
      wake(user, mainChatId),
    ]);
    expect(mainChatAgain).toBe(mainChat);
    expect(sideChat).not.toBe(mainChat);
    stack.agentcore.addCookie(sideChat, { ...EXAMPLE_SIGN_IN, value: 'side-session' });

    await asleep(user, mainChatId, mainChat);
    await asleep(user, sideChatId, sideChat);
    const third = await wake(user, thirdChatId);
    const [profile] = stack.agentcore.savedProfiles().filter(({ profileId }) => profileId === stack.agentcore.startedFromProfile(third));
    expect(profile?.saves).toBe(2);
  });

  it('wakes a new browser after a taken-over AgentCore session terminates', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    const chat = await user.newSideChat();
    const expired = await wake(user, chat);
    expect((await user.post(`/browser-take-over?session_id=${expired}`, {})).status).toBe(200);
    stack.agentcore.timeOut(expired);
    const replacement = await wake(user, chat);
    expect(replacement).not.toBe(expired);
    expect(await computer(user, chat)).toMatchObject({ state: 'awake', browserSessionId: replacement, control: 'agent' });
  });

  it('answers 422 without a thread_id', async () => {
    const user = stack.browser();
    await user.openAccountSession();

    const response = await user.post('/agent-computer/wake', {});

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'thread_id must not be blank' });
  });
});

describe('Take-over of the Agent Computer browser', () => {
  it("blinds the agent while the user drives, and gives control back when they're done", async () => {
    const user = stack.browser();
    await user.openAccountSession();
    const chat = await user.newSideChat();
    const agentBrowser = await wake(user, chat);

    const takeOver = await user.post(`/browser-take-over?session_id=${agentBrowser}`, {});
    expect(takeOver.status).toBe(200);
    expect(stack.agentcore.controlChanges(agentBrowser)).toEqual(['DISABLED']);

    const handBack = await user.post(`/browser-hand-back?session_id=${agentBrowser}`, {});
    expect(handBack.status).toBe(200);
    expect(stack.agentcore.controlChanges(agentBrowser)).toEqual(['DISABLED', 'ENABLED']);
  });

});


describe.concurrent('Agent Computer profile cleanup', () => {
  it('sleeps an idle browser into the account profile and wakes from it', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    const chat = await user.newSideChat();
    expect(await computer(user, chat)).toEqual({ state: 'asleep', screenshot: null });

    const first = await wake(user, chat);
    expect(stack.agentcore.startedFromProfile(first)).toBeNull();
    stack.agentcore.addCookie(first, EXAMPLE_SIGN_IN);
    expect(await computer(user, chat)).toEqual({ state: 'awake', browserSessionId: first, control: 'agent', screenshot: null });

    expect(await asleep(user, chat, first)).toEqual({
      state: 'asleep',
      screenshot: `data:image/jpeg;base64,${Buffer.from(`jpeg screenshot of ${first}`).toString('base64')}`,
    });
    expect(stack.agentcore.isStopped(first)).toBe(true);
    const [profile] = stack.agentcore.savedProfiles().filter(({ cookies }) => cookies.some(({ value }) => value === 'example-session'));
    expect(profile?.cookies).toEqual([EXAMPLE_SIGN_IN]);

    const second = await wake(user, chat);
    expect(second).not.toBe(first);
    expect(stack.agentcore.startedFromProfile(second)).toBe(profile?.profileId);
    expect(stack.agentcore.cookies(second)).toEqual([EXAMPLE_SIGN_IN]);
  });

});


describe('Agent Computer control failures', () => {
  it('answers 503 for a browser AgentCore no longer has', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    const chat = await user.newSideChat();
    const timedOut = await wake(user, chat);
    stack.agentcore.timeOut(timedOut);

    const response = await user.post(`/browser-take-over?session_id=${timedOut}`, {});

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: 'AgentCore refused the browser control change: HTTP 404' });
  });

});
