import { useLayoutEffect } from 'react';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FILE_ACCOUNT_LOCK } from '../cartridge/file-account';

import { ComposerFileChips, messageWithFiles, useComposerFiles, type ComposerFile } from './composer-files';

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
    act(() => result.current?.add([report, notes]));
    await act(async () => uploads[0]?.resolve('/report.csv'));

    rerender({ accountId: 'account-b' });

    expect(uploads[1]?.signal.aborted).toBe(true);
    expect(result.current?.files).toEqual([]);
    await act(async () => uploads[1]?.resolve('/notes.md'));
    expect(result.current?.files).toEqual([]);
    act(() => result.current?.add([report]));
    await act(async () => uploads[2]?.resolve('/report (1).csv'));
    expect(result.current?.files.map(({ state }) => state)).toEqual([{ status: 'uploaded', path: '/report (1).csv' }]);
  });

  it("invalidates stale paths before another tab's account claim can submit them", async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current?.add([report, notes]));
    await act(async () => uploads[0]?.resolve('/report.csv'));
    const stale = result.current;
    act(() => {
      localStorage.setItem(FILE_ACCOUNT_LOCK, 'another-tab-claim');
      expect(stale?.sendable).toBe(false);
      window.dispatchEvent(new StorageEvent('storage', { key: FILE_ACCOUNT_LOCK }));
    });
    expect(result.current?.files).toEqual([]);
    expect(uploads[1]?.signal.aborted).toBe(true);
  });

  it('keeps old paths unsendable in the render before an account epoch clears their chips', async () => {
    const { upload, uploads } = deferredUploads();
    let changing = false;
    const sendable: boolean[] = [];
    const { result } = renderHook(() => {
      const attached = useComposerFiles(upload, 'account-a');
      useLayoutEffect(() => {
        if (changing && attached && attached.files.length > 0) sendable.push(attached.sendable);
      });
      return attached;
    });
    act(() => result.current?.add([report]));
    await act(async () => uploads[0]?.resolve('/report.csv'));
    changing = true;
    act(() => {
      localStorage.setItem(FILE_ACCOUNT_LOCK, 'claim-before-paint');
      window.dispatchEvent(new StorageEvent('storage', { key: FILE_ACCOUNT_LOCK }));
    });
    expect(sendable).toContain(false);
    expect(sendable).not.toContain(true);
    expect(result.current?.files).toEqual([]);
  });

  it('has no files to attach without the cartridge uploading them', () => {
    expect(renderHook(() => useComposerFiles(undefined, 'account-a')).result.current).toBeNull();
  });

  it('uploads each file added, showing its progress, and lets the message go once every file has uploaded', async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));

    act(() => result.current?.add([report, notes]));
    expect(result.current?.files.map(({ file, state }) => [file.name, state])).toEqual([
      ['report.csv', { status: 'uploading', progress: 0 }],
      ['notes.md', { status: 'uploading', progress: 0 }],
    ]);
    expect(result.current?.sendable).toBe(false);

    act(() => uploads[0]?.progress(0.42));
    expect(result.current?.files[0]?.state).toEqual({ status: 'uploading', progress: 0.42 });

    await act(async () => uploads[0]?.resolve('/report.csv'));
    expect(result.current?.files[0]?.state).toEqual({ status: 'uploaded', path: '/report.csv' });
    expect(result.current?.sendable).toBe(false);

    await act(async () => uploads[1]?.resolve('/notes.md'));
    expect(result.current?.sendable).toBe(true);
  });

  it('shows why an upload failed, holding the message, and uploads the file again on Retry', async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current?.add([report]));

    await act(async () => uploads[0]?.reject(new Error('Upload failed: 403')));
    expect(result.current?.files[0]?.state).toEqual({ status: 'failed', error: 'Upload failed: 403' });
    expect(result.current?.sendable).toBe(false);

    const id = result.current?.files[0]?.id ?? '';
    act(() => result.current?.retry(id));
    expect(result.current?.files[0]?.state).toEqual({ status: 'uploading', progress: 0 });
    expect(uploads[1]?.file).toBe(report);

    await act(async () => uploads[1]?.resolve('/report.csv'));
    expect(result.current?.files[0]?.state).toEqual({ status: 'uploaded', path: '/report.csv' });
    expect(result.current?.sendable).toBe(true);
  });

  it('refuses a hidden file without uploading it, as the agent would never see it in its workspace', () => {
    const { upload } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));

    act(() => result.current?.add([new File(['KEY=1'], '.env')]));

    expect(result.current?.files[0]?.state).toEqual({
      status: 'failed',
      error: "The agent can't read hidden files like .env. Rename it without the leading dot.",
    });
    expect(result.current?.sendable).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('aborts the upload of a file removed, which never comes back as its upload ends', async () => {
    const { upload, uploads } = deferredUploads();
    const { result } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current?.add([report, notes]));

    act(() => result.current?.remove(result.current.files[0]?.id ?? ''));
    expect(uploads[0]?.signal.aborted).toBe(true);
    await act(async () => uploads[0]?.reject(new DOMException('Upload aborted', 'AbortError')));
    expect(result.current?.files.map(({ file }) => file.name)).toEqual(['notes.md']);
  });

  it('empties on clear, as a message sends, and aborts what is still uploading as the composer goes', () => {
    const { upload, uploads } = deferredUploads();
    const { result, unmount } = renderHook(() => useComposerFiles(upload, 'account-a'));
    act(() => result.current?.add([report]));
    act(() => result.current?.clear());
    expect(result.current?.files).toEqual([]);
    expect(result.current?.sendable).toBe(true);

    act(() => result.current?.add([notes]));
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
});
