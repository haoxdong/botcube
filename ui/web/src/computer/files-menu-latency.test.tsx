// @vitest-environment happy-dom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComputerView } from './computer-view';
import { reportMoments, type LatencyRecorder } from '../app/latency';

let host: HTMLDivElement;
let root: Root;
let listings: ((response: Response) => void)[];
const BrowserFrame = () => <div />;
const activity = { messages: [], running: false, stop: null, subscribeToCustomEvents: () => () => {} };
const measures = () => performance.getEntriesByName('latency:files-menu', 'measure');

beforeEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
  listings = [];
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  vi.stubGlobal('fetch', (input: string) => {
    if (new URL(input).pathname === '/files') return new Promise<Response>((resolve) => listings.push(resolve));
    return Promise.resolve(Response.json({ state: 'awake', browserSessionId: 'browser-test', control: 'agent', screenshot: null }));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const draw = (shown = true, id = 'chat-test') => act(async () => root.render(
  <StrictMode><ComputerView agentId="test" agentName="Test" conversation={{ id, service: 'chat-service' }} shown={shown}
    activity={activity} chatServiceUrl="https://chat.test" BrowserFrame={BrowserFrame} /></StrictMode>,
));

async function click(name: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (button === null) throw new Error(`Missing ${name} button`);
  await act(async () => button.click());
}

async function answer(files: { name: string; size: number; lastModified: string }[] = []) {
  await act(async () => listings.splice(0).forEach((resolve) => resolve(Response.json({ files }))));
}

it.each([{ empty: false, automated: false }, { empty: true, automated: true }])('reports one rendered Files opening with empty=$empty and automated=$automated, including buffered RUM delivery', async ({ empty, automated }) => {
  vi.spyOn(navigator, 'webdriver', 'get').mockReturnValue(automated);
  await draw();
  const clickedAt = performance.now();
  await click('Files');
  expect(measures()).toHaveLength(0);
  expect(host.querySelector('[aria-label="Loading Files"]')).not.toBeNull();

  await answer(empty ? [] : [{ name: 'report.csv', size: 12, lastModified: '2026-11-10T00:00:00Z' }]);
  expect(host.querySelector(empty ? '.agent-computer-files-empty' : '.agent-computer-file')).not.toBeNull();
  expect(measures()).toHaveLength(1);
  expect(measures()[0]?.startTime).toBeGreaterThanOrEqual(clickedAt);
  const recordEvent = vi.fn<LatencyRecorder['recordEvent']>();
  reportMoments({ recordEvent });
  await vi.waitFor(() => expect(recordEvent.mock.calls.filter(([, data]) => data.moment === 'files-menu')).toHaveLength(1));
  expect(recordEvent).toHaveBeenCalledWith('latency', { moment: 'files-menu', durationMs: expect.any(Number), automated });

  await click('Files');
  await draw();
  expect(measures()).toHaveLength(1);
  // Back to a Files window still open behind Chrome: its listing shows at once, a second opening.
  await click('Chrome');
  await click('Files');
  expect(measures()).toHaveLength(2);
  // Closed and opened again, Files lists anew: a third.
  await click('Close Files');
  await click('Files');
  await answer();
  expect(measures()).toHaveLength(3);
});

it('does not report a failed Files opening after a later successful reload', async () => {
  await draw();
  await click('Files');
  await act(async () => listings.splice(0).forEach((resolve) => resolve(Response.json({ detail: 'unavailable' }, { status: 503 }))));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('unavailable');
  expect(measures()).toHaveLength(0);
  const recents = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Recents');
  if (recents === undefined) throw new Error('Missing Recents button');
  await act(async () => recents.click());
  await answer();
  expect(measures()).toHaveLength(0);
});

it.each(['Chrome', 'hidden', 'chat'])('does not report a Files opening abandoned for %s before the response', async (leave) => {
  await draw();
  await click('Files');
  if (leave === 'Chrome') await click('Chrome');
  else await draw(leave !== 'hidden', leave === 'chat' ? 'another-chat' : 'chat-test');
  await answer();
  expect(measures()).toHaveLength(0);
  await draw();
  expect(measures()).toHaveLength(0);
});

it('times a listing from the press that brings Files back, when it was left behind Chrome before it listed', async () => {
  await draw();
  await click('Files');
  await click('Chrome');
  const back = performance.now();
  await click('Files');
  await answer();
  expect(measures()).toHaveLength(1);
  expect(measures()[0]?.startTime).toBeGreaterThanOrEqual(back);
});
