import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

type Observers = { displayLayout?: (width: number, height: number, layout: { rect: { width: number; height: number } }[]) => void };
const dcv = vi.hoisted(() => {
  // DCV's viewer reads the platform as it loads, and scales its display to fit only on a phone or tablet.
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  for (const target of [navigator, window.navigator, Object.getPrototypeOf(window.navigator)]) Object.defineProperty(target, 'userAgent', { configurable: true, get: () => phone });
  return { observers: undefined as Observers | undefined };
});

vi.mock('dcv', async (load: () => Promise<{ default: object }>) => ({
  default: {
    ...(await load()).default,
    connect: async (config: { observers: Observers }) => {
      dcv.observers = config.observers;
      return { getServerInfo: () => ({ hostname: '127.0.0.1' }), disconnect: () => undefined, requestDisplayLayout: async () => undefined };
    },
  },
}));

// The viewer's Cloudscape chrome stays hidden here (no toolbar) and cannot load under Vitest: stand-ins render nothing.
vi.mock('@cloudscape-design/components', () => Object.fromEntries(
  ['Popover', 'StatusIndicator', 'Button', 'Modal', 'Box', 'SpaceBetween', 'Textarea', 'Grid', 'Link', 'Tabs', 'RadioGroup', 'Alert', 'Select', 'ColumnLayout', 'Toggle', 'ButtonDropdown', 'Header', 'LineChart', 'Pagination', 'BreadcrumbGroup', 'Table', 'Icon', 'Input', 'Container', 'Badge', 'ProgressBar', 'Spinner'].map((name) => [name, () => null]),
));
vi.mock('@cloudscape-design/global-styles', () => ({ applyMode: () => undefined, Mode: { Light: 'light', Dark: 'dark' }, applyDensity: () => undefined, Density: { Comfortable: 'comfortable', Compact: 'compact' } }));
vi.mock('@cloudscape-design/design-tokens', () => Object.fromEntries(
  ['colorChartsPaletteCategorical1', 'colorChartsPaletteCategorical2', 'colorChartsPaletteCategorical3', 'colorBorderDividerDefault', 'colorBackgroundContainerHeader', 'colorBackgroundContainerContent', 'colorTextBodyDefault'].map((name) => [name, '#000']),
));


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

// The live view names its display `dcv-display-<n>` (bedrock-agentcore's BrowserLiveView) and scales it itself.
it('lays out a phone live view whose display is not named dcv-display without throwing', async () => {
  // DCV fits the display to the page's height, which happy-dom lays out as 0: the phone's 844.
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(844);
  const { DCVViewer } = await import('dcv-ui');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(DCVViewer, {
    dcv: { sessionId: 's', authToken: 't', logLevel: 'silent', serverUrl: 'https://live.test/', baseUrl: '/dcvjs-esm', divId: 'dcv-display-1' },
    uiConfig: { toolbar: { visible: false, fullscreenButton: false, multimonitorButton: false } },
  })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const observers = dcv.observers;
  if (!observers?.displayLayout) throw new Error('The DCV viewer did not connect');

  expect(() => observers.displayLayout?.(1280, 720, [{ rect: { width: 1280, height: 720 } }])).not.toThrow();
  await act(async () => root.unmount());
});
