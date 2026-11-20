import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';

import { m } from 'motion/react';
import type { ReactNode } from 'react';
import { Collapse, CollapseItem, CollapseList, Fade, Presence, Swap, presenceMotion } from './collapse';

// globals.css's tokens, which the transitions read as they start.
const tokens = () => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-move: 300ms; --motion-quick: 150ms; --ease: cubic-bezier(0.32, 0.72, 0, 1); }';
  onTestFinished(() => sheet.remove());
};

describe('Collapse', () => {
  const running = (box: Element, ...properties: string[]) => Object.defineProperty(box, 'getAnimations', { configurable: true, value: () => properties.map((transitionProperty) => ({ transitionProperty })) });
  const boxOf = (container: HTMLElement) => {
    const box = container.querySelector<HTMLElement>('.grid-collapse');
    if (!box) throw new Error('The open Collapse has no box');
    return box;
  };
  const ended = (target: Element, propertyName: string) => {
    const event = new Event('transitionend', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: propertyName });
    act(() => {
      target.dispatchEvent(event);
    });
  };

  it('never gives Motion a height to measure', () => {
    tokens();
    const view = render(<Collapse open>Steps</Collapse>);
    expect(boxOf(view.container).getAttribute('style')).toBeNull();
  });

  it('closes its rows, inert, until their transition ends, then unmounts', () => {
    tokens();
    const view = render(<Collapse open><span>Steps</span></Collapse>);
    const box = boxOf(view.container);
    running(box, 'grid-template-rows', 'opacity');
    view.rerender(<Collapse open={false}><span>Steps</span></Collapse>);
    expect(box).toHaveAttribute('data-closing');
    expect(box).toHaveAttribute('inert');
    ended(screen.getByText('Steps'), 'grid-template-rows');
    ended(box, 'opacity');
    expect(screen.queryByText('Steps')).not.toBeNull();
    ended(box, 'grid-template-rows');
    expect(screen.queryByText('Steps')).toBeNull();
  });

  it('unmounts at once when its close starts no transition, as under a hidden ancestor', async () => {
    tokens();
    const view = render(<Collapse open>Steps</Collapse>);
    running(boxOf(view.container));
    view.rerender(<Collapse open={false}>Steps</Collapse>);
    await waitFor(() => expect(screen.queryByText('Steps')).toBeNull(), { timeout: 100 });
  });

  it('unmounts at once when only its fade runs, as with a zero --motion-move', async () => {
    tokens();
    const view = render(<Collapse open>Steps</Collapse>);
    running(boxOf(view.container), 'opacity');
    view.rerender(<Collapse open={false}>Steps</Collapse>);
    await waitFor(() => expect(screen.queryByText('Steps')).toBeNull(), { timeout: 100 });
  });

  it('stays open when reopened while closing', () => {
    tokens();
    const view = render(<Collapse open>Steps</Collapse>);
    const box = boxOf(view.container);
    running(box, 'grid-template-rows', 'opacity');
    view.rerender(<Collapse open={false}>Steps</Collapse>);
    view.rerender(<Collapse open>Steps</Collapse>);
    expect(view.container.querySelectorAll('.grid-collapse')).toHaveLength(1);
    ended(box, 'grid-template-rows');
    expect(screen.getByText('Steps')).toBeVisible();
    expect(boxOf(view.container)).not.toHaveAttribute('data-closing');
  });

  it('shows at once when it must not appear, and grows in when opened later', () => {
    tokens();
    const view = render(<Collapse open appear={false}>Steps</Collapse>);
    expect(boxOf(view.container)).toHaveAttribute('data-still');
    running(boxOf(view.container));
    view.rerender(<Collapse open={false} appear={false}>Steps</Collapse>);
    view.rerender(<Collapse open appear={false}>Steps</Collapse>);
    expect(boxOf(view.container)).not.toHaveAttribute('data-still');
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

  it('unmounts with nothing to wait for without the motion tokens (no stylesheet)', async () => {
    const view = render(<Collapse open>Steps</Collapse>);
    view.rerender(<Collapse open={false}>Steps</Collapse>);
    await waitFor(() => expect(screen.queryByText('Steps')).toBeNull(), { timeout: 100 });
  });

  it("shows a list's rows at once as it mounts, and grows in a row that arrives", () => {
    tokens();
    const view = render(rows(['Rates recap']));
    expect(screen.getByText('Rates recap').closest('li')).toHaveAttribute('data-still');
    view.rerender(rows(['Rates recap', 'FX check']));
    expect(screen.getByText('FX check').closest('li')).not.toHaveAttribute('data-still');
  });

  it('closes a removed row up, inert, before it leaves the list', () => {
    tokens();
    const view = render(rows(['Rates recap', 'FX check']));
    const leaving = screen.getByText('FX check').closest('li');
    if (!leaving) throw new Error('The list has no FX check row');
    running(leaving, 'grid-template-rows', 'opacity');
    view.rerender(rows(['Rates recap']));
    expect(leaving).toHaveAttribute('data-closing');
    expect(leaving).toHaveAttribute('inert');
    ended(leaving, 'grid-template-rows');
    expect(screen.queryByText('FX check')).toBeNull();
    expect(view.container.querySelectorAll('li')).toHaveLength(1);
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
    const contents = (open: boolean) => <Presence>{open && <>
      <m.button {...presenceMotion} key="cancel">Cancel editing</m.button>
      <m.button {...presenceMotion} key="save">Save changes</m.button>
    </>}</Presence>;
    const view = render(contents(true));
    view.rerender(contents(false));
    expect(screen.getByText('Cancel editing')).toHaveAttribute('inert');
    expect(screen.getByText('Save changes')).toHaveAttribute('inert');
    await waitFor(() => expect(screen.queryByText('Save changes')).toBeNull());
    expect(screen.queryByText('Cancel editing')).toBeNull();
  });

  it('restores an exiting control when it reenters before the fade finishes', async () => {
    tokens();
    const contents = (open: boolean) => <Presence>{open && <m.button {...presenceMotion}>Retry upload</m.button>}</Presence>;
    const view = render(contents(true));
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
    await waitFor(() => expect(screen.queryByText('Loading Memory')).toBeNull());
    await waitFor(() => expect(screen.getByText('Loaded Memory')).toBeVisible());
  });
});
