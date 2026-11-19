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

it('rejects the retired GitHub fallback operation', async () => {
  const { ports, requests } = production();
  await expect(dispatch({ op: 'fallback', action: 'unpark' }, ports)).rejects.toThrow('Unknown parking event');
  expect(requests).toEqual([]);
});
