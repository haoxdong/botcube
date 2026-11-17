/** One external call: what made it, and when it started and ended. */
export interface RoundTrip {
  name: string;
  start: number;
  end: number;
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

/** The most of `trips` that ran one after another: each is one deeper than the deepest that ended before it started. */
export function serialDepth(trips: readonly RoundTrip[]): number {
  const depths = new Map<RoundTrip, number>();
  for (const trip of [...trips].sort((a, b) => a.start - b.start)) {
    depths.set(trip, 1 + Math.max(0, ...trips.filter((earlier) => earlier.end <= trip.start).map((earlier) => depths.get(earlier) ?? 0)));
  }
  return Math.max(0, ...depths.values());
}
