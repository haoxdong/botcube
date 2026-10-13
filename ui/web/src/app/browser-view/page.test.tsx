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

// BotCube's live browser view is the default, so a Cartridge on AgentCore Browser brings none.
it("shows BotCube's live browser view when the cartridge has none", () => {
  delete plugin.webUiPlugin.AuxiliaryView;

  expect(render(<BrowserViewPage />).container).toHaveTextContent('Missing browser session.');
});
