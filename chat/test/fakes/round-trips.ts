import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { vi } from 'vitest';

/** One external call: what made it, and when it started and ended. */
export interface RoundTrip {
  name: string;
  start: number;
  end: number;
}

/** The Chat Service function that made the call on this stack, or `fallback`. */
function caller(fallback: string): string {
  const frame = /at (?:async )?([\w.]+) \(\S*\/chat\/src\//.exec(new Error().stack ?? '');
  return frame?.[1] ?? fallback;
}

/**
 * `time` holds each call `latencyMs` before it goes out, so calls made together overlap and calls made in turn
 * do not, and records it in `trips`.
 */
export function roundTrips(latencyMs: number) {
  const trips: RoundTrip[] = [];
  const time = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    try {
      return await call();
    } finally {
      trips.push({ name, start, end: performance.now() });
    }
  };
  return { trips, time };
}

/** Every DynamoDB command on `client` (its Document clients share its middleware) and every `fetch`, timed. */
export function recordRoundTrips(client: DynamoDBClient, latencyMs: number): RoundTrip[] {
  const { trips, time } = roundTrips(latencyMs);
  client.middlewareStack.add((next, context) => (args) => time(caller(context.commandName ?? 'DynamoDB'), () => next(args)),
    { step: 'initialize', priority: 'high', name: 'recordRoundTrips' });
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    time(`fetch ${new URL(input instanceof Request ? input.url : input).pathname}`, () => fetch(input, init)));
  return trips;
}

/** The most of `trips` that ran one after another: each is one deeper than the deepest that ended before it started. */
export function serialDepth(trips: readonly RoundTrip[]): number {
  const depths = new Map<RoundTrip, number>();
  for (const trip of [...trips].sort((a, b) => a.start - b.start)) {
    depths.set(trip, 1 + Math.max(0, ...trips.filter((earlier) => earlier.end <= trip.start).map((earlier) => depths.get(earlier) ?? 0)));
  }
  return Math.max(0, ...depths.values());
}
