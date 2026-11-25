import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Page from 'botcube-ui-web/storybook-page';
import { FluentInPage, FluentReference } from '@/computer/fluent-check';
import { awakeComputer } from './example-chat-fixtures';

/**
 * ADR 0093: the Agent Computer draws with Fluent UI inside the app, and neither side's CSS reaches the other. Each
 * Fluent control the computer uses is drawn twice: inside the app, under its global CSS, and in a frame of its own, as
 * Fluent's reference. Every computed style of each must match. Then the chat must look the same before the computer
 * mounts and after it unmounts.
 */
const meta = {
  title: 'BotCube/Computer Fluent',
  component: Page,
  parameters: { msw: { handlers: awakeComputer } },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The app, with the controls drawn in its shell and, beside them, in Fluent's reference frame. */
function AppWithControls() {
  const [shell, setShell] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setShell(document.querySelector<HTMLElement>('.app-layout'));
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <Page />
      {shell !== null && createPortal(
        // Stacked, each 420px wide, so neither squeezes the other on a phone.
        <div style={{ position: 'fixed', left: 0, top: 0, zIndex: 300, display: 'flex', flexDirection: 'column', background: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.2)' }}>
          <div data-sample="app" style={{ width: 420, height: 260 }}><FluentInPage /></div>
          <FluentReference />
        </div>,
        shell,
      )}
    </>
  );
}

/** What a control looks like: these computed styles of it and every element in it, with its size. */
const LOOK = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'border-top-width', 'border-top-style', 'border-top-color', 'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-left', 'display', 'gap', 'text-decoration-line', 'fill', 'outline-style'];
function look(root: Element) {
  return [root, ...root.querySelectorAll('*')].map((element) => {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const { width, height } = element.getBoundingClientRect();
    // What is drawn: a border's style and colour only where it has a width; box-sizing shows in the size.
    const drawn = LOOK.filter((name) => !name.startsWith('border-top-') || name === 'border-top-width' || style?.getPropertyValue('border-top-width') !== '0px');
    return { element: element.tagName, size: `${Math.round(width)}x${Math.round(height)}`, ...Object.fromEntries(drawn.map((name) => [name, style?.getPropertyValue(name)])) };
  });
}
/** Each way two looks differ, element by element and property by property. */
function differences(inApp: ReturnType<typeof look>, reference: ReturnType<typeof look>) {
  if (inApp.length !== reference.length) return [`${inApp.length} elements, not ${reference.length}`];
  return inApp.flatMap((element, index) =>
    Object.entries(element).flatMap(([name, value]) => (value === reference[index]?.[name as keyof typeof element] ? [] : [`${index} ${element.element} ${name}: ${value}, not ${reference[index]?.[name as keyof typeof element]}`])),
  );
}

export const ControlsInTheApp: Story = {
  name: 'controls-in-the-app',
  render: () => <AppWithControls />,
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument;
    await within(document.body).findByText('What is on the example site?', {}, { timeout: 30000 });
    const frame = await waitFor(() => {
      const reference = document.querySelector<HTMLIFrameElement>('[data-sample="reference"]')?.contentDocument?.querySelector('[data-control="Text"]');
      if (!reference) throw new Error('no reference yet');
      return reference.ownerDocument;
    }, { timeout: 30000 });
    const compared = ['Button', 'Toolbar', 'Text'].map((control) => {
      const inApp = document.querySelector(`[data-sample="app"] [data-control="${control}"]`);
      const reference = frame.querySelector(`[data-control="${control}"]`);
      if (inApp === null || reference === null) throw new Error(`no ${control}`);
      return { control, differences: differences(look(inApp), look(reference)) };
    });
    await expect(compared.filter(({ differences }) => differences.length > 0)).toEqual([]);
  },
};

/** The chat's look: each element outside the profile and CopilotKit's hidden dev inspector, with its computed styles. */
function chatLook(root: HTMLElement) {
  const chat = root.ownerDocument.querySelector('.app-layout');
  if (chat === null) throw new Error('no app');
  return [...chat.querySelectorAll('*')].filter((element) => element.closest('.agent-profile-panel, [role="dialog"], cpk-web-inspector') === null).map((element) => {
    const style = getComputedStyle(element);
    return `${element.tagName}.${element.getAttribute('class') ?? ''} ${LOOK.map((name) => style.getPropertyValue(name)).join(' ')}`;
  });
}
/** What one look has that the other lacks. */
function changed(after: string[], before: string[]) {
  return [...after.filter((line) => !before.includes(line)).map((line) => `+ ${line}`), ...before.filter((line) => !after.includes(line)).map((line) => `- ${line}`)];
}
/** The chat at rest: its look the same across two frames. */
async function settledChat(root: HTMLElement) {
  return waitFor(async () => {
    const first = chatLook(root);
    await new Promise((done) => setTimeout(done, 300));
    await expect(chatLook(root)).toEqual(first);
    return first;
  }, { timeout: 15000 });
}

/** Every rule Fluent's styling engine injected: each must be scoped by a class, so none reaches the chat. */
function griffelSelectors(document: Document) {
  return [...document.querySelectorAll('style[data-make-styles-bucket]')].flatMap((style) =>
    [...((style as HTMLStyleElement).sheet?.cssRules ?? [])].flatMap(function selectors(rule: CSSRule): string[] {
      if (rule instanceof CSSStyleRule) return rule.selectorText.split(',').map((selector) => selector.trim());
      if ('cssRules' in rule) return [...(rule as CSSGroupingRule).cssRules].flatMap(selectors);
      return [];
    }),
  );
}

export const ChatUnchanged: Story = {
  name: 'chat-unchanged',
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument;
    const body = within(document.body);
    await body.findByText('What is on the example site?', {}, { timeout: 30000 });
    // The live chat, past its opening.
    await waitFor(() => expect([document.querySelector('.app-chat-opening, .kept-chat'), document.querySelector('.app-chat .chat-model-picker')]).toEqual([null, expect.anything()]), { timeout: 30000 });
    const before = await settledChat(canvasElement);

    await userEvent.click(body.getByRole('button', { name: 'Agent profile' }));
    await userEvent.click(await body.findByRole('tab', { name: 'Computer' }, { timeout: 30000 }));
    await body.findByRole('toolbar', { name: 'Taskbar' }, { timeout: 30000 });
    await userEvent.click(body.getByRole('button', { name: 'View computer' }));
    await userEvent.click(body.getByRole('button', { name: 'Close computer' }));
    await userEvent.click(body.getByRole('button', { name: 'Close agent profile' }));

    // Fluent's rules stay in the page once loaded: every one is scoped by a class.
    const selectors = griffelSelectors(document);
    await expect(selectors.length).toBeGreaterThan(0);
    await expect(selectors.filter((selector) => !/^(\.|:root\b|@)/.test(selector) && !/^[a-z-]*\[data-/.test(selector))).toEqual([]);
    await waitFor(() => expect(changed(chatLook(canvasElement), before)).toEqual([]), { timeout: 10000 });
  },
};
