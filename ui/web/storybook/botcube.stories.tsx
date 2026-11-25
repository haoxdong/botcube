import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import Page from 'botcube-ui-web/storybook-page';
import { animationsSettled } from '../.storybook/animations-settled';
import { CHAT_SERVICE_ORIGIN } from '../.storybook/chat-origin';
import { LiveBrowserWindow } from '../src/computer/live-browser-window';
import { reply } from './chat-service';
import { awakeComputer, noLiveViewComputer } from './example-chat-fixtures';

const meta = {
  title: 'BotCube/App',
  component: Page,
  play: resting(async ({ canvasElement }) => ready(canvasElement)),
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

type Play = NonNullable<StoryObj<typeof Page>['play']>;
function resting(play: Play): Play {
  return async (context) => {
    await play(context);
    await userEvent.unhover(context.canvasElement);
    const active = context.canvasElement.ownerDocument.activeElement;
    if (active instanceof HTMLElement) active.blur();
  };
}

async function visible(root: HTMLElement, selector: string) {
  await waitFor(() => expect(root.querySelector(selector)).toBeVisible(), { timeout: 30000 });
}
function box(root: ParentNode, selector: string) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element.getBoundingClientRect();
}
const near = async (actual: number, expected: number, tolerance = 1) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
async function noPageScroll(root: HTMLElement) {
  await expect(root.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}
/** The shared desktop is Windows' 16:9 screen, its taskbar along the bottom. */
async function computerGeometry(panel: HTMLElement) {
  const screen = box(panel, '.agent-computer-desktop');
  await near(screen.width / screen.height, 16 / 9, 0.01);
  await expect(panel.querySelector('[role="toolbar"][aria-label="Taskbar"]')).toBeVisible();
  return screen;
}

async function ready(root: HTMLElement) {
  const message = await within(root).findByText('What is on the example site?', {}, { timeout: 30000 });
  await waitFor(() => expect(message).toBeVisible());
  await visible(root, '.chat-composer textarea:not([readonly])');
}
async function profile(root: HTMLElement, tab: string) {
  await ready(root);
  await userEvent.click(within(root).getByRole('button', { name: 'Agent profile' }));
  const body = within(root.ownerDocument.body);
  await userEvent.click(await body.findByRole('tab', { name: tab }, { timeout: 30000 }));
  const panel = within(await body.findByRole('tabpanel', { name: tab }, { timeout: 30000 }));
  // Measured once the profile has slid open.
  await animationsSettled(root.ownerDocument);
  return panel;
}

export const Chat: Story = {
  name: 'chat',
  play: resting(async ({ canvasElement }) => {
    await ready(canvasElement);
    // The shell call is its Turn's work, folded under the Worklog's header: open it.
    await userEvent.click(await within(canvasElement).findByRole('button', { name: /^Worked/ }));
    await noPageScroll(canvasElement);
  }),
};
export const ProfilePersonalization: Story = {
  name: 'profile-personalization',
  play: resting(async ({ canvasElement }) => {
    await profile(canvasElement, 'Personalization');
    await visible(canvasElement.ownerDocument.body, '.agent-file-cards');
  }),
};
const computerPanel = (root: HTMLElement) => {
  const panel = root.ownerDocument.querySelector<HTMLElement>('[role="tabpanel"][aria-label="Computer"]');
  if (!panel) throw new Error('Missing Computer panel');
  return panel;
};
export const ProfileComputer: Story = {
  name: 'profile-computer',
  play: resting(async ({ canvasElement }) => {
    await profile(canvasElement, 'Computer');
    const panel = computerPanel(canvasElement);
    await visible(panel, '.agent-computer-desktop');
    await computerGeometry(panel);
    await noPageScroll(canvasElement);
  }),
};
export const ProfileComputerAwake: Story = {
  name: 'profile-computer-awake',
  parameters: { msw: { handlers: awakeComputer } },
  play: resting(async ({ canvasElement }) => {
    await profile(canvasElement, 'Computer');
    const panel = computerPanel(canvasElement);
    const covered = box(panel, '.agent-computer-screen');
    await visible(panel, '.computer-screen-image');
    // The screen keeps its place and size from its cover to its first frame.
    await computerGeometry(panel);
    const live = box(panel, '.agent-computer-screen');
    await expect([live.left, live.top, live.width, live.height]).toEqual([covered.left, covered.top, covered.width, covered.height]);
    await near(box(panel, '.computer-screen-image').width, box(panel, '.computer-screen-glass').width);
    await noPageScroll(canvasElement);
  }),
};
export const ProfileComputerNoLiveView: Story = {
  name: 'profile-computer-no-live-view',
  parameters: { msw: { handlers: noLiveViewComputer } },
  play: resting(async ({ canvasElement }) => {
    await profile(canvasElement, 'Computer');
    const panel = computerPanel(canvasElement);
    await visible(panel, '.agent-computer-notice');
    await expect(panel.querySelector('.agent-computer-notice')).toHaveTextContent('Live view is off in this deployment.');
    await expect(panel.querySelector('.agent-computer-live')).toBeNull();
    await computerGeometry(panel);
    await noPageScroll(canvasElement);
  }),
};
export const TurnLiveBrowser: Story = {
  name: 'turn-live-browser',
  parameters: {
    msw: {
      handlers: {
        view: awakeComputer.view,
        turn: http.post(CHAT_SERVICE_ORIGIN, async ({ request }) => {
          const { threadId, runId } = (await request.json()) as { threadId: string; runId: string };
          const messageId = 'live-reply';
          const events = [
            { type: 'RUN_STARTED', threadId, runId },
            { type: 'CUSTOM', name: 'botcube:browser-live-view', value: { open: true, sessionId: 'browser-shot' } },
            { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
            { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: "I opened the example site's sign-in page." },
            { type: 'TEXT_MESSAGE_END', messageId },
            { type: 'RUN_FINISHED', threadId, runId },
          ];
          const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
          return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
        }),
      },
    },
  },
  play: resting(async ({ canvasElement }) => {
    await ready(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox'), 'Open the example site');
    await userEvent.click(canvas.getByRole('button', { name: 'Send' }));
    await canvas.findByText("I opened the example site's sign-in page.", {}, { timeout: 30000 });
    const phone = window.innerWidth <= 640;
    await visible(canvasElement, phone ? '.live-browser-panel .computer-screen-bar' : '.live-browser-panel .computer-screen-image');
    const panel = box(canvasElement, '.live-browser-panel');
    // Clear of the composer and the header, inside the window's right gutter.
    await expect(panel.bottom).toBeLessThanOrEqual(box(canvasElement, '.chat-composer').top - 8);
    await expect(panel.top).toBeGreaterThanOrEqual(box(canvasElement, '.chat-header').bottom);
    await near(window.innerWidth - panel.right, phone ? 12 : 24);
    if (phone) {
      await near(panel.height, 44);
      await expect(canvasElement.querySelector('.live-browser-panel .computer-screen-glass')).not.toBeVisible();
    } else {
      await near(panel.width, 288);
      const glass = box(canvasElement, '.live-browser-panel .computer-screen-glass');
      await near(glass.width / glass.height, 1.6, 0.01);
    }
    await noPageScroll(canvasElement);
  }),
};
export const PopOut: Story = {
  name: 'browser-view',
  render: () => <LiveBrowserWindow agentName="BotCube" />,
  parameters: {
    msw: {
      handlers: {
        view: awakeComputer.view,
        liveViewUrl: reply('/browser-live-view-url', { signedUrl: `${CHAT_SERVICE_ORIGIN}/agent-computer/view?thread_id=main-shots` }),
      },
    },
  },
  beforeEach() {
    const url = new URL(window.location.href);
    url.searchParams.set('session_id', 'browser-shot');
    window.history.replaceState(null, '', url);
    return () => {
      url.searchParams.delete('session_id');
      window.history.replaceState(null, '', url);
    };
  },
  play: resting(async ({ canvasElement }) => {
    await visible(canvasElement, '.computer-screen-image');
    // As large as the window allows at 16:10, centred with at least a 24px margin.
    const screen = box(canvasElement, '.computer-screen');
    const glass = box(canvasElement, '.computer-screen-glass');
    await near(glass.width / glass.height, 1.6, 0.01);
    await near(screen.left, window.innerWidth - screen.right);
    await expect(screen.left).toBeGreaterThanOrEqual(24);
    await expect(screen.top).toBeGreaterThanOrEqual(24);
    await expect(screen.bottom).toBeLessThanOrEqual(window.innerHeight - 24 + 1);
    await noPageScroll(canvasElement);
  }),
};
