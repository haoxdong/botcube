import { useLayoutEffect } from 'react';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FILE_ACCOUNT_LOCK } from '../cartridge/file-account';

import { ComposerFileChips, SentFileCards, attachPastedImages, messageWithFiles, sentFilesOf, useComposerFiles, type ComposerFile } from './composer-files';

// jsdom has no object URLs; an image's thumbnail in the composer takes one per file.
const objectUrls = { created: [] as Blob[], revoked: [] as string[] };
URL.createObjectURL = (blob: Blob) => `blob:test/${objectUrls.created.push(blob)}`;
URL.revokeObjectURL = (url: string) => void objectUrls.revoked.push(url);
afterEach(() => {
  objectUrls.created = [];
  objectUrls.revoked = [];
});

describe('messageWithFiles', () => {
  // The message carries each attached file's path, by which the agent reads it in the Turn.
  it("names the attached files' paths under the message's text", () => {
    expect(messageWithFiles('Summarise these', ['/report.csv', '/notes (1).md'])).toBe(
      'Summarise these\n\nAttached files:\n- /report.csv\n- /notes (1).md',
    );
  });

  it('leaves a message with no files attached as it is', () => {
    expect(messageWithFiles('Where did rates close?', [])).toBe('Where did rates close?');
  });
});

describe('sentFilesOf', () => {
  it.each([
    ['check this', ['/AI_Trends_2026.pdf']],
    ['Summarise these\n\nboth of them', ['/report.csv', '/notes (1).md']],
    ['', ['/report.csv']],
  ])('reads back the text and paths messageWithFiles wrote for %j', (text, paths) => {
    expect(sentFilesOf(messageWithFiles(text, paths))).toEqual({ text, paths });
  });

  it('leaves a message without a trailing files block as it is', () => {
    for (const message of ['Where did rates close?', 'Summarise this\n\nAttached files:\n- /report.csv\n\nThen explain', 'Attached files:\n- /report.csv']) {
      expect(sentFilesOf(message)).toEqual({ text: message, paths: [] });
    }
  });
});

describe('SentFileCards', () => {
  it("shows each sent file as a card: its tinted tile, its name in full on hover, and its kind", () => {
    render(<SentFileCards paths={['/AI_Trends_2026.pdf', '/reports/rates.csv', '/Makefile']} />);

    const cards = within(screen.getByRole('list', { name: 'Attached files' })).getAllByRole('listitem');
    expect(cards.map((card) => card.textContent)).toEqual(['AI_Trends_2026.pdfPDF', 'rates.csvCSV', 'MakefileFile']);
    expect(cards.map((card) => card.querySelector('.file-tile')?.getAttribute('data-kind'))).toEqual(['pdf', 'sheet', 'file']);
    expect(within(cards[0] as HTMLElement).getByText('AI_Trends_2026.pdf')).toHaveAttribute('title', 'AI_Trends_2026.pdf');
  });

  it('shows nothing for a message without files', () => {
    const { container } = render(<SentFileCards paths={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a sent image as its thumbnail from the cartridge's file URL, and any other file as its card", async () => {
    const fileUrl = vi.fn(async (path: string) => `https://files.test${path}`);
    render(<SentFileCards paths={['/Pasted image 2026-10-13.png', '/notes.pdf', '/logo.svg']} fileUrl={fileUrl} />);

    expect(await screen.findByRole('img', { name: 'Pasted image 2026-10-13.png' })).toHaveAttribute('src', 'https://files.test/Pasted%20image%202026-10-13.png');
    expect(fileUrl).toHaveBeenCalledTimes(1);
    // A kind the composer shows as a card is a card once sent too.
    expect(screen.getAllByRole('listitem').slice(1).map((card) => card.textContent)).toEqual(['notes.pdfPDF', 'logo.svgSVG']);
  });

  it('keeps a sent image its empty thumbnail without a file URL, the size it takes once one comes', () => {
    render(<SentFileCards paths={['/chart.png']} />);
    const thumbnail = screen.getByRole('listitem', { name: 'chart.png' });
    expect(thumbnail).toHaveClass('image-thumb');
    expect(thumbnail).toBeEmptyDOMElement();
  });

  it("names a sent image with why when its URL fails", async () => {
    render(<SentFileCards paths={['/chart.png']} fileUrl={async () => Promise.reject(new Error('Download failed'))} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('chart.png could not load: Download failed');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it("names a sent image the browser won't show", async () => {
    render(<SentFileCards paths={['/chart.png']} fileUrl={async () => 'https://files.test/chart.png'} />);
    fireEvent.error(await screen.findByRole('img', { name: 'chart.png' }));
    expect(screen.getByRole('alert')).toHaveTextContent('chart.png could not load: the browser could not show it');
  });
});

/** An upload a test settles: its progress, then the path it resolves to or the error it rejects with. */
function deferredUploads() {
  const uploads: { file: File; signal: AbortSignal; progress: (fraction: number) => void; resolve: (path: string) => void; reject: (error: Error) => void }[] = [];
  const upload = vi.fn(
    (file: File, { onProgress, signal }: { onProgress: (fraction: number) => void; signal: AbortSignal }) =>
      new Promise<string>((resolve, reject) => {
        uploads.push({ file, signal, progress: onProgress, resolve, reject });
      }),
  );
  return { upload, uploads };
}

const report = new File(['date,close'], 'report.csv');
const notes = new File(['# notes'], 'notes.md');

describe('useComposerFiles', () => {
  it('aborts pending uploads and clears completed paths when their owning account changes', async () => {
    const { upload, uploads } = deferredUploads();
    const { result, rerender } = renderHook(({ accountId }) => useComposerFiles(upload, accountId), { initialProps: { accountId: 'account-a' } });
    act(() => result.current.add([report, notes]));
    await act(async () => uploads[0]?.resolve('/report.csv'));

    rerender({ accountId: 'account-b' });

    expect(uploads[1]?.signal.aborted).toBe(true);
    expect(result.current.files).toEqual([]);
    await act(async () => uploads[1]?.resolve('/notes.md'));
    expect(result.current.files).toEqual([]);
    act(() => result.current.add([report]));
    await act(async () => uploads[2]?.resolve('/report (1).csv'));
    expect(result.current.files.map(({ state }) => state)).toEqual([{ status: 'uploaded', path: '/report (1).csv' }]);
  });

  it("invalidates stale paths before another tab's account claim can submit them", async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current.add([report, notes]));
    await act(async () => uploads[0]?.resolve('/report.csv'));
    const stale = result.current;
    act(() => {
      localStorage.setItem(FILE_ACCOUNT_LOCK, 'another-tab-claim');
      expect(stale.sendable).toBe(false);
      window.dispatchEvent(new StorageEvent('storage', { key: FILE_ACCOUNT_LOCK }));
    });
    expect(result.current.files).toEqual([]);
    expect(uploads[1]?.signal.aborted).toBe(true);
  });

  it('keeps old paths unsendable in the render before an account epoch clears their chips', async () => {
    const { upload, uploads } = deferredUploads();
    let changing = false;
    const sendable: boolean[] = [];
    const { result } = renderHook(() => {
      const attached = useComposerFiles(upload, 'account-a');
      useLayoutEffect(() => {
        if (changing && attached.files.length > 0) sendable.push(attached.sendable);
      });
      return attached;
    });
    act(() => result.current.add([report]));
    await act(async () => uploads[0]?.resolve('/report.csv'));
    changing = true;
    act(() => {
      localStorage.setItem(FILE_ACCOUNT_LOCK, 'claim-before-paint');
      window.dispatchEvent(new StorageEvent('storage', { key: FILE_ACCOUNT_LOCK }));
    });
    expect(sendable).toContain(false);
    expect(sendable).not.toContain(true);
    expect(result.current.files).toEqual([]);
  });

  it('uploads each file added, showing its progress, and lets the message go once every file has uploaded', async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));

    act(() => result.current.add([report, notes]));
    expect(result.current.files.map(({ file, state }) => [file.name, state])).toEqual([
      ['report.csv', { status: 'uploading', progress: 0 }],
      ['notes.md', { status: 'uploading', progress: 0 }],
    ]);
    expect(result.current.sendable).toBe(false);

    act(() => uploads[0]?.progress(0.42));
    expect(result.current.files[0]?.state).toEqual({ status: 'uploading', progress: 0.42 });

    await act(async () => uploads[0]?.resolve('/report.csv'));
    expect(result.current.files[0]?.state).toEqual({ status: 'uploaded', path: '/report.csv' });
    expect(result.current.sendable).toBe(false);

    await act(async () => uploads[1]?.resolve('/notes.md'));
    expect(result.current.sendable).toBe(true);
  });

  it('shows why an upload failed, holding the message, and uploads the file again on Retry', async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current.add([report]));

    await act(async () => uploads[0]?.reject(new Error('Upload failed: 403')));
    expect(result.current.files[0]?.state).toEqual({ status: 'failed', error: 'Upload failed: 403' });
    expect(result.current.sendable).toBe(false);

    const id = result.current.files[0]?.id ?? '';
    act(() => result.current.retry(id));
    expect(result.current.files[0]?.state).toEqual({ status: 'uploading', progress: 0 });
    expect(uploads[1]?.file).toBe(report);

    await act(async () => uploads[1]?.resolve('/report.csv'));
    expect(result.current.files[0]?.state).toEqual({ status: 'uploaded', path: '/report.csv' });
    expect(result.current.sendable).toBe(true);
  });

  it('refuses a hidden file without uploading it, as the agent would never see it in its workspace', () => {
    const { upload } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));

    act(() => result.current.add([new File(['KEY=1'], '.env')]));

    expect(result.current.files[0]?.state).toEqual({
      status: 'failed',
      error: "The agent can't read hidden files like .env. Rename it without the leading dot.",
    });
    expect(result.current.sendable).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('aborts the upload of a file removed, which never comes back as its upload ends', async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current.add([report, notes]));

    act(() => result.current.remove(result.current.files[0]?.id ?? ''));
    expect(uploads[0]?.signal.aborted).toBe(true);
    await act(async () => uploads[0]?.reject(new DOMException('Upload aborted', 'AbortError')));
    expect(result.current.files.map(({ file }) => file.name)).toEqual(['notes.md']);
  });

  it('empties on clear, as a message sends, and aborts what is still uploading as the composer goes', () => {
    const { upload, uploads } = deferredUploads();
    const { result, unmount } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current.add([report]));
    act(() => result.current.clear());
    expect(result.current.files).toEqual([]);
    expect(result.current.sendable).toBe(true);

    act(() => result.current.add([notes]));
    unmount();
    expect(uploads[1]?.signal.aborted).toBe(true);
  });
});

describe('ComposerFileChips', () => {
  const chip = (name: string) => screen.getByText(name, { selector: '.composer-file-name' }).closest('li') as HTMLElement;
  const files: ComposerFile[] = [
    { id: '1', file: report, state: { status: 'uploading', progress: 0.42 } },
    { id: '2', file: notes, state: { status: 'uploaded', path: '/notes.md' } },
    { id: '3', file: new File([''], 'Makefile'), state: { status: 'failed', error: 'A file named Makefile is already in Files' } },
  ];

  it("shows each file's name in full on hover, and its upload: progress, its kind once uploaded, or why it failed", () => {
    render(<ComposerFileChips files={files} onRetry={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByRole('list', { name: 'Attached files' })).toBeInTheDocument();
    expect(within(chip('report.csv')).getByText('report.csv')).toHaveAttribute('title', 'report.csv');
    expect(within(chip('report.csv')).getByRole('progressbar', { name: 'Uploading report.csv' })).toHaveAttribute('aria-valuenow', '42');
    expect(chip('report.csv')).toHaveTextContent('Uploading… 42%');
    expect(chip('notes.md')).toHaveTextContent(/^notes\.mdMD$/);
    expect(within(chip('Makefile')).getByRole('alert')).toHaveTextContent('A file named Makefile is already in Files');
    expect(within(chip('report.csv')).queryByRole('button', { name: 'Retry' })).toBeNull();
    // The sent card's tile, so a file looks the same before and after it goes.
    expect(['report.csv', 'notes.md', 'Makefile'].map((name) => chip(name).querySelector('.file-tile')?.getAttribute('data-kind'))).toEqual(['sheet', 'file', 'file']);
  });

  it('shows the stored copy name on the chip, tooltip and Remove and sends its canonical path', async () => {
    const onRemove = vi.fn();
    render(<ComposerFileChips files={[{ id: 'copy', file: report, state: { status: 'uploaded', path: '/report (2).csv' } }]} onRetry={vi.fn()} onRemove={onRemove} />);
    expect(within(chip('report (2).csv')).getByText('report (2).csv')).toHaveAttribute('title', 'report (2).csv');
    expect(chip('report (2).csv')).toHaveTextContent(/^report \(2\)\.csvCSV$/);
    await userEvent.click(screen.getByRole('button', { name: 'Remove report (2).csv' }));
    expect(onRemove).toHaveBeenCalledWith('copy');
    expect(messageWithFiles('Read this', ['/report (2).csv'])).toBe('Read this\n\nAttached files:\n- /report (2).csv');
  });

  it('retries a failed file and removes any file', async () => {
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    render(<ComposerFileChips files={files} onRetry={onRetry} onRemove={onRemove} />);

    await userEvent.click(within(chip('Makefile')).getByRole('button', { name: 'Retry' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove report.csv' }));

    expect(onRetry).toHaveBeenCalledWith('3');
    expect(onRemove).toHaveBeenCalledWith('1');
  });

  it('shows an image as its thumbnail from the local file, its upload over it, and revokes the URL as it goes', () => {
    const chart = new File(['png'], 'chart.png', { type: 'image/png' });
    const { unmount } = render(<ComposerFileChips files={[{ id: 'img', file: chart, state: { status: 'uploading', progress: 0.5 } }, files[1] as ComposerFile]} onRetry={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByRole('img', { name: 'chart.png' })).toHaveAttribute('src', 'blob:test/1');
    expect(objectUrls.created).toEqual([chart]);
    expect(screen.getByRole('progressbar', { name: 'Uploading chart.png' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.queryByText('chart.png')).toBeNull();
    // Other files keep their chip.
    expect(chip('notes.md')).toHaveTextContent(/^notes\.mdMD$/);

    unmount();
    expect(objectUrls.revoked).toEqual(['blob:test/1']);
  });

  it('keeps a failed image its thumbnail with Retry on it, and says why in a line under the chips', async () => {
    const onRetry = vi.fn();
    const chart = new File(['png'], 'chart.png', { type: 'image/png' });
    render(<ComposerFileChips files={[{ id: 'img', file: chart, state: { status: 'failed', error: 'Files are not configured' } }, files[2] as ComposerFile]} onRetry={onRetry} onRemove={vi.fn()} />);

    const thumbnail = screen.getByRole('img', { name: 'chart.png' }).closest('li') as HTMLElement;
    expect(thumbnail.textContent).toBe('');
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(['A file named Makefile is already in Files', "Couldn't upload chart.png: Files are not configured"]);
    await userEvent.click(within(thumbnail).getByRole('button', { name: 'Retry chart.png' }));
    expect(onRetry).toHaveBeenCalledWith('img');
    expect(within(thumbnail).getByRole('button', { name: 'Remove chart.png' })).toBeInTheDocument();
  });

  it("takes a file's chip for an image the browser can't show, its failure said once, on the chip", () => {
    const corrupt = new File([''], 'photo.png', { type: 'image/png' });
    render(<ComposerFileChips files={[{ id: 'bad', file: corrupt, state: { status: 'failed', error: 'Files are not configured' } }]} onRetry={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(["Couldn't upload photo.png: Files are not configured"]);

    fireEvent.error(screen.getByRole('img', { name: 'photo.png' }));

    expect(screen.getByRole('listitem')).toHaveTextContent(/^photo\.pngFiles are not configuredRetry$/);
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(['Files are not configured']);
  });

  it('shows a file as an image by its name, as once sent: an SVG or a HEIC is a chip', () => {
    const files: ComposerFile[] = ['logo.svg', 'photo.heic'].map((name, index) => ({ id: String(index), file: new File([''], name, { type: `image/${name.slice(-4)}` }), state: { status: 'uploaded', path: `/${name}` } }));
    render(<ComposerFileChips files={files} onRetry={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['logo.svgSVG', 'photo.heicHEIC']);
  });
});

describe('attachPastedImages', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The composer's text box and chips, its paste attaching through the composer's files. */
  function PasteComposer({ upload }: { upload: ReturnType<typeof deferredUploads>['upload'] }) {
    const attached = useComposerFiles(upload, 'account-a');
    return (
      <>
        <textarea aria-label="Message" onPaste={attachPastedImages(attached.add)} />
        <ComposerFileChips files={attached.files} onRetry={attached.retry} onRemove={attached.remove} />
      </>
    );
  }
  type Item = { kind: string; type: string; getAsFile: () => File | null };
  /** A paste's clipboard: its files, and its items, text and files alike. */
  const clipboard = ({ files = [], items = [] }: { files?: File[]; items?: Item[] }) => ({
    clipboardData: {
      files,
      items,
      // As a browser lists them: each text item's type, then Files for any file.
      types: [...items.flatMap((item) => (item.kind === 'string' ? [item.type] : [])), ...(files.length > 0 || items.some((item) => item.kind === 'file') ? ['Files'] : [])],
    },
  });
  const text: Item = { kind: 'string', type: 'text/plain', getAsFile: () => null };
  const screenshot = () => new File(['png'], 'image.png', { type: 'image/png' });
  const pasteAt = (when: Date, data: ReturnType<typeof clipboard>) => {
    vi.setSystemTime(when);
    return fireEvent.paste(screen.getByRole('textbox', { name: 'Message' }), data);
  };

  it('attaches a pasted screenshot, named for when it was pasted', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { upload } = deferredUploads();
    render(<PasteComposer upload={upload} />);
    const image = screenshot();

    pasteAt(new Date(2026, 9, 13, 16, 31, 5), clipboard({ files: [image], items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] }));

    expect(upload.mock.calls.map(([file]) => [file.name, file.type])).toEqual([['Pasted image 2026-10-13 at 4.31.05 PM.png', 'image/png']]);
    expect(screen.getByRole('progressbar', { name: 'Uploading Pasted image 2026-10-13 at 4.31.05 PM.png' })).toBeInTheDocument();
  });

  it('pastes only the text of a clipboard holding text and a picture of it, as Office apps copy', () => {
    const { upload } = deferredUploads();
    render(<PasteComposer upload={upload} />);
    const image = screenshot();

    const pasted = pasteAt(new Date(2026, 9, 13, 16, 31, 5), clipboard({ files: [image], items: [text, { kind: 'file', type: 'image/png', getAsFile: () => image }] }));

    expect(pasted).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('attaches nothing for pasted text, which pastes as it always has', () => {
    const { upload } = deferredUploads();
    render(<PasteComposer upload={upload} />);

    expect(fireEvent.paste(screen.getByRole('textbox', { name: 'Message' }), clipboard({ items: [text] }))).toBe(true);

    expect(upload).not.toHaveBeenCalled();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('names two pasted screenshots apart, though both arrive as image.png', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { upload } = deferredUploads();
    render(<PasteComposer upload={upload} />);

    pasteAt(new Date(2026, 9, 13, 16, 31, 5), clipboard({ files: [screenshot()] }));
    // An image the clipboard lists only among its items attaches too.
    const image = screenshot();
    pasteAt(new Date(2026, 9, 14, 0, 2, 7), clipboard({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] }));

    expect(screen.getAllByRole('img').map((thumbnail) => thumbnail.getAttribute('alt'))).toEqual([
      'Pasted image 2026-10-13 at 4.31.05 PM.png',
      'Pasted image 2026-10-14 at 12.02.07 AM.png',
    ]);
  });
});
