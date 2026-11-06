import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { SessionMetadata } from './session-metadata.js';
import { MAX_RUNNING_TURN_AGE_MS } from './sessions.js';

/** The chat table partition the parking Lambda reads (botcube/infra/ecs/parking, docs/runbooks/production-parking.md). */
export const PARKING_PARTITION = 'PRODUCTION_PARKING';
export const HEARTBEAT_MS = 60_000;

/** A person's request: from the web UI, not a health check, Test User, or automation that names itself in its user agent. */
export function isUserRequest(request: Request, webOrigins: readonly string[], automation: readonly string[]): boolean {
  const { pathname } = new URL(request.url);
  if (pathname === '/health' || pathname === '/ping' || pathname.startsWith('/.well-known/')) return false;
  const origin = request.headers.get('origin');
  if (origin === null || !webOrigins.includes(origin)) return false;
  if (request.headers.has('x-botcube-test-user')) return false;
  const agent = request.headers.get('user-agent') ?? '';
  return !automation.some((marker) => agent.includes(marker));
}

export const SILENT_TURN_MS = 10 * 60_000;

type Running = { readonly id: string; readonly startedAt: number; readonly relayed: boolean; activeAt: number };

export class ProductionActivity {
  readonly instance = randomUUID();
  private lastUserRequestAt: number;
  private readonly running = new Map<string, Running>();

  constructor(private readonly now: () => number = Date.now) {
    this.lastUserRequestAt = now();
  }

  userRequest(): void {
    this.lastUserRequestAt = this.now();
  }

  turnStarted(sessionKey: string, runId: string, relayed = true): void {
    const now = this.now();
    this.running.set(`${sessionKey}#${runId}`, { id: `${sessionKey.split('#').at(-1)}/${runId}`, startedAt: now, relayed, activeAt: now });
  }

  turnActive(sessionKey: string, runId: string): void {
    const turn = this.running.get(`${sessionKey}#${runId}`);
    if (turn !== undefined) turn.activeAt = this.now();
  }

  turnEnded(sessionKey: string, runId: string): void {
    this.running.delete(`${sessionKey}#${runId}`);
  }

  heartbeat() {
    const now = this.now();
    for (const [key, { id, startedAt, relayed, activeAt }] of this.running) {
      const reason = relayed && now - activeAt >= SILENT_TURN_MS ? `its Harness sent nothing for ${Math.round((now - activeAt) / 60_000)} min`
        : now - startedAt >= MAX_RUNNING_TURN_AGE_MS ? `it started ${Math.round((now - startedAt) / 60_000)} min ago` : undefined;
      if (reason === undefined) continue;
      this.running.delete(key);
      console.warn(`Production activity stopped counting Turn ${id} as running: ${reason}`);
    }
    const runningTurnIds = [...this.running.values()].map(({ id }) => id);
    return { pk: PARKING_PARTITION, sk: `ACTIVITY#${this.instance}`, at: now, lastUserRequestAt: this.lastUserRequestAt, runningTurns: runningTurnIds.length, runningTurnIds };
  }

  observe(metadata: SessionMetadata): SessionMetadata {
    const prepareTurn: SessionMetadata['prepareTurn'] = async (owner, sessionId, turn) => {
      const prepared = await metadata.prepareTurn(owner, sessionId, turn);
      if (turn.running !== undefined && turn.postAcceptance !== true) this.turnStarted(`${owner}#${sessionId}`, turn.running.runId, turn.scheduledTaskId === undefined);
      return prepared;
    };
    const turnEnded: SessionMetadata['turnEnded'] = async (owner, sessionId, running, failure) => {
      this.turnEnded(`${owner}#${sessionId}`, running.runId);
      return metadata.turnEnded(owner, sessionId, running, failure);
    };
    const turnActive: NonNullable<SessionMetadata['turnActive']> = (owner, sessionId, running) => {
      this.turnActive(`${owner}#${sessionId}`, running.runId);
    };
    return new Proxy(metadata, {
      get(target, property, receiver) {
        if (property === 'prepareTurn') return prepareTurn;
        if (property === 'turnActive') return turnActive;
        if (property === 'turnEnded') return turnEnded;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  report(
    tableName: string,
    // Stryker disable next-line ObjectLiteral: production's client; tests inject one pointed at moto
    documents = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' })),
  ): () => void {
    const write = () => documents.send(new PutCommand({ TableName: tableName, Item: this.heartbeat() })).catch((error: unknown) => {
      console.error('Production activity heartbeat failed', error);
    });
    void write();
    const timer = setInterval(() => void write(), HEARTBEAT_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
}
