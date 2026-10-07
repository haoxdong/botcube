import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { WebUiPlugin } from '../../cartridge/index.js';

const plugin = vi.hoisted(() => {
  const webUiPlugin: Partial<WebUiPlugin> = {};
  return { webUiPlugin };
});
vi.mock('@cartridge-ui', () => plugin);

const { default: BrowserViewPage } = await import('./page');

it('shows the cartridge auxiliary view', () => {
  plugin.webUiPlugin.AuxiliaryView = () => <p>browser session</p>;

  expect(render(<BrowserViewPage />).container.innerHTML).toBe('<p>browser session</p>');
});

it('shows nothing when the cartridge has no auxiliary view', () => {
  delete plugin.webUiPlugin.AuxiliaryView;

  expect(render(<BrowserViewPage />).container.innerHTML).toBe('');
});
