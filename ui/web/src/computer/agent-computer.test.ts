import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./browser-live-frame', () => ({
  BrowserLiveFrame: ({ sessionId }: { sessionId: string }) =>
    React.createElement('div', { 'data-live-view': sessionId }),
}));

import { AgentComputer, handBackBrowser, loadAgentComputer, takeOverBrowser, wakeAgentComputer } from './agent-computer';

describe.each([
  ['takeOverBrowser', takeOverBrowser, '/browser-take-over', 'Take over failed'],
  ['handBackBrowser', handBackBrowser, '/browser-hand-back', 'Hand back failed'],
] as const)('%s', (_name, control, path, fallback) => {
  it("asks the Chat Service to change control of the browser, with the account's cookies", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'ok' }));

    await control('browser 1', { chatServiceUrl: 'https://chat.test', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(`https://chat.test${path}?session_id=browser+1`, {
      method: 'POST',
      credentials: 'include',
    });
  });

  it("fails loud with the Chat Service's reason", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ detail: 'AgentCore refused the browser control change: HTTP 404' }, { status: 502 }),
    );

    await expect(control('browser-1', { chatServiceUrl: 'https://chat.test', fetchImpl })).rejects.toThrow(
      'AgentCore refused the browser control change: HTTP 404',
    );
  });

  it('fails loud with the status when the answer has no reason', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad gateway', { status: 502 }));

    await expect(control('browser-1', { chatServiceUrl: 'https://chat.test', fetchImpl })).rejects.toThrow(
      `${fallback}: 502`,
    );
  });
});

describe.each([
  ['loadAgentComputer', loadAgentComputer, 'GET', '/agent-computer', 'Agent Computer request failed'],
  ['wakeAgentComputer', wakeAgentComputer, 'POST', '/agent-computer/wake', 'Wake failed'],
] as const)('%s', (_name, request, method, path, fallback) => {
  it("asks the Chat Service about the chat's Agent Computer, with the account's cookies", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ state: 'awake', browserSessionId: 'browser-1' }));

    const computer = await request('chat 1', { chatServiceUrl: 'https://chat.test', fetchImpl });

    expect(computer).toEqual({ state: 'awake', browserSessionId: 'browser-1' });
    expect(fetchImpl).toHaveBeenCalledWith(`https://chat.test${path}?thread_id=chat+1`, {
      method,
      credentials: 'include',
    });
  });

  it("fails loud with the Chat Service's reason, or the status", async () => {
    const refused = vi.fn(async () => Response.json({ detail: 'Missing templatebot account cookie' }, { status: 401 }));
    const broken = vi.fn(async () => new Response('Bad gateway', { status: 502 }));

    await expect(request('chat-1', { chatServiceUrl: 'https://chat.test', fetchImpl: refused })).rejects.toThrow(
      'Missing templatebot account cookie',
    );
    await expect(request('chat-1', { chatServiceUrl: 'https://chat.test', fetchImpl: broken })).rejects.toThrow(
      `${fallback}: 502`,
    );
  });
});

const handlers = {
  onTakeOver: () => {},
  onHandBack: () => {},
  onStop: () => {},
  onOpenApp: () => {},
};
const render = (props: Partial<Parameters<typeof AgentComputer>[0]>) =>
  renderToStaticMarkup(
    React.createElement(AgentComputer, {
      agentName: 'Template Bot',
      app: 'Chromium',
      files: React.createElement('div', { 'data-files': '' }),
      computer: { state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null },
      commands: [],
      control: 'agent',
      running: false,
      starting: false,
      busy: false,
      error: null,
      notice: null,
      ...handlers,
      ...props,
    }),
  ).replaceAll(' style="opacity:1"', '');
/** Each button's name: its text, or the label of an icon-only button. */
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(
    ([, attributes = '', content = '']) => content.replace(/<[^>]*>/g, '') || /aria-label="([^"]*)"/.exec(attributes)?.[1],
  );
/** The way into the computer sheet: the whole preview. */
const OPEN = 'View computer';
/** The buttons Windows draws: the taskbar's, each window's caption buttons, and Terminal's tab strip. */
const WINDOWS = /^(Start|Search|Files|Chromium|Terminal|New tab|Open a profile|(Close )?[\w-]+@computer: ~|(Minimise|Maximise|Restore|Close) \w+)$/;
/** The computer's own controls, outside Windows. */
const controls = (html: string) => buttons(html).filter((name) => name === undefined || !WINDOWS.test(name));
/** The taskbar's apps from the left, the front one pressed. */
const taskbar = (html: string) =>
  [...html.matchAll(/<button[^>]*class="[^"]*agent-computer-taskbar-app[^"]*"[^>]*>/g)].map(([tag]) => {
    const name = /aria-label="([^"]+)"/.exec(tag)?.[1];
    return tag.includes('aria-pressed="true"') ? `${name} pressed` : name;
  });

describe('AgentComputer', () => {
  it('shows the live browser directly on the desktop, with the agent in control', () => {
    const html = render({});

    expect(html).toContain('<div data-live-view="browser-1"></div>');
    expect(html).toContain('Template Bot has control');
    expect(controls(html)).toEqual([OPEN, 'Take over']);
    expect(html).not.toContain('agent-computer-touch');
  });

  it('offers Stop only while the agent runs a Turn, in the bar', () => {
    expect(controls(render({ running: true }))).toEqual([OPEN, 'Take over', 'Stop']);
    expect(controls(render({ running: true, control: 'user' }))).toEqual([OPEN, 'Return control', 'Stop']);
    expect(controls(render({ running: true, computer: { state: 'asleep', screenshot: null } }))).toEqual([OPEN, 'Stop']);
  });

  it('attaches who has control under the desktop, as dots does', () => {
    const html = render({});

    expect(html).toMatch(
      /<\/div><div class="agent-computer-bar"><span class="agent-computer-pill">Template Bot has control<span aria-hidden="true"> · <\/span><button[^>]*>Take over<\/button><\/span><\/div><\/div>$/,
    );
  });

  it('keeps compact user control read-only until the screen opens', () => {
    const html = render({ control: 'user' });
    expect(controls(html)).toEqual([OPEN, 'Return control']);
    expect(html).not.toContain('agent-computer-touch');
  });

  it('opens Chromium and Terminal each in a window, Files on the taskbar until it opens, the front one pressed', () => {
    const html = render({});

    expect(taskbar(html)).toEqual(['Files', 'Chromium pressed', 'Terminal']);
    expect([...html.matchAll(/data-window="(\w+)" data-state="open"/g)].map(([, app]) => app)).toEqual(['Chromium', 'Terminal']);
    // Files lists the account's files only once it opens.
    expect(html).not.toContain('data-files');
    expect(html).toContain('agent-computer-terminal');
    expect([...render({ app: 'Files' }).matchAll(/data-window="(\w+)" data-state="open"/g)].map(([, app]) => app)).toEqual(['Files', 'Chromium', 'Terminal']);
  });

  it('keeps the preview out of reach: a press anywhere opens the sheet', () => {
    expect(render({})).toMatch(/<div class="agent-computer-windows" data-layout="desktop" inert="">/);
  });

  it('brings the Files window in front of the browser while Files is open', () => {
    for (const computer of [{ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null }, { state: 'asleep', screenshot: 'data:,' }] as const) {
      const html = render({ app: 'Files', computer });

      expect(html).toContain('<section class="agent-computer-app" aria-label="Files"><div data-files=""></div></section>');
      expect(controls(html)).toEqual(computer.state === 'awake' ? [OPEN, 'Take over'] : [OPEN]);
      expect(taskbar(html)).toEqual(['Files pressed', 'Chromium', 'Terminal']);
    }
  });

  it("keeps the live view connected in Chromium's window under Terminal and Files, so Chromium shows it at once", () => {
    for (const app of ['Terminal', 'Files'] as const) {
      expect(render({ app })).toMatch(/<div class="agent-computer-screen[^"]*"><div class="agent-computer-live"><div data-live-view="browser-1"><\/div><\/div>/);
    }
  });

  // ADR 0077's 2026-10-04 amendment: opening the chat or the tab wakes the computer, so it offers no Wake.
  it('shows the last screenshot dimmed while asleep, with no Wake and nothing to take over', () => {
    const html = render({ computer: { state: 'asleep', screenshot: 'data:image/jpeg;base64,c2hvdA==' } });

    expect(html).toContain('<img class="agent-computer-screenshot" src="data:image/jpeg;base64,c2hvdA==" alt="The last screen"/>');
    expect(html).not.toContain('data-live-view');
    expect(controls(html)).toEqual([OPEN]);
  });

  it('shows the desktop, not a black frame, before the computer ever slept', () => {
    const html = render({ computer: { state: 'asleep', screenshot: null } });

    expect(html).toContain('<div class="agent-computer-screen agent-computer-screen-covered"><div class="agent-computer-cover"></div>');
  });

  // Its Starting… waits out a --motion-move first (agent-computer-sheet.test.ts).
  it('covers the live view with the last screen, dimmed, until the live view connects', () => {
    const html = render({ computer: { state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: 'data:image/jpeg;base64,c2hvdA==' } });

    expect(html).toContain(
      '<div class="agent-computer-screen agent-computer-screen-covered"><div class="agent-computer-live"><div data-live-view="browser-1"></div></div>' +
        '<div class="agent-computer-cover"><img class="agent-computer-screenshot" src="data:image/jpeg;base64,c2hvdA==" alt="The last screen"/></div>',
    );
  });

  it('disables the control buttons while a change is in flight', () => {
    const html = render({ busy: true });

    const control = html.match(/<button[^>]*>Take over<\/button>/)?.[0];
    expect(control).toContain('data-slot="button"');
    expect(control).toMatch(/\sdisabled(="")?[\s>]/);
  });

  it('says why a control change failed', () => {
    const html = render({ error: 'Take over failed: 502' });

    expect(html).toContain('<p class="agent-computer-error" role="alert">Take over failed: 502</p>');
  });
});

describe("the Agent Computer's sheet", () => {
  const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

  it('fills a phone screen on black (dots Fig 8)', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));

    expect(css).toMatch(/\n\.agent-computer-sheet \{[^}]*position: fixed;[^}]*inset: 0;/);
    // The black is the sheet's backdrop, which fades in behind the desktop.
    expect(phone).toMatch(/\.agent-computer-sheet-backdrop \{ background: var\(--color-text\); \}/);
    expect(css).toMatch(/\n\.agent-computer-sheet-backdrop \{[^}]*position: fixed;[^}]*inset: 0;/);
  });

  it('fills the screen with Terminal and Files, Files at the page’s own sizes', () => {
    expect(css).toMatch(/\n\.agent-computer-app \{[^}]*position: absolute;[^}]*inset: 0;[^}]*font-size: var\(--font-small\);/);
  });
});
