import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDesktopWindows, WindowsDesktop, type DockApp, type WindowsDesktopProps } from './windows-desktop';
import { SNAP_LAYOUTS_DELAY } from './windows-snap';

const WINDOWS: WindowsDesktopProps['windows'] = [
  { app: 'Files', title: 'Files', children: React.createElement('p', null, 'Files here') },
  { app: 'Chromium', title: 'Chromium', keepMounted: true, children: React.createElement('p', null, 'The browser') },
  { app: 'Terminal', title: 'workspace — zsh', dark: true, children: React.createElement('p', null, 'The shell') },
];

type Props = Partial<Omit<WindowsDesktopProps, 'desktop'>> & { front?: DockApp };
function Desktop({ front = 'Chromium', onFront, ...props }: Props & { onFront: (app: DockApp | null) => void }) {
  return React.createElement(WindowsDesktop, { windows: WINDOWS, interactive: true, desktop: useDesktopWindows(front, onFront), ...props });
}
const desktop = (props: Props = {}) => {
  const onFront = vi.fn();
  render(React.createElement(Desktop, { onFront, ...props }));
  return onFront;
};

const frame = (app: string) => {
  const element = document.querySelector<HTMLElement>(`[data-window="${app}"]`);
  if (element === null) throw new Error(`no ${app} window`);
  return element;
};
const state = (app: string) => frame(app).getAttribute('data-state');
// happy-dom lays nothing out, so react-rnd measures each window's offset from its parent as minus the place it opened
// at, and draws its translate that far off.
const OPENED = { Files: [40, 24], Chromium: [440, 44], Terminal: [200, 330] } as const;
/** Where a window sits on the 1280x672 screen above the taskbar, and its size. */
const place = (app: keyof typeof OPENED) => {
  const { transform, width, height } = frame(app).style;
  const [x = 0, y = 0] = [...transform.matchAll(/-?\d+/g)].map(Number);
  const [openX, openY] = OPENED[app];
  return `${x - openX},${y - openY} ${width}x${height}`;
};
const taskbarApp = (app: string) => {
  const button = document.querySelector<HTMLElement>(`.agent-computer-taskbar-app[aria-label="${app}"]`);
  if (button === null) throw new Error(`no ${app} on the taskbar`);
  return button;
};
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const surface = (name: string) => {
  const element = document.querySelector<HTMLElement>(`.fui-PopoverSurface[aria-label="${name}"]`);
  if (element === null) throw new Error(`no ${name} flyout`);
  return element;
};
const noSurface = (name: string) => document.querySelector(`.fui-PopoverSurface[aria-label="${name}"]`) === null;
const names = (element: HTMLElement) => within(element).getAllByRole('button').map((button) => button.textContent).filter(Boolean);

afterEach(() => vi.useRealTimers());

describe('Start', () => {
  it('opens the pinned apps above the taskbar, each opening its window', () => {
    const onFront = desktop();
    press('Start');
    const start = surface('Start');
    expect(within(start).getByRole('searchbox', { name: 'Search for apps, settings and documents' })).toBeTruthy();
    expect(names(start)).toEqual(['Files', 'Chromium', 'Terminal']);

    fireEvent.click(within(start).getByRole('button', { name: 'Files' }));
    expect(state('Files')).toBe('open');
    expect(onFront).toHaveBeenLastCalledWith('Files');
    expect(screen.getByRole('button', { name: 'Start' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('narrows the pinned apps as you type, and Enter opens the first', () => {
    const onFront = desktop();
    press('Start');
    const search = within(surface('Start')).getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'TERM' } });
    expect(within(surface('Start')).queryByRole('button', { name: 'Files' })).toBeNull();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onFront).toHaveBeenLastCalledWith('Terminal');
  });

  it("names the agent, and its Power menu stops the run, or is disabled while there's none", () => {
    const onStop = vi.fn();
    desktop({ agentName: 'Pebble', onStop });
    press('Start');
    expect(surface('Start').textContent).toContain('Pebble');
    fireEvent.click(within(surface('Start')).getByRole('button', { name: 'Power' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('keeps Stop disabled with no run to stop', () => {
    desktop({ agentName: 'Pebble', onStop: null });
    press('Start');
    fireEvent.click(within(surface('Start')).getByRole('button', { name: 'Power' }));
    expect(screen.getByRole('menuitem', { name: 'Stop' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Search', () => {
  it('finds an app by name, and Enter opens it', () => {
    const onFront = desktop({ front: 'Terminal' });
    press('Search');
    const search = within(surface('Search')).getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'ch' } });
    expect(names(surface('Search'))).toEqual(['Chromium']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onFront).toHaveBeenLastCalledWith('Chromium');
  });

  it('says when nothing matches', () => {
    desktop();
    press('Search');
    fireEvent.change(within(surface('Search')).getByRole('searchbox'), { target: { value: 'excel' } });
    expect(surface('Search').textContent).toContain('No results for “excel”');
  });
});

describe('the tray', () => {
  it("shows the computer's network as it is, changing nothing", () => {
    desktop({ online: true });
    press('Quick settings');
    expect(surface('Quick settings').textContent).toContain('Connected');
    expect(within(surface('Quick settings')).queryAllByRole('button')).toEqual([]);
  });

  it('says an asleep computer is not connected', () => {
    desktop({ online: false });
    press('Quick settings');
    expect(surface('Quick settings').textContent).toContain('Not connected');
  });

  it("opens the clock on today's date over a calendar, today selected", () => {
    desktop();
    const today = new Date();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(today.toLocaleDateString().replaceAll('/', '\\/')) }));
    const calendar = surface('Calendar');
    expect(calendar.textContent).toContain(today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
    expect(calendar.querySelector('[aria-selected="true"]')?.textContent).toContain(String(today.getDate()));
  });

  it('shows the desktop, and brings the same windows back on a second press', () => {
    desktop();
    press('Show desktop');
    expect([state('Chromium'), state('Terminal')]).toEqual(['minimised', 'minimised']);
    press('Show desktop');
    expect([state('Chromium'), state('Terminal')]).toEqual(['open', 'open']);
    expect(taskbarApp('Chromium').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('a taskbar app', () => {
  it('offers its menu on a right click: its name opens it, Close window closes it', () => {
    desktop();
    fireEvent.contextMenu(taskbarApp('Terminal'));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Terminal', 'Close window']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close window' }));
    expect(state('Terminal')).toBe('closed');
  });

  it("can't close a window that isn't open", () => {
    desktop();
    fireEvent.contextMenu(taskbarApp('Files'));
    expect(screen.getByRole('menuitem', { name: 'Close window' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Files' }));
    expect(state('Files')).toBe('open');
  });

  it("previews a running window's title bar on hover", () => {
    vi.useFakeTimers();
    desktop();
    fireEvent.pointerEnter(taskbarApp('Terminal'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('tooltip').textContent).toBe('workspace — zsh');
  });
});

describe('snapping', () => {
  it('offers the snap layouts on a held hover of Maximise, and snaps the window to the zone picked', () => {
    vi.useFakeTimers();
    desktop({ front: 'Terminal' });
    fireEvent.mouseOver(screen.getByRole('button', { name: 'Maximise Terminal' }));
    act(() => { vi.advanceTimersByTime(SNAP_LAYOUTS_DELAY - 1); });
    expect(noSurface('Snap layouts for Terminal')).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    const layouts = surface('Snap layouts for Terminal');
    expect(within(layouts).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual(['Halves', 'Two thirds and a third', 'A half and two quarters', 'Quarters']);

    fireEvent.click(within(within(layouts).getByRole('group', { name: 'Quarters' })).getByRole('button', { name: 'Top right quarter' }));
    expect(place('Terminal')).toBe('640,0 640pxx336px');

    press('Maximise Terminal');
    expect(place('Terminal')).toBe('0,0 100%x100%');
  });

  it('offers no layouts for a hover that leaves before the wait', () => {
    vi.useFakeTimers();
    desktop({ front: 'Terminal' });
    const maximise = screen.getByRole('button', { name: 'Maximise Terminal' });
    fireEvent.mouseOver(maximise);
    act(() => { vi.advanceTimersByTime(SNAP_LAYOUTS_DELAY / 2); });
    fireEvent.mouseOut(maximise);
    act(() => { vi.advanceTimersByTime(SNAP_LAYOUTS_DELAY * 4); });
    expect(noSurface('Snap layouts for Terminal')).toBe(true);
  });

  it("offers Windows' window menu on the title bar, enabling only what applies", () => {
    desktop({ front: 'Terminal' });
    const titleBar = () => frame('Terminal').querySelector('.window-titlebar') ?? document.body;
    const menu = () => Object.fromEntries(screen.getAllByRole('menuitem').map((item) => [item.textContent, item.getAttribute('aria-disabled') !== 'true']));
    fireEvent.contextMenu(titleBar());
    expect(menu()).toEqual({ Restore: false, Minimise: true, Maximise: true, Close: true });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Maximise' }));
    // Maximised, a window fills the area above the taskbar in CSS, not at a size react-rnd last placed.
    expect(place('Terminal')).toBe('0,0 100%x100%');
    fireEvent.contextMenu(titleBar());
    expect(menu()).toEqual({ Restore: true, Minimise: true, Maximise: false, Close: true });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
    expect(place('Terminal')).toBe('200,330 700pxx320px');
  });
});
