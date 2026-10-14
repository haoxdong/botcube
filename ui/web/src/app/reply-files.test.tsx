import { act, render, waitFor } from '@testing-library/react';
import { Streamdown } from 'streamdown';
import { afterEach, expect, it, vi } from 'vitest';

import { REPLY_MARKDOWN } from './reply-markdown';
import { ReplyTurnRunning } from './reply-turn';

afterEach(() => vi.unstubAllGlobals());

it.each([
  {
    name: 'download link',
    markdown: '[Report](/report.csv)',
    selector: 'a',
    url: 'https://files.test/report.csv',
  },
  {
    name: 'embedded image',
    markdown: '![Chart](/chart.svg)',
    selector: 'img',
    url: 'https://files.test/chart.svg',
  },
])(
  'recovers a $name streamed before the Turn pushes Files',
  async ({ markdown, selector, url }) => {
    let pushed = false;
    const fetchImpl = vi.fn(async () =>
      pushed
        ? Response.json({ url })
        : Response.json({ detail: 'No file in Files' }, { status: 404 })
    );
    vi.stubGlobal('fetch', fetchImpl);
    const reply = (running: boolean) => (
      <ReplyTurnRunning.Provider value={running}>
        <Streamdown {...REPLY_MARKDOWN}>{markdown}</Streamdown>
      </ReplyTurnRunning.Provider>
    );
    const view = render(reply(true));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('No file in Files')
    );
    pushed = true;
    view.rerender(reply(false));
    await waitFor(() =>
      expect(
        view.container
          .querySelector(selector)
          ?.getAttribute(selector === 'a' ? 'href' : 'src')
      ).toBe(url)
    );
    expect(view.queryByRole('alert')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }
);

it.each(['[Report](/report.csv)', '![Chart](/chart.svg)'])(
  'keeps a final missing-file error through subsequent Turns: %s',
  async (markdown) => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ detail: 'Still missing' }, { status: 404 })
    );
    vi.stubGlobal('fetch', fetchImpl);
    const reply = (running: boolean) => (
      <ReplyTurnRunning.Provider value={running}>
        <Streamdown {...REPLY_MARKDOWN}>{markdown}</Streamdown>
      </ReplyTurnRunning.Provider>
    );
    const view = render(reply(true));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Still missing')
    );
    view.rerender(reply(false));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Still missing')
    );
    view.rerender(reply(true));
    view.rerender(reply(false));
    await act(async () => {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(view.getByRole('alert')).toHaveTextContent('Still missing');
  }
);

it.each(['[Report](/report.csv)', '![Chart](/chart.svg)'])(
  'recovers a first 404 arriving after Turn completion: %s',
  async (markdown) => {
    let rejectFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      rejectFirst = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(Response.json({ url: 'https://files.test/ready' }));
    vi.stubGlobal('fetch', fetchImpl);
    const reply = (running: boolean) => (
      <ReplyTurnRunning.Provider value={running}>
        <Streamdown {...REPLY_MARKDOWN}>{markdown}</Streamdown>
      </ReplyTurnRunning.Provider>
    );
    const view = render(reply(true));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    view.rerender(reply(false));
    await act(async () =>
      rejectFirst(Response.json({ detail: 'Not yet pushed' }, { status: 404 }))
    );
    await waitFor(() =>
      expect(view.container.querySelector('a, img')).not.toBeNull()
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(view.queryByRole('alert')).toBeNull();
  }
);

it('ignores an old path lookup after the streamed path changes', async () => {
  let resolveOld!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue(Response.json({ url: 'https://files.test/new.csv' }))
  );
  const view = render(
    <Streamdown {...REPLY_MARKDOWN}>{'[Report](/old.csv)'}</Streamdown>
  );
  view.rerender(
    <Streamdown {...REPLY_MARKDOWN}>{'[Report](/new.csv)'}</Streamdown>
  );
  await waitFor(() =>
    expect(view.getByRole('link')).toHaveAttribute(
      'href',
      'https://files.test/new.csv'
    )
  );
  await act(async () =>
    resolveOld(Response.json({ detail: 'Old file missing' }, { status: 404 }))
  );
  expect(view.getByRole('link')).toHaveAttribute(
    'href',
    'https://files.test/new.csv'
  );
  expect(view.queryByRole('alert')).toBeNull();
});
