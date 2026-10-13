import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { AgentComputer, FilesWindow } from 'botcube-ui-web/computer';
import { expect, within } from 'storybook/test';
import 'botcube-ui-web/computer/styles.css';

/** Public component fixtures exercise the desktop independently of a bot's sign-in and branding. */
const meta = {
  title: 'BotCube/Computer',
  component: AgentComputer,
  args: {
    agentName: 'BotCube',
    chatId: 'template-chat',
    app: 'Chrome',
    files: <FilesWindow files={[]} error={null} onReload={() => {}} onDownload={() => {}} onDelete={() => {}} onRename={() => {}} />,
    computer: { state: 'asleep', screenshot: null },
    commands: [{ command: 'template-cli data', output: 'Sample item: 42' }],
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
    await expect(within(canvasElement).getByRole('log', { name: 'Terminal' })).toHaveTextContent('Sample item: 42');
  },
};
export const Files: Story = { args: { app: 'Files' } };
export const FailedControl: Story = { args: { error: 'Browser control unavailable' } };
