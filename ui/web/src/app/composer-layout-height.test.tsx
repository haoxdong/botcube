import { useRef } from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { useComposerSizing } from './composer-layout-height';

function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  useComposerSizing(root);
  return (
    <div ref={root}>
      <div className="copilotKitInput">
        <div data-layout="compact">
          <textarea aria-label="Ask anything" style={{ height: '56px', maxHeight: '116px' }} />
        </div>
      </div>
    </div>
  );
}

/** A composer whose draft, laid out anew, is `draftHeight` tall. */
function composer(draftHeight: number) {
  const view = render(<Fixture />);
  const textarea = view.getByLabelText('Ask anything');
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => draftHeight });
  const layout = textarea.parentElement;
  if (layout === null) throw new Error('no layout');
  return { textarea, layout };
}

// A line that wrapped in a desktop's compact text column fits on one in its expanded one; CopilotKit kept two lines'
// height.
it('sizes the text box to its draft as the composer changes layout', async () => {
  const { textarea, layout } = composer(36);

  layout.setAttribute('data-layout', 'expanded');

  await waitFor(() => expect(textarea.style.height).toBe('36px'));
});

it("keeps the text box within CopilotKit's cap", async () => {
  const { textarea, layout } = composer(200);

  layout.setAttribute('data-layout', 'expanded');

  await waitFor(() => expect(textarea.style.height).toBe('116px'));
});

// A phone's composer opening from rest changes its text's padding; the box kept its resting height.
it('sizes the text box to its draft as a phone composer opens or rests', async () => {
  const { textarea, layout } = composer(30);

  layout.parentElement?.setAttribute('data-open', '');

  await waitFor(() => expect(textarea.style.height).toBe('30px'));
});

describe('the composer box', () => {
  /** A ResizeObserver that reports when the test says, and the box's height as the test sets it. */
  function observed() {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    let height = 56;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
    // As a browser's, a glide just started is pending: it moves nothing until its first frame.
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null, pending: true, finished: Promise.resolve() }) as unknown as Animation);
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = animate;
    onTestFinished(() => { HTMLElement.prototype.animate = original; });
    const view = render(<Fixture />);
    const resize = (to: number) => {
      height = to;
      callbacks.forEach((callback) => callback([], {} as ResizeObserver));
    };
    const layout = view.getByLabelText('Ask anything').parentElement as HTMLElement;
    return { animate, resize, layout };
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.documentElement.style.removeProperty('--motion-move'); });

  it('glides from its last height to its new one over --motion-move, its controls held at its bottom', () => {
    document.documentElement.style.setProperty('--motion-move', '300ms');
    const { animate, resize } = observed();
    resize(78);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(
      [expect.objectContaining({ height: '56px', justifyContent: 'flex-end' }), expect.objectContaining({ height: '78px' })],
      expect.objectContaining({ duration: 300 }),
    );
  });

  // The expanded layout puts the draft on its own row above the controls; held at the bottom, it was clipped away.
  it('glides with the draft held at its top as the composer turns expanded', () => {
    document.documentElement.style.setProperty('--motion-move', '300ms');
    const { animate, resize, layout } = observed();
    layout.setAttribute('data-layout', 'expanded');
    resize(96);
    expect(animate).toHaveBeenCalledWith(
      [expect.objectContaining({ height: '56px', justifyContent: 'flex-start' }), expect.objectContaining({ height: '96px', justifyContent: 'flex-start' })],
      expect.objectContaining({ duration: 300 }),
    );
  });

  // A chip's leaving starts a glide, and the bar's resize, reported before that glide's first frame, cancelled it.
  it('carries on from where it was when a second change comes before its glide has moved', () => {
    document.documentElement.style.setProperty('--motion-move', '300ms');
    const { animate, resize } = observed();
    resize(78);
    resize(78);
    const gliding = animate.mock.results.filter(({ value }) => vi.mocked(value.cancel).mock.calls.length === 0);
    expect(gliding).toHaveLength(1);
    expect(animate).toHaveBeenLastCalledWith(
      [expect.objectContaining({ height: '56px' }), expect.objectContaining({ height: '78px' })],
      expect.objectContaining({ duration: 300 }),
    );
  });
});
