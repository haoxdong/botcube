import { expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'geist-sans-variable' }) }));
vi.mock('@cartridge-ui', () => ({ webUiPlugin: { config: { title: 'Research Bot' } } }));

const { metadata } = await import('./layout');

it('titles the page after the cartridge', () => {
  expect(metadata).toEqual({ title: 'Research Bot' });
});
