import type { Preview } from '@storybook/nextjs-vite';
import { handlers } from './example-chat-fixtures';

export default { parameters: { msw: { handlers } } } satisfies Preview;
