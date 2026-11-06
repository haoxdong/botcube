import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, onTestFinished } from 'vitest';

import { FileDropOverlay } from './composer-attach';

// The sheet covered the chat in one frame and vanished in one; DESIGN.md fades what enters and leaves.
it('fades the drop sheet in, and out, inert, once the drag leaves', async () => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = ':root { --motion-move: 300ms; --motion-quick: 150ms; --ease: cubic-bezier(0.32, 0.72, 0, 1); }';
  onTestFinished(() => sheet.remove());
  await act(() => import('./motion-features'));
  const view = render(<FileDropOverlay open />);
  expect(screen.getByText('Drop files to attach').style.opacity).toBe('0');
  await waitFor(() => expect(screen.getByText('Drop files to attach').style.opacity).toBe('1'));

  view.rerender(<FileDropOverlay open={false} />);

  expect(screen.getByText('Drop files to attach')).toHaveAttribute('inert');
  await waitFor(() => expect(screen.queryByText('Drop files to attach')).toBeNull());
});
