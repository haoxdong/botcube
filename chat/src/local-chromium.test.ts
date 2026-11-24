import { expect, it } from 'vitest';
import { localAgentComputer } from './local-agent-computer.js';

it.each(['http://user:secret@proxy.example:3128', 'http://user@proxy.example:3128'])('refuses a proxy URL with credentials, which Chromium would drop: %s', (url) => {
  const refusal = /Chromium can't authenticate to a proxy: remove the credentials from the BotCube Config's proxy URL/;
  expect(() => localAgentComputer({
    history: { owns: async () => true, ownsMainChat: async () => false }, requester: async () => ({ owner: 'acct_1' }), env: {}, proxy: { kind: 'forward', url },
  })).toThrow(refusal);
});
