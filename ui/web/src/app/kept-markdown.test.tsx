import { render, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import FullKeptMarkdown from './kept-streamdown';
import KeptMarkdown, { prepareKeptMarkdown } from './kept-markdown';

it.each([
  'A **finished** paragraph with *emphasis*.',
  '**Strong with *nested emphasis*.**',
  'First paragraph.\n\nSecond **paragraph**.',
  '日本語の **文章** と *強調*。',
  'Escaped \\*asterisk\\* and &amp; entities.',
  'A line  \nbreak and a soft\nnewline.',
  '**Unfinished emphasis',
  'An unfinished [link](https://example.com',
  '~~Deleted text~~ and https://example.com',
  '## Heading\n\n- First\n- Second',
  '<script>alert(1)</script>\n\n**Safe**',
  '$$x',
  'Word\u2003',
  'Word\u00a0',
  'A\u2003spaced **reply**.',
])('keeps the saved reply renderer output for %s', async (text) => {
  await prepareKeptMarkdown([text]);
  const saved = render(<KeptMarkdown text={text} />);
  const reference = render(<FullKeptMarkdown text={text} />);
  expect(saved.container.innerHTML).toBe(reference.container.innerHTML);
});

it('prepares complex replies after an earlier paragraph-only opening', async () => {
  vi.resetModules();
  const { default: KeptMarkdown, prepareKeptMarkdown } = await import('./kept-markdown');
  await prepareKeptMarkdown(['An **ordinary** reply.']);
  const paragraph = render(<KeptMarkdown text="An **ordinary** reply." />);
  expect(paragraph.container.querySelector('[data-streamdown="strong"]')).toHaveTextContent('ordinary');
  paragraph.unmount();

  await prepareKeptMarkdown(['## Later reply\n\n1. First item']);
  const complex = render(<KeptMarkdown text={'## Later reply\n\n1. First item'} />);
  expect(within(complex.container).getByRole('heading')).toHaveTextContent('Later reply');
  expect(within(complex.container).getByRole('listitem')).toHaveTextContent('First item');
});

it('surfaces a failed complex formatter instead of suspending on its rejected import', async () => {
  vi.resetModules();
  const failure = new Error('Formatter unavailable');
  vi.doMock('./kept-streamdown', () => { throw failure; });
  try {
    const { default: KeptMarkdown, prepareKeptMarkdown } = await import('./kept-markdown');
    const rejected = await Promise.resolve(prepareKeptMarkdown(['## Heading'])).catch((error: unknown) => error);
    if (!(rejected instanceof Error)) throw new Error('Missing formatter failure');
    expect(rejected).toHaveProperty('cause', failure);
    expect(() => render(<KeptMarkdown text="## Heading" />)).toThrow(rejected);
    expect(() => prepareKeptMarkdown(['## Heading'])).toThrow(rejected);
  } finally {
    vi.doUnmock('./kept-streamdown');
  }
});
