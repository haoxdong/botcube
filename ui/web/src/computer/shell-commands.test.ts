import type { Message } from '@ag-ui/client';
import { describe, expect, it } from 'vitest';

import { shellCommands } from './computer-view';

const call = (id: string, command: string): Message => ({
  id: `a-${id}`, role: 'assistant', content: '', toolCalls: [{ id, type: 'function', function: { name: 'execute', arguments: JSON.stringify({ command }) } }],
});
const result = (id: string, content: string): Message => ({ id: `t-${id}`, role: 'tool', toolCallId: id, content });

describe("the Terminal's commands", () => {
  it('shows a command a stopped Turn cut with no output, not the saver\'s placeholder', () => {
    // A replayed stopped Turn answers its cut call with langgraph-checkpoint-aws's placeholder, as production does.
    const messages = [
      call('c1', 'sleep 30; echo slept'), result('c1', "Tool call 'execute' with id 'c1' was interrupted before completion."),
      call('c2', 'ls'), result('c2', 'notes.md'),
    ];

    expect(shellCommands(messages)).toEqual([{ command: 'sleep 30; echo slept', output: '' }, { command: 'ls', output: 'notes.md' }]);
  });
});
