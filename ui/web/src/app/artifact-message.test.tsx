import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';

import { ARTIFACT_MESSAGE } from './artifact-message';

const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'search', arguments: '{}' } });
const reply = (id: string, content: string, toolCalls?: ReturnType<typeof call>[]) => ({ id, role: 'assistant' as const, content, ...(toolCalls && { toolCalls }) });

it('marks a reply that ends at a bubble with words, and not one a tool row follows or an empty bubble', () => {
  const { container } = render(
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <CopilotChatMessageView
          isRunning={false}
          assistantMessage={ARTIFACT_MESSAGE}
          messages={[
            reply('words', 'Rates rallied.'),
            reply('text-then-tool', 'Checking the curve.', [call('c1')]),
            reply('tool-only', '', [call('c2')]),
            reply('text-after-tool', 'The curve steepened.'),
            reply('blank', '  \n '),
          ]}
        />
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>,
  );
  const ends = [...container.querySelectorAll('.chat-message.is-assistant')].map((row) => [row.getAttribute('data-message-id'), row.hasAttribute('data-bubble-ends')]);

  expect(ends).toEqual([['words', true], ['text-then-tool', false], ['tool-only', false], ['text-after-tool', true], ['blank', false]]);
});
