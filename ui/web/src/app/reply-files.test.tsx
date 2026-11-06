import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { Streamdown } from 'streamdown';
import { afterEach, expect, it, vi } from 'vitest';

import { REPLY_MARKDOWN } from './reply-markdown';
import { ReplyTurnRunning } from './reply-turn';
import { ReplyImage } from './reply-image';
import MarkdownRenderer from './markdown-renderer';
import { invalidateAttachmentAccount } from '../cartridge/file-account';

afterEach(() => vi.unstubAllGlobals());

const reply = (markdown: string, running: boolean) => (
  <ReplyTurnRunning.Provider value={running}>
    <Streamdown {...REPLY_MARKDOWN}>{markdown}</Streamdown>
  </ReplyTurnRunning.Provider>
);

it('downloads a file whose encoded name contains a literal hash', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ url: 'https://files.test/report' }));
  vi.stubGlobal('fetch', fetchImpl);
  const view = render(<MarkdownRenderer content="Read [Report](/Q%26A%20%231.pdf) for details." />);

  await waitFor(() => expect(view.getByRole('link', { name: 'Report' })).toHaveAttribute('href', 'https://files.test/report'));
});

it.each(['/report.pdf#section', '/Q%26A%20%231.pdf#section'])(
  'does not resolve a URL fragment through Files: %s',
  async (path) => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const view = render(<MarkdownRenderer content={`Read [Report](${path}) for details.`} />);

    await act(async () => {});
    expect(view.queryByRole('link', { name: 'Report' })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  }
);

it('keeps an inline file download available after a transient download failure', async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json({ url: 'https://files.test/report.csv' }))
    .mockResolvedValueOnce(Response.json({ detail: 'Files temporarily unavailable' }, { status: 503 }));
  vi.stubGlobal('fetch', fetchImpl);
  const view = render(<Streamdown {...REPLY_MARKDOWN}>Read the [Report](/report.csv) for details.</Streamdown>);
  const link = await view.findByRole('link', { name: 'Report' });

  await act(async () => fireEvent.click(link));

  expect(view.getByRole('alert')).toHaveTextContent('Files temporarily unavailable');
  expect(view.getByRole('link', { name: 'Report' })).toBeVisible();
});

it('downloads a successful external image response', async () => {
  const blob = new Blob(['image bytes'], { type: 'image/png' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(blob)));
  const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:downloaded-image');
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = vi.fn();
  });
  try {
    const view = render(<ReplyImage src="https://images.test/chart.png" alt="Chart" />);
    await act(async () => fireEvent.click(view.getByTitle('Download image')));

    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.contexts[0]).toEqual(expect.objectContaining({ download: 'chart.png' }));
    expect(await createObjectURL.mock.calls[0]?.[0].text()).toBe('image bytes');
    expect(view.queryByRole('alert')).toBeNull();
  } finally {
    saved.mockRestore();
  }
});

it('reports an external image HTTP failure instead of downloading its error body', async () => {
  const fetchImpl = vi.fn(async () => new Response('Image is gone', { status: 404 }));
  vi.stubGlobal('fetch', fetchImpl);
  const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:failed-image');
    static override revokeObjectURL = vi.fn();
  });
  try {
    const view = render(<ReplyImage src="https://images.test/chart.png" alt="Chart" />);
    await act(async () => fireEvent.click(view.getByTitle('Download image')));

    expect(saved).not.toHaveBeenCalled();
    expect(view.getByRole('alert')).toHaveTextContent('could not download');
  } finally {
    saved.mockRestore();
  }
});

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
    const view = render(reply(markdown, true));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('No file in Files')
    );
    pushed = true;
    view.rerender(reply(markdown, false));
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
    const view = render(reply(markdown, true));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Still missing')
    );
    view.rerender(reply(markdown, false));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Still missing')
    );
    view.rerender(reply(markdown, true));
    view.rerender(reply(markdown, false));
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
    const view = render(reply(markdown, true));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    view.rerender(reply(markdown, false));
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

// Main Chat's kept copy and then the live chat each mount a reply's file link; each started at "(loading)" on one line
// and resolved to a three-line alert, so the text above the latest message changed 44px at a time.
it('shows a remounted file link as its file last resolved, not loading again', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail: 'No file mnt/data/remounted-map.png in Files' }, { status: 404 })));
  const content = 'See the map [1](/remounted-map.png).';
  const first = render(<MarkdownRenderer content={content} />);
  await waitFor(() => expect(first.getByRole('alert')).toHaveTextContent('could not download'));
  first.unmount();

  const again = render(<MarkdownRenderer content={content} />);
  expect(again.container).not.toHaveTextContent('(loading)');
  expect(again.getByRole('alert')).toHaveTextContent('No file mnt/data/remounted-map.png in Files');
});

// A review finding: a link must not show another account's file. An account change rotates the epoch it was kept under.
it('asks again, without the last state, for a file link after the account changes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ url: 'https://files.test/account-a.png' })));
  const content = 'See the chart [chart](/account-chart.png).';
  const first = render(<MarkdownRenderer content={content} />);
  await waitFor(() => expect(first.getByRole('link', { name: 'chart' })).toHaveAttribute('href', 'https://files.test/account-a.png'));
  first.unmount();

  invalidateAttachmentAccount();
  const again = render(<MarkdownRenderer content={content} />);
  expect(again.container).toHaveTextContent('(loading)');
  expect(again.queryByRole('link', { name: 'chart' })).toBeNull();
});

it('preserves ordinary anchor styles, refs and animation events on a file download', async () => {
  const { createRef } = await import('react');
  const { ReplyFileLink } = await import('./reply-file-link');
  const { StreamdownContext } = await import('streamdown');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ url: 'https://files.test/anchor-props' })));
  const ref = createRef<HTMLAnchorElement>();
  const onAnimationStart = vi.fn();
  const view = render(<StreamdownContext.Provider value={{
    codeBlockMaxHeight: 400, controls: true, isAnimating: false, lineNumbers: true,
    mode: 'static', tableMaxHeight: 300, shikiTheme: ['github-light', 'github-dark'], linkSafety: { enabled: false },
  }}><ReplyFileLink href="/anchor-props.txt" ref={ref} style={{ fontWeight: 700 }} onAnimationStart={onAnimationStart}>Download</ReplyFileLink></StreamdownContext.Provider>);
  const link = await view.findByRole('link', { name: 'Download' });
  expect(ref.current).toBe(link);
  expect(link).toHaveStyle({ fontWeight: '700' });
  fireEvent.animationStart(link);
  expect(onAnimationStart).toHaveBeenCalledOnce();
});
