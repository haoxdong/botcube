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

const here = path.dirname(fileURLToPath(import.meta.url));
// The app's spacing tokens, which styles.css spaces with. Its motion tokens stay out: they would start animations the
// tests then cancel.
const spaceTokens = readFileSync(path.join(here, '../design-system/tokens.css'), 'utf8').match(/--space-\d+: [^;]+;/g);
if (spaceTokens === null) throw new Error('tokens.css declares no --space-* tokens');
const spacing = `:root { ${spaceTokens.join(' ')} }`;

// Styles the computer with the spacing tokens and styles.css in a window of the given size, as the app does, for each
// test in the block.
const inWindow = (viewport: Viewport) => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = `${spacing}\n${readFileSync(path.join(here, 'styles.css'), 'utf8')}`;
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

// Who drives: the stock Button in the bar's pill, Take over or Return control.
const whoDrives = () => container.querySelector<HTMLButtonElement>('.agent-computer-pill [data-slot="button"]');

const takeOver = () => {
  const control = whoDrives();
  if (control === null) throw new Error('no Take over button');
  act(() => control.click());
};

describe("the Agent Computer's sheet", () => {
  it('closes the watching dialog on Escape without taking control', () => {
    const onTakeOver = vi.fn();
    renderComputer('agent', { onTakeOver });
    act(() => button('View computer')?.click());
    const close = button('Close computer');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      close?.focus();
      close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onTakeOver).not.toHaveBeenCalled();
  });

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
    expect(whoDrives()?.disabled).toBe(true);
    act(() => {
      button('View computer')?.click();
      whoDrives()?.click();
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
    act(() => whoDrives()?.click());
    expect(onHandBack).toHaveBeenCalledWith('browser-1');
    renderComputer('user', { busy: true });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    renderComputer('user', { error: 'Hand back failed' });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Hand back failed');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    renderComputer('user', { onHandBack });
    act(() => whoDrives()?.click());
    renderComputer('agent');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps a reopened watching view open when an earlier return finishes', () => {
    renderComputer('user');
    act(() => button('View computer')?.click());
    act(() => whoDrives()?.click());
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

  it('packs files and folders into columns 60px wide at least, under 34px icons, with a 44px toolbar and sidebar targets', () => {
    const files = [
      { name: 'prices.csv', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'reports/q3.pdf', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
    ];
    const thumbnailUrl = async () => 'https://s3.test/picture.png';
    renderComputer('agent', {
      app: 'Files',
      files: React.createElement(FilesWindow, { files, error: null, onDownload: () => {}, onDelete: () => {}, onRename: () => null, onReload: () => {}, thumbnailUrl }),
    });
    const icons = [...container.querySelectorAll('.agent-computer-file svg')].map((icon) => getComputedStyle(icon));
    const grid = styleOf('.agent-computer-files-grid');

    expect([grid.display, grid.gridTemplateColumns]).toEqual(['grid', 'repeat(auto-fill, minmax(60px, 1fr))']);
    // A wide folder beside a page.
    expect(icons.map(({ width, height }) => [width, height])).toEqual([['28px', '34px'], ['42px', '34px']]);
    expect([styleOf('.agent-computer-files-toolbar').height, styleOf('.agent-computer-files-sidebar button').height]).toEqual(['44px', '44px']);
    expect(styleOf('.agent-computer-files-crumbs button').height).toBe('44px');
    // Back and Forward are the stock icon Button, at its own size.
    expect(['Back', 'Forward'].map((name) => button(name)?.dataset.slot)).toEqual(['button', 'button']);
    expect(styleOf('.agent-computer-files-toolbar > button').width).not.toBe('44px');
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
    // The stock Button covers the whole screen, its own height giving way to the inset.
    const open = styleOf('.agent-computer-screen-open');
    expect([open.position, open.inset, open.height]).toEqual(['absolute', '0', 'auto']);
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
  // Following the latest output is the stock Conversation's, proven with real layout in terminal-follow.stories.tsx.
  const commands = (count: number) => Array.from({ length: count }, (_, index) => ({ command: `echo ${index}`, output: `${index}` }));

  it('shows its failure in place of the log', () => {
    renderComputer('agent', { app: 'Terminal', commands: commands(10), terminalError: 'The commands could not load' });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The commands could not load');
  });
});

// The label waits out a full --motion-move (300ms with no stylesheet), then shows at once.
describe("the Agent Computer cover's Starting…", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  const asleep = { state: 'asleep', screenshot: null } as const;
  const label = () => container.querySelector('.agent-computer-starting')?.textContent ?? null;
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it('says the computer is starting only once its wake has kept the cover a full --motion-move', () => {
    renderComputer('agent', { computer: asleep, starting: true });
    expect(label()).toBeNull();
    wait(299);
    expect(label()).toBeNull();
    wait(1);
    expect(label()).toBe('Starting…');
    expect(container.querySelector('.agent-computer-starting')?.getAttribute('role')).toBe('status');
  });

  it('says an awake browser is connecting even if the wake flag is still set, and a computer asleep with no wake nothing', () => {
    renderComputer('agent', { starting: true });
    wait(300);
    expect(label()).toBe('Connecting…');

    renderComputer('agent', { computer: asleep });
    expect(label()).toBeNull();
  });

  it('shows nothing for a short wait: a cover gone before a --motion-move waits it out again', () => {
    renderComputer('agent', { computer: asleep, starting: true });
    wait(200);
    renderComputer('agent', { computer: asleep, starting: true, app: 'Terminal' });
    renderComputer('agent', { computer: asleep, starting: true });
    wait(200);
    expect(label()).toBeNull();
    wait(100);
    expect(label()).toBe('Starting…');
  });
});
