// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installBrowserLocks } from '../../tests/browser-locks';

import { deleteFile, fileDownloadUrl, FilesApp, listFiles, renameFile, uploadFile, withUploadsSettled } from './files-app';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = { chatServiceUrl: 'https://chat.test' };

describe('the Files client', () => {
  it("lists the account's Files, with its cookies", async () => {
    const files = [{ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' }];
    const fetchImpl = vi.fn(async () => Response.json({ files }));

    expect(await listFiles({ ...CHAT, fetchImpl })).toEqual(files);
    expect(fetchImpl).toHaveBeenCalledWith('https://chat.test/files', { method: 'GET', credentials: 'include' });
  });

  it('asks for a download URL by the file path', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ url: 'https://s3.test/report' }));

    expect(await fileDownloadUrl('notes/plan v2.txt', { ...CHAT, fetchImpl })).toBe('https://s3.test/report');
    expect(fetchImpl).toHaveBeenCalledWith('https://chat.test/files/download-url?name=notes%2Fplan+v2.txt', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('deletes a file by its path', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await deleteFile('notes/plan v2.txt', { ...CHAT, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('https://chat.test/files?name=notes%2Fplan+v2.txt', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('renames a file from one path to another', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ name: 'notes/plan v3.txt' }));

    await renameFile('notes/plan v2.txt', 'notes/plan v3.txt', { ...CHAT, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('https://chat.test/files/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"from":"notes/plan v2.txt","to":"notes/plan v3.txt"}',
      credentials: 'include',
    });
  });

  it("fails loud with the Chat Service's reason, or the status", async () => {
    const refused = vi.fn(async () => Response.json({ detail: 'Files are not configured' }, { status: 503 }));
    const broken = vi.fn(async () => new Response('Bad gateway', { status: 502 }));

    await expect(listFiles({ ...CHAT, fetchImpl: refused })).rejects.toThrow('Files are not configured');
    await expect(listFiles({ ...CHAT, fetchImpl: broken })).rejects.toThrow('Files request failed: 502');
    await expect(fileDownloadUrl('x', { ...CHAT, fetchImpl: broken })).rejects.toThrow('Download failed: 502');
    await expect(deleteFile('x', { ...CHAT, fetchImpl: refused })).rejects.toThrow('Files are not configured');
    await expect(deleteFile('x', { ...CHAT, fetchImpl: broken })).rejects.toThrow('Delete failed: 502');
    await expect(renameFile('x', 'y', { ...CHAT, fetchImpl: refused })).rejects.toThrow('Files are not configured');
    await expect(renameFile('x', 'y', { ...CHAT, fetchImpl: broken })).rejects.toThrow('Rename failed: 502');
  });
});

/** The browser's PUTs to presigned URLs, each answered as a test says: its progress, then its status or a network error. */
const puts: FakeUpload[] = [];
class FakeUpload {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  aborted = false;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    puts.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }
}

describe('uploading a file the user attached in the chat', () => {
  const file = new File(['buy low'], 'plan.txt', { type: 'text/plain' });
  /** The Chat Service's upload URLs: one for each name, except the names Files already holds. */
  const service = (taken: string[] = []) => vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { name } = JSON.parse(init?.body as string) as { name: string };
    if (taken.includes(name)) return Response.json({ detail: `A file named ${name} is already in Files` }, { status: 409 });
    return Response.json({ url: `https://s3.test/upload/${encodeURIComponent(name)}` });
  });
  /** The request's PUT, once the Chat Service has handed over its URL. */
  const put = async () => {
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    return puts[0] as FakeUpload;
  };
  beforeEach(() => {
    puts.length = 0;
    installBrowserLocks();
    vi.stubGlobal('XMLHttpRequest', FakeUpload);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the bytes as a new file to the Chat Service's presigned URL, reporting progress, and resolves to the agent's path", async () => {
    const fetchImpl = service();
    const onProgress = vi.fn();
    const uploading = uploadFile(file, { onProgress, signal: new AbortController().signal }, { ...CHAT, fetchImpl });
    const request = await put();
    request.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 7 });
    request.respond(200);

    expect(await uploading).toBe('/plan.txt');
    expect(fetchImpl).toHaveBeenCalledWith('https://chat.test/files/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"plan.txt"}',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    });
    expect(request).toMatchObject({ method: 'PUT', url: 'https://s3.test/upload/plan.txt', headers: { 'If-None-Match': '*' }, body: file });
    expect(onProgress).toHaveBeenCalledWith(3 / 7);
  });

  it.each([
    ['plan.txt', 'plan (3).txt', ['plan.txt', 'plan (2).txt']],
    ['plan.txt', 'plan (102).txt', ['plan.txt', ...Array.from({ length: 100 }, (_, index) => `plan (${index + 2}).txt`)]],
    ['Makefile', 'Makefile (2)', ['Makefile']],
    ['archive.tar.gz', 'archive.tar (2).gz', ['archive.tar.gz']],
    ['résumé.txt', 'résumé (2).txt', ['résumé.txt']],
    ['a.' + 'b'.repeat(253), 'a (2).' + 'b'.repeat(249), ['a.' + 'b'.repeat(253)]],
    ['😀'.repeat(62) + '.txt', '😀'.repeat(61) + ' (2).txt', ['😀'.repeat(62) + '.txt']],
  ])('keeps a copy of %s under its available stored name', async (original, stored, taken) => {
    const fetchImpl = service(taken);
    const body = new File(['new bytes'], original);
    const uploading = uploadFile(body, { onProgress: vi.fn(), signal: new AbortController().signal }, { ...CHAT, fetchImpl });
    const request = await put();
    request.respond(200);
    expect(await uploading).toBe(`/${stored}`);
    expect(request).toMatchObject({ url: `https://s3.test/upload/${encodeURIComponent(stored)}`, body });
  });

  it('keeps both composer attachments when Files already holds the name', async () => {
    const fetchImpl = service(['plan.txt']);
    const uploading = uploadFile(file, { onProgress: vi.fn(), signal: new AbortController().signal }, { ...CHAT, fetchImpl })
      .catch((error: Error) => error.message);
    (await put()).respond(200);

    expect(await uploading).toBe('/plan (2).txt');
    expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual(['{"name":"plan.txt"}', '{"name":"plan (2).txt"}']);
  });

  it("fails with the Chat Service's reason when it refuses an upload URL", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ detail: 'Files are not configured' }, { status: 503 }));
    const broken = vi.fn(async () => new Response('Bad gateway', { status: 502 }));
    const options = { onProgress: vi.fn(), signal: new AbortController().signal };

    await expect(uploadFile(file, options, { ...CHAT, fetchImpl })).rejects.toThrow('Files are not configured');
    await expect(uploadFile(file, options, { ...CHAT, fetchImpl: broken })).rejects.toThrow('Upload failed: 502');
    expect(puts).toEqual([]);
  });

  it('fails with the status when the storage refuses the PUT, or says the network failed', async () => {
    const options = { onProgress: vi.fn(), signal: new AbortController().signal };
    const refused = uploadFile(file, options, { ...CHAT, fetchImpl: service() });
    (await put()).respond(403);
    await expect(refused).rejects.toThrow('Upload failed: 403');

    puts.length = 0;
    const offline = uploadFile(file, options, { ...CHAT, fetchImpl: service() });
    (await put()).onerror?.();
    await expect(offline).rejects.toThrow('Upload failed: network error');
  });

  it('advances when concurrent uploaders claim the same name at the conditional PUT', async () => {
    const fetchImpl = service();
    const options = { onProgress: vi.fn(), signal: new AbortController().signal };
    const uploading = uploadFile(file, options, { ...CHAT, fetchImpl });
    (await put()).respond(412);
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.url).toBe('https://s3.test/upload/plan%20(2).txt');
    expect(puts[1]?.headers).toEqual({ 'If-None-Match': '*' });
    puts[1]?.respond(412);
    await vi.waitFor(() => expect(puts).toHaveLength(3));
    puts[2]?.respond(200);
    expect(await uploading).toBe('/plan (3).txt');
  });

  it('aborts the active PUT after selecting a new name for a concurrent collision', async () => {
    const controller = new AbortController();
    const uploading = uploadFile(file, { onProgress: vi.fn(), signal: controller.signal }, { ...CHAT, fetchImpl: service() });
    (await put()).respond(412);
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    controller.abort();
    await expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    expect(puts[1]?.aborted).toBe(true);
  });

  it('stops collision advancement when the attachment is removed', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      return Response.json({ detail: 'A file named plan.txt is already in Files' }, { status: 409 });
    });
    await expect(uploadFile(file, { onProgress: vi.fn(), signal: controller.signal }, { ...CHAT, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([]);
  });

  it('propagates an unavailable service after a name collision', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ detail: 'A file named plan.txt is already in Files' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ detail: 'Files unavailable' }, { status: 503 }));
    await expect(uploadFile(file, { onProgress: vi.fn(), signal: new AbortController().signal }, { ...CHAT, fetchImpl })).rejects.toThrow('Files unavailable');
    expect(fetchImpl.mock.calls.map(([, init]) => (init as RequestInit).body)).toEqual(['{"name":"plan.txt"}', '{"name":"plan (2).txt"}']);
  });

  it('propagates an account conflict without allocating another attachment name', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ detail: 'Account deletion is pending' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ detail: 'Unexpected second request' }, { status: 503 }));
    await expect(uploadFile(file, { onProgress: vi.fn(), signal: new AbortController().signal }, { ...CHAT, fetchImpl })).rejects.toThrow('Account deletion is pending');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(withUploadsSettled(async () => 'settled')).resolves.toBe('settled');
  });

  it('drains uploads before an account change and refuses new uploads until the change finishes', async () => {
    const options = { onProgress: vi.fn(), signal: new AbortController().signal };
    const fetchImpl = service();
    const uploading = uploadFile(file, options, { ...CHAT, fetchImpl });
    const request = await put();
    let finish!: () => void;
    const change = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const transition = withUploadsSettled(change);
    await expect(uploadFile(file, options, { ...CHAT, fetchImpl })).rejects.toThrow('Uploads are paused while your account changes');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(change).not.toHaveBeenCalled();
    request.respond(200);
    await uploading;
    await vi.waitFor(() => expect(change).toHaveBeenCalledOnce());
    await expect(uploadFile(file, options, { ...CHAT, fetchImpl })).rejects.toThrow('Uploads are paused while your account changes');
    finish();
    await transition;
    puts.length = 0;
    const next = uploadFile(file, options, { ...CHAT, fetchImpl });
    (await put()).respond(200);
    expect(await next).toBe('/plan.txt');
  });

  it('propagates an upload failure without changing accounts and permits another upload', async () => {
    const options = { onProgress: vi.fn(), signal: new AbortController().signal };
    const uploading = uploadFile(file, options, { ...CHAT, fetchImpl: service() });
    const request = await put();
    const change = vi.fn(async () => {});
    const transition = withUploadsSettled(change);
    request.respond(403);
    await expect(uploading).rejects.toThrow('Upload failed: 403');
    await expect(transition).rejects.toThrow('Upload failed: 403');
    expect(change).not.toHaveBeenCalled();
    puts.length = 0;
    const next = uploadFile(file, options, { ...CHAT, fetchImpl: service() });
    (await put()).respond(200);
    expect(await next).toBe('/plan.txt');
  });

  it("waits for another tab's pending upload before claiming the shared account", async () => {
    vi.resetModules();
    const uploadingTab = await import('./files-app');
    vi.resetModules();
    const claimingTab = await import('./files-app');
    expect(uploadingTab.uploadFile).not.toBe(claimingTab.uploadFile);
    const uploading = uploadingTab.uploadFile(file, { onProgress: vi.fn(), signal: new AbortController().signal }, { ...CHAT, fetchImpl: service() });
    const request = await put();
    const claim = vi.fn(async () => {});
    const transition = claimingTab.withUploadsSettled(claim);
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(claim).not.toHaveBeenCalled();
    } finally {
      request.respond(200);
      await uploading;
      await transition;
    }
    expect(claim).toHaveBeenCalledOnce();
  });

  it('aborts the PUT when the user removes the file', async () => {
    const controller = new AbortController();
    const uploading = uploadFile(file, { onProgress: vi.fn(), signal: controller.signal }, { ...CHAT, fetchImpl: service() });
    const request = await put();
    controller.abort();

    await expect(uploading).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(request.aborted).toBe(true);
  });
});

/** The Chat Service as the app sees it: the account's Files, and the requests it got. */
const calls: string[] = [];
let stored: { name: string; size: number; lastModified: string }[] = [];
let failing: number | null = null;
const assign = vi.fn();
beforeEach(() => {
  calls.length = 0;
  stored = [];
  failing = null;
  assign.mockClear();
  vi.stubGlobal('location', { assign });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(`${init?.method} ${url.origin}${url.pathname}${url.search}`);
    if (failing !== null) return Response.json({ detail: 'refused' }, { status: failing });
    if (url.pathname === '/files' && init?.method === 'DELETE') {
      stored = stored.filter(({ name }) => name !== url.searchParams.get('name'));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/files/rename') {
      const { from, to } = JSON.parse(init?.body as string) as { from: string; to: string };
      calls.push(`renamed ${from} to ${to}`);
      stored = stored.map((file) => (file.name === from ? { ...file, name: to } : file));
      return Response.json({ name: to });
    }
    if (url.pathname === '/files') return Response.json({ files: stored });
    if (url.pathname === '/files/download-url') return Response.json({ url: `https://s3.test/${url.searchParams.get('name')}` });
    throw new Error(`Unexpected request: ${input}`);
  });
});

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function app(): Promise<HTMLElement> {
  // In the document, so focus moves and a tap outside the app reaches it.
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(React.createElement(FilesApp, CHAT)));
  return host;
}
const names = (host: HTMLElement) => [...host.querySelectorAll('.agent-computer-file')].map((file) => file.textContent);
// A button's name: an icon chip's label, else its text.
const named = (button: HTMLButtonElement) => button.getAttribute('aria-label') ?? button.textContent;
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll('button')].find((candidate) => named(candidate) === label);
  if (button === undefined) throw new Error(`no ${label} button`);
  await act(async () => button.click());
};
/** The open place's name, Finder's title. */
const folderName = (host: HTMLElement) => host.querySelector('.agent-computer-files-title')?.textContent;
/** A part of the window's buttons by name: the sidebar's places, the grid's items, or the path bar's folders. */
const within = (part: string) => ({
  names: (host: HTMLElement) => [...host.querySelectorAll(`${part} button`)].map((button) => named(button as HTMLButtonElement)),
  open: async (host: HTMLElement, name: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>(`${part} button`)].find((candidate) => named(candidate) === name);
    if (button === undefined) throw new Error(`no ${name} in ${part}`);
    await act(async () => button.click());
  },
  current: (host: HTMLElement) => host.querySelector(`${part} [aria-current="true"]`)?.textContent,
});
const sidebar = within('.agent-computer-files-sidebar');
const grid = within('.agent-computer-files-grid');
const pathBar = within('.agent-computer-files-path');
const back = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
const forward = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Forward"]');

describe('FilesApp', () => {
  it('draws a plain document for an extension named after an inherited object property', async () => {
    stored.push({ name: 'report.constructor', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
    const host = await app();
    const item = host.querySelector('.agent-computer-file');
    expect(item?.getAttribute('data-kind')).toBe('document');
    expect(item?.querySelectorAll('svg path')).toHaveLength(2);
  });

  it('says where files come from while there are none, and lists them when Files opens again', async () => {
    const host = await app();
    expect(host.querySelector('.agent-computer-files-empty')?.textContent).toBe(
      'No files yet. Files the agent downloads appear here within a minute or two.',
    );
    expect(names(host)).toEqual([]);
    expect([...host.querySelectorAll('button')].map(named)).not.toContain('Refresh');
    expect([...host.querySelectorAll('button')].map(named)).not.toContain('Upload');

    stored.push({ name: 'report.csv', size: 2048, lastModified: '2026-10-01T12:00:00.000Z' });
    const again = await app();

    expect(names(again)).toEqual(['report.csv']);
    expect(again.querySelector('.agent-computer-files-empty')).toBeNull();
    expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
  });

  it('reloads the listing as each place opens', async () => {
    stored.push({ name: 'reports/q3.pdf', size: 1, lastModified: '2026-10-01T09:00:00.000Z' });
    const host = await app();

    await grid.open(host, 'reports');
    stored.push({ name: 'reports/q4.pdf', size: 1, lastModified: '2026-10-02T09:00:00.000Z' });
    await sidebar.open(host, 'reports');
    expect(names(host)).toEqual(['q3.pdf', 'q4.pdf']);
    await click(host, 'Back');
    await sidebar.open(host, 'Recents');

    expect(calls).toEqual(Array(5).fill('GET https://chat.test/files'));
  });

  it('loads the Files of the Chat Service it is pointed at', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(FilesApp, CHAT)));

    await act(async () => root.render(React.createElement(FilesApp, { chatServiceUrl: 'https://other.test' })));

    expect(calls).toEqual(['GET https://chat.test/files', 'GET https://other.test/files']);
  });

  it('downloads a file by following its URL', async () => {
    stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
    const host = await app();

    await click(host, 'report.csv');

    expect(assign).toHaveBeenCalledWith('https://s3.test/report.csv');
  });

  it('clears a refused download after an explicit successful retry', async () => {
    stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
    const host = await app();
    failing = 503;
    await click(host, 'report.csv');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused');
    expect(assign).not.toHaveBeenCalled();

    await click(host, 'report.csv');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused');
    expect(assign).not.toHaveBeenCalled();

    failing = null;
    await click(host, 'report.csv');
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('https://s3.test/report.csv');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(calls.filter((call) => call === 'GET https://chat.test/files')).toHaveLength(1);
  });

  it('says why when the Chat Service refuses', async () => {
    failing = 503;
    const host = await app();

    expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused');
    const reopened = await app();
    expect(reopened.querySelector('[role="alert"]')?.textContent).toBe('refused');

    failing = null;
    stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
    const listed = await app();
    expect(listed.querySelector('[role="alert"]')).toBeNull();
    failing = 502;
    await click(listed, 'report.csv');
    expect(listed.querySelector('[role="alert"]')?.textContent).toBe('refused');
    expect(assign).not.toHaveBeenCalled();
  });

  /** The open folder's items as Finder's icon view draws them: each name, and the kind its icon draws. */
  const items = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('.agent-computer-file')].map((item) => `${item.textContent} (${item.dataset.kind})`);
  /** A pointer's click on an item, as a mouse or a tap gives it (Enter's click has no pointer behind it). */
  const press = async (host: HTMLElement, label: string, count = 1) => {
    const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => candidate.textContent === label);
    if (file === undefined) throw new Error(`no ${label} item`);
    await act(async () => {
      for (let detail = 1; detail <= count; detail++) file.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
      if (count === 2) file.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    });
  };
  const selected = (host: HTMLElement) =>
    [...host.querySelectorAll('.agent-computer-file[aria-selected="true"]')].map((item) => item.textContent);

  // Issue the regression: Files as Finder's icon view, each item a drawn icon with its name under it.
  it("shows the open folder's files and folders as Finder's icon view, in name order, each with its drawn icon", async () => {
    stored.push(
      { name: 'prices.csv', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'q3.PDF', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'model.xlsx', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'recap.md', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'curve.png', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'notes.txt', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'Makefile', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: '.env', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'reports/a.txt', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
    );
    const host = await app();

    expect(host.querySelector('.agent-computer-files-grid')?.getAttribute('role')).toBe('listbox');
    expect(host.querySelector('table')).toBeNull();
    expect(items(host)).toEqual([
      '.env (document)', 'curve.png (document)', 'Makefile (document)', 'model.xlsx (spreadsheet)', 'notes.txt (text)',
      'prices.csv (spreadsheet)', 'q3.PDF (text)', 'recap.md (text)', 'reports (folder)',
    ]);
    expect([...host.querySelectorAll('.agent-computer-file')].map((item) => item.getAttribute('role'))).toEqual(Array(9).fill('option'));
    expect([...host.querySelectorAll('.agent-computer-file svg')].map((svg) => svg.getAttribute('aria-hidden'))).toEqual(Array(9).fill('true'));
  });

  it('selects an item on a click, highlighting it, and opens it on a double-click', async () => {
    stored.push(
      { name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
      { name: 'reports/q3.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
    );
    const host = await app();
    expect(selected(host)).toEqual([]);

    await press(host, 'report.csv');
    expect(selected(host)).toEqual(['report.csv']);
    expect(assign).not.toHaveBeenCalled();
    await press(host, 'reports');
    expect(selected(host)).toEqual(['reports']);
    expect(items(host)).toEqual(['report.csv (spreadsheet)', 'reports (folder)']);

    await press(host, 'report.csv', 2);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('https://s3.test/report.csv');
    await press(host, 'reports', 2);
    expect(items(host)).toEqual(['q3.pdf (text)']);
    expect(folderName(host)).toBe('reports');
  });

  it('opens the folders of the open folder, its items in name order, and goes back up its path bar', async () => {
    stored.push(
      { name: 'reports/summary.csv', size: 12, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'reports/2026/q3.pdf', size: 2048, lastModified: '2026-10-02T09:00:00.000Z' },
      { name: 'reports/2026/q2.pdf', size: 1024, lastModified: '2026-09-01T09:00:00.000Z' },
      { name: 'reports/2026/drafts/q4.pdf', size: 512, lastModified: '2026-09-15T09:00:00.000Z' },
      { name: 'Notes.txt', size: 7, lastModified: '2026-09-30T09:00:00.000Z' },
    );
    const host = await app();

    expect(names(host)).toEqual(['Notes.txt', 'reports']);
    expect(folderName(host)).toBe('workspace');
    expect(pathBar.names(host)).toEqual(['workspace']);

    await grid.open(host, 'reports');
    await grid.open(host, '2026');
    await grid.open(host, 'drafts');

    expect(names(host)).toEqual(['q4.pdf']);
    expect(folderName(host)).toBe('drafts');
    expect(pathBar.names(host)).toEqual(['workspace', 'reports', '2026', 'drafts']);
    expect(pathBar.current(host)).toBe('drafts');
    expect(host.querySelector('.agent-computer-files-path')?.textContent).toBe('workspace›reports›2026›drafts');

    await grid.open(host, 'q4.pdf');
    expect(assign).toHaveBeenCalledWith('https://s3.test/reports/2026/drafts/q4.pdf');

    await pathBar.open(host, '2026');
    expect(names(host)).toEqual(['drafts', 'q2.pdf', 'q3.pdf']);
    expect(pathBar.names(host)).toEqual(['workspace', 'reports', '2026']);

    await pathBar.open(host, 'reports');
    expect(names(host)).toEqual(['2026', 'summary.csv']);

    await pathBar.open(host, 'workspace');
    expect(names(host)).toEqual(['Notes.txt', 'reports']);
  });

  it('goes Back and Forward through the places it opened, as Finder does', async () => {
    stored.push(
      { name: 'reports/summary.csv', size: 12, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'reports/2026/drafts/q4.pdf', size: 512, lastModified: '2026-09-15T09:00:00.000Z' },
      { name: 'Notes.txt', size: 7, lastModified: '2026-09-30T09:00:00.000Z' },
    );
    const host = await app();
    expect([back(host)?.disabled, forward(host)?.disabled]).toEqual([true, true]);

    await grid.open(host, 'reports');
    await grid.open(host, '2026');
    await pathBar.open(host, 'workspace');
    expect(folderName(host)).toBe('workspace');

    // Back retraces the path bar's jump, not the folder's parent.
    await click(host, 'Back');
    expect(folderName(host)).toBe('2026');
    expect(names(host)).toEqual(['drafts']);
    await click(host, 'Back');
    await click(host, 'Back');
    expect(folderName(host)).toBe('workspace');
    expect([back(host)?.disabled, forward(host)?.disabled]).toEqual([true, false]);

    await click(host, 'Forward');
    expect(folderName(host)).toBe('reports');
    await click(host, 'Forward');
    expect(folderName(host)).toBe('2026');

    // A place opened after going Back drops what Forward held.
    await click(host, 'Back');
    await sidebar.open(host, 'Recents');
    expect(folderName(host)).toBe('Recents');
    expect(forward(host)?.disabled).toBe(true);
    await click(host, 'Back');
    expect(folderName(host)).toBe('reports');
    expect(names(host)).toEqual(['2026', 'summary.csv']);
  });

  it('lists Recents, workspace and its own folders in the sidebar, marking the open place', async () => {
    stored.push(
      { name: 'reports/2026/q3.pdf', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'notes/plan.md', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'rates-recap.md', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
    );
    const host = await app();

    expect(sidebar.names(host)).toEqual(['Recents', 'workspace', 'notes', 'reports']);
    expect(host.querySelector('.agent-computer-files-sidebar p')?.textContent).toBe('Files');
    expect(sidebar.current(host)).toBe('workspace');

    await sidebar.open(host, 'reports');
    expect(sidebar.current(host)).toBe('reports');
    expect(names(host)).toEqual(['2026']);
    // A folder further down is open, and none of the sidebar's.
    await grid.open(host, '2026');
    expect(sidebar.current(host)).toBeUndefined();
  });

  it('lists Recents as the newest files in every folder, newest first, twenty at most', async () => {
    stored.push(
      { name: 'reports/2026/q3.pdf', size: 1, lastModified: '2026-10-03T09:00:00.000Z' },
      { name: 'rates-recap.md', size: 1, lastModified: '2026-10-05T09:00:00Z' },
      { name: 'notes/plan.md', size: 1, lastModified: '2026-10-04T09:00:00.000Z' },
      ...Array.from({ length: 20 }, (_, index) => ({ name: `old/${index}.txt`, size: 1, lastModified: `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00.000Z` })),
    );
    const host = await app();

    await sidebar.open(host, 'Recents');

    expect(folderName(host)).toBe('Recents');
    expect(names(host)).toEqual(['rates-recap.md', 'plan.md', 'q3.pdf', ...Array.from({ length: 17 }, (_, index) => `${19 - index}.txt`)]);
    expect(host.querySelector('.agent-computer-files-path')?.textContent).toBe('Recents');
    expect(pathBar.names(host)).toEqual([]);

    // A recent file opens, and renames in, its own folder.
    await grid.open(host, 'q3.pdf');
    expect(assign).toHaveBeenCalledWith('https://s3.test/reports/2026/q3.pdf');
    const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => candidate.textContent === 'plan.md');
    await act(async () => file?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await click(host, 'Rename');
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('.agent-computer-file-rename');
      if (input === null) throw new Error('no name field');
      input.value = 'plan v2.md';
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
    });
    expect(calls).toContain('renamed notes/plan.md to notes/plan v2.md');
  });

  it('wraps a name to two lines at most, cutting a longer one in its middle, and names the item in full', async () => {
    stored.push(
      { name: 'z-quarterly-earnings-model.xlsx', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'rates-recap.md', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'notes.txt', size: 1, lastModified: '2026-10-01T09:00:00.000Z' },
    );
    // Two 12px lines of ten characters each.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(24);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return 12 * Math.ceil(this.textContent.length / 10);
    });
    const host = await app();

    // The start gives way to the two lines; the last six characters stay whole, tight after one ellipsis.
    expect([...host.querySelectorAll('.agent-computer-file-name')].map((name) => name.textContent)).toEqual(['notes.txt', 'rates-recap.md', 'z-quarterly-e…l.xlsx']);
    expect([...host.querySelectorAll('.agent-computer-file')].map((item) => [item.getAttribute('aria-label'), item.getAttribute('title')])).toEqual([
      ['notes.txt', 'notes.txt'],
      ['rates-recap.md', 'rates-recap.md'],
      ['z-quarterly-earnings-model.xlsx', 'z-quarterly-earnings-model.xlsx'],
    ]);
  });

  it('shows a file beside a folder of the same name, and opens the folder', async () => {
    stored.push(
      { name: 'reports', size: 3, lastModified: '2026-10-01T09:00:00.000Z' },
      { name: 'reports/summary.csv', size: 12, lastModified: '2026-10-02T09:00:00.000Z' },
    );
    const host = await app();

    expect(items(host)).toEqual(['reports (document)', 'reports (folder)']);
    await act(async () => (host.querySelector('[data-kind="folder"]') as HTMLButtonElement).click());
    expect(items(host)).toEqual(['summary.csv (spreadsheet)']);
  });

  describe("a file row's menu", () => {
    /** A right-click on a row's name, or a long-press on a phone: both fire `contextmenu`. */
    const menuOn = async (host: HTMLElement, label: string, clientX = 40, clientY = 60) => {
      const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => candidate.textContent === label);
      if (file === undefined) throw new Error(`no ${label} row`);
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY });
      await act(async () => file.dispatchEvent(event));
      return event;
    };
    const menu = (host: HTMLElement) => host.querySelector('[role="menu"]');
    const items = (host: HTMLElement) => [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    const sheet = (host: HTMLElement) => host.querySelector('[role="alertdialog"]');
    const key = async (target: Element | null, init: KeyboardEventInit) =>
      act(async () => target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));

    it('opens on a file row, with Download, Rename and Delete, and on no folder row', async () => {
      stored.push(
        { name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
        { name: 'reports/q3.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
      );
      const host = await app();

      expect((await menuOn(host, 'reports')).defaultPrevented).toBe(false);
      expect(menu(host)).toBeNull();
      expect((await menuOn(host, 'report.csv')).defaultPrevented).toBe(true);
      expect(items(host)).toEqual(['Download', 'Rename', 'Delete']);
      expect(selected(host)).toEqual(['report.csv']);
      expect(assign).not.toHaveBeenCalled();
    });

    it('opens at the pointer, or up and left of it where it would run past the window', async () => {
      stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
      // A 300×200 window, and a 120×100 menu.
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120);
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
      const host = await app();
      const at = () => [(menu(host) as HTMLElement).style.left, (menu(host) as HTMLElement).style.top];

      await menuOn(host, 'report.csv');
      expect(at()).toEqual(['40px', '60px']);
      await key(document.activeElement, { key: 'Escape' });
      await menuOn(host, 'report.csv', 250, 150);
      expect(at()).toEqual(['130px', '50px']);
    });

    it('downloads the file as a double-click does', async () => {
      stored.push({ name: 'reports/q3.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
      const host = await app();
      await click(host, 'reports');

      await menuOn(host, 'q3.pdf');
      await click(host, 'Download');
      expect(menu(host)).toBeNull();
      expect(calls.at(-1)).toBe('GET https://chat.test/files/download-url?name=reports%2Fq3.pdf');
      expect(assign).toHaveBeenCalledWith('https://s3.test/reports/q3.pdf');
    });

    it('deletes the file once its sheet confirms, then lists Files again; Cancel deletes nothing', async () => {
      stored.push(
        { name: 'reports/q3.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
        { name: 'reports/q2.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
      );
      const host = await app();
      await click(host, 'reports');

      await menuOn(host, 'q3.pdf');
      await click(host, 'Delete');
      expect(menu(host)).toBeNull();
      expect(sheet(host)?.querySelector('p')?.textContent).toBe("Delete “q3.pdf”? This can't be undone.");
      await click(host, 'Cancel');
      expect(sheet(host)).toBeNull();
      expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);

      await menuOn(host, 'q3.pdf');
      await click(host, 'Delete');
      await click(host, 'Delete');

      expect(sheet(host)).toBeNull();
      expect(calls.slice(2)).toEqual(['DELETE https://chat.test/files?name=reports%2Fq3.pdf', 'GET https://chat.test/files']);
      expect(names(host)).toEqual(['q2.pdf']);
    });

    it('says why when the Chat Service refuses a delete, and keeps the file listed', async () => {
      stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
      const host = await app();
      await menuOn(host, 'report.csv');
      await click(host, 'Delete');
      failing = 404;

      await click(host, 'Delete');

      expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused');
      expect(names(host)).toEqual(['report.csv']);
    });

    it('closes on a tap outside it, and stays open for a tap inside it', async () => {
      stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
      const host = await app();
      await menuOn(host, 'report.csv');

      await act(async () => menu(host)?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(menu(host)).not.toBeNull();
      await act(async () => host.querySelector('.agent-computer-files-grid')?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(menu(host)).toBeNull();
    });

    it.each([
      ['the context-menu key', { key: 'ContextMenu' }],
      ['Shift+F10', { key: 'F10', shiftKey: true }],
    ])('opens from %s on a focused file row, moves by arrows, activates on Enter, and closes on Escape', async (_name, open) => {
      stored.push(
        { name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
        { name: 'reports/q3.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
      );
      const host = await app();
      const [file, folder] = [...host.querySelectorAll<HTMLButtonElement>('.agent-computer-file')];
      if (file === undefined || folder === undefined) throw new Error('rows missing');

      folder.focus();
      await key(folder, open);
      expect(menu(host)).toBeNull();
      file.focus();
      await key(file, open);
      expect(document.activeElement?.textContent).toBe('Download');
      await key(document.activeElement, { key: 'ArrowDown' });
      expect(document.activeElement?.textContent).toBe('Rename');
      await key(document.activeElement, { key: 'ArrowDown' });
      expect(document.activeElement?.textContent).toBe('Delete');
      await key(document.activeElement, { key: 'ArrowDown' });
      expect(document.activeElement?.textContent).toBe('Download');
      await key(document.activeElement, { key: 'ArrowUp' });
      expect(document.activeElement?.textContent).toBe('Delete');
      // Escape closes the menu alone: the phone's Agent Profile, which closes on an Escape reaching the document, stays.
      const reached = vi.fn();
      document.addEventListener('keydown', reached);
      await key(document.activeElement, { key: 'Escape' });
      document.removeEventListener('keydown', reached);
      expect(reached).not.toHaveBeenCalled();
      expect(menu(host)).toBeNull();
      expect(document.activeElement).toBe(file);

      await key(file, open);
      await key(document.activeElement, { key: 'ArrowUp' });
      await key(document.activeElement, { key: 'Enter' });
      expect(menu(host)).toBeNull();
      expect(sheet(host)).not.toBeNull();
      expect(calls).toEqual(['GET https://chat.test/files']);
    });

    it('closes on Tab out of it', async () => {
      stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
      const host = await app();
      await menuOn(host, 'report.csv');

      await key(document.activeElement, { key: 'Tab' });

      expect(menu(host)).toBeNull();
    });

    it.each([
      ['Cancel', async (host: HTMLElement) => click(host, 'Cancel')],
      ['Escape', async (host: HTMLElement) => key(sheet(host)?.querySelector('button') ?? null, { key: 'Escape' })],
      [
        'a refused Delete',
        async (host: HTMLElement) => {
          failing = 404;
          await click(host, 'Delete');
        },
      ],
    ])("gives focus to the sheet, then back to the file's row once %s closes it", async (_name, close) => {
      stored.push({ name: 'report.csv', size: 12, lastModified: '2026-10-01T12:00:00.000Z' });
      const host = await app();
      const file = host.querySelector<HTMLButtonElement>('.agent-computer-file');
      await menuOn(host, 'report.csv');

      await click(host, 'Delete');
      expect(document.activeElement?.textContent).toBe('Cancel');
      await close(host);

      expect(sheet(host)).toBeNull();
      expect(document.activeElement).toBe(file);
    });
  });

  describe('renaming a file in its row', () => {
    const rename = async (host: HTMLElement, label: string) => {
      const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => candidate.textContent === label);
      if (file === undefined) throw new Error(`no ${label} row`);
      await act(async () => file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      await click(host, 'Rename');
      const input = host.querySelector<HTMLInputElement>('.agent-computer-file-rename');
      if (input === null) throw new Error('no name field');
      return input;
    };
    const type = async (input: HTMLInputElement, name: string, key?: string) =>
      act(async () => {
        input.value = name;
        if (key) input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
      });
    const blur = async (input: HTMLInputElement) => act(async () => input.blur());
    const renames = () => calls.filter((call) => call.startsWith('renamed'));

    beforeEach(() => {
      stored.push(
        { name: 'reports/q3.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
        { name: 'reports/q2.pdf', size: 12, lastModified: '2026-10-01T12:00:00.000Z' },
      );
    });

    it('edits the name in place with its stem selected, and commits on Enter in the same folder, then lists Files again', async () => {
      const host = await app();
      await click(host, 'reports');
      const input = await rename(host, 'q3.pdf');

      expect(document.activeElement).toBe(input);
      expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['q3.pdf', 0, 2]);
      // The field blurs as Enter's commit removes it, before the list draws again: one rename, not two.
      await act(async () => {
        input.value = 'q3 final.pdf';
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });

      expect(calls.slice(2)).toEqual([
        'POST https://chat.test/files/rename',
        'renamed reports/q3.pdf to reports/q3 final.pdf',
        'GET https://chat.test/files',
      ]);
      expect(host.querySelector('.agent-computer-file-rename')).toBeNull();
      expect(names(host)).toEqual(['q2.pdf', 'q3 final.pdf']);
    });

    it('commits on blur', async () => {
      const host = await app();
      await click(host, 'reports');
      const input = await rename(host, 'q3.pdf');

      await type(input, 'q4.pdf');
      await blur(input);

      expect(renames()).toEqual(['renamed reports/q3.pdf to reports/q4.pdf']);
      expect(names(host)).toEqual(['q2.pdf', 'q4.pdf']);
    });

    it('cancels on Escape, and commits nothing for an unchanged name', async () => {
      const host = await app();
      await click(host, 'reports');

      const input = await rename(host, 'q3.pdf');
      await type(input, 'q4.pdf', 'Escape');
      await blur(input);
      expect(host.querySelector('.agent-computer-file-rename')).toBeNull();
      expect(names(host)).toEqual(['q2.pdf', 'q3.pdf']);

      await type(await rename(host, 'q3.pdf'), 'q3.pdf', 'Enter');
      expect(host.querySelector('.agent-computer-file-rename')).toBeNull();
      expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
    });

    it('refuses a typed `/` without calling the Chat Service, and says why', async () => {
      const host = await app();
      await click(host, 'reports');

      await type(await rename(host, 'q3.pdf'), 'drafts/q3.pdf', 'Enter');

      expect(host.querySelector('[role="alert"]')?.textContent).toBe('A file name can’t contain “/”.');
      expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
      expect(names(host)).toEqual(['q2.pdf', 'q3.pdf']);
    });

    it('says why when the Chat Service refuses a rename, and keeps the file listed', async () => {
      const host = await app();
      await click(host, 'reports');
      const input = await rename(host, 'q3.pdf');
      failing = 409;

      await type(input, 'q2.pdf', 'Enter');

      expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused');
      expect(names(host)).toEqual(['q2.pdf', 'q3.pdf']);
    });

    it("keeps the row's own shortcuts out of the name field: a double-click edits, the context-menu key types", async () => {
      const host = await app();
      await click(host, 'reports');
      const input = await rename(host, 'q3.pdf');

      await act(async () => {
        input.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
        input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ContextMenu' }));
      });

      expect(assign).not.toHaveBeenCalled();
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(input);
      expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
    });
  });
});
