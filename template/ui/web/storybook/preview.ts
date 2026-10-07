import type { Preview } from '@storybook/nextjs-vite';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { setupWorker } from 'msw/browser';
import { handlers, unhandledChatRequests } from './chat-service';
import { viewports } from '../../../../ui/web/.storybook/viewports';
import { expect } from 'storybook/test';
import { CHAT_SERVICE_ORIGIN } from '../../../../ui/web/.storybook/chat-origin';

const loadMocks = mswLoader(async () => {
  const worker = setupWorker();
  await worker.start({
    quiet: true,
    onUnhandledRequest(request, print) {
      if (new URL(request.url).origin === CHAT_SERVICE_ORIGIN) {
        unhandledChatRequests.push(`${request.method} ${request.url}`);
        print.error();
      }
    },
  });
  return worker;
});

const preview: Preview = {
  initialGlobals: {
    viewport: {
      value: 'phone',
      isRotated: false,
    },
  },
  parameters: {
    layout: 'fullscreen',
    nextjs: { appDirectory: true },
    msw: { handlers },
    viewport: {
      options: {
        phone: {
          name: 'Phone',
          styles: {
            width: `${viewports.phone.viewport.width}px`,
            height: `${viewports.phone.viewport.height}px`,
          },
        },
        desktop: {
          name: 'Desktop',
          styles: {
            width: `${viewports.desktop.viewport.width}px`,
            height: `${viewports.desktop.viewport.height}px`,
          },
        },
      },
    },
  },
  loaders: [loadMocks],
  async afterEach() {
    await expect(unhandledChatRequests).toEqual([]);
  },
  beforeEach() {
    unhandledChatRequests.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    for (const cookie of document.cookie.split(';'))
      document.cookie = `${cookie.split('=')[0]?.trim()}=; Max-Age=0; path=/`;
  },
};
export default preview;
