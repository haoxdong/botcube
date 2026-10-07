import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import Page from 'botcube-ui-web/storybook-page';
import { animationsSettled } from '../../../../ui/web/.storybook/animations-settled';
import { CHAT_SERVICE_ORIGIN } from '../../../../ui/web/.storybook/chat-origin';
import { BrowserView } from '../src/browser-view';
import { SESSION, awakeComputer, reply } from './chat-service';

const meta = {
  title: 'Template',
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
/** The Computer tab's screen: the panel's full width, a 16:10 viewport, and its bar 12px under it. */
async function computerGeometry(panel: HTMLElement) {
  const content = panel.getBoundingClientRect();
  const style = getComputedStyle(panel);
  const screen = box(panel, '.template-screen');
  const glass = box(panel, '.template-screen-glass');
  const bar = box(panel, '.template-computer-bar');
  await near(screen.left, content.left + parseFloat(style.paddingLeft));
  await near(screen.right, content.right - parseFloat(style.paddingRight));
  await near(glass.width / glass.height, 1.6, 0.01);
  await near(bar.top - screen.bottom, 12);
  await near(box(panel, '.template-computer-bar .button').right, screen.right);
  return screen;
}

async function ready(root: HTMLElement) {
  const message = await within(root).findByText('What is on the template site?', {}, { timeout: 30000 });
  await waitFor(() => expect(message).toBeVisible());
  await visible(root, '.copilotKitInput textarea');
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
    await visible(canvasElement, '.template-site-data');
    // The card sits under its shell call's row, lined up with the row's icon, inside the reply column.
    const card = box(canvasElement, '.template-site-data');
    const row = canvasElement.querySelector('.template-site-data')?.previousElementSibling;
    const icon = row?.querySelector('svg')?.getBoundingClientRect();
    if (!row || !icon) throw new Error('The data card has no shell call row above it');
    await near(card.left, icon.left);
    await expect(card.top).toBeGreaterThanOrEqual(row.getBoundingClientRect().bottom);
    await expect(card.width).toBeLessThanOrEqual(360);
    await expect(card.right).toBeLessThanOrEqual(box(canvasElement, '.copilotKitInput').right);
    await noPageScroll(canvasElement);
  }),
};
export const Welcome: Story = {
  name: 'welcome',
  parameters: {
    msw: { handlers: { '/main-chat': reply('/main-chat', { id: 'main-shots', messages: [] }) } },
  },
  play: resting(async ({ canvasElement }) => visible(canvasElement, '.welcome-screen')),
};
export const SignInNeeded: Story = {
  name: 'chat-sign-in-needed',
  parameters: {
    msw: {
      handlers: {
        '/account/session': reply('/account/session', { ...SESSION, signInNeeded: true }),
        '/account/sign-ins': reply('/account/sign-ins', { signIns: [{ site: 'template-site', status: 'not_linked' }] }),
      },
    },
  },
  play: resting(async ({ canvasElement }) => {
    await ready(canvasElement);
    const chip = await within(canvasElement).findByRole('button', { name: /Sign in needed/ }, { timeout: 30000 });
    const chipBox = chip.getBoundingClientRect();
    const composer = box(canvasElement, '.copilotKitInput');
    // Above the composer, on its left edge, a finger's target on a phone.
    await near(chipBox.left, composer.left);
    await expect(chipBox.bottom).toBeLessThanOrEqual(composer.top);
    await expect(chipBox.height).toBeGreaterThanOrEqual(window.innerWidth <= 640 ? 44 : 32);
    await noPageScroll(canvasElement);
  }),
};
export const ProfileIdentity: Story = {
  name: 'profile-identity',
  play: resting(async ({ canvasElement }) => {
    await profile(canvasElement, 'Identity');
    await visible(canvasElement.ownerDocument.body, '.agent-file-cards');
  }),
};
export const ProfileSignIns: Story = {
  name: 'profile-sign-ins',
  play: resting(async ({ canvasElement }) => {
    const panel = await profile(canvasElement, 'Sign-ins');
    await panel.findByText('Linked', {}, { timeout: 30000 });
    const tab = canvasElement.ownerDocument.querySelector<HTMLElement>('[role="tabpanel"][aria-label="Sign-ins"]');
    if (!tab) throw new Error('Missing Sign-ins panel');
    const content = tab.getBoundingClientRect().right - parseFloat(getComputedStyle(tab).paddingRight);
    // The status ends at the panel's edge; the action starts under the site's name.
    await near(box(tab, '.template-sign-in-status').right, content);
    await near(box(tab, '.template-sign-in-action').left, box(tab, '.list-row-title').left);
    await near(box(tab, '.list-row-icon').width, window.innerWidth <= 640 ? 44 : 40);
    await noPageScroll(canvasElement);
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
    await within(panel).findByRole('button', { name: 'Wake' }, { timeout: 30000 });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Wake' })).toBeEnabled());
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
    const covered = box(panel, '.template-screen');
    await visible(panel, '.template-screen-image');
    // The screen keeps its place and size from its cover to its first frame.
    const live = await computerGeometry(panel);
    await expect([live.left, live.top, live.width, live.height]).toEqual([covered.left, covered.top, covered.width, covered.height]);
    await near(box(panel, '.template-screen-image').width, box(panel, '.template-screen-glass').width);
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
            { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: "I opened the template site's sign-in page." },
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
    await userEvent.type(canvas.getByRole('textbox'), 'Open the template site');
    await userEvent.click(canvas.getByRole('button', { name: 'Send' }));
    await canvas.findByText("I opened the template site's sign-in page.", {}, { timeout: 30000 });
    const phone = window.innerWidth <= 640;
    await visible(canvasElement, phone ? '.template-browser-panel .template-screen-bar' : '.template-browser-panel .template-screen-image');
    const panel = box(canvasElement, '.template-browser-panel');
    // Clear of the composer and the header, inside the window's right gutter.
    await expect(panel.bottom).toBeLessThanOrEqual(box(canvasElement, '.copilotKitInput').top - 8);
    await expect(panel.top).toBeGreaterThanOrEqual(box(canvasElement, '.chat-header').bottom);
    await near(window.innerWidth - panel.right, phone ? 12 : 24);
    if (phone) {
      await near(panel.height, 44);
      await expect(canvasElement.querySelector('.template-browser-panel .template-screen-glass')).not.toBeVisible();
    } else {
      await near(panel.width, 288);
      const glass = box(canvasElement, '.template-browser-panel .template-screen-glass');
      await near(glass.width / glass.height, 1.6, 0.01);
    }
    await noPageScroll(canvasElement);
  }),
};
export const PopOut: Story = {
  name: 'browser-view',
  render: () => <BrowserView />,
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
    await visible(canvasElement, '.template-screen-image');
    // As large as the window allows at 16:10, centred with at least a 24px margin.
    const screen = box(canvasElement, '.template-screen');
    const glass = box(canvasElement, '.template-screen-glass');
    await near(glass.width / glass.height, 1.6, 0.01);
    await near(screen.left, window.innerWidth - screen.right);
    await expect(screen.left).toBeGreaterThanOrEqual(24);
    await expect(screen.top).toBeGreaterThanOrEqual(24);
    await expect(screen.bottom).toBeLessThanOrEqual(window.innerHeight - 24 + 1);
    await noPageScroll(canvasElement);
  }),
};
