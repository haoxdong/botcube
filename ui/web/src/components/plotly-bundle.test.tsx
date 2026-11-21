import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { PlotlyPrefetch } from './plotly-bundle';

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('link').forEach((link) => link.remove());
});

it('hints plotly.js as a prefetch in the head, where React hoists it, and runs none of its code', async () => {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => root.render(<PlotlyPrefetch />));

  const links = [...document.head.querySelectorAll('link[rel="prefetch"]')];
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute('as')).toBe('script');
  expect(links[0]?.getAttribute('href')).toMatch(/plotly\.min\.js$/);
  expect(host.innerHTML).toBe('');
  expect(document.head.querySelector('script')).toBeNull();
  await act(async () => root.unmount());
});
