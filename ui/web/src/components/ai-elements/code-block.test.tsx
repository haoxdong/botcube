import { render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { CodeBlock } from './code-block';

const failure = new Error('grammar unavailable');
vi.mock('shiki', () => ({ createHighlighter: () => Promise.reject(failure) }));

it('reports a highlighter failure and keeps the plain text', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const { container } = render(<CodeBlock code={'{"rows": 2}'} />);

  await waitFor(() => expect(error).toHaveBeenCalledWith('Failed to highlight code:', failure));
  expect(container.querySelector('pre')).toHaveTextContent('{"rows": 2}');
});
