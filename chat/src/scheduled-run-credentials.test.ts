import { describe, expect, it, vi } from 'vitest';

import { mainChat, owner, posted, run, scheduler, signInChecks, stream, text, turnSecrets } from '../test/scheduled-run-fixture.js';

describe('a scheduled run', () => {
  it.each([
    ['Files access key in malformed data', [`data: ${turnSecrets.files.accessKeyId}`]],
    ['Files access key in text', text('a1', turnSecrets.files.accessKeyId)],
    ['Files session token in a tool result', [{ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: `Sign in to continue: ${turnSecrets.files.sessionToken}` }]],
    ['CDP URL in a run error', [{ type: 'RUN_ERROR', message: `Failed: ${turnSecrets.agentComputerCdpUrl}` }]],
    ['CDP bearer token on its own', text('a1', 'scheduled-cdp-token')],
    ['invocation token split across text deltas', text('a1', 'scheduled-invocation-', 'token')],
    ['Files secret split across tool argument deltas', [
      { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'execute' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"command":"scheduled/' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: 'secret+key"}' },
      { type: 'TOOL_CALL_END', toolCallId: 't1' },
    ]],
    ['JSON-escaped Files secret in a run error', ['data: {"type":"RUN_ERROR","message":"scheduled\\/secret+key"}']],
    ['Files secret in a state snapshot', [{ type: 'STATE_SNAPSHOT', snapshot: { files: { secretAccessKey: turnSecrets.files.secretAccessKey } } }]],
    ['credential used as an escaped state property name', ['data: {"type":"STATE_SNAPSHOT","snapshot":{"scheduled-\\u0073ession-token":true}}']],
    ['an escaped credential in a multiline state event', ['data: {"type":"STATE_SNAPSHOT","snapshot":{"token":\ndata: "scheduled-\\u0073ession-token"}}']],
    ...([['literal', 'scheduled-invocation-', 'token'], ['encoded query token', 'scheduled%2', 'Dcdp-token']] as const).map(([label, first, last]): [string, Record<string, unknown>[]] => [
      `${label} assembled by scheduled output after safe snapshot replacement`, [
        ...text('a1', first), { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'a1', role: 'assistant', content: 'safe replacement' }] }, ...text('a1', last),
      ],
    ]),
    ['adjacent multipart text credential', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'scheduled-invocation-' }, { type: 'text', text: 'token' }] }] }]],
    ['JSON Pointer decoded Files secret property', [{ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/scheduled~1secret+key', value: true }] }]],
    ['run input seeded text', [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r', input: { threadId: 't', runId: 'r', state: {}, messages: [{ id: 'a1', role: 'assistant', content: 'scheduled-invocation-' }], tools: [], context: [], forwardedProps: {} } },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
    ]],
    ['tool result seeded text', [
      { type: 'TOOL_CALL_RESULT', messageId: 'a1', toolCallId: 't1', content: 'scheduled-invocation-' },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
    ]],
    ['activity root-patch seeded text', [
      { type: 'ACTIVITY_SNAPSHOT', messageId: 'a1', activityType: 'test', content: {} },
      { type: 'ACTIVITY_DELTA', messageId: 'a1', activityType: 'test', patch: [{ op: 'replace', path: '', value: 'scheduled-invocation-' }] },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
    ]],
    ...['TEXT_MESSAGE', 'REASONING_MESSAGE', 'TOOL_CALL'].flatMap((kind): [string, Record<string, unknown>[]][] => {
      const identity = kind === 'TOOL_CALL' ? { toolCallId: 'x', toolCallName: 'execute' } : { messageId: 'x' };
      const content = kind === 'TOOL_CALL' ? 'TOOL_CALL_ARGS' : `${kind}_CONTENT`;
      return [['literal', 'scheduled-invocation-', 'token'], ['encoded', 'scheduled%2', 'Dcdp-token']].map(([label, first, last]) => [
        `${label} token across reused ${kind} ID`, [
          { type: `${kind}_START`, ...identity }, { type: content, ...identity, delta: first },
          { type: `${kind}_END`, ...identity }, { type: `${kind}_START`, ...identity },
          { type: content, ...identity, delta: last }, { type: `${kind}_END`, ...identity },
        ],
      ]);
    }),
    ...['TEXT_MESSAGE_CHUNK', 'TOOL_CALL_CHUNK', 'REASONING_MESSAGE_CHUNK'].flatMap((type): [string, Record<string, unknown>[]][] => [
      [`literal token split across ${type}`, [
        { type, ...(type === 'TOOL_CALL_CHUNK' ? { toolCallId: 't1', toolCallName: 'execute' } : { messageId: 'a1' }), delta: 'scheduled-invocation-' },
        { type: 'RAW', event: {} },
        { type, delta: 'token' },
      ]],
      [`encoded token split across ${type}`, [
        { type, ...(type === 'TOOL_CALL_CHUNK' ? { toolCallId: 't1', toolCallName: 'execute' } : { messageId: 'a1' }), delta: 'scheduled%2' },
        { type, delta: 'Dcdp-token' },
      ]],
    ]),
    ['invocation token split across reasoning deltas', [
      { type: 'REASONING_MESSAGE_START', messageId: 'a1' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'scheduled-invocation-' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'token' },
      { type: 'REASONING_MESSAGE_END', messageId: 'a1' },
    ]],
    ['encoded CDP query token split across reasoning deltas', [
      { type: 'REASONING_MESSAGE_START', messageId: 'a1' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'scheduled%2' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'a1', delta: 'Dcdp-token' },
      { type: 'REASONING_MESSAGE_END', messageId: 'a1' },
    ]],
    ['encoded standalone CDP token in text', text('a1', 'scheduled%2Dcdp-token')],
    ['encoded standalone CDP token in tool arguments', [{ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"token":"scheduled%2Dcdp-token"}' }]],
    ['encoded standalone CDP token split across text', text('a1', 'scheduled%2', 'Dcdp-token')],
    ['percent-encoded CDP URL in text', text('a1', 'open https://computer.example/cdp?token=%73cheduled-cdp-token')],
    ['percent-encoded CDP URL split across text deltas', text('a1', 'open https://computer.example/cdp?token=%73cheduled-', 'cdp-token')],
    ['percent-encoded CDP URL in tool arguments', [{ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"command":"open https://computer.example/cdp?token=%73cheduled-cdp-token"}' }]],
  ])('withholds %s before sign-in checks or a Main Chat post', async (_, frames) => {
    const account = owner();
    const main = await mainChat(account);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await run(account, stream(...frames));

      expect((await posted(main)).map(({ content }) => content)).toEqual([
        'Scheduled task "Morning brief" failed: The agent\'s answer carried the Turn\'s credentials, so it was withheld',
      ]);
      expect(signInChecks.filter((check) => check.owner === account).flatMap((check) => check.outputs)).toEqual([]);
      const logged = errors.mock.calls.flat().map(String).join('\n');
      for (const secret of [...Object.values(turnSecrets.files), turnSecrets.credentialServiceInvocationToken, turnSecrets.agentComputerCdpUrl]) {
        expect(logged).not.toContain(secret);
      }
      await vi.waitFor(async () => expect(await scheduler.queued()).toBe(0), { timeout: 2_000 });
    } finally {
      errors.mockRestore();
    }
  });

  it.each([
    turnSecrets.files.sessionToken,
    'failed token scheduled%2Dcdp-token',
    '{"message":"scheduled\\/secret+key"}',
    '{"scheduled-\\u0073ession-token":"diagnostic"}',
    'failed to open https://computer.example/cdp?token=%73cheduled-cdp-token',
  ])('withholds a credential-bearing HTTP refusal before a Main Chat post: %s', async (body) => {
    const account = owner();
    const main = await mainChat(account);

    await run(account, { kind: 'error', status: 503, body });

    expect((await posted(main)).map(({ content }) => content)).toEqual([
      'Scheduled task "Morning brief" failed: AgentCore upstream returned HTTP 503: The error body carried the Turn\'s credentials, so it was withheld',
    ]);
    expect(signInChecks.filter((check) => check.owner === account).flatMap((check) => check.outputs)).toEqual([]);
  });

});
