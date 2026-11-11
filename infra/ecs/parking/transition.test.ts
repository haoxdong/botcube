import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { InvokeCommand } from '@aws-sdk/client-lambda';
// @ts-expect-error -- Lambda source is packaged as JavaScript.
import { dispatcherPorts } from './aws-ports.mjs';
// @ts-expect-error -- Lambda source is packaged as JavaScript.
import { dispatch } from './dispatcher.mjs';

afterEach(() => vi.unstubAllEnvs());

function production(refused = false) {
  vi.stubEnv('CHAT_TABLE', 'chat');
  vi.stubEnv('TRANSITION_FUNCTION', 'parking-transition');
  const requests: InvokeCommand['input'][] = [];
  const ports = dispatcherPorts({ lambda: {
    async send(command: InvokeCommand) {
      requests.push(command.input);
      return refused ? { FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"stack is updating"}') }
        : { Payload: Buffer.from('{"executionArn":"accepted"}') };
    },
  } });
  return { ports, requests };
}

it('the dispatcher starts the AWS transition through the serialized Lambda entry', async () => {
  const { ports, requests } = production();
  expect(await dispatch({ op: 'unpark' }, ports)).toEqual({ started: 'unpark', executionArn: 'accepted' });
  expect(requests).toEqual([{ FunctionName: 'parking-transition', InvocationType: 'RequestResponse',
    Payload: Buffer.from('{"action":"unpark","op":"start"}') }]);
});

it('a refused transition reaches the caller as a failure', async () => {
  const { ports } = production(true);
  await expect(dispatch({ op: 'unpark' }, ports)).rejects.toThrow('stack is updating');
});

it('a stack mismatch is reported as transition incomplete by the dispatcher check', async () => {
  const { ports } = production();
  ports.state = async () => 'transition incomplete';
  expect(await dispatch({ op: 'check' }, ports)).toEqual({ action: 'none', reason: 'transition incomplete' });
});


it('the dispatcher reads transition incomplete through its AWS boundary', async () => {
  vi.stubEnv('CHAT_TABLE', 'chat');
  vi.stubEnv('PARK_STATE_PARAMETER', '/state');
  vi.stubEnv('TRANSITION_FUNCTION', 'transition');
  const ports = dispatcherPorts({
    ssm: { async send() { return { Parameter: { Value: 'parked' } }; } },
    lambda: { async send(command: InvokeCommand) {
      expect(JSON.parse(Buffer.from(command.input.Payload ?? []).toString())).toEqual({ op: 'state', stored: 'parked' });
      return { Payload: Buffer.from('{"state":"transition incomplete"}') };
    } },
  });
  expect(await dispatch({ op: 'check' }, ports)).toEqual({ action: 'none', reason: 'transition incomplete' });
});

it.each([204, 403])('the explicit fallback uses GitHub independently of the transition Lambda with HTTP %s', async status => {
  vi.stubEnv('CHAT_TABLE', 'chat');
  vi.stubEnv('GITHUB_APP_SECRET', 'github');
  vi.stubEnv('REPOSITORY', 'owner/repo');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests: { url: string; body?: string }[] = [];
  const ports = dispatcherPorts({
    secrets: { async send() { return { SecretString: JSON.stringify({ app_id: '1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) }; } },
    fetch: async (url: string, options?: RequestInit) => {
      requests.push({ url, body: typeof options?.body === 'string' ? options.body : undefined });
      if (url.endsWith('/installation')) return Response.json({ id: 2 });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      return new Response(null, { status });
    },
  });
  const result = dispatch({ op: 'fallback', action: 'unpark' }, ports);
  if (status === 204) expect(await result).toEqual({ fallback: 'unpark' });
  else await expect(result).rejects.toThrow('GitHub refused the unpark dispatch with HTTP 403');
  expect(requests.at(-1)).toEqual({ url: 'https://api.github.com/repos/owner/repo/dispatches', body: '{"event_type":"park-production","client_payload":{"action":"unpark"}}' });
});
