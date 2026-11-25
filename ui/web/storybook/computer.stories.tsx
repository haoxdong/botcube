import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { AgentComputer, FilesWindow } from 'botcube-ui-web/computer';
import { expect, within } from 'storybook/test';

/** Public component fixtures exercise the desktop independently of a bot's sign-in and branding. */
const meta = {
  title: 'BotCube/Computer',
  component: AgentComputer,
  // The desktop sizes itself to its pane's height, so it needs a sized pane, as the profile's Computer tab gives it.
  decorators: [(Story) => <div style={{ height: '100dvh' }}><Story /></div>],
  args: {
    agentName: 'BotCube',
    app: 'Chromium',
    files: <FilesWindow files={[]} error={null} onReload={() => {}} onDownload={() => {}} onDelete={() => {}} onRename={() => null} onMove={() => {}} onUpload={() => Promise.reject(new Error('The fixture has no uploads'))} thumbnailUrl={() => Promise.reject(new Error('The fixture has no pictures'))} />,
    computer: { state: 'asleep', screenshot: null },
    commands: [{ command: 'fake-cli data', output: 'Sample item: 42' }],
    control: 'agent',
    running: false,
    busy: false,
    error: null,
    notice: null,
    starting: false,
    onStop: null,
    onTakeOver: () => {},
    onHandBack: () => {},
    onOpenApp: () => {},
  },
} satisfies Meta<typeof AgentComputer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sleeping: Story = {};
export const Terminal: Story = {
  args: { app: 'Terminal' },
  play: async ({ canvasElement }) => {
    const terminal = within(canvasElement).getByRole('log', { name: 'Terminal' });
    await expect(terminal).toHaveTextContent('Sample item: 42');
    // The desktop fills the pane's width at 16:9: a collapsed one leaves the terminal with no area.
    const desktop = canvasElement.querySelector('.agent-computer-desktop')?.getBoundingClientRect();
    await expect(Math.min(desktop?.width ?? 0, desktop?.height ?? 0)).toBeGreaterThan(100);
    const { width, height } = terminal.getBoundingClientRect();
    await expect(Math.min(width, height)).toBeGreaterThan(0);
  },
};
export const Files: Story = { args: { app: 'Files' } };
export const FailedControl: Story = { args: { error: 'Browser control unavailable' } };
