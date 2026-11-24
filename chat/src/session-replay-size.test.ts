import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { startOnFreePort, type RunningProcess } from '../test/fakes/process.js';

const python = fileURLToPath(new URL('../../harness/deepagents/.venv/bin/python', import.meta.url));
const fixture = fileURLToPath(new URL('../test/large-session-replay.py', import.meta.url));
let directory: string | undefined;
let lambda: RunningProcess | undefined;

beforeAll(async () => {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), 'session-replay-'));
  directory = checkpointDirectory;
  lambda = await startOnFreePort((port) => ({
    command: `"${python}" "${fixture}"`,
    env: { ...process.env, PORT: String(port), BOTCUBE_CHECKPOINT_PATH: join(checkpointDirectory, 'record.sqlite'), AGENTCORE_MEMORY_ID: '' },
    url: `http://127.0.0.1:${port}`,
    listening: 'Uvicorn running on',
  }));
});

afterAll(async () => {
  await lambda?.stop();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

it('reopens a chat larger than Lambda’s 6 MB response limit and reads older history', async () => {
  if (lambda === undefined) throw new Error('The Session API fixture did not start');
  const stack = await startInProcess({
    config: { sessionApi: { functionArn: 'session-replay', region: 'us-east-1', endpoint: lambda.url } },
  });
  try {
    await stack.allocate('acct_account-1', 'large-replay');
    const response = await stack.app.request('/threads/large-replay');
    expect(response.status, response.status === 200 ? undefined : await response.text()).toBe(200);
    const newest = await response.json();
    expect(newest.messages.at(-1)).toEqual({
      id: 'result', role: 'tool', toolCallId: 'call',
      content: 'Large message content is stored in the Session record.',
    });
    expect(newest.messages).toHaveLength(80);
    expect(newest.nextBefore).toBe('m21');

    const older = await stack.app.request(`/threads/large-replay?before=${encodeURIComponent(newest.nextBefore)}`);
    expect(older.status).toBe(200);
    const earlier = await older.json();
    expect([...earlier.messages, ...newest.messages].map(({ id }: { id: string }) => id))
      .toEqual([...Array.from({ length: 100 }, (_, i) => `m${i}`), 'result']);
    expect(earlier.nextBefore).toBeUndefined();

    const stale = await stack.app.request('/threads/large-replay?before=missing');
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'STALE_REPLAY_CURSOR' });
  } finally {
    await stack.stop();
  }
});
