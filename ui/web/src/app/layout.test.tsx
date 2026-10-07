import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const localFont = vi.hoisted(() => vi.fn(() => ({ variable: 'geist-sans-variable' })));
vi.mock('next/font/local', () => ({ default: localFont }));
vi.mock('@cartridge-ui', () => ({ webUiPlugin: { config: { title: 'Research Bot' } } }));

const { default: RootLayout, metadata } = await import('./layout');

it('titles the page after the cartridge', () => {
  expect(metadata).toEqual({ title: 'Research Bot' });
});

it('sets the page in English in the Geist sans font', () => {
  expect(renderToStaticMarkup(<RootLayout>chat</RootLayout>)).toBe(
    '<html lang="en" class="font-sans geist-sans-variable"><head></head><body>chat</body></html>',
  );
  expect(localFont).toHaveBeenCalledExactlyOnceWith({
    src: './fonts/Geist.woff2',
    weight: '100 900',
    display: 'swap',
    variable: '--font-sans',
  });
});
