export const IDLE_MS = 30 * 60_000;
const HEARTBEAT_FRESH_MS = 3 * 60_000;
export const WAKES_PER_DAY = 20;
const WAKE_DEBOUNCE_MS = 15 * 60_000;
const PARK_DEBOUNCE_MS = 10 * 60_000;
export const PARTITION = 'PRODUCTION_PARKING';
export const ACTIVITY = 'ACTIVITY#';
export const DISPATCH = 'DISPATCH#';

/**
 * @typedef {'park' | 'unpark'} Action
 * @typedef {{ kind: 'park' | 'wake', day: string, at: number }} Claim
 * @typedef {{ instance: string, at: number, lastUserRequestAt: number, runningTurns: number, runningTurnIds: string[] }} Heartbeat
 * @typedef {{
 *   now(): number,
 *   paused(): Promise<boolean>,
 *   claim(claim: Claim, cap: number, debounceMs: number): Promise<'claimed' | 'debounced' | 'capped'>,
 *   release(claim: Claim): Promise<void>,
 *   lastClaim(kind: Claim['kind'], day: string): Promise<number | null>,
 *   requestDispatch(action: Action, claim: Claim): Promise<void>,
 * }} WakePorts
 * @typedef {WakePorts & {
 *   state(): Promise<'live' | 'parked'>,
 *   originClaimed(): Promise<boolean>,
 *   heartbeats(): Promise<Heartbeat[]>,
 *   forget(instances: string[]): Promise<void>,
 *   dispatch(action: Action): Promise<void>,
 * }} DispatcherPorts
 */

const day = (/** @type {number} */ at) => new Date(at).toISOString().slice(0, 10);

export function wakeService(/** @type {WakePorts} */ ports) {
  const status = async () => {
    if (!await ports.paused()) return { state: 'live' };
    const now = ports.now();
    const last = await ports.lastClaim('wake', day(now));
    return last !== null && now - last < WAKE_DEBOUNCE_MS ? { state: 'waking', since: new Date(last).toISOString() } : { state: 'parked' };
  };
  return {
    status,
    async wake() {
      if (!await ports.paused()) return { state: 'live' };
      const now = ports.now();
      /** @type {Claim} */
      const claim = { kind: 'wake', day: day(now), at: now };
      const claimed = await ports.claim(claim, WAKES_PER_DAY, WAKE_DEBOUNCE_MS);
      if (claimed === 'capped') return { state: 'limit', limit: WAKES_PER_DAY };
      if (claimed === 'claimed') await ports.requestDispatch('unpark', claim);
      return status();
    },
  };
}

export function dispatcherService(/** @type {DispatcherPorts} */ ports) {
  const dispatchUnder = async (/** @type {Action} */ action, /** @type {Claim} */ claim) => {
    if (action !== 'park' && action !== 'unpark') throw new Error(`Refusing to dispatch ${JSON.stringify(action)}`);
    try {
      await ports.dispatch(action);
    } catch (error) {
      await ports.release(claim);
      throw error;
    }
  };

  const idle = async () => {
    const now = ports.now();
    const beats = await ports.heartbeats();
    const fresh = beats.filter(({ at }) => now - at <= HEARTBEAT_FRESH_MS);
    await ports.forget(beats.filter(({ at }) => now - at > IDLE_MS * 2).map(({ instance }) => instance));
    if (fresh.length === 0) return { idle: false, reason: 'no Chat Service heartbeat in the last 3 minutes' };
    const running = fresh.reduce((sum, { runningTurns }) => sum + runningTurns, 0);
    if (running > 0) {
      const turns = fresh.flatMap(({ instance, runningTurnIds }) => runningTurnIds.map((id) => `${id} on ${instance}`));
      return { idle: false, reason: `${running} Turn(s) running${turns.length === 0 ? '' : `: ${turns.join(', ')}`}` };
    }
    const quietMs = now - Math.max(...fresh.map(({ lastUserRequestAt }) => lastUserRequestAt));
    if (quietMs < IDLE_MS) return { idle: false, reason: `last user request ${Math.round(quietMs / 60_000)} min ago` };
    return { idle: true, reason: `no user request for ${Math.round(quietMs / 60_000)} min and no Turn running` };
  };

  return {
    idle,
    dispatchRequested: dispatchUnder,
    async check() {
      if (await ports.state() !== 'live') return { action: 'none', reason: 'production is not Live' };
      if (await ports.originClaimed()) return { action: 'none', reason: 'a session holds the origin slot' };
      const verdict = await idle();
      if (!verdict.idle) return { action: 'none', reason: verdict.reason };
      const now = ports.now();
      /** @type {Claim} */
      const claim = { kind: 'park', day: day(now), at: now };
      if (await ports.claim(claim, Number.POSITIVE_INFINITY, PARK_DEBOUNCE_MS) !== 'claimed') {
        return { action: 'none', reason: 'a park was asked for in the last 10 minutes' };
      }
      await dispatchUnder('park', claim);
      return { action: 'park', reason: verdict.reason };
    },
  };
}
