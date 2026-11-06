import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { Message } from '@ag-ui/client';
import { afterAll, beforeAll, expect } from 'vitest';
import type { AgentModel } from '../src/cartridge.js';
import { defined } from './defined.js';
import { eventually } from './eventually.js';
import type { UpstreamScript } from './fakes/fake-agentcore.js';
import { SchedulerView } from './fakes/scheduler.js';
import { startInProcess, type InProcessStack } from './in-process.js';

export const signInChecks: { owner: string; outputs: string[] }[] = [];
/** Owners whose plan catalog cannot be fetched for their scheduled runs. */
export const unavailableCatalogs = new Set<string>();
export const turnSecrets = {
  files: { accessKeyId: 'scheduled-access-key', secretAccessKey: 'scheduled/secret+key', sessionToken: 'scheduled-session-token' },
  credentialServiceInvocationToken: 'scheduled-invocation-token',
  agentComputerCdpUrl: 'https://computer.example/cdp?token=scheduled-cdp-token',
};
export let stack: InProcessStack;
export let scheduler: SchedulerView;
beforeAll(async () => {
  stack = await startInProcess({
    scheduled: true,
    cartridge: {
      credentialProps: ['credentialServiceInvocationToken', 'agentComputerCdpUrl'],
      // A scheduled run acts for its owner with no request: say so in the payload.
      scheduledRequester: async (owner) => ({ owner, scheduled: true }),
      accountModels: async (requester) => {
        if ('scheduled' in requester && unavailableCatalogs.has(requester.owner)) throw new Error('The plan catalog is unavailable');
        return [{ key: 'plan', label: 'Plan', provider: 'openai' }];
      },
      invocationPayload: async (input, requester, model?: AgentModel) => ({
        ...input, forwardedProps: { ...input.forwardedProps, requester, approvedModel: model, ...turnSecrets },
      }),
      signInNeeded: async (owner, outputs) => {
        signInChecks.push({ owner, outputs });
        return outputs.find((output) => output.includes('Sign in to continue')) ?? null;
      },
    },
  });
  scheduler = defined(stack.scheduler, 'the stack schedules tasks');
});
afterAll(() => stack.stop());

export const owner = () => `owner-${Math.random().toString(36).slice(2)}`;

export const request = (account: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  stack.app.request(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-test-owner': account },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** Confirm a task whose prompt the fake AgentCore answers with this script, edit in any model chosen, and fire its schedule. */
export async function run(account: string, script: UpstreamScript, title = 'Morning brief', chosen: { model?: string; timezone?: string } = {}): Promise<{ id: string; prompt: string }> {
  const prompt = `Brief me ${Math.random().toString(36).slice(2)}`;
  stack.agentcore.scriptPrompt(prompt, script);
  const response = await request(account, '/scheduled-tasks', {
    method: 'POST',
    body: { title, prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt, ...chosen },
  });
  const { id } = (await response.json()) as { id: string };
  await scheduler.fire(id);
  return { id, prompt };
}

export async function sideChatOf(account: string, taskId: string): Promise<string | null | undefined> {
  const { tasks } = (await (await request(account, '/scheduled-tasks')).json()) as { tasks: { id: string; sideChat: string | null }[] };
  return tasks.find((task) => task.id === taskId)?.sideChat;
}

/** The account's Activity, each task's completion time checked to fall after `started` and then left out. */
export async function activity(account: string, started: number): Promise<Record<string, unknown>[]> {
  const { tasks } = (await (await request(account, '/activity')).json()) as { tasks: { completedAt: string }[] };
  return tasks.map(({ completedAt, ...task }) => {
    expect(Date.parse(completedAt)).toBeGreaterThanOrEqual(started);
    return task;
  });
}

export async function mainChat(account: string): Promise<string> {
  return ((await (await request(account, '/main-chat')).json()) as { id: string }).id;
}

/** What has been posted to the Session, once the first post is in: a run's post is its last step. */
export async function posted(sessionId: string, api: InProcessStack['sessionApi'] = stack.sessionApi): Promise<{ content: string; userId: string }[]> {
  return eventually(() => {
    const posts = api
      .events()
      .flatMap((event) =>
        event.operation === 'post' && event.sessionId === sessionId ? [{ content: event.content ?? '', userId: event.userId }] : [],
      );
    expect(posts).not.toEqual([]);
    return posts;
  });
}

export const stream = (...frames: (object | string | (() => object))[]): Extract<UpstreamScript, { kind: 'stream' }> => ({
  kind: 'stream',
  frames: () => [{ type: 'RUN_STARTED' }, ...frames, { type: 'RUN_FINISHED' }].map((frame) =>
    typeof frame === 'string' ? frame : `data: ${JSON.stringify(typeof frame === 'function' ? frame() : frame)}`,
  ),
});

export const text = (messageId: string, ...deltas: string[]) => [
  { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  ...deltas.map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta })),
  { type: 'TEXT_MESSAGE_END', messageId },
];

export const snapshot = (messages: Message[], history: Message[] = []) => () => {
  const input = RunAgentInputSchema.parse(JSON.parse(defined(stack.agentcore.invocations().at(-1), 'scheduled invocation').body));
  return { type: 'MESSAGES_SNAPSHOT', messages: [...history, ...input.messages, ...messages] };
};
