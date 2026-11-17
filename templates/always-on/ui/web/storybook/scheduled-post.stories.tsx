import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import Page from 'botcube-ui-web/storybook-page';
import { CHAT_SERVICE_ORIGIN } from '../../../../../ui/web/.storybook/chat-origin';
import { TEMPLATE_IDENTITY } from '../../../identity';

const question = 'Please keep this exact question.';
const detail = `${TEMPLATE_IDENTITY.name} is still posting a scheduled task. Send your message again in a minute.`;
const answer = 'The scheduled task finished posting.';

function busyPost() {
  let attempts = 0;
  return { msw: { handlers: { turn: http.post(CHAT_SERVICE_ORIGIN, async ({ request }) => {
    const input = await request.json() as { threadId: string; runId: string; messages: { role: string; content: unknown }[] };
    await expect(input.messages.filter((message) => message.role === 'user' && message.content === question)).toHaveLength(1);
    attempts += 1;
    if (attempts === 1) return HttpResponse.json({ code: 'SESSION_BUSY', detail }, { status: 409 });
    const events = [
      { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
      { type: 'TEXT_MESSAGE_START', messageId: 'retry-answer', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'retry-answer', delta: answer },
      { type: 'TEXT_MESSAGE_END', messageId: 'retry-answer' },
      { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId },
    ];
    return new HttpResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) } } };
}

const meta = { title: 'Template', component: Page } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

async function refuse(root: HTMLElement) {
  const canvas = within(root);
  await canvas.findByText('What is on the template site?', {}, { timeout: 30000 });
  const input = await canvas.findByRole('textbox', {}, { timeout: 30000 });
  await userEvent.type(input, question);
  await userEvent.keyboard('{Enter}');
  const alert = await canvas.findByRole('alert', {}, { timeout: 30000 });
  await expect(alert).toHaveTextContent(detail);
  await expect(root.querySelector('.chat-failed-question')).toHaveTextContent(question);
  await waitFor(() => expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible());
}

export const ScheduledPostBusy: Story = {
  name: 'scheduled-post-busy',
  parameters: busyPost(),
  play: async ({ canvasElement }) => { await refuse(canvasElement); },
};

export const ScheduledPostRetry: Story = {
  name: 'scheduled-post-retry',
  parameters: busyPost(),
  play: async ({ canvasElement }) => {
    await refuse(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(canvas.getByText(answer)).toBeVisible(), { timeout: 30000 });
    await waitFor(() => expect(canvas.queryByRole('alert')).toBeNull());
  },
};
