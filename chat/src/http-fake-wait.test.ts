import { expect, it } from 'vitest';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';

const posts = (fake: HttpFake) => fake.requests.filter((request) => request.path === '/post').length;

it('waits for requests the fake records later, and returns at once for ones it already recorded', async () => {
  const fake = await new HttpFake((_request, response) => sendJson(response, 200, {})).listen();
  try {
    let settled = false;
    const second = fake.waitForRequests(() => posts(fake) >= 2).then(() => { settled = true; });
    await fetch(`${fake.url}/post`, { method: 'POST' });
    await fetch(`${fake.url}/other`);
    expect(settled).toBe(false);
    await fetch(`${fake.url}/post`, { method: 'POST' });
    await second;
    await fake.waitForRequests(() => posts(fake) === 2);
    expect(posts(fake)).toBe(2);
  } finally {
    await fake.close();
  }
});
