// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Each live view's failure, by browser Session, for the test to report. */
const liveFailures = vi.hoisted(() => new Map<string, () => void>());
vi.mock('./browser-live-frame', () => ({
  BrowserLiveFrame: ({ sessionId, onError }: { sessionId: string; onError: () => void }) => {
    liveFailures.set(sessionId, onError);
    return React.createElement('div', { 'data-live-view': sessionId });
  },
}));

import { AgentComputer, type DockApp } from './agent-computer';
import { FilesWindow } from './files-app';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderComputer = (control: 'agent' | 'user' = 'agent', props: Partial<Parameters<typeof AgentComputer>[0]> = {}) =>
  act(() =>
    root.render(
      React.createElement(AgentComputer, {
        agentName: 'Pebble',
        chatId: 'chat-1',
        app: 'Chrome',
        files: React.createElement('div'),
        computer: { state: 'awake', browserSessionId: 'browser-1', control, screenshot: null },
        commands: [],
        control,
        running: false,
        starting: false,
        busy: false,
        error: null,
        notice: null,
        onTakeOver: () => {},
        onHandBack: () => {},
        onStop: () => {},
        onOpenApp: () => {},
        ...props,
      }),
    ),
  );

/** A button by its label, or by its text when it has none. */
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name) ?? null;

type Viewport = { width: number; height: number };
const happyDOM = () => (window as unknown as { happyDOM: { setViewport: (viewport: Viewport) => void } }).happyDOM;

// Styles the computer with styles.css in a window of the given size, as the app does, for each test in the block.
const inWindow = (viewport: Viewport) => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    document.head.append(style);
    happyDOM().setViewport(viewport);
  });

  afterEach(() => {
    happyDOM().setViewport({ width: 1024, height: 768 });
    style.remove();
  });
};

const styleOf = (selector: string) => {
  const element = container.querySelector(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return getComputedStyle(element);
};

const takeOver = () => {
  const control = container.querySelector<HTMLButtonElement>('.agent-computer-control');
  if (control === null) throw new Error('no Take over button');
  act(() => control.click());
};

describe("the Agent Computer's sheet", () => {
  it('opens the computer as a sheet titled with the agent, and closes it again', () => {
    renderComputer();
    const liveView = container.querySelector('[data-live-view="browser-1"]');

    act(() => button('View computer')?.click());

    const sheet = container.querySelector('.agent-computer');
    expect(sheet?.classList.contains('agent-computer-sheet')).toBe(true);
    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(container.querySelector('.agent-computer-sheet-title')?.textContent).toBe("Pebble's computer");
    // The live view stays connected: opening the sheet restyles the computer, it does not remount it.
    expect(container.querySelector('[data-live-view="browser-1"]')).toBe(liveView);

    act(() => button('Close computer')?.click());

    expect(container.querySelector('.agent-computer')?.classList.contains('agent-computer-sheet')).toBe(false);
    expect(button('View computer')).not.toBeNull();
  });
});

describe('full-view ownership', () => {
  it('opens watching without requesting control and preserves the stream', () => {
    const onTakeOver = vi.fn();
    renderComputer('agent', { onTakeOver });
    const stream = container.querySelector('[data-live-view]');
    act(() => button('View computer')?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onTakeOver).not.toHaveBeenCalled();
    expect(container.querySelector('.agent-computer-touch')).toBeNull();
    expect(container.querySelector('[data-live-view]')).toBe(stream);
  });

  it.each(['agent', 'user'] as const)('closes an inactive chat sheet and disables its %s ownership controls without replacing its viewer', (control) => {
    const onTakeOver = vi.fn();
    const onHandBack = vi.fn();
    const props = { onTakeOver, onHandBack };
    renderComputer(control, props);
    act(() => button('View computer')?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const stream = container.querySelector('[data-live-view]');

    renderComputer(control, { ...props, active: false });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
    expect(button('View computer')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.agent-computer-control')?.disabled).toBe(true);
    act(() => {
      button('View computer')?.click();
      container.querySelector<HTMLButtonElement>('.agent-computer-control')?.click();
    });
    expect(onTakeOver).not.toHaveBeenCalled();
    expect(onHandBack).not.toHaveBeenCalled();
    expect(container.querySelector('[data-live-view]')).toBe(stream);

    renderComputer(control, { ...props, active: true });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(button('View computer')?.disabled).toBe(false);
    act(() => button('View computer')?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-live-view]')).toBe(stream);
  });

  it('keeps failed takeover read-only and keeps failed handback open until ownership confirms', () => {
    const onTakeOver = vi.fn();
    const onHandBack = vi.fn();
    renderComputer('agent', { onTakeOver, onHandBack });
    takeOver();
    expect(onTakeOver).toHaveBeenCalledWith('browser-1');
    renderComputer('agent', { error: 'Take over failed' });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('.agent-computer-touch')).toBeNull();
    renderComputer('user', { onHandBack });
    act(() => container.querySelector<HTMLButtonElement>('.agent-computer-control')?.click());
    expect(onHandBack).toHaveBeenCalledWith('browser-1');
    renderComputer('user', { busy: true });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    renderComputer('user', { error: 'Hand back failed' });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Hand back failed');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    renderComputer('user', { onHandBack });
    act(() => container.querySelector<HTMLButtonElement>('.agent-computer-control')?.click());
    renderComputer('agent');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps a reopened watching view open when an earlier return finishes', () => {
    renderComputer('user');
    act(() => button('View computer')?.click());
    act(() => container.querySelector<HTMLButtonElement>('.agent-computer-control')?.click());
    act(() => button('Close computer')?.click());
    act(() => button('View computer')?.click());
    renderComputer('agent');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('.agent-computer-touch')).toBeNull();
  });

  it('disables duplicate ownership requests while busy', () => {
    const onTakeOver = vi.fn();
    renderComputer('agent', { busy: true, onTakeOver });
    takeOver();
    expect(onTakeOver).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("the Agent Computer's app frame", () => {
  it('switches from Files and Terminal back to Chrome in the dock, keeping the same browser view', () => {
    const onOpenApp = (app: DockApp) => renderComputer('agent', { app, onOpenApp });
    renderComputer('agent', { app: 'Chrome', onOpenApp });
    act(() => liveFailures.get('browser-1')?.());
    const liveView = container.querySelector('[data-live-view="browser-1"]');

    act(() => button('Files')?.click());
    expect(container.querySelector('.agent-computer-app')?.getAttribute('aria-label')).toBe('Files');
    expect(button('Close app')).toBeNull();
    act(() => button('Chrome')?.click());
    expect(container.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe('Chrome');
    expect(container.querySelector('[data-live-view="browser-1"]')).toBe(liveView);

    act(() => button('Terminal')?.click());
    expect(container.querySelector('.agent-computer-terminal')?.textContent).toBe('No commands yet');
    expect(button('Close app')).toBeNull();
    act(() => button('Chrome')?.click());
    expect(container.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe('Chrome');
    expect(container.querySelector('.agent-computer-app')).toBeNull();
    expect(container.querySelector('[data-live-view="browser-1"]')).toBe(liveView);
    expect(container.querySelector('.agent-computer-screen-covered')).toBeNull();
  });
});

describe("the Agent Computer's screen", () => {
  it("uncovers a new browser Session's live view when it too cannot start", () => {
    const covered = () => container.querySelector('.agent-computer-screen-covered') !== null;
    renderComputer();
    act(() => liveFailures.get('browser-1')?.());
    expect(covered()).toBe(false);

    renderComputer('agent', { computer: { state: 'awake', browserSessionId: 'browser-2', control: 'agent', screenshot: null } });
    expect(covered()).toBe(true);
    act(() => liveFailures.get('browser-2')?.());

    expect(covered()).toBe(false);
  });
});

describe('the Agent Computer on a phone, while the user has control (dots Fig 8)', () => {
  inWindow({ width: 390, height: 844 });

  it('says who drives under the screen, as on desktops, leaving the touch tools to the toolbar', () => {
    renderComputer('user');
    act(() => button('View computer')?.click());

    expect(container.querySelector('.agent-computer-bar .agent-computer-pill')?.textContent).toBe("You have control · Return control");
    expect(styleOf('.agent-computer-bar').display).not.toBe('none');
    expect(container.querySelector('.agent-computer-touch .agent-computer-pill')).toBeNull();
  });

  it("keeps the touch tools one phone gutter from the screen's edges", () => {
    renderComputer('user');
    act(() => button('View computer')?.click());

    expect(styleOf('.agent-computer-touch').paddingLeft).toBe('16px');
    expect(styleOf('.agent-computer-touch').paddingRight).toBe('16px');
  });


});

describe("the Agent Computer's preview in the profile on a phone, while the agent drives (Muse Fig 14)", () => {
  inWindow({ width: 390, height: 844 });

  it('sets the desktop under the tabs as a rounded card that fills the pane down to who drives', () => {
    renderComputer();

    expect(styleOf('.agent-computer-desktop').flexGrow).toBe('1');
    expect(styleOf('.agent-computer-desktop').borderRadius).not.toBe('0px');


  });
});

describe("the Agent Computer's Files on a phone", () => {
  inWindow({ width: 390, height: 844 });

  it('packs files and folders from the left in 62px cells, each a tap target 44px tall at least, under a 32px icon', () => {
    const files = [
      { name: 'prices.csv', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'reports/q3.pdf', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
    ];
    renderComputer('agent', {
      app: 'Files',
      files: React.createElement(FilesWindow, { files, error: null, onDownload: () => {}, onDelete: () => {}, onRename: () => {}, onReload: () => {} }),
    });
    const items = [...container.querySelectorAll('.agent-computer-file')].map((item) => getComputedStyle(item));
    const icons = [...container.querySelectorAll('.agent-computer-file svg')].map((icon) => getComputedStyle(icon));

    expect(items.map(({ width, minHeight }) => [width, minHeight])).toEqual([['62px', '44px'], ['62px', '44px']]);
    expect([styleOf('.agent-computer-files-grid').display, styleOf('.agent-computer-files-grid').flexWrap]).toEqual(['flex', 'wrap']);
    // A big folder beside a page, as Finder draws them.
    expect(icons.map(({ width, height }) => [width, height])).toEqual([['26px', '32px'], ['40px', '32px']]);
  });
});

describe('the Agent Computer on a desktop (dots Fig 6)', () => {
  inWindow({ width: 1280, height: 800 });

  it("hangs the preview under the tabs and centers the full view", () => {
    renderComputer();

    expect(styleOf('.agent-computer').justifyContent).toBe('flex-start');
    act(() => button('View computer')?.click());
    expect(styleOf('.agent-computer').justifyContent).toBe('center');
  });

  it('drops the bar under the desktop, and its gap, while it has nothing to say', () => {
    renderComputer('agent', { computer: { state: 'asleep', screenshot: null } });

    expect(styleOf('.agent-computer-bar').display).toBe('none');

    renderComputer('agent', { computer: { state: 'asleep', screenshot: null }, running: true });

    expect(styleOf('.agent-computer-bar').display).not.toBe('none');
  });

  it('opens the computer over the full desktop window', () => {
    renderComputer();

    expect(styleOf('.agent-computer-screen-open').display).not.toBe('none');
    act(() => button('View computer')?.click());

    const pane = styleOf('.agent-computer-sheet');
    expect(pane.position).toBe('fixed');
    expect(pane.inset).toBe('0');
    expect(styleOf('.agent-computer-sheet-head').display).toBe('flex');
  });

  it('opens full screen on desktop Take over', () => {
    renderComputer();

    takeOver();

    expect(container.querySelector('.agent-computer')?.classList.contains('agent-computer-sheet')).toBe(true);
  });

  it('keeps the whole window on Take over', () => {
    renderComputer();
    act(() => button('View computer')?.click());

    takeOver();

    expect(styleOf('.agent-computer-sheet').position).toBe('fixed');
  });
});

describe('the Agent Computer on a phone, on Take over (dots Fig 8)', () => {
  inWindow({ width: 390, height: 844 });

  it('opens full screen on Take over', () => {
    renderComputer();
    takeOver();
    expect(styleOf('.agent-computer-sheet').position).toBe('fixed');
  });
});

describe("the Agent Computer's Terminal", () => {
  // happy-dom lays nothing out: each command and each output is a 20px line, in a 100px window, and a scroll past the
  // end stays there, where a browser stops at the end.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.childElementCount * 20;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
  });
  afterEach(() => vi.restoreAllMocks());

  const commands = (count: number) => Array.from({ length: count }, (_, index) => ({ command: `echo ${index}`, output: `${index}` }));
  const renderTerminal = (count: number) => renderComputer('agent', { app: 'Terminal', commands: commands(count) });
  const terminal = () => {
    const log = container.querySelector<HTMLElement>('.agent-computer-terminal');
    if (log === null) throw new Error('no Terminal');
    return log;
  };
  const scrollTo = (top: number) =>
    act(() => {
      terminal().scrollTop = top;
      terminal().dispatchEvent(new Event('scroll'));
    });

  it('opens at the latest output', () => {
    renderTerminal(10);

    expect(terminal().scrollTop).toBe(400);
  });

  it('follows new output', () => {
    renderTerminal(10);

    renderTerminal(12);

    expect(terminal().scrollTop).toBe(480);
  });

  it('stays where the user scrolled up to while new output arrives, and follows again once they scroll back down', () => {
    renderTerminal(10);
    scrollTo(40);

    renderTerminal(12);

    expect(terminal().scrollTop).toBe(40);

    scrollTo(480 - 100);
    renderTerminal(14);

    expect(terminal().scrollTop).toBe(560);
  });

  it('follows from within a pixel of the end, not from two', () => {
    renderTerminal(10);
    scrollTo(400 - 100 - 1);

    renderTerminal(12);

    expect(terminal().scrollTop).toBe(480);

    scrollTo(480 - 100 - 2);
    renderTerminal(14);

    expect(terminal().scrollTop).toBe(378);
  });

  it('shows its failure in place of the log', () => {
    renderComputer('agent', { app: 'Terminal', commands: commands(10), terminalError: 'The commands could not load' });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The commands could not load');
  });
});
