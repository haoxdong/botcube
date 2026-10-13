import { useRef } from 'react';
import { render, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useComposerResizesOnLayout } from './composer-layout-height';

function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  useComposerResizesOnLayout(root);
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
