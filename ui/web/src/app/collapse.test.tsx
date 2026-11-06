import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { m } from 'framer-motion';
import type { ReactNode } from 'react';
import { Collapse, CollapseItem, CollapseList, Fade, Presence, Swap, presenceMotion } from './collapse';

// globals.css's tokens, which the transitions read as they start.
const tokens = () => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-move: 300ms; --motion-quick: 150ms; --ease: cubic-bezier(0.32, 0.72, 0, 1); }';
  onTestFinished(() => sheet.remove());
};
// Motion's features load after first paint; until then a box shows as it starts and leaves at once.
const loaded = () => act(() => import('./motion-features'));

describe('Collapse', () => {
  it('unmounts with nothing to wait for without the motion tokens (no stylesheet)', async () => {
    const view = render(<Collapse open>Steps</Collapse>);
    view.rerender(<Collapse open={false}>Steps</Collapse>);
    await waitFor(() => expect(screen.queryByText('Steps')).toBeNull(), { timeout: 100 });
  });

  describe('with the motion tokens', () => {
    it('shrinks away, inert, until its height has closed, then unmounts', async () => {
      tokens();
      const view = render(<Collapse open><button type="button">Ran ls</button></Collapse>);
      await loaded();
      view.rerender(<Collapse open={false}><button type="button">Ran ls</button></Collapse>);
      const box = view.container.querySelector('.collapsible');
      expect(box).toHaveAttribute('data-closing');
      expect(box).toHaveAttribute('inert');
      expect(screen.queryByText('Ran ls')).not.toBeNull();
      await waitFor(() => expect(screen.queryByText('Ran ls')).toBeNull(), { timeout: 1000 });
    });

    // Laid out at its end height for a moment, the box would shrink a scroll view held at its end, and the browser
    // would clamp the view's scroll there and keep it: the whole chat dropped in one frame as a Worklog closed.
    // happy-dom has no layout to clamp, so this watches the cause: Motion (motion-dom 14.7.1's measureEndState) reads
    // the box's computed style while it holds the end height, to resolve a close from "auto".
    it('closes from the height it shows, never laid out at its end height first', async () => {
      tokens();
      await loaded();
      const view = render(<Collapse open>Steps</Collapse>);
      const box = view.container.querySelector<HTMLElement>('.collapsible');
      if (!box) throw new Error('The open Collapse has no box');
      // Open at rest: its height has grown in to auto, as a Worklog's has a while into its Turn.
      await waitFor(() => expect(box.style.height).toBe('auto'), { timeout: 1000 });
      // Its motion value settles on "auto" only once the 300 ms opening has run.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const read = window.getComputedStyle;
      const laidOutAt: string[] = [];
      const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        if (element === box) laidOutAt.push(box.style.height);
        return read.call(window, element, pseudo);
      });
      onTestFinished(() => spy.mockRestore());
      view.rerender(<Collapse open={false}>Steps</Collapse>);
      await waitFor(() => expect(screen.queryByText('Steps')).toBeNull(), { timeout: 1000 });
      expect(laidOutAt).not.toContain('0px');
    });

    it('opens again from where it is when reopened while closing', async () => {
      tokens();
      const view = render(<Collapse open>Steps</Collapse>);
      await loaded();
      view.rerender(<Collapse open={false}>Steps</Collapse>);
      view.rerender(<Collapse open>Steps</Collapse>);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const box = view.container.querySelector('.collapsible');
      expect(box).not.toHaveAttribute('data-closing');
      expect(box).not.toHaveAttribute('inert');
      expect(screen.getByText('Steps')).toBeVisible();
    });

    const rows = (ids: string[]) => (
      <ul>
        <CollapseList>
          {ids.map((id) => (
            <CollapseItem as="li" key={id}>{id}</CollapseItem>
          ))}
        </CollapseList>
      </ul>
    );

    it("shows a list's rows at once as it mounts, and grows in a row that arrives", () => {
      tokens();
      const view = render(rows(['Rates recap']));
      expect(view.container.querySelector('li')?.style.height).toBe('auto');
      view.rerender(rows(['Rates recap', 'FX check']));
      expect(screen.getByText('FX check').closest('li')?.style.height).toBe('0px');
    });

    it('closes a removed row up, inert, before it leaves the list', async () => {
      tokens();
      const view = render(rows(['Rates recap', 'FX check']));
      await loaded();
      view.rerender(rows(['Rates recap']));
      const leaving = screen.getByText('FX check').closest('li');
      expect(leaving).toHaveAttribute('inert');
      await waitFor(() => expect(screen.queryByText('FX check')).toBeNull(), { timeout: 1000 });
      expect(view.container.querySelectorAll('li')).toHaveLength(1);
    });
  });
});

describe('Fade', () => {
  it('unmounts at once without the motion tokens (no stylesheet)', () => {
    const view = render(<Fade open className="menu">Log out</Fade>);
    view.rerender(<Fade open={false} className="menu">Log out</Fade>);
    expect(screen.queryByText('Log out')).toBeNull();
  });

  describe('with the motion tokens', () => {
    it('fades in from nothing as it mounts', async () => {
      tokens();
      await loaded();
      const view = render(<Fade open className="menu">Log out</Fade>);
      expect(view.container.querySelector<HTMLElement>('.menu')?.style.opacity).toBe('0');
    });
  });
});


describe('Presence', () => {
  it('preserves a custom component render prop while assigning presence keys', () => {
    const Content = ({ children }: { children: () => ReactNode }) => children();
    render(<Presence><Content>{() => <button>Open Memory</button>}</Content></Presence>);
    expect(screen.getByRole('button', { name: 'Open Memory' })).toBeVisible();
  });

  it('retains each fragment child until its fade finishes and prevents actions during exit', async () => {
    tokens();
    await loaded();
    const contents = (open: boolean) => <Presence>{open && <>
      <m.button {...presenceMotion} key="cancel">Cancel editing</m.button>
      <m.button {...presenceMotion} key="save">Save changes</m.button>
    </>}</Presence>;
    const view = render(contents(true));
    await loaded();
    view.rerender(contents(false));
    expect(screen.getByText('Cancel editing')).toHaveAttribute('inert');
    expect(screen.getByText('Save changes')).toHaveAttribute('inert');
    await waitFor(() => expect(screen.queryByText('Save changes')).toBeNull());
    expect(screen.queryByText('Cancel editing')).toBeNull();
  });

  it('restores an exiting control when it reenters before the fade finishes', async () => {
    tokens();
    await loaded();
    const contents = (open: boolean) => <Presence>{open && <m.button {...presenceMotion}>Retry upload</m.button>}</Presence>;
    const view = render(contents(true));
    await loaded();
    const button = screen.getByText('Retry upload');
    view.rerender(contents(false));
    expect(button).toHaveAttribute('inert');
    view.rerender(contents(true));
    expect(screen.getByText('Retry upload')).toBe(button);
    expect(button).not.toHaveAttribute('inert');
    await waitFor(() => expect(button.style.opacity).toBe('1'));
  });
});


describe('Swap', () => {
  it('removes a loading document containing another swap after its replacement arrives', async () => {
    tokens();
    const view = render(<Swap state="loading"><article><Swap state="loading">Loading Memory</Swap></article></Swap>);
    view.rerender(<Swap state="loaded"><article>Loaded Memory</article></Swap>);
    await loaded();
    await waitFor(() => expect(screen.queryByText('Loading Memory')).toBeNull());
    await waitFor(() => expect(screen.getByText('Loaded Memory')).toBeVisible());
  });
});
