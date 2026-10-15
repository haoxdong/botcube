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
      chatId: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
      app: 'Chrome',
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
  );
/** Each button's name: its text, or the label of an icon-only button. */
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(
    ([, attributes = '', content = '']) => content.replace(/<[^>]*>/g, '') || /aria-label="([^"]*)"/.exec(attributes)?.[1],
  );
/** The way into the computer sheet, at the wallpaper's bottom right under the dock. */
const OPEN = 'View computer';
const DOCK = ['Files', 'Chrome', 'Terminal'];
/** The dock's apps: each one's name, whether it shows its drawn icon, and whether it is the open one. */
const dock = (html: string) =>
  [...html.matchAll(/class="agent-computer-dock-app[^"]*" aria-label="([^"]+)" title="\1"( aria-current="true")?>(<svg class="agent-computer-dock-icon")?/g)].map(
    ([, name, open, icon]) => `${name}${icon ? ' (icon)' : ''}${open ? ' open' : ''}`,
  );

describe('AgentComputer', () => {
  it('shows the live browser directly on the desktop, with the agent in control', () => {
    const html = render({});

    expect(html).toContain('<div data-live-view="browser-1"></div>');
    expect(html).toContain('Template Bot has control');
    expect(buttons(html)).toEqual([OPEN, ...DOCK, 'Take over']);
    expect(html).not.toContain('agent-computer-touch');
  });

  it('offers Stop only while the agent runs a Turn, in the bar', () => {
    expect(buttons(render({ running: true }))).toEqual([OPEN, ...DOCK, 'Take over', 'Stop']);
    expect(buttons(render({ running: true, control: 'user' }))).toEqual(
      [OPEN, ...DOCK, 'Return control', 'Stop'],
    );
    expect(buttons(render({ running: true, computer: { state: 'asleep', screenshot: null } }))).toEqual(
      [OPEN, ...DOCK, 'Stop'],
    );
  });

  it('attaches who has control under the desktop, as dots does', () => {
    const html = render({});

    expect(html).toMatch(
      /<\/div><div class="agent-computer-bar"><span class="agent-computer-pill">Template Bot has control<span aria-hidden="true"> · <\/span><button[^>]*>Take over<\/button><\/span><\/div><\/div>$/,
    );
  });

  it('keeps compact user control read-only until the screen opens', () => {
    const html = render({ control: 'user' });
    expect(buttons(html)).toEqual([OPEN, ...DOCK, 'Return control']);
    expect(html).not.toContain('agent-computer-touch');
  });

  it('docks Files, Chrome and Terminal from the left, marking the open one', () => {
    const html = render({});

    expect(dock(html)).toEqual(['Files (icon)', 'Chrome (icon) open', 'Terminal (icon)']);
    expect(html).not.toContain('data-files');
    expect(html).not.toContain('agent-computer-terminal');
  });

  it("draws Chrome's dock icon as the Chromium logo: three blue segments around a blue core in a white ring", () => {
    const chrome = /aria-label="Chrome"[^>]*><svg[^>]*>(.*?)<\/svg>/.exec(render({}))?.[1] ?? '';

    expect([...chrome.matchAll(/fill="(#[0-9a-f]+)"/g)].map(([, fill]) => fill)).toEqual(['#1a73e8', '#4285f4', '#8ab4f8', '#ffffff', '#4285f4']);
  });

  it('docks the apps under the screen without the old Open computer pill', () => {
    const html = render({});
    expect(html).toContain('agent-computer-dock');
    expect(html).not.toContain('agent-computer-open');
  });

  it("shows the Terminal's commands and their output as a read-only log in place of the browser", () => {
    const html = render({
      app: 'Terminal',
      commands: [
        { command: 'ls', output: 'a.txt' },
        { command: 'cat a.txt', output: 'hello' },
      ],
    });

    // Each command after zsh's prompt on the chat's host, its output plain, under a title bar of the folder and shell alone.
    expect(html).toMatch(
      /<section class="agent-computer-app" aria-label="Terminal"><div class="agent-computer-terminal-bar"><svg[^>]*>.*?<\/svg><span>workspace — zsh<\/span><\/div>/,
    );
    expect(html).toContain(
      '<div class="agent-computer-terminal" role="log" aria-label="Terminal">' +
        '<div class="agent-computer-terminal-line">agent@a1b2c3d4e5f6 workspace % ls</div><div class="agent-computer-terminal-output">a.txt</div>' +
        '<div class="agent-computer-terminal-line">agent@a1b2c3d4e5f6 workspace % cat a.txt</div><div class="agent-computer-terminal-output">hello</div></div></section>',
    );
    // The dock switches apps: no window has a Close of its own.
    expect(buttons(html)).toEqual([...DOCK, 'Take over']);
    expect(html).not.toContain('data-files');
    expect(dock(html)).toContain('Terminal (icon) open');
  });

  it('says so while the agent has run no commands', () => {
    const html = render({ app: 'Terminal' });

    expect(html).toContain('<div class="agent-computer-terminal-empty">No commands yet</div>');
  });

  it('shows the Files window over the browser while Files is open, with no Close: the dock switches apps', () => {
    for (const computer of [{ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null }, { state: 'asleep', screenshot: 'data:,' }] as const) {
      const html = render({ app: 'Files', computer });

      expect(html).toContain('<section class="agent-computer-app" aria-label="Files"><div data-files=""></div></section>');
      expect(buttons(html)).toEqual(computer.state === 'awake' ? [...DOCK, 'Take over'] : DOCK);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('Starting…');
      expect(dock(html)).toContain('Files (icon) open');
    }
  });

  it("keeps the live view connected on the agent's screen under Terminal and Files, so Chrome shows it at once", () => {
    for (const app of ['Terminal', 'Files'] as const) {
      expect(render({ app })).toMatch(
        /<div class="agent-computer-window"><div class="agent-computer-screen"><div data-live-view="browser-1"><\/div><section class="agent-computer-app"/,
      );
    }
  });

  // ADR 0077's 2026-10-04 amendment: opening the chat or the tab wakes the computer, so it offers no Wake.
  it('shows the last screenshot dimmed while asleep, with no Wake and nothing to take over', () => {
    const html = render({ computer: { state: 'asleep', screenshot: 'data:image/jpeg;base64,c2hvdA==' } });

    expect(html).toContain('<img class="agent-computer-screenshot" src="data:image/jpeg;base64,c2hvdA==" alt="The last screen"/>');
    expect(html).not.toContain('data-live-view');
    expect(buttons(html)).toEqual([OPEN, ...DOCK]);
  });

  it('shows the desktop, not a black frame, before the computer ever slept', () => {
    const html = render({ computer: { state: 'asleep', screenshot: null } });

    expect(html).toContain('<div class="agent-computer-screen agent-computer-screen-covered"><div class="agent-computer-cover"></div>');
  });

  it('says the computer is starting while its wake is in flight', () => {
    expect(render({ computer: { state: 'asleep', screenshot: null }, starting: true })).toContain(
      '<p class="agent-computer-starting" role="status">Starting…</p>',
    );
    expect(render({ computer: { state: 'asleep', screenshot: null } })).not.toContain('Starting…');
  });

  it('covers the live view with the last screen, dimmed, and says it is connecting, until the live view connects', () => {
    const html = render({ computer: { state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: 'data:image/jpeg;base64,c2hvdA==' } });

    expect(html).toContain(
      '<div class="agent-computer-screen agent-computer-screen-covered"><div data-live-view="browser-1"></div>' +
        '<div class="agent-computer-cover"><img class="agent-computer-screenshot" src="data:image/jpeg;base64,c2hvdA==" alt="The last screen"/>' +
        '<p class="agent-computer-starting" role="status">Connecting…</p></div>',
    );
  });

  it('says an awake browser is connecting even if the wake flag is still set', () => {
    const html = render({
      computer: { state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null },
      starting: true,
    });

    expect(html).toContain('<p class="agent-computer-starting" role="status">Connecting…</p>');
    expect(html).not.toContain('Starting…');
  });

  it('disables the control buttons while a change is in flight', () => {
    const html = render({ busy: true });

    expect(html).toContain('<button type="button" class="agent-computer-control" disabled="">Take over</button>');
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

    expect(phone).toMatch(/\.agent-computer-sheet\s*\{[^}]*position: fixed;[^}]*inset: 0;[^}]*background: var\(--color-black\);/);
  });

  it('fills the screen with Terminal and Files, Files at the page’s own sizes', () => {
    expect(css).toMatch(/\n\.agent-computer-app \{[^}]*position: absolute;[^}]*inset: 0;[^}]*font-size: var\(--font-detail\);/);
  });

  // Terminal's bar and type are Chrome's: shares of the screen's width, as a 1280px stream draws them.
  it("sizes Terminal by the screen's width, as the live view scales Chrome", () => {
    expect(css).toMatch(/\n\.agent-computer-screen \{[^}]*container-type: inline-size;/);
    expect(css).toMatch(/\n\.agent-computer-terminal-bar \{[^}]*height: 2\.97cqw;[^}]*padding: 0 1\.25cqw;[^}]*font-size: 1\.02cqw;/);
    expect(css).toMatch(/\n\.agent-computer-terminal-bar svg \{[^}]*width: 1\.25cqw;[^}]*height: 1\.25cqw;/);
    expect(css).toMatch(/\n\.agent-computer-terminal \{[^}]*padding: 0\.63cqw 1\.09cqw;[^}]*background: #1c1e21;[^}]*font: 1\.41cqw\/1\.4 'Menlo'/);
  });

  it("wraps the Terminal's lines between words, breaking only a word longer than the line", () => {
    expect(css).toMatch(/\n\.agent-computer-terminal \{[^}]*overflow-wrap: anywhere;/);
    expect(css).not.toContain('word-break: break-all');
  });


});
