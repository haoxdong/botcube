import { request } from 'node:http';
import { expect, it } from 'vitest';
import { HttpFake } from '../test/fakes/http-fake.js';

it('closes a fake while a request body is still arriving without an unhandled rejection', async () => {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', record);
  try {
    const fake = await new HttpFake(() => undefined).listen();
    const arrived = new Promise<void>((resolve) => fake.server.once('request', () => resolve()));
    const outgoing = request(`${fake.url}/`, { method: 'POST', headers: { 'content-length': '1000000' } });
    const reset = new Promise<void>((resolve) => outgoing.on('error', () => resolve()));
    outgoing.write('partial');
    await arrived;
    await fake.close();
    await reset;
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.requests).toEqual([]);
    expect(rejections).toEqual([]);
  } finally {
    process.off('unhandledRejection', record);
  }
});
