import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import Page from 'botcube-ui-web/storybook-page';
import { CHAT_SERVICE_ORIGIN } from '../.storybook/chat-origin';
import { BOT_SETTINGS } from 'botcube-ui-web/bot-settings';

const question = 'Please keep this exact question.';
const detail = `${BOT_SETTINGS.agentIdentity.name} is still posting a scheduled task. Send your message again in a minute.`;
/** The Chat Service refuses the turn while a scheduled task is posting. */
function busyPost() {
  return { msw: { handlers: { turn: http.post(CHAT_SERVICE_ORIGIN, async ({ request }) => {
    const input = await request.json() as { messages: { role: string; content: unknown }[] };
    await expect(input.messages.filter((message) => message.role === 'user' && message.content === question)).toHaveLength(1);
    return HttpResponse.json({ code: 'SESSION_BUSY', detail }, { status: 409 });
  }) } } };
}

const meta = { title: 'BotCube/App', component: Page } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

async function refuse(root: HTMLElement) {
  const canvas = within(root);
  await canvas.findByText('What is on the example site?', {}, { timeout: 30000 });
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
