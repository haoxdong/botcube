import type { AccountHistory } from 'botcube-chat';
import { expect, it } from 'vitest';
import { templateCartridge } from './cartridge.js';

const history: AccountHistory = { delete: async () => undefined, transfer: async () => undefined, ownsMainChat: async () => false,
      owns: async () => true };

it('reports a scheduled site refusal only to the task owner', async () => {
  const cartridge = templateCartridge(history);
  const first = await cartridge.routes.request('/account/session');
  const { accountId } = await first.json() as { accountId: string };
  const cookie = first.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Template account cookie is missing');
  expect(await cartridge.scheduledRequester(accountId)).toEqual({ owner: accountId });
  expect(await cartridge.signInNeeded(accountId, ['Sample item: 42'])).toBeNull();
  expect(await cartridge.signInNeeded(accountId, ['[stderr] Template site sign-in needed.\n[Command failed with exit code 1]'])).toBe('Template site sign-in needed.');
  expect(await (await cartridge.routes.request('/account/session', { headers: { Cookie: cookie } })).json()).toMatchObject({ accountId, signInNeeded: true });
  expect(await (await cartridge.routes.request('/account/session')).json()).toMatchObject({ signInNeeded: false });
});
