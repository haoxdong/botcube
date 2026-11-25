import type { Preview } from '@storybook/nextjs-vite';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { setupWorker } from 'msw/browser';
import { viewports } from './viewports';
import { expect } from 'storybook/test';
import { CHAT_SERVICE_ORIGIN } from './chat-origin';
import '../src/app/globals.css';
import './font.css';

document.documentElement.classList.add('font-sans');

const unhandledChatRequests: string[] = [];

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
    viewport: {
      options: {
        phone: {
          name: 'Phone',
          styles: {
            width: `${process.env.STORYBOOK_VISUAL_COMPARE === '1' ? 390 : viewports.phone.viewport.width}px`,
            height: `${process.env.STORYBOOK_VISUAL_COMPARE === '1' ? 900 : viewports.phone.viewport.height}px`,
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
  async beforeEach() {
    if ((import.meta as ImportMeta & { env: { MODE: string } }).env.MODE === 'test') {
      // A story that hovered with the real pointer leaves it there, past its own screenshot.
      const { parkPointer } = await import('./pointer');
      await parkPointer();
    }
    unhandledChatRequests.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    // A story that opens a Side Chat names it in the URL (`?chat=`); the next story starts on the Main Chat.
    const url = new URL(window.location.href);
    url.searchParams.delete('chat');
    window.history.replaceState(window.history.state, '', url);
    for (const cookie of document.cookie.split(';'))
      document.cookie = `${cookie.split('=')[0]?.trim()}=; Max-Age=0; path=/`;
  },
};
export default preview;
