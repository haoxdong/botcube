import { DescribeTasksCommand, ECSClient, type DescribeTasksCommandOutput } from '@aws-sdk/client-ecs';
import { SQSClient } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defined } from '../test/defined.js';
import { SchedulerView, createScheduledRuns } from '../test/fakes/scheduler.js';
import { ecsTaskDraining, pollScheduledRuns, sqsRunQueue, type RunQueue } from './scheduled-runs.js';
import { type ScheduledRunMessage } from './scheduled-tasks.js';
import { motoAws, motoEndpoint } from '../test/fakes/moto.js';
import { eventually } from '../test/eventually.js';


describe('pollScheduledRuns', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A queue holding these deliveries, then none until the poller stops. */
  function queue(...bodies: string[]) {
    const deliveries = bodies.map((body, n) => [{ body, receipt: `receipt-${n}`, deliveryId: `delivery-${n}`, firedAt: new Date(0) }]);
    const deleted: string[] = [];
    const signals: AbortSignal[] = [];
    let receives = 0;
    const fake: RunQueue = {
      receive: async (signal) => {
        receives += 1;
        signals.push(signal);
        const next = deliveries.shift();
        if (next) return next;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      delete: async (receipt) => {
        deleted.push(receipt);
      },
    };
    return { fake, deleted, signals, receives: () => receives };
  }

  const neverDraining = async () => false;

  it('receives healthy deliveries while expiration maintenance is still pending', async () => {
    let releaseMaintenance!: () => void;
    const heldMaintenance = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    let maintenancePending = false;
    let maintenanceStarts = 0;
    const { fake, deleted, receives } = queue('{"owner":"healthy-owner","taskId":"healthy-task"}');
    const runs: ScheduledRunMessage[] = [];
    const stop = pollScheduledRuns(fake, async (message) => {
      runs.push(message);
    }, neverDraining, undefined, async () => {
      maintenanceStarts += 1;
      maintenancePending = true;
      await heldMaintenance;
      maintenancePending = false;
    });

    try {
      await eventually(() => {
        expect(runs).toEqual([{ owner: 'healthy-owner', taskId: 'healthy-task', deliveryId: 'delivery-0', firedAt: new Date(0) }]);
        expect(deleted).toEqual(['receipt-0']);
        expect(maintenancePending).toBe(true);
        expect(receives()).toBe(2);
        expect(maintenanceStarts).toBe(1);
      });
    } finally {
      releaseMaintenance();
      stop();
    }
  });

  it('aborts receiving and reports a delayed maintenance failure after acknowledging healthy work', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectMaintenance!: (error: Error) => void;
    const heldMaintenance = new Promise<void>((_, reject) => { rejectMaintenance = reject; });
    const failure = new Error('Expiry storage unavailable');
    const failed = vi.fn();
    const { fake, deleted, receives, signals } = queue('{"owner":"healthy-owner","taskId":"healthy-task"}');
    const runs: ScheduledRunMessage[] = [];
    const stop = pollScheduledRuns(fake, async (message) => {
      runs.push(message);
    }, neverDraining, failed, () => heldMaintenance);

    try {
      await eventually(() => {
        expect(deleted).toEqual(['receipt-0']);
        expect(receives()).toBe(2);
      });
      rejectMaintenance(failure);
      await eventually(() => expect(failed).toHaveBeenCalledWith(failure));
      expect(runs).toEqual([{ owner: 'healthy-owner', taskId: 'healthy-task', deliveryId: 'delivery-0', firedAt: new Date(0) }]);
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
      expect(errors).toHaveBeenCalledWith('Scheduled runs stopped: expired task maintenance failed', failure);
      expect(deleted).toEqual(['receipt-0']);
      expect(receives()).toBe(2);
    } finally {
      stop();
    }
  });

  it('keeps healthy work moving between maintenance runs and resumes maintenance after a minute', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const releases: (() => void)[] = [];
    const waits = Array.from({ length: 3 }, () => new Promise<void>((resolve) => { releases.push(resolve); }));
    const { fake, deleted, receives } = queue(
      '{"owner":"healthy-owner","taskId":"first"}',
      '{"owner":"healthy-owner","taskId":"second"}',
      '{"owner":"healthy-owner","taskId":"third"}',
    );
    const receive = fake.receive;
    let waiting = 0;
    const runs: ScheduledRunMessage[] = [];
    const maintenance = vi.fn(async () => undefined);
    const stop = pollScheduledRuns({
      ...fake,
      receive: async (signal) => {
        const wait = waits[waiting++];
        if (wait) await wait;
        return receive(signal);
      },
    }, async (message) => { runs.push(message); }, neverDraining, undefined, maintenance);

    try {
      await eventually(() => expect(waiting).toBe(1));
      defined(releases[0], 'first receive')();
      await eventually(() => expect(waiting).toBe(2));
      defined(releases[1], 'second receive')();
      await eventually(() => {
        expect(waiting).toBe(3);
        expect(deleted).toEqual(['receipt-0', 'receipt-1']);
      });
      expect(maintenance).toHaveBeenCalledTimes(1);
      now = 61_000;
      defined(releases[2], 'third receive')();
      await eventually(() => expect(receives()).toBe(4));
      expect(maintenance).toHaveBeenCalledTimes(2);
      expect(deleted).toEqual(['receipt-0', 'receipt-1', 'receipt-2']);
      expect(runs).toEqual([
        { owner: 'healthy-owner', taskId: 'first', deliveryId: 'delivery-0', firedAt: new Date(0) },
        { owner: 'healthy-owner', taskId: 'second', deliveryId: 'delivery-1', firedAt: new Date(0) },
        { owner: 'healthy-owner', taskId: 'third', deliveryId: 'delivery-2', firedAt: new Date(0) },
      ]);
    } finally {
      releases.forEach((release) => release());
      stop();
    }
  });

  it('settles expired tasks before receiving without requiring a scheduled delivery', async () => {
    const events: string[] = [];
    const maintenance = vi.fn(async () => { events.push('maintenance'); });
    let received = false;
    const stop = pollScheduledRuns({
      receive: async (signal) => {
        if (!received) { received = true; events.push('receive'); return []; }
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      delete: async () => undefined,
    }, async () => undefined, neverDraining, undefined, maintenance);
    await eventually(() => expect(events.slice(0, 2)).toEqual(['maintenance', 'receive']));
    stop();
  });

  it('stops and reports expiration maintenance failure without deleting queued work', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, deleted, receives } = queue('{"owner":"a","taskId":"t1"}');
    const failure = new Error('Expiry storage unavailable');
    const failed = vi.fn();
    const run = vi.fn();
    const stop = pollScheduledRuns(fake, run, neverDraining, failed, async () => { throw failure; });
    await eventually(() => expect(failed).toHaveBeenCalledWith(failure));
    expect(errors).toHaveBeenCalledWith('Scheduled runs stopped: expired task maintenance failed', failure);
    expect(deleted).toEqual([]);
    expect(receives()).toBe(0);
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it('finishes a message claimed while a long receive was in flight before stopping for drain', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let draining = false;
    const receive = vi.fn(async () => {
      draining = true;
      return [{ body: '{"owner":"a","taskId":"t1"}', receipt: 'in-flight', deliveryId: 'claimed', firedAt: new Date(0) }];
    });
    const remove = vi.fn(async () => undefined);
    const run = vi.fn(async () => undefined);
    const stop = pollScheduledRuns({ receive, delete: remove }, run, async () => draining, undefined, async () => undefined);
    try {
      await eventually(() => expect(remove).toHaveBeenCalledWith('in-flight'));
      expect(run).toHaveBeenCalledWith({ owner: 'a', taskId: 't1', deliveryId: 'claimed', firedAt: new Date(0) });
      expect(receive).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith('This Chat Service task is draining; it takes no more scheduled runs');
    } finally { stop(); }
  });

  it('stops and reports queue infrastructure failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('SQS unavailable');
    const failed = vi.fn();
    const run = vi.fn();
    const receive = vi.fn(async () => { throw failure; });
    const stop = pollScheduledRuns({ receive, delete: async () => undefined }, run, neverDraining, failed);
    await eventually(() => expect(failed).toHaveBeenCalledWith(failure));
    expect(errors).toHaveBeenCalledWith('Scheduled runs stopped: queue receive failed', failure);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it('runs each delivery and then deletes it', async () => {
    const { fake, deleted } = queue('{"owner":"a","taskId":"t1"}', '{"owner":"b","taskId":"t2"}');
    const runs: ScheduledRunMessage[] = [];

    const stop = pollScheduledRuns(
      fake,
      async (message) => {
        runs.push(message);
      },
      neverDraining,
    );

    await eventually(() => expect(deleted).toEqual(['receipt-0', 'receipt-1']));
    expect(runs).toEqual([
      { owner: 'a', taskId: 't1', deliveryId: 'delivery-0', firedAt: new Date(0) },
      { owner: 'b', taskId: 't2', deliveryId: 'delivery-1', firedAt: new Date(0) },
    ]);
    stop();
  });

  it('leaves a failed run on the queue, logs it, and receives again after five seconds', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, deleted, receives } = queue('{"owner":"a","taskId":"t1"}');
    const failure = new Error('AgentCore is down');

    const stop = pollScheduledRuns(
      fake,
      async () => {
        throw failure;
      },
      neverDraining,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenCalledWith('Scheduled run failed', failure);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(receives()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(receives()).toBe(2);
    expect(deleted).toEqual([]);
    stop();
  });

  it('stops receiving, without logging, once stopped', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, receives, signals } = queue();

    const stop = pollScheduledRuns(fake, async () => undefined, neverDraining);
    await eventually(() => expect(receives()).toBe(1));
    stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(receives()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('takes no more runs once its task is draining, so a deploy hands them to the new revision', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { fake, deleted, receives } = queue('{"owner":"a","taskId":"t1"}', '{"owner":"b","taskId":"t2"}');
    let draining = false;

    pollScheduledRuns(
      fake,
      async () => {
        draining = true;
      },
      async () => draining,
    );

    await eventually(() => expect(logs).toHaveBeenCalledWith('This Chat Service task is draining; it takes no more scheduled runs'));
    expect(deleted).toEqual(['receipt-0']);
    expect(receives()).toBe(1);
  });

  it('stops before receiving and propagates an unanswered drain check to service health', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fake, receives } = queue('{"owner":"a","taskId":"t1"}');
    const failure = new Error('ECS DescribeTasks is unreachable');
    const failed = vi.fn();
    const run = vi.fn();
    const stop = pollScheduledRuns(fake, run, async () => { throw failure; }, failed);

    await eventually(() => expect(failed).toHaveBeenCalledWith(failure));
    expect(receives()).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith('Scheduled runs stopped: cannot tell whether this task is draining', failure);
    stop();
  });

});

describe('ecsTaskDraining', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const metadataUri = 'http://169.254.170.2/v4/container';
  const cluster = 'arn:aws:ecs:us-east-1:123456789012:cluster/chat';
  const taskArn = 'arn:aws:ecs:us-east-1:123456789012:task/chat/0123456789abcdef';

  const metadata = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status }));

  /** An ECS client whose DescribeTasks answers these tasks. */
  function ecs(tasks: DescribeTasksCommandOutput['tasks']) {
    const client = new ECSClient({ region: 'us-east-1' });
    const send = vi.spyOn(client, 'send').mockImplementation(async () => ({ tasks, failures: [], $metadata: {} }));
    return { client, send };
  }

  it.each([
    ['metadata HTTP failure', 'ECS task metadata answered HTTP 503'],
    ['malformed metadata', 'ECS task metadata has no Cluster or TaskARN'],
    ['metadata network failure', 'metadata refused'],
    ['ECS denial', 'DescribeTasks refused'],
  ])('stops queue admission and reports %s', async (kind, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = metadata({ Cluster: cluster, TaskARN: taskArn });
    const { client, send } = ecs([{ taskArn, desiredStatus: 'RUNNING' }]);
    if (kind === 'metadata HTTP failure') fetch.mockResolvedValue(new Response(null, { status: 503 }));
    if (kind === 'malformed metadata') fetch.mockResolvedValue(new Response('{}'));
    if (kind === 'metadata network failure') fetch.mockRejectedValue(new Error('metadata refused'));
    if (kind === 'ECS denial') send.mockRejectedValue(new Error('DescribeTasks refused'));
    const receive = vi.fn<RunQueue['receive']>(() => new Promise(() => undefined));
    const failed = vi.fn();
    const stop = pollScheduledRuns({ receive, delete: async () => undefined }, async () => undefined, ecsTaskDraining(metadataUri, client), failed);
    try {
      await eventually(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message })));
      expect(receive).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('is never draining outside ECS', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { client, send } = ecs([]);

    expect(await ecsTaskDraining(undefined, client)()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('follows the desired status ECS describes for its own task, named by its task metadata', async () => {
    const fetch = metadata({ Cluster: cluster, TaskARN: taskArn, DesiredStatus: 'RUNNING' });
    const running = ecs([{ taskArn, desiredStatus: 'RUNNING' }]);

    expect(await ecsTaskDraining(metadataUri, running.client)()).toBe(false);
    expect(fetch).toHaveBeenCalledWith(`${metadataUri}/task`, { signal: expect.any(AbortSignal) });
    const [command, options] = running.send.mock.calls[0] as unknown as [DescribeTasksCommand, { abortSignal: AbortSignal }];
    expect(command).toBeInstanceOf(DescribeTasksCommand);
    expect(command.input).toEqual({ cluster, tasks: [taskArn] });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    // The metadata still says RUNNING while the deploy drains it; ECS says STOPPED.
    expect(await ecsTaskDraining(metadataUri, ecs([{ taskArn, desiredStatus: 'STOPPED' }]).client)()).toBe(true);
  });

  it('fails when it cannot name its task or ECS does not describe it', async () => {
    const { client } = ecs([]);
    metadata({}, 500);
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow('ECS task metadata answered HTTP 500');
    metadata({ Cluster: cluster });
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow('ECS task metadata has no Cluster or TaskARN');
    metadata({ TaskARN: taskArn });
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow('ECS task metadata has no Cluster or TaskARN');
    metadata({ Cluster: cluster, TaskARN: taskArn });
    await expect(ecsTaskDraining(metadataUri, client)()).rejects.toThrow(`ECS describes no desired status for task ${taskArn}`);
    await expect(ecsTaskDraining(metadataUri, ecs(undefined).client)()).rejects.toThrow(`ECS describes no desired status for task ${taskArn}`);
    await expect(ecsTaskDraining(metadataUri, ecs([{ taskArn }]).client)()).rejects.toThrow(`ECS describes no desired status for task ${taskArn}`);
  });
});

describe('the SQS run queue', () => {
  it('dates each run by when its schedule sent it, however late it is received', async () => {
    const client = { send: async () => ({ Messages: [{ Body: '{"owner":"a","taskId":"t1"}', ReceiptHandle: 'receipt-1', MessageId: 'm', Attributes: { SentTimestamp: '1793000000000' } }] }) } as unknown as SQSClient;

    expect(await sqsRunQueue('https://queue.test/runs', client).receive(new AbortController().signal)).toEqual([
      { body: '{"owner":"a","taskId":"t1"}', receipt: 'receipt-1', deliveryId: 'm', firedAt: new Date(1793000000000) },
    ]);
  });

  it.each([
    ['a body', { ReceiptHandle: 'receipt-1', MessageId: 'm', Attributes: { SentTimestamp: '1' } }],
    ['a receipt handle', { Body: '{"owner":"a","taskId":"t1"}', MessageId: 'm', Attributes: { SentTimestamp: '1' } }],
    ['a stable message identity', { Body: '{"owner":"a","taskId":"t1"}', ReceiptHandle: 'receipt-1', Attributes: { SentTimestamp: '1' } }],
    ['the time its schedule sent it', { Body: '{"owner":"a","taskId":"t1"}', ReceiptHandle: 'receipt-1', MessageId: 'm' }],
  ])('refuses a delivery without %s', async (_missing, message) => {
    const client = { send: async () => ({ Messages: [message] }) } as unknown as SQSClient;

    await expect(sqsRunQueue('https://queue.test/runs', client).receive(new AbortController().signal)).rejects.toThrow(
      'Scheduled run delivery is missing its Body, ReceiptHandle, MessageId or SentTimestamp',
    );
  });

  it('abandons a receive once its signal aborts, leaving the run queued', async () => {
    const endpoint = motoEndpoint();
    const runs = await createScheduledRuns(endpoint);
    const view = new SchedulerView(endpoint, runs);
    await view.deliver('{"owner":"a","taskId":"t1"}');
    const client = new SQSClient(motoAws());

    await expect(sqsRunQueue(runs.queueUrl, client).receive(AbortSignal.abort())).rejects.toThrow();

    expect(await view.queued()).toBe(1);
  });
});
