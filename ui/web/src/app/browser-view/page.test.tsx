import { render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@cartridge-ui', () => ({ webUiPlugin: { config: { agentName: 'Quill' } } }));

const settings = vi.hoisted(() => ({
  agentIdentity: { name: 'Quill', character: 'A drafting agent' },
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  agentComputer: { enabled: true, liveBrowser: false },
}));
vi.mock('@bot-settings', () => ({ default: settings }));

afterEach(() => {
  vi.resetModules();
});

const page = async () => (await import('./page')).default;

// BotCube's live browser view is the default, so a bot on AgentCore Browser shows it.
it("shows BotCube's live browser view when the bot settings leave the live browser panel off", async () => {
  settings.agentComputer.liveBrowser = false;
  const BrowserViewPage = await page();

  expect(render(<BrowserViewPage />).container).toHaveTextContent('Missing browser session.');
});

it("shows the live browser panel's own window when the bot settings switch the panel on", async () => {
  settings.agentComputer.liveBrowser = true;
  const BrowserViewPage = await page();

  expect(render(<BrowserViewPage />).container).toHaveTextContent('This window names no browser Session.');
  expect(document.querySelector('.computer-screen-title')).toHaveTextContent("Quill's computer");
});
