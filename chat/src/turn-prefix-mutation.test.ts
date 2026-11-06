import { describe, expect, it } from 'vitest';
import { sseFrameData, turnCredentialGuard, turnCredentials } from './turn-stream.js';

const text = (delta: string, messageId = 'answer') => ({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
const start = (messageId = 'answer') => ({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
const snapshot = (messages: unknown[]) => ({ type: 'MESSAGES_SNAPSHOT', messages });

describe('Turn credential prefix boundaries', () => {
  it('removes only the optional leading SSE data space', () => {
    expect(sseFrameData(['data:answer has spaces', 'data:  indented', 'event: custom'])).toBe('answer has spaces\n indented');
  });

  it('collects only supplied, nonempty credentials and URL query values', () => {
    expect(turnCredentials({}, ['missing'])).toEqual([]);
    expect(turnCredentials({ files: [], cdp: 'ordinary text' }, ['cdp'])).toEqual(['ordinary text']);
    expect(turnCredentials({ files: { accessKeyId: 'key', secretAccessKey: '', sessionToken: null }, cdp: 'ws://computer/cdp?token=&other=value' }, ['cdp'])).toEqual(['key', 'ws://computer/cdp?token=&other=value', 'value']);
  });

  it.each([
    ['literal', ['private-token'], 'answer private-', 'token'],
    ['encoded first character after an explanation', ['ws://computer/cdp?token=cdp.signed.token'], 'Unrelated long explanation before the value:%63', 'dp.signed.token'],
    ['encoded query escape', ['ws://computer/cdp?token=cdp.signed.token'], 'answer cdp%2', 'Esigned.token'],
    ['encoded first character after unrelated text', ['ws://computer/cdp?token=cdp.signed.token'], 'unrelated-long-prefix%63', 'dp.signed.token'],
    ['URL query plus escape', ['ws://computer/cdp?token=a%20b'], 'open ws://computer/cdp?token=a+', 'b'],
    ['secure websocket query plus escape', ['wss://computer/cdp?token=a%20b'], 'open wss://computer/cdp?token=a+', 'b'],
    ['HTTP query plus escape', ['http://computer/cdp?token=a%20b'], 'open http://computer/cdp?token=a+', 'b'],
  ])('holds an incomplete %s until the next delta exposes the credential', (_, credentials, first, last) => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [start(), text(first)])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [text(last)])).toBe(true);
  });

  it.each([
    'ordinary answer',
    'cdp%2F',
    'cdp%2 unrelated',
    'ws://different/cdp?token=a+',
    'ws://computer/other?token=a+',
    'ws://computer/cdp?other=a+',
    'ws://computer/cdp?token=z+',
    'ws://computer/cdp?token=a+ completed sentence',
    'ws://:invalid/cdp?token=a+',
  ])('streams a disproved or unrelated representation immediately: %s', (delta) => {
    const guard = turnCredentialGuard(['ws://computer/cdp?token=a%20b', 'ws://computer/cdp?token=cdp.signed.token', 'ordinary-non-URL-secret']);
    expect(guard.leaks('', [start(), text(delta)])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
  });

  it('releases a held encoded prefix once its continuation disproves the credential', () => {
    const guard = turnCredentialGuard(['ws://computer/cdp?token=cdp.signed.token']);
    expect(guard.leaks('', [start(), text('cdp%2')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [text('Fordinary')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
  });

  it('does not confuse a text message with a same-ID tool argument buffer', () => {
    const guard = turnCredentialGuard(['private-token']);
    expect(guard.leaks('', [start('same'), text('private-', 'same'), { type: 'TOOL_CALL_START', toolCallId: 'same', toolCallName: 'execute' }])).toBe(false);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_ARGS', toolCallId: 'same', delta: 'token' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [text('token', 'same')])).toBe(true);
  });

  it('activates a saved text prefix only when its message resumes', () => {
    const guard = turnCredentialGuard(['private-token'], [{ id: 'answer', role: 'assistant', content: 'private-' }]);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [start()])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [text('token')])).toBe(true);
  });

  it('does not hold completed credential history as an incomplete prefix when the message resumes', () => {
    const guard = turnCredentialGuard(['cdp.signed.token'], [{ id: 'answer', role: 'assistant', content: 'cdp.signed.token' }]);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [start()])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
  });

  it('clears obsolete tool buffers when a snapshot replaces their messages', () => {
    const guard = turnCredentialGuard(['private-token']);
    expect(guard.leaks('', [snapshot([{ id: 'answer', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'private-' } }] }])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [snapshot([{ id: 'answer', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'safe-' } }] }])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'execute', parentMessageId: 'answer' }, { type: 'TOOL_CALL_ARGS', toolCallId: 'tool', delta: 'token' }])).toBe(false);
  });

  // turn-stream.test.ts already records the first matching tool buffer across
  // same-tool-ID messages; this also checks that its prefix remains pending.
  it('takes the first tool argument buffer across same-tool-ID snapshot messages', () => {
    const guard = turnCredentialGuard(['private-token']);
    expect(guard.leaks('', [snapshot([
      { id: 'first', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'private-' } }] },
      { id: 'second', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'safe-' } }] },
    ])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_ARGS', toolCallId: 'tool', delta: 'token' }])).toBe(true);
  });
});

it('rejects a usable credential URL when the Turn also holds non-URL credentials', () => {
  const credentials = turnCredentials({ cdp: 'ws://computer/cdp?token=a%20b', files: { accessKeyId: 'turn-key' } }, ['cdp']);
  const guard = turnCredentialGuard(credentials);
  expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'open ws://computer/cdp?token=a+b' }])).toBe(true);
});
