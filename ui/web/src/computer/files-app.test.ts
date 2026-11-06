import React, { act } from 'react';
import userEvent from '@testing-library/user-event';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteFile, fileDownloadUrl, FilesApp, FilesWindow, listFiles, renameFile, uploadFile, withUploadsSettled, type FileEntry } from './files-app';

const entry = (name: string, size = 1, lastModified = '2026-10-01T09:00:00.000Z') => ({ name, size, lastModified });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = { chatServiceUrl: 'https://chat.test' };

describe('the Files client', () => {
  it("lists the account's Files, with its cookies", async () => {
    const files = [entry('report.csv', 12, '2026-10-01T12:00:00.000Z')];
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

  it('uploads to a Files link from EFS in 4 MiB chunks, chunk 0 first, then finishes with the size and SHA-256', async () => {
    const big = new File([new Uint8Array(9 * 1024 * 1024).fill(7)], 'big.bin');
    const link = 'https://links.test/?t=signed';
    const fetchImpl = vi.fn(async () => Response.json({ url: link }));
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent.push(`${new URL(url).search} ${(init.body as Blob).size}`);
      return new Response('ok');
    }));
    const onProgress = vi.fn();

    expect(await uploadFile(big, { onProgress, signal: new AbortController().signal }, { ...CHAT, fetchImpl })).toBe('/big.bin');

    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await big.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(sent[0]).toBe('?t=signed&offset=0 4194304');
    expect(sent.slice(1, 3).sort()).toEqual(['?t=signed&offset=4194304 4194304', '?t=signed&offset=8388608 1048576']);
    expect(sent[3]).toBe(`?t=signed&offset=12582912&done=9437184&sha256=${sha256} 0`);
    expect(onProgress).toHaveBeenLastCalledWith(1);
    expect(puts).toHaveLength(0);
  });

  it('tries the next copy name when a Files link from EFS finds the name taken', async () => {
    const links = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { name } = JSON.parse(init?.body as string) as { name: string };
      return Response.json({ url: `https://links.test/?t=${encodeURIComponent(name)}` });
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (new URL(url).searchParams.get('t') === 'plan.txt' && url.includes('done=')
      ? new Response('A file with this name is already in Files', { status: 409 })
      : new Response('ok'))));

    expect(await uploadFile(file, { onProgress: vi.fn(), signal: new AbortController().signal }, { ...CHAT, fetchImpl: links })).toBe('/plan (2).txt');
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
/** A cell's file or folder name, as it shows under the icon (a type icon's label is text too). */
const fileName = (cell: Element) => cell.querySelector('.agent-computer-file-name')?.textContent ?? '';
const names = (host: HTMLElement) => [...host.querySelectorAll('.agent-computer-file')].map(fileName);
// A button's name: an icon chip's label, else its text.
const named = (button: HTMLButtonElement) => button.getAttribute('aria-label') ?? button.textContent;
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll('button'), ...document.querySelectorAll<HTMLButtonElement>('[role=menu] button')].find((candidate) => named(candidate) === label);
  if (button === undefined) throw new Error(`no ${label} button`);
  await act(async () => button.click());
};
/** The open place's name: the location field's current folder, or Recents. */
const folderName = (host: HTMLElement) => host.querySelector('.agent-computer-files-path [aria-current="true"]')?.textContent;
/** A part of the window's buttons by name: the sidebar's places, the grid's items, or the location field's folders. */
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
  describe('while the listing loads', () => {
    /** Holds every Chat Service answer until the returned function lets them through. */
    const hold = () => {
      const answer = globalThis.fetch;
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        await held;
        return answer(input, init);
      });
      return () => act(async () => release());
    };
    const loading = (host: HTMLElement) => host.querySelector('[role="status"][aria-label="Loading Files"]');

    it('shows Files loading, with no listing, until the listing arrives', async () => {
      stored.push(entry('report.csv', 2048, '2026-10-01T12:00:00.000Z'));
      const release = hold();
      const host = await app();

      expect(loading(host)).not.toBeNull();
      expect(host.querySelector('.agent-computer-files-grid')).toBeNull();
      expect(host.querySelector('.agent-computer-files-empty')).toBeNull();

      await release();

      expect(loading(host)).toBeNull();
      expect(names(host)).toEqual(['report.csv']);
    });

    it('shows Files loading until why it could not load arrives', async () => {
      failing = 502;
      const release = hold();
      const host = await app();
      expect(loading(host)).not.toBeNull();

      await release();

      expect(loading(host)).toBeNull();
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused');
    });
  });

  it('keeps a deleted file out of a delayed folder listing', async () => {
    stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
    const host = await app();
    const answer = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holdNextListing = true;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const response = await answer(input, init);
      if (new URL(input).pathname === '/files' && init?.method === 'GET' && holdNextListing) {
        holdNextListing = false;
        await held;
      }
      return response;
    });

    await sidebar.open(host, 'Recents');
    const file = host.querySelector('.agent-computer-file');
    if (file === null) throw new Error('report.csv is missing');
    await act(async () => file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await click(host, 'Delete');
    await click(host, 'Delete');
    expect(names(host)).toEqual([]);
    expect(stored).toEqual([]);

    await act(async () => release());

    expect(names(host)).toEqual([]);
  });

  it('draws a plain document for an extension named after an inherited object property', async () => {
    stored.push(entry('report.constructor', 12, '2026-10-01T12:00:00.000Z'));
    const host = await app();
    const item = host.querySelector('.agent-computer-file');
    expect(item?.getAttribute('data-kind')).toBe('document');
    // Its type's label, and no glyph.
    expect(item?.querySelector('svg text')?.textContent).toBe('constructor');
    expect(item?.querySelector('svg > g[fill]')).toBeNull();
  });

  it('says where files come from while there are none, and lists them when Files opens again', async () => {
    const host = await app();
    expect(host.querySelector('.agent-computer-files-empty')?.textContent).toBe(
      'No files yet. Files the agent downloads appear here within a minute or two.',
    );
    expect(names(host)).toEqual([]);
    expect([...host.querySelectorAll('button')].map(named)).not.toContain('Refresh');
    expect([...host.querySelectorAll('button')].map(named)).not.toContain('Upload');

    stored.push(entry('report.csv', 2048, '2026-10-01T12:00:00.000Z'));
    const again = await app();

    expect(names(again)).toEqual(['report.csv']);
    expect(again.querySelector('.agent-computer-files-empty')).toBeNull();
    expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
  });

  it('reloads the listing as each place opens', async () => {
    stored.push(entry('reports/q3.pdf'));
    const host = await app();

    await grid.open(host, 'reports');
    stored.push(entry('reports/q4.pdf', 1, '2026-10-02T09:00:00.000Z'));
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
    stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
    const host = await app();

    await click(host, 'report.csv');

    expect(assign).toHaveBeenCalledWith('https://s3.test/report.csv');
  });

  it('clears a refused download after an explicit successful retry', async () => {
    stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
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
    stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
    const listed = await app();
    expect(listed.querySelector('[role="alert"]')).toBeNull();
    failing = 502;
    await click(listed, 'report.csv');
    expect(listed.querySelector('[role="alert"]')?.textContent).toBe('refused');
    expect(assign).not.toHaveBeenCalled();
  });

  /** The open folder's items as Finder's icon view draws them: each name, and the kind its icon draws. */
  const items = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('.agent-computer-file')].map((item) => `${fileName(item)} (${item.dataset.kind})`);
  /** A pointer's click on an item, as a mouse or a tap gives it (Enter's click has no pointer behind it). */
  const press = async (host: HTMLElement, label: string, count = 1) => {
    const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => fileName(candidate) === label);
    if (file === undefined) throw new Error(`no ${label} item`);
    await act(async () => {
      for (let detail = 1; detail <= count; detail++) file.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
      if (count === 2) file.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    });
  };
  const selected = (host: HTMLElement) =>
    [...host.querySelectorAll('.agent-computer-file[aria-selected="true"]')].map(fileName);

  // Issue the regression: Files as an icon view, each item a drawn icon with its name under it.
  it("shows the open folder's files and folders as an icon view, in name order, each with its drawn icon", async () => {
    stored.push(
      entry('prices.csv'),
      entry('q3.PDF'),
      entry('model.xlsx'),
      entry('recap.md'),
      entry('curve.png'),
      entry('notes.txt'),
      entry('Makefile'),
      entry('.env'),
      entry('reports/a.txt'),
    );
    const host = await app();

    expect(host.querySelector('.agent-computer-files-grid')?.getAttribute('role')).toBe('listbox');
    expect(host.querySelector('table')).toBeNull();
    expect(items(host)).toEqual([
      '.env (document)', 'curve.png (image)', 'Makefile (document)', 'model.xlsx (document)', 'notes.txt (document)',
      'prices.csv (document)', 'q3.PDF (document)', 'recap.md (document)', 'reports (folder)',
    ]);
    expect([...host.querySelectorAll('.agent-computer-file')].map((item) => item.getAttribute('role'))).toEqual(Array(9).fill('option'));
    // Each icon, or the image's picture once it has loaded, is hidden from the cell's name.
    await vi.waitFor(() => expect(host.querySelector('img')).not.toBeNull());
    await act(async () => host.querySelector('img')?.dispatchEvent(new Event('load')));
    const icons = () => [...host.querySelectorAll('.agent-computer-file > :first-child')];
    await vi.waitFor(() =>
      expect(icons().map((icon) => icon.getAttribute('aria-hidden') ?? icon.getAttribute('alt'))).toEqual(Array(9).fill('true')),
    );
    // Each file's icon is labelled with its type, but a name without an extension's or a dotfile's; the image is its picture.
    expect([...host.querySelectorAll('.agent-computer-file')].map((item) => item.querySelector('svg text')?.textContent ?? null)).toEqual([
      null, null, null, 'xlsx', 'txt', 'csv', 'pdf', 'md', null,
    ]);
  });

  it('selects an item on a click, highlighting it, and opens it on a double-click', async () => {
    stored.push(
      entry('report.csv', 12, '2026-10-01T12:00:00.000Z'),
      entry('reports/q3.pdf', 12, '2026-10-01T12:00:00.000Z'),
    );
    const host = await app();
    expect(selected(host)).toEqual([]);

    await press(host, 'report.csv');
    expect(selected(host)).toEqual(['report.csv']);
    expect(assign).not.toHaveBeenCalled();
    await press(host, 'reports');
    expect(selected(host)).toEqual(['reports']);
    expect(items(host)).toEqual(['report.csv (document)', 'reports (folder)']);

    await press(host, 'report.csv', 2);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('https://s3.test/report.csv');
    await press(host, 'reports', 2);
    expect(items(host)).toEqual(['q3.pdf (document)']);
    expect(folderName(host)).toBe('reports');
  });

  it('opens the folders of the open folder, its items in name order, and goes back up its location field', async () => {
    stored.push(
      entry('reports/summary.csv', 12),
      entry('reports/2026/q3.pdf', 2048, '2026-10-02T09:00:00.000Z'),
      entry('reports/2026/q2.pdf', 1024, '2026-09-01T09:00:00.000Z'),
      entry('reports/2026/drafts/q4.pdf', 512, '2026-09-15T09:00:00.000Z'),
      entry('Notes.txt', 7, '2026-09-30T09:00:00.000Z'),
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
      entry('reports/summary.csv', 12),
      entry('reports/2026/drafts/q4.pdf', 512, '2026-09-15T09:00:00.000Z'),
      entry('Notes.txt', 7, '2026-09-30T09:00:00.000Z'),
    );
    const host = await app();
    expect([back(host)?.disabled, forward(host)?.disabled]).toEqual([true, true]);

    await grid.open(host, 'reports');
    await grid.open(host, '2026');
    await pathBar.open(host, 'workspace');
    expect(folderName(host)).toBe('workspace');

    // Back retraces the location field's jump, not the folder's parent.
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

  it('lists Recents, workspace and its own folders under Places in the sidebar, marking the open place', async () => {
    stored.push(
      entry('reports/2026/q3.pdf'),
      entry('notes/plan.md'),
      entry('rates-recap.md'),
    );
    const host = await app();

    expect(sidebar.names(host)).toEqual(['Recents', 'workspace', 'notes', 'reports']);
    expect(host.querySelector('.agent-computer-files-sidebar p')?.textContent).toBe('Places');
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
      entry('reports/2026/q3.pdf', 1, '2026-10-03T09:00:00.000Z'),
      entry('rates-recap.md', 1, '2026-10-05T09:00:00Z'),
      entry('notes/plan.md', 1, '2026-10-04T09:00:00.000Z'),
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
    const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => fileName(candidate) === 'plan.md');
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

  it('wraps a name to two lines at most at word breaks and before its extension, cutting a longer one in its middle, and names the item in full', async () => {
    stored.push(
      entry('z-quarterly-earnings-model.xlsx'),
      entry('quarterly-forecasts.pdf'),
      entry('quarterlyearningsmodel.xlsx'),
      entry('rates-recap.md'),
      entry('sunrise.png'),
      entry('notes.txt'),
    );
    // Lines of ten 6px characters, 12px high, broken after a space or hyphen and at a `<wbr>` only.
    const words = (html: string) => html.split(/(?<=[ -])|<wbr>/).map((word) => word.length);
    const lines = (text: string) => words(text).reduce<[number, number]>(([count, used], length) => (used > 0 && used + length > 10 ? [count + 1, length] : [count, used + length]), [1, 0])[0];
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(24);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return 12 * lines(this.innerHTML);
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return Math.max(60, 6 * Math.max(...words(this.innerHTML)));
    });
    const host = await app();

    // A name on one line stays whole; one a little wider wraps before its extension, not inside a word; the start of a longer
    // one, or of one word wider than the line, gives way, the last six characters staying whole after one ellipsis.
    expect([...host.querySelectorAll('.agent-computer-file-name')].map((name) => name.innerHTML)).toEqual([
      'notes.txt',
      'quarterly-for…ts.pdf',
      'quarterl…l<wbr>.xlsx',
      'rates-recap.md',
      'sunrise<wbr>.png',
      'z-quarte…l<wbr>.xlsx',
    ]);
    expect([...host.querySelectorAll('.agent-computer-file')].map((item) => [item.getAttribute('aria-label'), item.getAttribute('title')])).toEqual([
      ['notes.txt', 'notes.txt'],
      ['quarterly-forecasts.pdf', 'quarterly-forecasts.pdf'],
      ['quarterlyearningsmodel.xlsx', 'quarterlyearningsmodel.xlsx'],
      ['rates-recap.md', 'rates-recap.md'],
      ['sunrise.png', 'sunrise.png'],
      ['z-quarterly-earnings-model.xlsx', 'z-quarterly-earnings-model.xlsx'],
    ]);
  });

  it('shows a file beside a folder of the same name, and opens the folder', async () => {
    stored.push(
      entry('reports', 3),
      entry('reports/summary.csv', 12, '2026-10-02T09:00:00.000Z'),
    );
    const host = await app();

    expect(items(host)).toEqual(['reports (document)', 'reports (folder)']);
    await act(async () => (host.querySelector('[data-kind="folder"]') as HTMLButtonElement).click());
    expect(items(host)).toEqual(['summary.csv (document)']);
  });

  describe('the status bar', () => {
    const status = (host: HTMLElement) => host.querySelector('[role="status"]')?.textContent;

    it("says what the open place holds, in Thunar's words, leaving a zero part out", async () => {
      stored.push(
        entry('charts/curve-2026.png'),
        entry('reports/q3.pdf'),
        entry('reports/2026/q2.pdf'),
        entry('notes.txt'),
        entry('rates-recap.md', 1, '2026-10-02T09:00:00.000Z'),
      );
      const host = await app();

      expect(status(host)).toBe('2 folders, 2 files');
      await grid.open(host, 'reports');
      expect(status(host)).toBe('1 folder, 1 file');
      await grid.open(host, '2026');
      expect(status(host)).toBe('1 file');
      await sidebar.open(host, 'Recents');
      expect(status(host)).toBe('5 files');
    });

    it('says nothing before the listing comes, nor for an account with no files', async () => {
      let answer!: (response: Response) => void;
      vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { answer = resolve; }));
      const host = await app();
      expect(host.querySelector('.agent-computer-files-status')).toBeNull();

      await act(async () => answer(Response.json({ files: [] })));
      expect(host.querySelector('.agent-computer-files-empty')).not.toBeNull();
      expect(host.querySelector('[role="status"]')).toBeNull();
    });

    it.each([
      [0, '0 bytes'],
      [1, '1 byte'],
      [1023, '1023 bytes'],
      [1024, '1.0 KiB'],
      [1240, '1.2 KiB'],
      [48_210, '47.1 KiB'],
      [3_400_000, '3.2 MiB'],
      [31_890_000_000, '29.7 GiB'],
    ])('gives a selected file of %d bytes as its name and %s, and a selected folder as the counts', async (size, shown) => {
      stored.push(
        { name: 'q3.pdf', size, lastModified: '2026-10-01T09:00:00.000Z' },
        entry('reports/q2.pdf'),
      );
      const host = await app();

      await press(host, 'q3.pdf');
      expect(status(host)).toBe(`“q3.pdf” ${shown}`);
      await press(host, 'reports');
      expect(status(host)).toBe('1 folder, 1 file');
    });
  });

  describe("an image's thumbnail", () => {
    const pictures = (host: HTMLElement) =>
      [...host.querySelectorAll<HTMLElement>('.agent-computer-file')].map((item) => item.querySelector('img')?.getAttribute('src') ?? (item.querySelector('svg') ? 'icon' : null));

    it('shows each image as its own picture, from its download URL, asked for once', async () => {
      stored.push(
        entry('curve.png'),
        entry('spread.JPEG'),
        entry('notes.txt'),
        entry('logo.svg'),
      );
      const host = await app();

      await vi.waitFor(() => expect(pictures(host)).toEqual(['https://s3.test/curve.png', 'https://s3.test/logo.svg', 'icon', 'https://s3.test/spread.JPEG']));
      const image = host.querySelector('img');
      expect([image?.getAttribute('alt'), image?.getAttribute('loading'), image?.getAttribute('draggable')]).toEqual(['', 'lazy', 'false']);
      // A place opened again draws the pictures it already has.
      await sidebar.open(host, 'workspace');
      expect(calls.filter((call) => call.includes('download-url'))).toEqual([
        'GET https://chat.test/files/download-url?name=curve.png',
        'GET https://chat.test/files/download-url?name=logo.svg',
        'GET https://chat.test/files/download-url?name=spread.JPEG',
      ]);
    });

    /** The window alone, an image in it beside a folder, its thumbnail URL as a test answers it. */
    const windowWith = async (thumbnailUrl: (path: string) => Promise<string>) => {
      const host = document.body.appendChild(document.createElement('div'));
      const root = createRoot(host);
      roots.push(root);
      const files: FileEntry[] = [
        entry('curve.png'),
        entry('reports/q3.pdf'),
      ];
      const props = { files, error: null, onDownload: vi.fn(), onDelete: vi.fn(), onRename: vi.fn(() => null), onReload: vi.fn(), thumbnailUrl };
      const render = (error: string | null) => act(async () => root.render(React.createElement(FilesWindow, { ...props, error })));
      await render(null);
      return { host, render };
    };
    const alerts = (host: HTMLElement) => [...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);

    it('keeps its type icon until its picture has loaded, then shows the picture alone', async () => {
      const { host } = await windowWith(async () => 'https://s3.test/curve.png');
      const cell = host.querySelector<HTMLElement>('.agent-computer-file[data-kind="image"]');
      const shows = () => [cell?.querySelector('.file-type-icon') ? 'icon' : null, cell?.querySelector('img:not([data-loading])') ? 'picture' : null].filter(Boolean);
      expect(shows()).toEqual(['icon']);
      expect(cell?.querySelector('img')).toHaveAttribute('data-loading');

      await act(async () => cell?.querySelector('img')?.dispatchEvent(new Event('load')));

      expect(shows()).toEqual(['picture']);
    });

    it('keeps its type icon, and says why, when the URL is refused', async () => {
      const thumbnailUrl = vi.fn(async () => {
        throw new Error('Download failed: 503');
      });
      const { host } = await windowWith(thumbnailUrl);

      expect(thumbnailUrl).toHaveBeenCalledExactlyOnceWith('curve.png');
      expect(pictures(host)).toEqual(['icon', 'icon']);
      expect(alerts(host)).toEqual(['curve.png could not load: Download failed: 503']);
      expect(host.querySelector('[role="alert"]')?.className).toBe('agent-computer-error');
    });

    it('goes back to its type icon, and says why, when the picture fails to load', async () => {
      const { host } = await windowWith(async () => 'https://s3.test/curve.png');
      expect(pictures(host)).toEqual(['https://s3.test/curve.png', 'icon']);

      await act(async () => host.querySelector('img')?.dispatchEvent(new Event('error')));

      expect(pictures(host)).toEqual(['icon', 'icon']);
      expect(alerts(host)).toEqual(['curve.png could not load: the browser could not show it']);
    });

    it("stops saying why once another place opens", async () => {
      const { host } = await windowWith(async () => {
        throw new Error('Download failed: 503');
      });
      expect(alerts(host)).toHaveLength(1);

      await sidebar.open(host, 'reports');

      expect(alerts(host)).toEqual([]);
    });

    it('asks for a picture once as its cell draws again', async () => {
      const thumbnailUrl = vi.fn(async () => 'https://s3.test/curve.png');
      const { host, render } = await windowWith(thumbnailUrl);

      await render('refused');
      await act(async () => (host.querySelector('.agent-computer-file') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));

      expect(thumbnailUrl).toHaveBeenCalledOnce();
      expect(pictures(host)).toEqual(['https://s3.test/curve.png', 'icon']);
    });
  });

  /** Holds the Chat Service's answer to every write (a rename or delete) until the returned function lets it through. */
  const holdWrites = () => {
    const answer = globalThis.fetch;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (init?.method !== 'GET') await held;
      return answer(input, init);
    });
    return () => act(async () => release());
  };

  describe("a file row's menu", () => {
    /** A right-click on a row's name, or a long-press on a phone: both fire `contextmenu`. */
    const menuOn = async (host: HTMLElement, label: string, clientX = 40, clientY = 60) => {
      const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => fileName(candidate) === label);
      if (file === undefined) throw new Error(`no ${label} row`);
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY });
      await act(async () => file.dispatchEvent(event));
      return event;
    };
    const menu = (_host: HTMLElement) => document.querySelector('[role="menu"]');
    const items = (_host: HTMLElement) => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    const sheet = (host: HTMLElement) => host.querySelector('[role="alertdialog"]');
    const key = async (target: Element | null, init: KeyboardEventInit) => {
      if (!(target instanceof HTMLElement)) throw new Error('Keyboard target is missing');
      target.focus();
      await act(async () => userEvent.keyboard(init.shiftKey ? `{Shift>}{${init.key}}{/Shift}` : `{${init.key}}`));
    };

    it('opens on a file row, with Download, Rename and Delete, and on no folder row', async () => {
      stored.push(
        entry('report.csv', 12, '2026-10-01T12:00:00.000Z'),
        entry('reports/q3.pdf', 12, '2026-10-01T12:00:00.000Z'),
      );
      const host = await app();

      expect((await menuOn(host, 'reports')).defaultPrevented).toBe(false);
      expect(menu(host)).toBeNull();
      expect((await menuOn(host, 'report.csv')).defaultPrevented).toBe(true);
      expect(items(host)).toEqual(['Download', 'Rename', 'Delete']);
      expect(selected(host)).toEqual(['report.csv']);
      expect(assign).not.toHaveBeenCalled();
    });

    it('downloads the file as a double-click does', async () => {
      stored.push(entry('reports/q3.pdf', 12, '2026-10-01T12:00:00.000Z'));
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
        entry('reports/q3.pdf', 12, '2026-10-01T12:00:00.000Z'),
        entry('reports/q2.pdf', 12, '2026-10-01T12:00:00.000Z'),
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

    it('takes a deleted file away as the sheet confirms, before the Chat Service answers', async () => {
      stored.push(
        entry('report.csv', 12, '2026-10-01T12:00:00.000Z'),
        entry('notes.txt', 12, '2026-10-01T12:00:00.000Z'),
      );
      const host = await app();
      const release = holdWrites();
      await menuOn(host, 'report.csv');
      await click(host, 'Delete');

      await click(host, 'Delete');

      expect(names(host)).toEqual(['notes.txt']);
      await release();
      expect(names(host)).toEqual(['notes.txt']);
    });

    it('says why when the Chat Service refuses a delete, and keeps the file listed', async () => {
      stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
      const host = await app();
      await menuOn(host, 'report.csv');
      await click(host, 'Delete');
      failing = 404;

      await click(host, 'Delete');

      expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused');
      expect(names(host)).toEqual(['report.csv']);
    });

    it('closes on a tap outside it, and stays open for a tap inside it', async () => {
      stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
      const host = await app();
      await menuOn(host, 'report.csv');

      await act(async () => menu(host)?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(menu(host)).not.toBeNull();
      await act(async () => userEvent.click(host.querySelector('.agent-computer-files-grid') ?? host));
      expect(menu(host)).toBeNull();
    });

    it.each([
      ['the context-menu key', { key: 'ContextMenu' }],
      ['Shift+F10', { key: 'F10', shiftKey: true }],
    ])('opens from %s on a focused file row, moves by arrows, activates on Enter, and closes on Escape', async (_name, open) => {
      stored.push(
        entry('report.csv', 12, '2026-10-01T12:00:00.000Z'),
        entry('reports/q3.pdf', 12, '2026-10-01T12:00:00.000Z'),
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
      stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
      const host = await app();
      await menuOn(host, 'report.csv');

      await key(document.activeElement, { key: 'Tab' });

      expect(menu(host)).toBeNull();
    });

    it.each([
      ['Delete', 'Cancel', false],
      ['Cancel', 'Delete', true],
    ])('keeps %s followed by Tab inside the delete confirmation at %s', async (from, to, shiftKey) => {
      stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
      const host = await app();
      await menuOn(host, 'report.csv');
      await click(host, 'Delete');
      const buttons = [...(sheet(host)?.querySelectorAll('button') ?? [])];
      const start = buttons.find((button) => button.textContent === from);
      if (start === undefined) throw new Error('confirmation button missing');
      start.focus();
      await act(async () => userEvent.tab({ shift: shiftKey }));

      expect(document.activeElement?.textContent).toBe(to);
      expect(sheet(host)?.contains(document.activeElement)).toBe(true);
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
      stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
      const host = await app();
      await menuOn(host, 'report.csv');

      await click(host, 'Delete');
      expect(document.activeElement?.textContent).toBe('Cancel');
      await close(host);

      expect(sheet(host)).toBeNull();
      // A refused Delete takes the row away and brings it back, so focus goes to the file's row as it shows again.
      await vi.waitFor(() => expect(document.activeElement).toBe([...host.querySelectorAll('.agent-computer-file')].find((row) => fileName(row) === 'report.csv')));
    });
  });

  describe('renaming a file in its row', () => {
    const rename = async (host: HTMLElement, label: string) => {
      const file = [...host.querySelectorAll('.agent-computer-file')].find((candidate) => fileName(candidate) === label);
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
        entry('reports/q3.pdf', 12, '2026-10-01T12:00:00.000Z'),
        entry('reports/q2.pdf', 12, '2026-10-01T12:00:00.000Z'),
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

    it('keeps the filename editor open when Enter confirms an IME candidate', async () => {
      const host = await app();
      await click(host, 'reports');
      const input = await rename(host, 'q3.pdf');

      await act(async () => {
        input.value = '四半期.pdf';
        input.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          isComposing: true,
        }));
      });

      expect(renames()).toEqual([]);
      expect(host.querySelector('.agent-computer-file-rename')).toBe(input);
      expect(document.activeElement).toBe(input);
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

    it('shows the new name at once and keeps the file selected, while the Chat Service renames it', async () => {
      const host = await app();
      await click(host, 'reports');
      const answer = globalThis.fetch;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        if (new URL(input).pathname === '/files/rename') await held;
        return answer(input, init);
      });

      await type(await rename(host, 'q3.pdf'), 'q4.pdf', 'Enter');

      expect(names(host)).toEqual(['q2.pdf', 'q4.pdf']);
      expect(selected(host)).toEqual(['q4.pdf']);
      expect(host.querySelector('[role="status"]')?.textContent).toBe('“q4.pdf” 12 bytes');
      await act(async () => release());
      expect(names(host)).toEqual(['q2.pdf', 'q4.pdf']);
      expect(selected(host)).toEqual(['q4.pdf']);
    });

    it('takes a shown rename back when the Chat Service refuses it', async () => {
      const host = await app();
      await click(host, 'reports');
      const input = await rename(host, 'q3.pdf');
      failing = 503;

      await type(input, 'q4.pdf', 'Enter');

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
