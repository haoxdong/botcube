import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { Hono } from 'hono';
import * as aws from '@aws-sdk/client-bedrock-agentcore';
import { BedrockAgentCoreControlClient, GetMemoryCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { HttpError } from './cartridge.js';
import type { SessionMetadata, TurnMemoryLease, TurnFailure, RunningTurn, RegisteredDispatch } from './session-metadata.js';

const issuer = 'botcube-chat';
const audience = 'botcube-turn-memory';
const lifetimeSeconds = 3600;
const leaseSchema = z.object({
  purpose: z.literal('warmup').optional(),
  owner: z.string().min(1), accountActorId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  filingUserId: z.string().regex(/^[a-zA-Z0-9_-]+$/), sessionId: z.string().min(1),
  runId: z.string().min(1), jti: z.string().uuid(), startedAt: z.string(), expiresAt: z.number().int(),
});
const eventAddress = { memoryId: z.string(), actorId: z.string(), sessionId: z.string() };
const pagination = { nextToken: z.string().optional(), maxResults: z.number().int().min(1).max(100).optional() };
const payload = z.array(z.union([
  z.object({ blob: z.string() }).strict(),
  z.object({ conversational: z.object({ content: z.object({ text: z.string() }).strict(), role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'OTHER']) }).strict() }).strict(),
]));
const metadata = z.record(z.string(), z.object({ stringValue: z.string().optional(), numberValue: z.number().optional(), booleanValue: z.boolean().optional() }).strict());
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list_events'), params: z.object({ ...eventAddress, ...pagination, includePayloads: z.boolean().optional(), filter: z.unknown().optional() }).strict() }).strict(),
  z.object({ operation: z.literal('get_event'), params: z.object({ ...eventAddress, eventId: z.string() }).strict() }).strict(),
  z.object({ operation: z.literal('create_event'), params: z.object({ ...eventAddress, eventTimestamp: z.string().datetime({ offset: true }), payload, metadata: metadata.optional(), clientToken: z.string().optional(), extractionMode: z.enum(['SKIP', 'EXTRACT']).optional() }).strict() }).strict(),
  z.object({ operation: z.literal('delete_event'), params: z.object({ ...eventAddress, eventId: z.string() }).strict() }).strict(),
  z.object({ operation: z.literal('startup_snapshot'), params: z.object({ memoryId: z.string(), actorId: z.string(), sessionIds: z.array(z.string()).max(5) }).strict() }).strict(),
  z.object({ operation: z.literal('actor_namespaces'), params: z.object({ memoryId: z.string(), actorId: z.string() }).strict() }).strict(),
  z.object({ operation: z.literal('list_memory_records'), params: z.object({ memoryId: z.string(), namespacePath: z.string(), ...pagination }).strict() }).strict(),
  z.object({ operation: z.literal('retrieve_memory_records'), params: z.object({ memoryId: z.string(), namespacePath: z.string(), searchCriteria: z.object({ searchQuery: z.string(), topK: z.number().optional() }).strict(), ...pagination }).strict() }).strict(),
  z.object({ operation: z.literal('get_memory_record'), params: z.object({ memoryId: z.string(), memoryRecordId: z.string() }).strict() }).strict(),
  z.object({ operation: z.literal('delete_memory_record'), params: z.object({ memoryId: z.string(), memoryRecordId: z.string() }).strict() }).strict(),
  z.object({ operation: z.literal('batch_update_memory_records'), params: z.object({ memoryId: z.string(), records: z.array(z.object({ memoryRecordId: z.string(), timestamp: z.string().datetime({ offset: true }), content: z.object({ text: z.string() }).strict() }).strict()).min(1).max(100), clientToken: z.string().optional() }).strict() }).strict(),
]);

type Request = z.infer<typeof requestSchema>;
const recordSummaries = z.array(z.object({ namespaces: z.array(z.string()).min(1) }).passthrough());
const recordPage = z.object({ memoryRecordSummaries: recordSummaries, nextToken: z.string().optional() });
const eventPage = z.object({ events: z.array(z.record(z.string(), z.unknown())), nextToken: z.string().optional() });
export interface MemoryBackend {
  call(operation: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}
const commands = {
  list_events: (params: never) => new aws.ListEventsCommand(params), get_event: (params: never) => new aws.GetEventCommand(params), create_event: (params: never) => new aws.CreateEventCommand(params),
  delete_event: (params: never) => new aws.DeleteEventCommand(params),
  list_memory_records: (params: never) => new aws.ListMemoryRecordsCommand(params), retrieve_memory_records: (params: never) => new aws.RetrieveMemoryRecordsCommand(params),
  get_memory_record: (params: never) => new aws.GetMemoryRecordCommand(params), delete_memory_record: (params: never) => new aws.DeleteMemoryRecordCommand(params),
  batch_update_memory_records: (params: never) => new aws.BatchUpdateMemoryRecordsCommand(params),
};

export function awsMemoryBackend(region: string): MemoryBackend {
  const client = new aws.BedrockAgentCoreClient({ region });
  const control = new BedrockAgentCoreControlClient({ region });
  return {
    async call(operation, params) {
      if (operation === 'get_memory') return await control.send(new GetMemoryCommand(params as never)) as unknown as Record<string, unknown>;
      const Command = (commands as Partial<typeof commands>)[operation as keyof typeof commands];
      if (Command === undefined) throw new Error('Unsupported Memory backend operation');
      return await client.send(Command(params as never) as aws.ListEventsCommand) as unknown as Record<string, unknown>;
    },
  };
}

function forbidden(): never { throw new HttpError(403, 'Memory access is outside this Turn'); }

function eventAllowed(lease: TurnMemoryLease, params: Record<string, unknown>, at: number): boolean {
  const checkpoint = params.actorId === lease.filingUserId &&
    (params.sessionId === lease.sessionId || params.sessionId === `${lease.sessionId}-messages`);
  if (checkpoint) return true;
  if (params.actorId !== lease.accountActorId) return false;
  if (params.sessionId === lease.sessionId) return true;
  const day = (offset: number) => new Date(at + offset).toISOString().slice(0, 10).replaceAll('-', '');
  const pending = [-86_400_000, 0, 900_000].map((offset) => `pending-memory-${day(offset)}`);
  const bucket = Math.floor(at / 300_000);
  return [...pending, `memory-saves-${bucket - 1}`, `memory-saves-${bucket}`].includes(String(params.sessionId));
}

function warmupAllowed(lease: TurnMemoryLease, request: Request): boolean {
  return request.operation === 'startup_snapshot' || (
    (request.operation === 'list_events' || request.operation === 'get_event') &&
    request.params.actorId === lease.filingUserId &&
    (request.params.sessionId === lease.sessionId || request.params.sessionId === `${lease.sessionId}-messages`)
  );
}

export class TurnMemory {
  private readonly key: Uint8Array;
  constructor(
    private readonly metadata: SessionMetadata,
    secret: string,
    private readonly memoryId: string,
    private readonly backend: MemoryBackend,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new Error('Turn Memory signing secret must contain at least 32 characters');
    this.key = new TextEncoder().encode(secret);
  }

  async start(identity: Omit<TurnMemoryLease, 'jti' | 'expiresAt'>): Promise<{ token: string; lease: TurnMemoryLease }> {
    const lease = leaseSchema.parse({ ...identity, jti: randomUUID(), expiresAt: Math.floor(new Date(identity.startedAt).getTime() / 1000) + lifetimeSeconds });
    const token = await new SignJWT(lease).setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience(audience)
      .setIssuedAt().setExpirationTime(lease.expiresAt).setJti(lease.jti).sign(this.key);
    await this.metadata.createMemoryLease(lease);
    return { token, lease };
  }

  async revoke(lease: TurnMemoryLease): Promise<void> {
    await this.metadata.endMemoryLease(lease.owner, lease.jti);
  }

  async end(lease: TurnMemoryLease | undefined, owner: string, sessionId: string, running: RunningTurn, failure: TurnFailure | undefined): Promise<void> {
    if (lease !== undefined) await this.metadata.endMemoryLease(lease.owner, lease.jti);
    await this.metadata.turnEnded(owner, sessionId, running, failure);
  }

  async authorize(token: string): Promise<TurnMemoryLease> {
    let claims: TurnMemoryLease;
    try {
      const { payload: signed } = await jwtVerify(token, this.key, { algorithms: ['HS256'], issuer, audience, currentDate: new Date(this.now()) });
      claims = leaseSchema.parse(signed);
    } catch {
      throw new HttpError(401, 'Invalid Turn Memory token');
    }
    const stored = await this.metadata.memoryLease(claims.owner, claims.jti);
    if (stored === null || stored.purpose !== claims.purpose || Object.entries(claims).some(([key, value]) => stored[key as keyof TurnMemoryLease] !== value) ||
        !await this.metadata.memorySessionActive(claims.owner, claims.sessionId, claims.filingUserId)) forbidden();
    return claims;
  }

  private async namespaces(lease: TurnMemoryLease): Promise<string[]> {
    const response = await this.backend.call('get_memory', { memoryId: this.memoryId });
    const memory = z.object({ strategies: z.array(z.object({ strategyId: z.string().regex(/^[a-zA-Z0-9_-]+$/) })) }).parse(response.memory);
    return memory.strategies.map((strategy) => `/strategies/${strategy.strategyId}/actors/${lease.accountActorId}/`);
  }

  private async ownedRecord(id: string, namespaces: string[]): Promise<Record<string, unknown>> {
    const response = await this.backend.call('get_memory_record', { memoryId: this.memoryId, memoryRecordId: id });
    const record = z.object({ namespaces: z.array(z.string()).min(1) }).passthrough().parse(response.memoryRecord);
    if (!record.namespaces.every((path) => namespaces.some((prefix) => path.startsWith(prefix)))) forbidden();
    return response;
  }

  async request(token: string, body: unknown): Promise<Record<string, unknown>> {
    const lease = await this.authorize(token);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'Invalid Turn Memory operation');
    const request = parsed.data;
    if (request.params.memoryId !== this.memoryId) forbidden();
    if (lease.purpose === 'warmup' && !warmupAllowed(lease, request)) forbidden();
    if (request.operation === 'startup_snapshot') return this.startupSnapshot(lease, request.params);
    if ('actorId' in request.params && request.operation !== 'actor_namespaces') {
      if (!eventAllowed(lease, request.params, this.now())) forbidden();
      const complete = request.operation === 'create_event' ? await this.metadata.beginDispatch(lease.owner, lease.sessionId, undefined, { startedAt: lease.startedAt, runId: lease.runId }) : undefined;
      const response = await this.backend.call(request.operation, { ...request.params, ...('eventTimestamp' in request.params ? { eventTimestamp: new Date(request.params.eventTimestamp) } : {}) });
      if (complete !== undefined) await this.completeWriter(complete);
      return response;
    }
    return this.records(lease, request);
  }

  private async completeWriter(complete: RegisteredDispatch): Promise<void> {
    if (complete.markSucceeded === undefined) throw new Error('Durable Memory writer settlement is not configured');
    await complete.markSucceeded('memory-event');
    await complete();
  }

  private async startupSnapshot(lease: TurnMemoryLease, params: Extract<Request, { operation: 'startup_snapshot' }>['params']): Promise<Record<string, unknown>> {
    const at = this.now();
    if (params.actorId !== lease.accountActorId || params.sessionIds.some((sessionId) =>
      !/^(memory-saves-\d+|pending-memory-\d{8})$/.test(sessionId) ||
      !eventAllowed(lease, { actorId: params.actorId, sessionId }, at))) forbidden();
    const records = this.namespaces(lease).then(async (namespaces) => {
      const startupNamespaces = namespaces.filter((namespace) => /^\/strategies\/[^/]*(?:userpreference|semantic)[^/]*\//i.test(namespace));
      return (await Promise.all(startupNamespaces.map((namespace) => this.recordPages(namespace, namespaces)))).flat();
    });
    const events = Promise.all(params.sessionIds.map(async (sessionId) =>
      [sessionId, await this.eventPages(params.actorId, sessionId)] as const));
    const [memoryRecordSummaries, eventEntries] = await Promise.all([records, events]);
    return { memoryRecordSummaries, eventsBySession: Object.fromEntries(eventEntries) };
  }

  private async recordPages(namespacePath: string, namespaces: string[]): Promise<z.infer<typeof recordSummaries>> {
    const records: z.infer<typeof recordSummaries> = [];
    let nextToken: string | undefined;
    do {
      // Each page supplies the token required by the next request.
      // eslint-disable-next-line no-await-in-loop
      const page = recordPage.parse(await this.backend.call('list_memory_records', {
        memoryId: this.memoryId, namespacePath, maxResults: 100, ...(nextToken === undefined ? {} : { nextToken }),
      }));
      records.push(...page.memoryRecordSummaries.filter((record) =>
        record.namespaces.every((path) => namespaces.some((prefix) => path.startsWith(prefix)))));
      nextToken = page.nextToken;
    } while (nextToken !== undefined);
    return records;
  }

  private async eventPages(actorId: string, sessionId: string): Promise<z.infer<typeof eventPage>['events']> {
    const events: z.infer<typeof eventPage>['events'] = [];
    let nextToken: string | undefined;
    do {
      let response: Record<string, unknown>;
      try {
        // Each page supplies the token required by the next request.
        // eslint-disable-next-line no-await-in-loop
        response = await this.backend.call('list_events', {
          memoryId: this.memoryId, actorId, sessionId, maxResults: 100, includePayloads: true,
          ...(nextToken === undefined ? {} : { nextToken }),
        });
      } catch (error) {
        if (sessionId.startsWith('pending-memory-') && error instanceof Error && error.name === 'ResourceNotFoundException') return events;
        throw error;
      }
      const page = eventPage.parse(response);
      events.push(...page.events);
      nextToken = page.nextToken;
    } while (nextToken !== undefined);
    return events;
  }

  private async records(lease: TurnMemoryLease, request: Request): Promise<Record<string, unknown>> {
    if (request.operation === 'actor_namespaces' && request.params.actorId !== lease.accountActorId) forbidden();
    if ('namespacePath' in request.params && !request.params.namespacePath.startsWith('/strategies/')) forbidden();
    if ('namespacePath' in request.params && request.params.namespacePath === '/strategies/') forbidden();
    const namespaces = await this.namespaces(lease);
    if (request.operation === 'actor_namespaces') return { namespaces };
    if ('namespacePath' in request.params) {
      if (!namespaces.includes(request.params.namespacePath)) forbidden();
      const response = await this.backend.call(request.operation, request.params);
      const records = z.array(z.object({ namespaces: z.array(z.string()).min(1) }).passthrough()).parse(response.memoryRecordSummaries);
      return { ...response, memoryRecordSummaries: records.filter((record) => record.namespaces.every((path) => namespaces.some((prefix) => path.startsWith(prefix)))) };
    }
    if ('memoryRecordId' in request.params) {
      const response = await this.ownedRecord(request.params.memoryRecordId, namespaces);
      return request.operation === 'get_memory_record' ? response : this.backend.call(request.operation, request.params);
    }
    if (request.operation === 'batch_update_memory_records') {
      await Promise.all(request.params.records.map((record) => this.ownedRecord(record.memoryRecordId, namespaces)));
      return this.backend.call(request.operation, { ...request.params, records: request.params.records.map((record) => ({ ...record, timestamp: new Date(record.timestamp) })) });
    }
    forbidden();
  }
}

export function turnMemoryRoutes(memory: TurnMemory | null): Hono {
  const app = new Hono();
  app.post('/', async (c) => {
    try {
      if (memory === null) throw new HttpError(503, 'Turn Memory is not configured');
      const authorization = c.req.header('authorization');
      if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Turn Memory token required');
      const body = await c.req.json().catch(() => { throw new HttpError(400, 'Invalid Turn Memory JSON'); });
      return c.json(await memory.request(authorization.slice(7), body));
    } catch (error) {
      if (error instanceof HttpError) return c.json({ detail: error.detail }, error.status as 400);
      if (error instanceof Error && '$metadata' in error) {
        const sdkError = error as Error & { $metadata: { httpStatusCode?: number } };
        return c.json({ code: sdkError.name, detail: 'AgentCore Memory request failed' }, (sdkError.$metadata.httpStatusCode ?? 502) as 400);
      }
      throw error;
    }
  });
  return app;
}
