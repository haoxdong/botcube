import { wakeService } from './parking.mjs';

const json = (/** @type {number} */ statusCode, /** @type {unknown} */ body) => ({
  statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

/**
 * @param {{ requestContext?: { http?: { method?: string } } }} event
 */
export async function answer(event, ports) {
  const service = wakeService(ports);
  const method = event.requestContext?.http?.method;
  if (method === 'GET') return json(200, await service.status());
  if (method === 'POST') return json(200, await service.wake());
  return json(405, { error: 'GET or POST' });
}

// Node.js 24 Lambdas refuse a handler with more than two parameters as callback-style.
export const handler = async (/** @type {Parameters<typeof answer>[0]} */ event) => answer(event, (await import('./aws-ports.mjs')).wakePorts());
