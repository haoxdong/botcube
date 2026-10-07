import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { HttpError } from './cartridge.js';
import { HttpFake } from '../../../tests/chat/fakes/http-fake.js';

// Each request acts as the account its x-account header names.
let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ cartridge: { requester: async (c) => ({ owner: defined(c.req.header('x-account'), 'an x-account header') }) } });
});
afterAll(() => stack.stop());

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/;

const as = (account: string, path: string, method = 'GET') =>
  stack.app.request(path, { method, headers: { 'x-account': account } });

async function chat(account: string, ...threadIds: string[]): Promise<void> {
  for (const threadId of threadIds) {
    // eslint-disable-next-line no-await-in-loop -- turns are sent in thread order
    const response = await stack.app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account': account },
      body: JSON.stringify({
        threadId,
        runId: 'run-1',
        state: {},
        messages: [{ id: 'm1', role: 'user', content: `about ${threadId}` }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    expect(response.status).toBe(200);
    // eslint-disable-next-line no-await-in-loop -- turns are sent in thread order
    await response.text();
  }
}

async function threadIds(account: string): Promise<string[]> {
  const { threads } = (await (await as(account, '/threads')).json()) as { threads: { id: string }[] };
  return threads.map(({ id }) => id);
}

describe('Turn preparation cleanup', () => {
  it('relays a classified run error when recording RUN_STARTED fails, then clears its preparing mark', async () => {
    const target = await startInProcess();
    const failure = new Error('start metadata unavailable');
    const started = vi.spyOn(target.sessionMetadata, 'turnStarted').mockRejectedValue(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await target.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'start-metadata-fails', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }) });
      expect(response.status).toBe(200);
      const frames = await response.text();
      expect(frames).toContain('"code":"TURN_START_FAILED"');
      expect(frames).toContain('start metadata unavailable');
      expect(frames).not.toContain('RUN_FINISHED');
      const recorded = await target.sessionMetadata.get('account-1', 'start-metadata-fails');
      expect(recorded).not.toHaveProperty('turn_running_since');
      expect(recorded).not.toHaveProperty('turn_run_id');
      expect(recorded).not.toHaveProperty('turn_preparing');
      expect(logged).toHaveBeenCalledWith('The Turn\'s start could not be recorded session_id=start-metadata-fails', failure);
    } finally { started.mockRestore(); logged.mockRestore(); await target.stop(); }
  });

  it('refuses Stop while preparing, then accepts it after the real RUN_STARTED frame', async () => {
    let release!: () => void;
    let entered!: () => void;
    let finish: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const upstream = await new HttpFake((request, response) => {
      const input = JSON.parse(request.body);
      if (input.forwardedProps.stop) {
        response.writeHead(204); response.end();
        defined(finish, 'the running Turn completion')();
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"RUN_STARTED"}\n\n');
        finish = () => response.end('data: {"type":"RUN_ERROR","code":"TURN_STOPPED","message":"The Turn was stopped"}\n\n');
      }
    }).listen();
    const target = await startInProcess({ config: { localHarnessUrl: upstream.url }, cartridge: { invocationPayload: async (input) => {
      entered(); await waiting;
      return { ...input, forwardedProps: { ...input.forwardedProps } };
    } } });
    const sessionId = 'stopped-while-preparing';
    target.sessionApi.reply(sessionId, 200, { messages: [] });
    const posted = target.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: sessionId, runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }) });
    const stop = () => target.app.request(`/threads/${sessionId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'run-1' }) });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await preparing;
      const replay = await (await target.app.request(`/threads/${sessionId}`)).json();
      expect(replay).toMatchObject({ running: true });
      expect(replay).not.toHaveProperty('runId');
      const refused = await stop();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ detail: 'The Turn is still preparing. Retry Stop once it starts.' });
      expect(upstream.requests).toEqual([]);
      release();
      const response = await posted;
      reader = defined(response.body, 'the Turn stream').getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('RUN_STARTED');
      expect(await (await target.app.request(`/threads/${sessionId}`)).json()).toMatchObject({ running: true, runId: 'run-1' });
      expect((await stop()).status).toBe(204);
      // eslint-disable-next-line no-await-in-loop -- stream reads are sequential until the stopped terminal frame ends it
      while (!(await reader.read()).done) { /* Drain the truthful stopped terminal frame. */ }
      const requests = upstream.requests.map(({ body }) => JSON.parse(body));
      expect(requests).toHaveLength(2);
      expect(requests[0].forwardedProps.stop).toBeUndefined();
      expect(requests[1]).toMatchObject({ threadId: sessionId, runId: 'run-1', forwardedProps: { stop: true } });
    } finally {
      release();
      const response = await posted;
      finish?.();
      if (reader !== undefined) { await reader.cancel(); reader.releaseLock(); }
      else if (!response.bodyUsed) await response.text();
      await target.stop(); await upstream.close();
    }
  });

  it.each([false, true])('preserves the preparation error when cleanup failure is %s', async (cleanupFails) => {
    const preparationError = new HttpError(403, 'Turn credentials denied');
    const cleanupError = new Error('running mark store unavailable');
    const target = await startInProcess({ cartridge: { invocationPayload: async () => { throw preparationError; } } });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ended = vi.spyOn(target.sessionMetadata, 'turnEnded');
    if (cleanupFails) ended.mockRejectedValue(cleanupError);
    try {
      const response = await target.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 'preparation-cleanup', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
      });
      expect(response.status).toBe(cleanupFails ? 500 : 403);
      if (cleanupFails) {
        expect(await response.text()).toBe('Internal Server Error');
        expect(logged).toHaveBeenCalledOnce();
        const [message, failure] = defined(logged.mock.calls[0], 'the logged preparation failure');
        expect(message).toBe('POST / failed');
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).message).toBe('Turn preparation failed and its running mark could not be cleared');
        expect((failure as AggregateError).errors).toEqual([preparationError, cleanupError]);
      } else {
        expect(await response.json()).toEqual({ detail: 'Turn credentials denied' });
        expect(logged).not.toHaveBeenCalled();
      }
      expect(target.agentcore.invocations()).toEqual([]);
      const recorded = await target.sessionMetadata.get('account-1', 'preparation-cleanup');
      if (cleanupFails) expect(recorded).toMatchObject({ turn_run_id: 'run-1' });
      else expect(recorded).not.toHaveProperty('turn_run_id');
    } finally {
      ended.mockRestore();
      logged.mockRestore();
      await target.stop();
    }
  });
});

describe('the Cartridge account-history ownership hook', () => {
  it('recognizes a Session the account started through a Turn', async () => {
    await chat('hook-owner', 'hook-owned');

    expect(await stack.history.owns('hook-owner', 'hook-owned')).toBe(true);
  });

  it('rejects an unknown Session and a Session belonging to another account', async () => {
    await chat('hook-other-owner', 'hook-other-session');

    expect(await stack.history.owns('hook-intruder', 'hook-unknown')).toBe(false);
    expect(await stack.history.owns('hook-intruder', 'hook-other-session')).toBe(false);
  });

  it('stops recognizing a Session after its owner deletes it', async () => {
    await chat('hook-deleter', 'hook-deleted');
    const response = await as('hook-deleter', '/threads/hook-deleted', 'DELETE');

    expect(response.status).toBe(204);
    expect(await stack.history.owns('hook-deleter', 'hook-deleted')).toBe(false);
  });
});

describe('GET /threads', () => {
  it("lists the account's Sessions, most recent activity first", async () => {
    await chat('lister', 'list-older', 'list-newer', 'list-older');

    const response = await as('lister', '/threads');

    expect(response.status).toBe(200);
    const { threads } = await response.json();
    expect(threads).toEqual([
      { id: 'list-older', title: 'about list-older', created_at: expect.stringMatching(TIMESTAMP), updated_at: expect.stringMatching(TIMESTAMP) },
      { id: 'list-newer', title: 'about list-newer', created_at: expect.stringMatching(TIMESTAMP), updated_at: expect.stringMatching(TIMESTAMP) },
    ]);
  });

  it("keeps each account's Sessions to itself", async () => {
    await chat('first', 'isolated-first');
    await chat('second', 'isolated-second');

    expect(await threadIds('first')).toEqual(['isolated-first']);
    expect(await threadIds('second')).toEqual(['isolated-second']);
  });
});

describe('GET /threads/{id}', () => {
  it("replays the Session's messages from the session API under its filing user", async () => {
    await chat('replayer', 'replayed');
    const messages = [
      { id: 'm1', role: 'user', content: 'about replayed' },
      { id: 'm2', role: 'assistant', content: 'an answer' },
    ];
    stack.sessionApi.reply('replayed', 200, { messages });

    const response = await as('replayer', '/threads/replayed');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'replayed',
      title: 'about replayed',
      provider: 'openai',
      created_at: expect.stringMatching(TIMESTAMP),
      updated_at: expect.stringMatching(TIMESTAMP),
      messages,
      running: false,
    });
    expect(stack.sessionApi.events()).toContainEqual({ operation: 'get', sessionId: 'replayed', userId: 'filed-replayer', contains: 'run-1' });
  });

  // A page reloaded mid-Turn waited for a focus to see its reply; it polls while the Session's Turn runs.
  it.each([
    ['a Turn that started a minute ago', 'running-recent', 60_000, true],
    ['a mark older than any Turn can run, as when its task died', 'running-stale', 2 * 3_600_000, false],
  ])('says the Session runs for %s', async (_label, sessionId, age, running) => {
    await chat('runner', sessionId);
    await markRunning('runner', sessionId, new Date(Date.now() - age).toISOString());
    stack.sessionApi.reply(sessionId, 200, { messages: [] });

    const replayed = (await (await as('runner', `/threads/${sessionId}`)).json()) as Record<string, unknown>;
    expect(replayed.running).toBe(running);
    // The page's Stop names the run it stops.
    expect(replayed.runId).toBe(running ? 'run-running' : undefined);
    expect(stack.sessionApi.events()).toContainEqual({
      operation: 'get',
      sessionId,
      userId: 'filed-runner',
      ...(running ? {} : { contains: 'run-1' }),
    });
  });

  it('does not reveal a Session the account does not own', async () => {
    await chat('owner', 'someone-elses');

    const response = await as('intruder', '/threads/someone-elses');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'Session not found' });
  });

  it('passes a session API failure through as its HttpError', async () => {
    await chat('reader', 'events-gone');
    stack.sessionApi.reply('events-gone', 404, { error: 'No events for the Session' });

    const response = await as('reader', '/threads/events-gone');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'No events for the Session' });
  });
});

describe('DELETE /threads/{id}', () => {
  it('removes the Session at once and purges its events in the background', async () => {
    await chat('deleter', 'deleted', 'kept');

    const response = await as('deleter', '/threads/deleted', 'DELETE');

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await threadIds('deleter')).toEqual(['kept']);
    expect((await as('deleter', '/threads/deleted')).status).toBe(404);
    await expect
      .poll(() => stack.sessionApi.events())
      .toContainEqual({ operation: 'purge', sessionId: 'deleted', userId: 'filed-deleter' });
  });

  it("leaves another account's Session untouched and purges nothing", async () => {
    await chat('keeper', 'not-yours-to-delete');

    const response = await as('intruder', '/threads/not-yours-to-delete', 'DELETE');

    expect(response.status).toBe(204);
    expect(await threadIds('keeper')).toEqual(['not-yours-to-delete']);
    expect((await as('keeper', '/threads/not-yours-to-delete')).status).toBe(200);
    expect(stack.sessionApi.events().filter(({ operation }) => operation === 'purge')).not.toContainEqual(
      expect.objectContaining({ sessionId: 'not-yours-to-delete' }),
    );
  });
});

/** Mark the Session's Turn, `run-running`, running since `since`, as a relay still streaming it leaves it. */
async function markRunning(account: string, sessionId: string, since: string): Promise<void> {
  await DynamoDBDocumentClient.from(stack.table.client).send(
    new UpdateCommand({
      TableName: stack.table.name,
      Key: { pk: `SESSIONS#${account}`, sk: `SESSION#${sessionId}` },
      UpdateExpression: 'SET turn_running_since = :since, turn_run_id = :run_id',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':since': since, ':run_id': 'run-running' },
    }),
  );
}

async function mainChat(account: string): Promise<{ id: string; messages: unknown[] }> {
  const response = await as(account, '/main-chat');
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; messages: unknown[] };
}

describe('GET /main-chat', () => {
  it('lands the account in the same Main Chat, empty until it has Turns', async () => {
    const { id } = await mainChat('lander');

    expect(await mainChat('lander')).toEqual({ id, messages: [], running: false });
    expect(stack.sessionApi.events()).not.toContainEqual(expect.objectContaining({ sessionId: id }));
  });

  it('replays the Main Chat under its filing user once it has Turns', async () => {
    const { id } = await mainChat('main-replayer');
    await chat('main-replayer', id);
    const messages = [{ id: 'm1', role: 'user', content: `about ${id}` }];
    stack.sessionApi.reply(id, 200, { messages });

    expect(await mainChat('main-replayer')).toEqual({ id, provider: 'openai', messages, running: false });
    expect(stack.sessionApi.events()).toContainEqual({ operation: 'get', sessionId: id, userId: 'filed-main-replayer', contains: 'run-1' });
  });
});

describe('Side Chats', () => {
  it('lists every Session but the Main Chat', async () => {
    const { id } = await mainChat('sider');
    await chat('sider', id, 'side-a');

    expect(await threadIds('sider')).toEqual(['side-a']);
  });

  // The web UI no longer archives, so a Side Chat archived earlier was out of every list it shows.
  it('lists a Side Chat archived before archiving was removed', async () => {
    await chat('archived-earlier', 'archived-side', 'listed-side');
    await DynamoDBDocumentClient.from(stack.table.client).send(
      new UpdateCommand({
        TableName: stack.table.name,
        Key: { pk: 'SESSIONS#archived-earlier', sk: 'SESSION#archived-side' },
        UpdateExpression: 'SET archived_at = :at',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':at': '2026-09-01T00:00:00.000000+00:00' },
      }),
    );

    expect(await threadIds('archived-earlier')).toEqual(['listed-side', 'archived-side']);
  });

  it('refuses to delete the Main Chat', async () => {
    const { id } = await mainChat('main-keeper');
    await chat('main-keeper', id);

    const remove = await as('main-keeper', `/threads/${id}`, 'DELETE');

    expect(remove.status).toBe(409);
    expect(await remove.json()).toEqual({ detail: 'The Main Chat cannot be deleted' });
    expect((await as('main-keeper', `/threads/${id}`)).status).toBe(200);
  });
});

describe('POST /threads/{id}/stop', () => {
  const stop = (account: string, sessionId: string, body: unknown) =>
    stack.app.request(`/threads/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account': account },
      body: JSON.stringify(body),
    });
  const stopsOf = (sessionId: string) =>
    stack.agentcore
      .invocations()
      .map(({ body }) => JSON.parse(body) as { threadId: string; forwardedProps: { stop?: boolean } })
      .filter(({ threadId, forwardedProps }) => threadId === sessionId && forwardedProps.stop === true);

  it('records the incoming Turn identity until the public Turn finishes', async () => {
    const end = stack.sessionMetadata.turnEnded.bind(stack.sessionMetadata);
    let active: unknown;
    const ended = vi.spyOn(stack.sessionMetadata, 'turnEnded').mockImplementation(async (owner, sessionId, running, failure) => {
      active = await stack.sessionMetadata.get(owner, sessionId);
      await end(owner, sessionId, running, failure);
    });
    try {
      await chat('public-running-identity', 'public-turn');
      expect(active).toMatchObject({ turn_running_since: expect.any(String), turn_run_id: 'run-1' });
      expect(await stack.sessionMetadata.get('public-running-identity', 'public-turn')).not.toHaveProperty('turn_run_id');
    } finally {
      ended.mockRestore();
    }
  });

  // A reloaded chat has no streaming client: its replay must identify the Turn that Stop sends to the server.
  it.each(['Main', 'Side'])('replays the running %s Chat identity for Stop under its original filing user', async (kind) => {
    const owner = `detached-${kind}`;
    const sessionId = kind === 'Main' ? await stack.sessionMetadata.mainChat(owner) : 'detached-side';
    const runId = `running-${kind}`;
    const since = new Date().toISOString();
    await stack.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: 'original-filing-user', title: 'running', running: { startedAt: since, runId } });
    await stack.sessionMetadata.turnStarted(owner, sessionId, { startedAt: since, runId });
    stack.sessionApi.reply(sessionId, 200, { messages: [] });
    const path = kind === 'Main' ? '/main-chat' : `/threads/${sessionId}`;
    const replay = await (await as(owner, path)).json();
    expect(replay).toMatchObject({ running: true, runId });
    expect((await stop(owner, sessionId, { runId: replay.runId })).status).toBe(204);
    expect(stopsOf(sessionId)).toEqual([
      { threadId: sessionId, runId, messages: [], tools: [], context: [], state: {}, forwardedProps: { stop: true, sessionUserId: 'original-filing-user' } },
    ]);
    await stack.sessionMetadata.turnEnded(owner, sessionId, { startedAt: since, runId }, undefined);
    const ended = await (await as(owner, path)).json();
    expect(ended).toMatchObject({ running: false });
    expect(ended).not.toHaveProperty('runId');
  });

  it('keeps a detached Turn identity when Stop is refused, so the reloaded chat can retry', async () => {
    const since = new Date().toISOString();
    await stack.sessionMetadata.recordTurn('detached-refused', 'refused-turn', { filingUserId: 'original-filing-user', title: 'running', running: { startedAt: since, runId: 'refused-run' } });
    await stack.sessionMetadata.turnStarted('detached-refused', 'refused-turn', { startedAt: since, runId: 'refused-run' });
    stack.sessionApi.reply('refused-turn', 200, { messages: [] });
    stack.agentcore.script('refused-turn', { kind: 'error', status: 503, body: 'cannot stop' });
    expect((await stop('detached-refused', 'refused-turn', { runId: 'refused-run' })).status).toBe(502);
    expect(await (await as('detached-refused', '/threads/refused-turn')).json()).toMatchObject({ running: true, runId: 'refused-run' });
    stack.agentcore.script('refused-turn', { kind: 'stream', frames: [] });
    expect((await stop('detached-refused', 'refused-turn', { runId: 'refused-run' })).status).toBe(204);
    await stack.sessionMetadata.turnEnded('detached-refused', 'refused-turn', { startedAt: since, runId: 'refused-run' }, undefined);
  });

  // A page that opens the chat after its Turn failed unseen shows why.
  it.each(['Main', 'Side'])("replays why the %s Chat's latest Turn failed, with its run ID", async (kind) => {
    const owner = `failed-${kind}`;
    const sessionId = kind === 'Main' ? await stack.sessionMetadata.mainChat(owner) : 'failed-side';
    const running = { startedAt: new Date().toISOString(), runId: `failed-${kind}-run` };
    await stack.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: 'f', title: 'failing', running });
    await stack.sessionMetadata.turnEnded(owner, sessionId, running, { code: 'PROVIDER_ERROR', message: 'The provider failed' });
    stack.sessionApi.reply(sessionId, 200, { messages: [] });

    const replay = await (await as(owner, kind === 'Main' ? '/main-chat' : `/threads/${sessionId}`)).json();

    expect(replay).toMatchObject({ running: false, failure: { runId: running.runId, code: 'PROVIDER_ERROR', message: 'The provider failed' } });
  });

  it('does not expose an expired running identity', async () => {
    await stack.sessionMetadata.recordTurn('stale-detached', 'stale-run', { filingUserId: 'f', title: 'stale', running: { startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), runId: 'expired-run' } });
    stack.sessionApi.reply('stale-run', 200, { messages: [] });
    const replay = await (await as('stale-detached', '/threads/stale-run')).json();
    expect(replay).toMatchObject({ running: false });
    expect(replay).not.toHaveProperty('runId');
  });

  // Stop is the only way a Turn stops before it ends.
  it("asks the AgentCore Runtime to stop the Session's Turn under its filing user", async () => {
    await chat('stopper', 'stopped');

    const response = await stop('stopper', 'stopped', { runId: 'run-1' });

    expect(response.status).toBe(204);
    expect(stopsOf('stopped')).toEqual([
      { threadId: 'stopped', runId: 'run-1', messages: [], tools: [], context: [], state: {}, forwardedProps: { stop: true, sessionUserId: 'filed-stopper' } },
    ]);
  });

  it('does not stop a Session the account does not own', async () => {
    await chat('stop-owner', 'stop-someone-elses');

    const response = await stop('stop-intruder', 'stop-someone-elses', { runId: 'run-1' });

    expect(response.status).toBe(404);
    expect(stopsOf('stop-someone-elses')).toEqual([]);
  });

  it("needs the Turn's run ID", async () => {
    await chat('stop-runless', 'stop-runless-session');

    const response = await stop('stop-runless', 'stop-runless-session', {});

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'runId is required' });
  });
});

// A Turn's summary runs on after its stream closed, so the thread's next read reports its failure.
describe('a Turn whose summary cannot be saved', () => {
  const frameTypes = async (account: string, threadId: string) => {
    const response = await stack.app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account': account },
      body: JSON.stringify({
        threadId,
        runId: 'run-1',
        state: {},
        messages: [{ id: 'm1', role: 'user', content: `about ${threadId}` }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    expect(response.status).toBe(200);
    return (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data:'))
      .map((frame) => (JSON.parse(frame.slice(5)) as { type: string }).type);
  };

  it('relays RUN_FINISHED without waiting on the summary', async () => {
    let save = () => undefined as void;
    const saving = vi.spyOn(stack.sessionMetadata, 'saveTurnSummary').mockImplementation(async () => new Promise((resolve) => { save = resolve; }));
    try {
      expect((await frameTypes('summary-pending', 'summary-pending-turn')).at(-1)).toBe('RUN_FINISHED');
      await vi.waitFor(() => expect(saving).toHaveBeenCalled());
    } finally {
      save();
      saving.mockRestore();
    }
  });

  it('returns TURN_SUMMARY_FAILED for that Turn on the next read of the thread', async () => {
    const saving = vi.spyOn(stack.sessionMetadata, 'saveTurnSummary').mockRejectedValue(new Error('DynamoDB rejected the write'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await frameTypes('summary-unsaved', 'summary-unsaved-turn')).at(-1)).toBe('RUN_FINISHED');

      await vi.waitFor(async () => expect(await (await as('summary-unsaved', '/threads/summary-unsaved-turn')).json()).toMatchObject({
        running: false,
        failure: { runId: 'run-1', code: 'TURN_SUMMARY_FAILED', message: 'The Turn summary could not be saved: DynamoDB rejected the write' },
      }));
      expect(logged).toHaveBeenCalledWith('Turn summary failed session_id=summary-unsaved-turn', new Error('DynamoDB rejected the write'));
    } finally {
      saving.mockRestore();
      logged.mockRestore();
    }
  });
});
