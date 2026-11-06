import { afterAll, afterEach, expect, it, vi } from 'vitest';

import { act, renderHook } from '@testing-library/react';

import { FILE_ACCOUNT_LOCK } from '../cartridge/file-account';

vi.stubEnv('NEXT_PUBLIC_CHAT_SERVICE_URL', 'http://chat.test');
afterAll(() => {
  vi.unstubAllEnvs();
});

const { agentFiles } = await import('./agent-files');
const { useComposerFiles } = await import('./composer-files');

afterEach(() => {
  vi.unstubAllGlobals();
});

// The agent writes `/chart.svg` to its files as `chart.svg`, and a reply embeds it by that path, which
// markdown hands over percent-encoded.
it("gives a reply's file path the download URL of the file it names in Files", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ url: 'https://s3.test/chart.svg?signed' }));
  vi.stubGlobal('fetch', fetchImpl);

  expect(await agentFiles.url('/spx%20closes.svg')).toBe('https://s3.test/chart.svg?signed');
  expect(fetchImpl).toHaveBeenCalledWith('http://chat.test/files/download-url?name=spx+closes.svg', { method: 'GET', credentials: 'include' });
});

// A file the user attaches in the chat goes to the top of Files, which the agent reads as `/name`.
it('uploads a file the user attached to Files, failing with what the Chat Service answered', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ detail: 'Files are not configured' }, { status: 503 }));
  vi.stubGlobal('fetch', fetchImpl);

  await expect(agentFiles.upload(new File(['date,close'], 'report.csv'), { onProgress: vi.fn(), signal: new AbortController().signal })).rejects.toThrow('Files are not configured');
  expect(fetchImpl).toHaveBeenCalledWith('http://chat.test/files/upload-url', expect.objectContaining({ method: 'POST', body: '{"name":"report.csv"}' }));
});

it('deletes an attached file from Files by the path its upload resolved to', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchImpl);

  await agentFiles.discard('/report (2).csv', localStorage.getItem(FILE_ACCOUNT_LOCK));
  expect(fetchImpl).toHaveBeenCalledWith('http://chat.test/files?name=report+%282%29.csv', { method: 'DELETE', credentials: 'include' });
});

it("refuses to delete an attached file once another account has signed in, sending nothing", async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchImpl);
  localStorage.setItem(FILE_ACCOUNT_LOCK, 'account-b');

  await expect(agentFiles.discard('/report.csv', 'account-a')).rejects.toThrow('Your account changed since you attached it.');
  expect(fetchImpl).not.toHaveBeenCalled();
  localStorage.removeItem(FILE_ACCOUNT_LOCK);
});

it("sends no DELETE when Remove is clicked on a chip another tab's sign-in left stale", async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchImpl);
  localStorage.setItem(FILE_ACCOUNT_LOCK, 'account-a');
  const upload = vi.fn(async () => '/report.csv');
  const { result } = renderHook(() => useComposerFiles({ upload, discard: agentFiles.discard }, 'account-a'));
  await act(async () => result.current.add([new File(['date,close'], 'report.csv')]));
  localStorage.setItem(FILE_ACCOUNT_LOCK, 'account-b');

  await act(async () => result.current.remove(result.current.files[0]?.id ?? ''));

  expect(fetchImpl).not.toHaveBeenCalled();
  localStorage.removeItem(FILE_ACCOUNT_LOCK);
});
