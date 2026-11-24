import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, onTestFinished } from 'vitest';

import { FileDropOverlay } from './composer-attach';

// The sheet covered the chat in one frame and vanished in one; DESIGN.md fades what enters and leaves.
it('fades the drop sheet in, and out, inert, once the drag leaves', async () => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-move: 300ms; --motion-quick: 150ms; --ease: cubic-bezier(0.32, 0.72, 0, 1); }';
  onTestFinished(() => sheet.remove());
  const fades = () => screen.getByText('Drop files to attach').getAnimations()
    .map(({ effect }) => (effect instanceof KeyframeEffect ? effect.getKeyframes().map(({ opacity }) => Number(opacity)) : []));
  const view = render(<FileDropOverlay open />);
  expect(fades()).toEqual([[0, 1]]);

  view.rerender(<FileDropOverlay open={false} />);

  expect(screen.getByText('Drop files to attach')).toHaveAttribute('inert');
  expect(fades()).toEqual([[1, 0]]);
  await waitFor(() => expect(screen.queryByText('Drop files to attach')).toBeNull());
});
