import { DISPATCH, dispatcherService, PARTITION } from './parking.mjs';

/**
 * @typedef {{ eventName?: string, dynamodb?: { NewImage?: Record<string, { S?: string, N?: string }> } }} StreamRecord
 * @param {{ op?: string, action?: 'park' | 'unpark', Records?: StreamRecord[] }} event
 */
export async function dispatch(event, resolved) {
  const service = dispatcherService(resolved);
  if (event.Records) {
    for (const { eventName, dynamodb } of event.Records) {
      const image = dynamodb?.NewImage;
      if (eventName !== 'INSERT' || image?.pk?.S !== PARTITION || !image.sk?.S?.startsWith(DISPATCH)) continue;
      const claim = { kind: image.kind?.S === 'park' ? 'park' : 'wake', day: String(image.day?.S), at: Number(image.at?.N) };
      // eslint-disable-next-line no-await-in-loop -- each request is dispatched once, in order
      await service.dispatchRequested(String(image.action?.S), claim);
      // eslint-disable-next-line no-await-in-loop -- its request is forgotten once dispatched
      await resolved.forgetRequest(claim.at);
      console.log(JSON.stringify({ dispatched: image.action?.S, at: claim.at }));
    }
    return { dispatched: true };
  }
  if (event.op === 'park' || event.op === 'unpark') {
    const execution = await resolved.dispatch(event.op);
    return { started: event.op, ...execution };
  }
  if (event.op === 'fallback' && (event.action === 'park' || event.action === 'unpark')) {
    await resolved.fallback(event.action);
    return { fallback: event.action };
  }
  if (event.op === 'idle') return service.idle();
  if (event.op === 'check') {
    const result = await service.check();
    console.log(JSON.stringify(result));
    return result;
  }
  throw new Error(`Unknown parking event ${JSON.stringify(event)}`);
}

// Node.js 24 Lambdas refuse a handler with more than two parameters as callback-style.
export const handler = async (/** @type {Parameters<typeof dispatch>[0]} */ event) => dispatch(event, (await import('./aws-ports.mjs')).dispatcherPorts());
