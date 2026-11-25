import React, { act } from 'react';
import userEvent from '@testing-library/user-event';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesApp } from './files-app';
import { FilesWindow } from './files-explorer';
import { WindowsDesktop } from './windows-desktop';
import { deleteFile, fileDownloadUrl, listFiles, moveIntoFolder, renameFile, uploadFile, uploadInto, withUploadsSettled, type UploadOptions } from './files-service';

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
    const fetchImpl = vi.fn(async () => Response.json({ url: 'https://links.test/report' }));

    expect(await fileDownloadUrl('notes/plan v2.txt', { ...CHAT, fetchImpl })).toBe('https://links.test/report');
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

const puts: FakeUpload[] = [];
class FakeUpload {
  readonly method = 'PUT';
  readonly headers = { 'content-type': 'application/octet-stream' };
  readonly body: Blob;
  aborted = false;
  private resolve!: (response: Response) => void;
  private reject!: (error: Error) => void;
  readonly response: Promise<Response>;
  constructor(readonly url: string, init: RequestInit) {
    this.body = init.body as Blob;
    this.response = new Promise<Response>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    init.signal?.addEventListener('abort', () => {
      this.aborted = true;
      this.reject(new DOMException('Aborted', 'AbortError'));
    });
    puts.push(this);
  }
  onerror = () => { this.reject(new Error('Upload failed: network error')); };
  respond(status: number) { this.resolve(new Response(null, { status })); }
}

describe('uploading a file the user attached in the chat', () => {
  const file = new File(['buy low'], 'plan.txt', { type: 'text/plain' });
  /** The Chat Service's upload URLs: one for each name, except the names Files already holds. */
  const service = (taken: string[] = []) => vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { name } = JSON.parse(init?.body as string) as { name: string };
    if (taken.includes(name)) return Response.json({ detail: `A file named ${name} is already in Files` }, { status: 409 });
    return Response.json({ url: `https://links.test/?t=${encodeURIComponent(name)}` });
  });
  /** The request's PUT, once the Chat Service has handed over its URL. */
  const put = async () => {
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    return puts[0] as FakeUpload;
  };
  beforeEach(() => {
    puts.length = 0;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.includes('done=')
      ? Promise.resolve(new Response('ok')) : new FakeUpload(url, init).response);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the bytes as a new file to the Chat Service's presigned URL, reporting progress, and resolves to the agent's path", async () => {
    const fetchImpl = service();
    const onProgress = vi.fn();
    const uploading = uploadFile(file, { onProgress, signal: new AbortController().signal }, { ...CHAT, fetchImpl });
    const request = await put();
    request.respond(200);

    expect(await uploading).toBe('/plan.txt');
    expect(fetchImpl).toHaveBeenCalledWith('https://chat.test/files/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"plan.txt"}',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    });
    expect(request).toMatchObject({ method: 'PUT', url: 'https://links.test/?t=plan.txt&offset=0', headers: { 'content-type': 'application/octet-stream' } });
    expect(await request.body.text()).toBe(await file.text());
    expect(onProgress).toHaveBeenLastCalledWith(1);
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
    expect(request.url).toBe(`https://links.test/?t=${encodeURIComponent(stored)}&offset=0`);
    expect(await request.body.text()).toBe(await body.text());
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
    (await put()).onerror();
    await expect(offline).rejects.toThrow('Upload failed: network error');
  });

  it('advances when concurrent uploaders claim the same name at the conditional PUT', async () => {
    const fetchImpl = service();
    const options = { onProgress: vi.fn(), signal: new AbortController().signal };
    const uploading = uploadFile(file, options, { ...CHAT, fetchImpl });
    (await put()).respond(412);
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.url).toBe('https://links.test/?t=plan%20(2).txt&offset=0');
    expect(puts[1]?.headers).toEqual({ 'content-type': 'application/octet-stream' });
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
    const uploadingTab = await import('./files-service');
    vi.resetModules();
    const claimingTab = await import('./files-service');
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

describe('an upload into a folder, and a move into one', () => {
  const file = new File(['buy low'], 'plan.txt', { type: 'text/plain' });
  /** The Chat Service: an upload URL for any name, and a rename that refuses the names Files holds, or refuses outright. */
  const service = (taken: string[] = [], refusal?: string) => {
    const renames: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const body = JSON.parse(init?.body as string) as { name: string; from: string; to: string };
      if (url.pathname === '/files/upload-url') return Response.json({ url: `https://links.test/?t=${encodeURIComponent(body.name)}` });
      renames.push(`${body.from} to ${body.to}`);
      if (refusal !== undefined) return Response.json({ detail: refusal }, { status: 503 });
      if (taken.includes(body.to)) return Response.json({ detail: `A file named ${body.to} is already in Files` }, { status: 409 });
      return Response.json({ name: body.to });
    });
    return { renames, options: { ...CHAT, fetchImpl } };
  };
  const options = () => ({ onProgress: vi.fn(), signal: new AbortController().signal });
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response('ok'));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('leaves an upload to workspace at the top', async () => {
    const { renames, options: chat } = service();

    expect(await uploadInto(file, options(), '', chat)).toBe('plan.txt');
    expect(renames).toEqual([]);
  });

  it('moves an upload into the open folder', async () => {
    const { renames, options: chat } = service();

    expect(await uploadInto(file, options(), 'reports/2026/', chat)).toBe('reports/2026/plan.txt');
    expect(renames).toEqual(['plan.txt to reports/2026/plan.txt']);
  });

  it("moves it in as the next copy name where the folder holds the file's name", async () => {
    const { renames, options: chat } = service(['reports/plan.txt', 'reports/plan (2).txt']);

    expect(await uploadInto(file, options(), 'reports/', chat)).toBe('reports/plan (3).txt');
    expect(renames).toEqual(['plan.txt to reports/plan.txt', 'plan.txt to reports/plan (2).txt', 'plan.txt to reports/plan (3).txt']);
  });

  it('says the upload stayed in workspace when the move is refused', async () => {
    const { options: chat } = service([], 'Files are not configured');

    await expect(uploadInto(file, options(), 'reports/', chat)).rejects.toThrow('“plan.txt” was uploaded to workspace: Files are not configured');
  });

  it("moves a file into another folder under its own name, or a copy name", async () => {
    const { renames, options: chat } = service(['reports/a.md']);

    expect(await moveIntoFolder('notes/a.md', 'reports/', chat)).toBe('reports/a (2).md');
    expect(await moveIntoFolder('notes/b.md', '', chat)).toBe('b.md');
    expect(renames).toEqual(['notes/a.md to reports/a.md', 'notes/a.md to reports/a (2).md', 'notes/b.md to b.md']);
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
      if (stored.some(({ name }) => name === to)) return Response.json({ detail: `A file named ${to} is already in Files` }, { status: 409 });
      calls.push(`renamed ${from} to ${to}`);
      stored = stored.map((file) => (file.name === from ? { ...file, name: to } : file));
      return Response.json({ name: to });
    }
    if (url.pathname === '/files') return Response.json({ files: stored });
    if (url.pathname === '/files/download-url') return Response.json({ url: `https://links.test/${url.searchParams.get('name')}` });
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

type WindowProps = React.ComponentProps<typeof FilesWindow>;
/** The window alone, with the props a test gives, the rest doing nothing. */
async function windowWith(given: Partial<WindowProps>) {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  roots.push(root);
  const props: WindowProps = {
    files: [], error: null, onDownload: vi.fn(), onDelete: vi.fn(), onRename: vi.fn(() => null), onMove: vi.fn(), onReload: vi.fn(),
    onUpload: vi.fn(() => Promise.reject(new Error('The test has no uploads'))), thumbnailUrl: vi.fn(async () => 'https://links.test/chart'),
    ...given,
  };
  await act(async () => root.render(React.createElement(FilesWindow, props)));
  return { host, props };
}

/** Whether an element shows: mounted, and not hidden by its class. */
const shows = (element: Element | null) => element !== null && getComputedStyle(element).display !== 'none';
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.agent-computer-file')];
const nameOf = (row: Element) => row.querySelector('.agent-computer-file-name')?.textContent ?? '';
/** The list's names, while it shows. */
const names = (host: HTMLElement) => (shows(host.querySelector('[role="grid"]')) ? rows(host).map(nameOf) : []);
const rowOf = (host: HTMLElement, name: string) => {
  const row = rows(host).find((candidate) => nameOf(candidate) === name);
  if (row === undefined) throw new Error(`no ${name} row`);
  return row;
};
/** Each row's cells as they read, spaces made plain. */
const cells = (host: HTMLElement) =>
  rows(host).map((row) => [...row.querySelectorAll('[role="gridcell"]')].map((cell) => cell.textContent.replace(/\s/g, ' ')));
const selected = (host: HTMLElement) => rows(host).filter((row) => row.getAttribute('aria-selected') === 'true').map(nameOf);
/** A pointer's click on a row, or two and a double-click. */
const press = async (host: HTMLElement, name: string, count = 1) => {
  const row = rowOf(host, name);
  await act(async () => {
    for (let detail = 1; detail <= count; detail++) row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    if (count === 2) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  });
};
const key = async (target: Element | null, keys: string) => {
  if (!(target instanceof HTMLElement)) throw new Error('Keyboard target is missing');
  target.focus();
  await act(async () => userEvent.keyboard(keys));
};
/** A button by its label, or its text, anywhere in the page: popups draw outside the window. */
const buttonIn = (scope: ParentNode, label: string) => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === label);
  if (button === undefined) throw new Error(`no ${label} button`);
  return button;
};
const command = (label: string) => buttonIn(document.querySelector('[role="toolbar"][aria-label="Commands"]') ?? document, label);
const address = (label: string) => buttonIn(document, label);
const clickOn = async (element: HTMLElement) => act(async () => element.click());
const menu = () => document.querySelector('[role="menu"]');
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
const menuItem = async (label: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label);
  if (item === undefined) throw new Error(`no ${label} menu item`);
  await clickOn(item);
};
const contextMenu = async (host: HTMLElement, name: string) => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  await act(async () => rowOf(host, name).dispatchEvent(event));
  return event;
};
const dialog = () => document.querySelector('[role="alertdialog"]');
/** A moment inside act: Fluent's motion and Tabster's focus moves end on timers. */
const settled = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
/** Moments, one after another, until `done` or `turns` of them. */
const settledUntil = async (done: () => boolean, turns: number): Promise<void> => {
  if (turns === 0 || done()) return;
  await settled();
  await settledUntil(done, turns - 1);
};
/** The dialog's close motion, over. */
const gone = async () => {
  await settledUntil(() => dialog() === null, 100);
  expect(dialog()).toBeNull();
};
const dialogButton = (label: string) => {
  const sheet = dialog();
  if (sheet === null) throw new Error('no dialog');
  return buttonIn(sheet, label);
};
const alertText = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent;
const status = (host: HTMLElement) => [...(host.querySelector('[role="status"]')?.children ?? [])].map((part) => part.textContent).filter(Boolean);
/** The navigation tree's items, each by its own name. */
const treeItems = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const treeName = (item: Element) => item.querySelector('.fui-TreeItemLayout__main')?.textContent;
const tree = {
  names: (host: HTMLElement) => treeItems(host).map(treeName),
  current: (host: HTMLElement) => treeItems(host).filter((item) => item.getAttribute('aria-current') === 'true').map(treeName),
  open: async (host: HTMLElement, name: string) => {
    const layout = treeItems(host).find((item) => treeName(item) === name)?.querySelector<HTMLElement>('.fui-TreeItemLayout');
    if (layout === undefined || layout === null) throw new Error(`no ${name} in the tree`);
    await clickOn(layout);
  },
  expand: async (host: HTMLElement, name: string) => {
    const chevron = treeItems(host).find((item) => treeName(item) === name)?.querySelector<HTMLElement>('.fui-TreeItemLayout__expandIcon');
    if (chevron === undefined || chevron === null) throw new Error(`no ${name} chevron in the tree`);
    await clickOn(chevron);
  },
};
const path = {
  names: (host: HTMLElement) => [...host.querySelectorAll('[aria-label="Path"] button')].map((button) => button.textContent),
  current: (host: HTMLElement) => host.querySelector('[aria-label="Path"] [aria-current="page"]')?.textContent,
  open: async (host: HTMLElement, name: string) => clickOn(buttonIn(host.querySelector('[aria-label="Path"]') ?? host, name)),
};
const search = async (host: HTMLElement, text: string) => {
  const box = host.querySelector<HTMLInputElement>('input[aria-label="Search"]');
  if (box === null) throw new Error('no search box');
  await act(async () => {
    box.focus();
    await userEvent.clear(box);
    if (text !== '') await userEvent.type(box, text);
  });
};

describe('FilesApp', () => {
  // Tabster, which moves focus in Fluent's menus and dialogs, finds nothing to focus in a page whose body has no size,
  // as a page with no layout has.
  beforeEach(() => {
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 1280, height: 720 }));
  });

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
    const loading = (host: HTMLElement) => shows(host.querySelector('[role="progressbar"]'));

    it('shows a spinner, with no listing, until the listing arrives', async () => {
      stored.push(entry('report.csv', 2048, '2026-10-01T12:00:00.000Z'));
      const release = hold();
      const host = await app();

      expect(loading(host)).toBe(true);
      expect(host.querySelector('[role="progressbar"]')?.textContent).toBe('Loading');
      expect(names(host)).toEqual([]);
      expect(shows(host.querySelector('.agent-computer-files-empty'))).toBe(false);
      expect(status(host)).toEqual([]);

      await release();

      expect(loading(host)).toBe(false);
      expect(names(host)).toEqual(['report.csv']);
    });

    it('shows the spinner until why it could not load arrives', async () => {
      failing = 502;
      const release = hold();
      const host = await app();
      expect(loading(host)).toBe(true);

      await release();

      expect(loading(host)).toBe(false);
      expect(alertText(host)).toBe('refused');
    });
  });

  it('says where files come from while there are none, and lists them when Files opens again', async () => {
    const host = await app();
    expect(shows(host.querySelector('.agent-computer-files-empty'))).toBe(true);
    expect(host.querySelector('.agent-computer-files-empty')?.textContent.trim()).toBe('No files yet. Files the agent downloads appear here within a minute or two.');
    expect(names(host)).toEqual([]);
    expect(status(host)).toEqual(['0 items']);

    stored.push(entry('report.csv', 2048, '2026-10-01T12:00:00.000Z'));
    const again = await app();

    expect(names(again)).toEqual(['report.csv']);
    expect(shows(again.querySelector('.agent-computer-files-empty'))).toBe(false);
    expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
  });

  it('says why when the Chat Service refuses, and stops once a download goes through', async () => {
    failing = 503;
    const host = await app();
    expect(alertText(host)).toBe('refused');

    failing = null;
    stored.push(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
    const listed = await app();
    expect(alertText(listed)).toBeUndefined();
    failing = 502;
    await press(listed, 'report.csv', 2);
    expect(alertText(listed)).toBe('refused');
    expect(assign).not.toHaveBeenCalled();

    failing = null;
    await press(listed, 'report.csv', 2);
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://links.test/report.csv');
    expect(alertText(listed)).toBeUndefined();
  });

  it('loads the Files of the Chat Service it is pointed at', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(FilesApp, CHAT)));

    await act(async () => root.render(React.createElement(FilesApp, { chatServiceUrl: 'https://other.test' })));

    expect(calls).toEqual(['GET https://chat.test/files', 'GET https://other.test/files']);
  });

  it("lists the open folder in details view: folders first, then files, each by name, with Explorer's date, type and size", async () => {
    stored.push(
      entry('prices.csv', 3_276_800, '2026-10-02T15:30:00.000Z'),
      entry('curve.png', 1),
      entry('Makefile', 0),
      entry('.env', 1024),
      entry('reports/a.txt', 1, '2026-09-01T09:00:00.000Z'),
      entry('reports/2026/b.txt', 1, '2026-10-03T08:05:00.000Z'),
      entry('charts/c.plotly.json', 1),
    );
    const host = await app();

    expect([...host.querySelectorAll('[role="columnheader"]')].map((header) => header.textContent)).toEqual(['Name', 'Date modified', 'Type', 'Size']);
    expect(cells(host)).toEqual([
      ['charts', '10/1/26, 9:00 AM', 'File folder', ''],
      ['reports', '10/3/26, 8:05 AM', 'File folder', ''],
      ['.env', '10/1/26, 9:00 AM', 'File', '1 KB'],
      ['curve.png', '10/1/26, 9:00 AM', 'PNG File', '1 KB'],
      ['Makefile', '10/1/26, 9:00 AM', 'File', '0 KB'],
      ['prices.csv', '10/2/26, 3:30 PM', 'CSV File', '3,200 KB'],
    ]);
    expect(rows(host).map((row) => [row.dataset.filePath, row.dataset.kind])).toEqual([
      ['charts/', 'folder'], ['reports/', 'folder'], ['.env', 'document'], ['curve.png', 'image'], ['Makefile', 'document'], ['prices.csv', 'document'],
    ]);
    expect(status(host)).toEqual(['6 items']);
  });

  it('sorts by the column whose header is clicked, and the other way on a second click', async () => {
    stored.push(entry('b.txt', 5000), entry('a.md', 9000), entry('c.png', 10), entry('docs/x.txt'));
    const host = await app();
    const header = (name: string) => {
      const cell = [...host.querySelectorAll<HTMLElement>('[role="columnheader"]')].find((candidate) => candidate.textContent === name);
      return cell?.querySelector('button') ?? cell;
    };

    await act(async () => header('Size')?.click());
    expect(names(host)).toEqual(['docs', 'c.png', 'b.txt', 'a.md']);
    await act(async () => header('Size')?.click());
    expect(names(host)).toEqual(['a.md', 'b.txt', 'c.png', 'docs']);
    await act(async () => header('Type')?.click());
    expect(names(host)).toEqual(['docs', 'a.md', 'c.png', 'b.txt']);
  });

  it('draws a plain document for an extension named after an inherited object property', async () => {
    stored.push(entry('report.constructor', 12, '2026-10-01T12:00:00.000Z'));
    const host = await app();

    expect(rowOf(host, 'report.constructor').dataset.kind).toBe('document');
    expect(cells(host)[0]?.[2]).toBe('CONSTRUCTOR File');
  });

  it('selects a row on a click, and opens it on a double-click or Enter', async () => {
    stored.push(entry('report.csv', 2048), entry('reports/q3.pdf'));
    const host = await app();
    expect(selected(host)).toEqual([]);

    await press(host, 'report.csv');
    expect(selected(host)).toEqual(['report.csv']);
    expect(status(host)).toEqual(['2 items', '1 item selected', '2 KB']);
    await press(host, 'report.csv');
    expect(selected(host)).toEqual(['report.csv']);
    expect(assign).not.toHaveBeenCalled();
    await press(host, 'reports');
    expect(status(host)).toEqual(['2 items', '1 item selected']);

    await press(host, 'report.csv', 2);
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://links.test/report.csv');
    await key(rowOf(host, 'reports'), '{Enter}');
    expect(names(host)).toEqual(['q3.pdf']);
    expect(path.current(host)).toBe('reports');
  });

  it('shows a file beside a folder of the same name, and opens the folder', async () => {
    stored.push(entry('reports', 3), entry('reports/summary.csv', 12, '2026-10-02T09:00:00.000Z'));
    const host = await app();

    expect(rows(host).map((row) => [nameOf(row), row.dataset.kind])).toEqual([['reports', 'folder'], ['reports', 'document']]);
    await key(host.querySelector('[data-kind="folder"]'), '{Enter}');
    expect(names(host)).toEqual(['summary.csv']);
  });

  it('opens folders in place, its path running from workspace, each crumb opening its folder', async () => {
    stored.push(
      entry('reports/summary.csv'),
      entry('reports/2026/q3.pdf'),
      entry('reports/2026/q2.pdf'),
      entry('reports/2026/drafts/q4.pdf'),
      entry('Notes.txt'),
    );
    const host = await app();
    expect(path.names(host)).toEqual(['workspace']);
    expect(path.current(host)).toBe('workspace');

    await press(host, 'reports', 2);
    await press(host, '2026', 2);
    await press(host, 'drafts', 2);
    expect(names(host)).toEqual(['q4.pdf']);
    expect(path.names(host)).toEqual(['workspace', 'reports', '2026', 'drafts']);
    expect(path.current(host)).toBe('drafts');

    await press(host, 'q4.pdf', 2);
    expect(assign).toHaveBeenCalledWith('https://links.test/reports/2026/drafts/q4.pdf');

    await path.open(host, '2026');
    expect(names(host)).toEqual(['drafts', 'q2.pdf', 'q3.pdf']);
    await path.open(host, 'workspace');
    expect(names(host)).toEqual(['reports', 'Notes.txt']);
  });

  it('goes Back, Forward and Up through the places it opened', async () => {
    stored.push(entry('reports/summary.csv'), entry('reports/2026/drafts/q4.pdf'), entry('Notes.txt'));
    const host = await app();
    expect([address('Back').disabled, address('Forward').disabled, address('Up').disabled]).toEqual([true, true, true]);

    await press(host, 'reports', 2);
    await press(host, '2026', 2);
    await path.open(host, 'workspace');
    // Back retraces the path's jump, not the folder's parent.
    await clickOn(address('Back'));
    expect(path.current(host)).toBe('2026');
    await clickOn(address('Up'));
    expect(path.current(host)).toBe('reports');
    expect(names(host)).toEqual(['2026', 'summary.csv']);
    await clickOn(address('Back'));
    expect(path.current(host)).toBe('2026');
    expect(address('Forward').disabled).toBe(false);
    await clickOn(address('Forward'));
    expect(path.current(host)).toBe('reports');
    expect(address('Forward').disabled).toBe(true);

    // A place opened after going Back drops what Forward held.
    await clickOn(address('Back'));
    await tree.open(host, 'Home');
    expect(address('Forward').disabled).toBe(true);
    expect(address('Up').disabled).toBe(true);
    await clickOn(address('Back'));
    expect(path.current(host)).toBe('2026');
  });

  it('reloads the listing as each place opens, and on Refresh', async () => {
    stored.push(entry('reports/q3.pdf'));
    const host = await app();

    await press(host, 'reports', 2);
    stored.push(entry('reports/q4.pdf', 1, '2026-10-02T09:00:00.000Z'));
    await clickOn(address('Refresh'));
    expect(names(host)).toEqual(['q3.pdf', 'q4.pdf']);
    await clickOn(address('Back'));
    await tree.open(host, 'Home');

    expect(calls).toEqual(Array(5).fill('GET https://chat.test/files'));
  });

  it("lists Home and workspace's folders to any depth in the navigation pane, marking the open place", async () => {
    stored.push(entry('reports/2026/q3.pdf'), entry('notes/plan.md'), entry('rates-recap.md'));
    const host = await app();

    expect(host.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe('Navigation');
    expect(tree.names(host)).toEqual(['Home', 'workspace', 'notes', 'reports']);
    expect(tree.current(host)).toEqual(['workspace']);

    // A click opens a folder; its chevron shows the folders inside it.
    await tree.open(host, 'reports');
    expect(tree.current(host)).toEqual(['reports']);
    expect(names(host)).toEqual(['2026']);
    expect(tree.names(host)).toEqual(['Home', 'workspace', 'notes', 'reports']);
    await tree.expand(host, 'reports');
    expect(tree.names(host)).toEqual(['Home', 'workspace', 'notes', 'reports', '2026']);
    await tree.open(host, '2026');
    expect(tree.current(host)).toEqual(['2026']);
    expect(path.names(host)).toEqual(['workspace', 'reports', '2026']);
  });

  it('starts the path with the place’s icon and Places, a menu of Home, workspace and its top folders', async () => {
    stored.push(entry('reports/2026/q3.pdf', 1, '2026-10-03T09:00:00.000Z'), entry('notes/plan.md', 1, '2026-10-04T09:00:00.000Z'), entry('Notes.txt'));
    const host = await app();
    const start = () => [...(host.querySelector('[aria-label="Path"]')?.parentElement?.children ?? [])]
      .map((part) => [part.tagName.toLowerCase(), part.getAttribute('aria-label'), part.getAttribute('color')].filter(Boolean).join(' '));
    expect(start()).toEqual(['svg #f8c246', 'button Places', 'nav Path']);

    await clickOn(address('Places'));
    expect(menuItems()).toEqual(['Home', 'workspace', 'notes', 'reports']);
    await menuItem('reports');
    expect(path.names(host)).toEqual(['workspace', 'reports']);
    expect(names(host)).toEqual(['2026']);

    await clickOn(address('Places'));
    await menuItem('Home');
    expect(path.names(host)).toEqual(['Home']);
    expect(tree.current(host)).toEqual(['Home']);
    expect(names(host)).toEqual(['plan.md', 'q3.pdf', 'Notes.txt']);
    expect(start()).toEqual(['svg', 'button Places', 'nav Path']);
  });

  it('keeps each folder’s name in the navigation pane to one line, its full name as its title', async () => {
    const long = 'a folder whose name runs far past the width of the navigation pane';
    stored.push(entry(`${long}/notes.txt`));
    const host = await app();

    const layout = treeItems(host).find((item) => treeName(item) === long)?.querySelector('.fui-TreeItemLayout');
    expect(layout?.getAttribute('title')).toBe(long);
    const main = layout?.querySelector('.fui-TreeItemLayout__main');
    expect(main === null || main === undefined ? null : getComputedStyle(main).whiteSpace).toBe('nowrap');
  });

  it('shows Search as a button in a narrow window, which swaps the path for the search box until Escape', async () => {
    stored.push(entry('rates.csv'), entry('notes.txt'));
    const host = await app();
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Search"]');
    const toggle = buttonIn(host, 'Search');
    // jsdom has no container queries: the button is for narrow windows only, so it never shows here.
    expect(shows(toggle)).toBe(false);

    await clickOn(toggle);
    expect(document.activeElement).toBe(box);
    await act(async () => userEvent.type(box ?? host, 'rates'));
    expect(names(host)).toEqual(['rates.csv']);

    await key(box, '{Escape}');
    expect(document.activeElement).toBe(toggle);
  });

  it('lists Home as the newest files in every folder, newest first, twenty at most', async () => {
    stored.push(
      entry('reports/2026/q3.pdf', 1, '2026-10-03T09:00:00.000Z'),
      entry('rates-recap.md', 1, '2026-10-05T09:00:00Z'),
      entry('notes/plan.md', 1, '2026-10-04T09:00:00.000Z'),
      ...Array.from({ length: 20 }, (_, index) => entry(`old/${index}.txt`, 1, `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`)),
    );
    const host = await app();

    await tree.open(host, 'Home');

    expect(tree.current(host)).toEqual(['Home']);
    expect(path.names(host)).toEqual(['Home']);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Search"]')?.placeholder).toBe('Search Home');
    expect(names(host)).toEqual(['rates-recap.md', 'plan.md', 'q3.pdf', ...Array.from({ length: 17 }, (_, index) => `${19 - index}.txt`)]);
    expect(status(host)).toEqual(['20 items']);

    // A recent file opens, and renames in, its own folder.
    await press(host, 'q3.pdf', 2);
    expect(assign).toHaveBeenCalledWith('https://links.test/reports/2026/q3.pdf');
    await contextMenu(host, 'plan.md');
    await menuItem('Rename');
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Rename plan.md"]');
      if (input === null) throw new Error('no name field');
      input.value = 'plan v2.md';
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
    });
    expect(calls).toContain('renamed notes/plan.md to notes/plan v2.md');
  });

  it("filters the open place by name, whatever the case, until another place opens", async () => {
    stored.push(entry('Rates-recap.md'), entry('rates.csv'), entry('notes.txt'), entry('reports/rates-2026.pdf'));
    const host = await app();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Search"]')?.placeholder).toBe('Search workspace');

    await search(host, 'RATES');
    expect(names(host)).toEqual(['Rates-recap.md', 'rates.csv']);
    expect(status(host)).toEqual(['2 items']);

    await tree.open(host, 'reports');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Search"]')?.value).toBe('');
    expect(names(host)).toEqual(['rates-2026.pdf']);
  });

  it('opens a chart in the list’s place, and brings the list back on Close', async () => {
    const { host, props } = await windowWith({ files: [entry('curve.plotly.json'), entry('notes.txt')] });
    vi.stubGlobal('fetch', async () => new Response('{"data":[]}'));

    await press(host, 'curve.plotly.json', 2);

    expect(host.querySelector('.agent-computer-files-chart')?.getAttribute('aria-label')).toBe('curve.plotly.json');
    expect(names(host)).toEqual([]);
    expect(props.onDownload).not.toHaveBeenCalled();
    await clickOn(buttonIn(host.querySelector('.agent-computer-files-chart') ?? host, 'Close'));
    expect(names(host)).toEqual(['curve.plotly.json', 'notes.txt']);
  });

  describe('the command bar', () => {
    it("acts on the selected file, and is off for nothing selected or a folder", async () => {
      const { host, props } = await windowWith({ files: [entry('report.csv'), entry('reports/q3.pdf')] });
      const off = () => ['Cut', 'Download', 'Rename', 'Delete'].map((label) => command(label).disabled);
      expect(off()).toEqual([true, true, true, true]);
      await press(host, 'reports');
      expect(off()).toEqual([true, true, true, true]);

      await press(host, 'report.csv');
      expect(off()).toEqual([false, false, false, false]);
      await clickOn(command('Download'));
      expect(props.onDownload).toHaveBeenCalledExactlyOnceWith('report.csv');
      await clickOn(command('Rename'));
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Rename report.csv');
    });
    it('labels only New; the other commands are icons, each named by its tooltip, with See more only for what does not fit', async () => {
      await windowWith({ files: [entry('report.csv')] });
      const bar = document.querySelector('[role="toolbar"][aria-label="Commands"]');
      expect(command('New').textContent).toBe('New');
      expect(['Cut', 'Paste', 'Download', 'Rename', 'Delete'].map((label) => [command(label).getAttribute('aria-label'), command(label).textContent])).toEqual(
        ['Cut', 'Paste', 'Download', 'Rename', 'Delete'].map((label) => [label, '']),
      );
      // A page with no layout has nothing overflowing, so See more stays hidden.
      expect(bar?.lastElementChild?.getAttribute('aria-label')).toBe('See more');
      expect(shows(command('See more'))).toBe(false);

      await act(async () => userEvent.hover(command('Download')));
      await settledUntil(() => document.querySelector('[role="tooltip"]') !== null, 50);
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Download');
    });
  });

  describe("a row's menu", () => {
    it('opens on a right-click with Open, Cut, Download, Rename and Delete, selecting the row; a folder has Open alone', async () => {
      stored.push(entry('report.csv'), entry('reports/q3.pdf'));
      const host = await app();

      expect((await contextMenu(host, 'report.csv')).defaultPrevented).toBe(true);
      expect(menuItems()).toEqual(['Open', 'Cut', 'Download', 'Rename', 'Delete']);
      expect(selected(host)).toEqual(['report.csv']);
      expect(assign).not.toHaveBeenCalled();
      await act(async () => userEvent.keyboard('{Escape}'));
      expect(menu()).toBeNull();

      await contextMenu(host, 'reports');
      expect(menuItems()).toEqual(['Open']);
      await menuItem('Open');
      expect(names(host)).toEqual(['q3.pdf']);
    });

    it('downloads the file', async () => {
      stored.push(entry('reports/q3.pdf'));
      const host = await app();
      await press(host, 'reports', 2);

      await contextMenu(host, 'q3.pdf');
      await menuItem('Download');

      expect(menu()).toBeNull();
      expect(assign).toHaveBeenCalledWith('https://links.test/reports/q3.pdf');
    });

    it('opens from the context-menu key on a focused row, its first item focused, and gives focus back on Escape', async () => {
      stored.push(entry('report.csv'));
      const host = await app();
      const row = rowOf(host, 'report.csv');
      row.focus();

      // The browser sends the row a contextmenu event for the context-menu key and Shift+F10.
      await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      expect(document.activeElement?.textContent).toBe('Open');
      await act(async () => userEvent.keyboard('{Escape}'));

      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(row);
    });
  });

  describe('deleting a file', () => {
    it('deletes once the dialog confirms, then lists Files again; Cancel deletes nothing', async () => {
      stored.push(entry('reports/q3.pdf'), entry('reports/q2.pdf'));
      const host = await app();
      await press(host, 'reports', 2);

      await contextMenu(host, 'q3.pdf');
      await menuItem('Delete');
      expect(dialog()?.textContent).toContain('Delete file');
      expect(dialog()?.textContent).toContain("Delete “q3.pdf”? This can't be undone.");
      await clickOn(dialogButton('Cancel'));
      await gone();
      expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);

      await press(host, 'q3.pdf');
      await clickOn(command('Delete'));
      await clickOn(dialogButton('Delete'));
      await gone();

      expect(names(host)).toEqual(['q2.pdf']);
      expect(calls.slice(2)).toEqual(['DELETE https://chat.test/files?name=reports%2Fq3.pdf', 'GET https://chat.test/files']);
    });

    it("opens its dialog on the window's theme alone, not on a copy of the window that whites out the page", async () => {
      stored.push(entry('notes.txt'));
      // Files in its window on the desktop, as the Agent Computer draws it.
      const host = document.body.appendChild(document.createElement('div'));
      const root = createRoot(host);
      roots.push(root);
      const windows = [{ app: 'Files' as const, title: 'Files', children: React.createElement(FilesApp, CHAT) }];
      await act(async () => root.render(React.createElement(WindowsDesktop, { windows, front: 'Files', interactive: true, onFront: vi.fn() })));

      await press(host, 'notes.txt');
      await clickOn(command('Delete'));
      const surface = dialog();
      if (surface === null) throw new Error('no dialog');
      // Fluent's Portal mounts the dialog on a node of its own under the body, with the classes of the providers above it.
      let mount: Element = surface;
      while (mount.parentElement !== null && mount.parentElement !== document.body) mount = mount.parentElement;
      const provider = (element: Element | null | undefined) => element != null && [...element.classList].some((name) => name.startsWith('fui-FluentProvider'));

      expect(mount).not.toBe(host);
      expect(provider(mount)).toBe(true);
      expect(mount.classList.contains('agent-computer-windows-window')).toBe(false);
      // The shield styles.css scopes Fluent's parts by reaches the dialog too.
      expect(mount.classList.contains('agent-computer-fluent')).toBe(true);
      // Nor the desktop's place or the window's size: either made it a full layer over the page. Fluent's own mount node
      // sits at the top, as wide as the page and with no height.
      const place = getComputedStyle(mount);
      expect([place.bottom, place.height]).toEqual(['', '']);
      // The window is the div inside its provider; the provider draws no box of its own.
      const frame = host.querySelector('.agent-computer-windows-window');
      expect(provider(frame?.parentElement)).toBe(true);
      expect(frame?.parentElement?.classList.contains('agent-computer-windows-window')).toBe(false);
      expect((frame?.parentElement as HTMLElement | null)?.style.display).toBe('contents');
    });

    it('takes a deleted file away at once, and keeps it out of a listing that answers late', async () => {
      stored.push(entry('report.csv'), entry('notes.txt'));
      const host = await app();
      const answer = globalThis.fetch;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const response = await answer(input, init);
        if (init?.method === 'DELETE') await held;
        return response;
      });

      await contextMenu(host, 'report.csv');
      await menuItem('Delete');
      await clickOn(dialogButton('Delete'));
      await gone();
      expect(names(host)).toEqual(['notes.txt']);

      await act(async () => release());
      expect(names(host)).toEqual(['notes.txt']);
    });

    it("says why a delete was refused, shows the file again, and gives its row focus", async () => {
      stored.push(entry('report.csv'));
      const host = await app();
      await contextMenu(host, 'report.csv');
      await menuItem('Delete');
      expect(document.activeElement?.textContent).toBe('Cancel');
      failing = 404;

      await clickOn(dialogButton('Delete'));
      await gone();

      expect(alertText(host)).toBe('refused');
      expect(names(host)).toEqual(['report.csv']);
      expect(document.activeElement).toBe(rowOf(host, 'report.csv'));
    });

    it('gives focus back to the command that opened the dialog once Cancel closes it from the keyboard', async () => {
      stored.push(entry('report.csv'));
      const host = await app();
      await press(host, 'report.csv');
      await key(command('Delete'), '{Enter}');
      expect(document.activeElement?.textContent).toBe('Cancel');

      await key(dialogButton('Cancel'), '{Enter}');
      await gone();

      await settled();
      expect(document.activeElement).toBe(command('Delete'));
    });
  });

  describe('renaming a file in its row', () => {
    const rename = async (host: HTMLElement, name: string) => {
      await contextMenu(host, name);
      await menuItem('Rename');
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="Rename ${name}"]`);
      if (input === null) throw new Error('no name field');
      return input;
    };
    const type = async (input: HTMLInputElement, name: string, pressed?: string) =>
      act(async () => {
        input.value = name;
        if (pressed) input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: pressed }));
      });
    const field = (host: HTMLElement) => host.querySelector('input[aria-label^="Rename "]');
    const renames = () => calls.filter((call) => call.startsWith('renamed'));

    beforeEach(() => {
      stored.push(entry('reports/q3.pdf', 12), entry('reports/q2.pdf', 12));
    });

    it('edits the name in place with its stem selected, and commits once on Enter, then lists Files again', async () => {
      const host = await app();
      await press(host, 'reports', 2);
      const input = await rename(host, 'q3.pdf');

      expect(document.activeElement).toBe(input);
      expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['q3.pdf', 0, 2]);
      // The field blurs as Enter's commit removes it: one rename, not two.
      await act(async () => {
        input.value = 'q3 final.pdf';
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });

      expect(calls.slice(2)).toEqual(['POST https://chat.test/files/rename', 'renamed reports/q3.pdf to reports/q3 final.pdf', 'GET https://chat.test/files']);
      expect(field(host)).toBeNull();
      expect(names(host)).toEqual(['q2.pdf', 'q3 final.pdf']);
    });

    it('keeps the field open when Enter confirms an IME candidate', async () => {
      const host = await app();
      await press(host, 'reports', 2);
      const input = await rename(host, 'q3.pdf');

      await act(async () => {
        input.value = '四半期.pdf';
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true }));
      });

      expect(renames()).toEqual([]);
      expect(field(host)).toBe(input);
    });

    it('commits on blur', async () => {
      const host = await app();
      await press(host, 'reports', 2);
      const input = await rename(host, 'q3.pdf');

      await type(input, 'q4.pdf');
      await act(async () => input.blur());

      expect(renames()).toEqual(['renamed reports/q3.pdf to reports/q4.pdf']);
      expect(names(host)).toEqual(['q2.pdf', 'q4.pdf']);
    });

    it('cancels on Escape, and commits nothing for an unchanged name', async () => {
      const host = await app();
      await press(host, 'reports', 2);

      const input = await rename(host, 'q3.pdf');
      await type(input, 'q4.pdf', 'Escape');
      await act(async () => input.blur());
      expect(field(host)).toBeNull();
      expect(names(host)).toEqual(['q2.pdf', 'q3.pdf']);

      await type(await rename(host, 'q3.pdf'), 'q3.pdf', 'Enter');
      expect(field(host)).toBeNull();
      expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
    });

    it('refuses a typed `/` without calling the Chat Service, and says why', async () => {
      const host = await app();
      await press(host, 'reports', 2);

      await type(await rename(host, 'q3.pdf'), 'drafts/q3.pdf', 'Enter');

      expect(alertText(host)).toBe('A file name can’t contain “/”.');
      expect(calls).toEqual(['GET https://chat.test/files', 'GET https://chat.test/files']);
    });

    it('shows the new name at once and keeps the file selected, and takes it back when the Chat Service refuses', async () => {
      const host = await app();
      await press(host, 'reports', 2);
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
      failing = 409;
      await act(async () => release());

      expect(alertText(host)).toBe('refused');
      expect(names(host)).toEqual(['q2.pdf', 'q3.pdf']);
    });

    it("keeps the row's own shortcuts out of the field: a double-click edits, the context-menu key types", async () => {
      const host = await app();
      await press(host, 'reports', 2);
      const input = await rename(host, 'q3.pdf');

      await act(async () => {
        input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
        input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });

      expect(assign).not.toHaveBeenCalled();
      expect(menu()).toBeNull();
      expect(field(host)).toBe(input);
      expect(document.activeElement).toBe(input);
    });
  });

  describe('cutting and pasting a file', () => {
    beforeEach(() => {
      stored.push(entry('notes/a.md'), entry('reports/b.pdf'), entry('top.txt'));
    });

    it('moves a cut file into the folder it is pasted in, and lists Files again', async () => {
      const host = await app();
      expect(command('Paste').disabled).toBe(true);
      await tree.open(host, 'notes');
      await contextMenu(host, 'a.md');
      await menuItem('Cut');
      expect(command('Paste').disabled).toBe(false);

      await tree.open(host, 'reports');
      await clickOn(command('Paste'));

      expect(calls).toContain('renamed notes/a.md to reports/a.md');
      expect(names(host)).toEqual(['a.md', 'b.pdf']);
      expect(command('Paste').disabled).toBe(true);
    });

    it('pastes a name the folder holds as its next copy name', async () => {
      stored.push(entry('reports/a.md'));
      const host = await app();
      await tree.open(host, 'notes');
      await press(host, 'a.md');
      await clickOn(command('Cut'));
      await tree.open(host, 'reports');

      await clickOn(command('Paste'));

      expect(calls).toContain('renamed notes/a.md to reports/a (2).md');
    });

    it('cuts on Ctrl+X and pastes on Ctrl+V, and Escape forgets the cut', async () => {
      const host = await app();
      await press(host, 'top.txt');
      await key(rowOf(host, 'top.txt'), '{Control>}x{/Control}');
      await key(rowOf(host, 'top.txt'), '{Escape}');
      expect(command('Paste').disabled).toBe(true);

      await key(rowOf(host, 'top.txt'), '{Meta>}x{/Meta}');
      await key(rowOf(host, 'top.txt'), '{Enter}');
      await tree.open(host, 'reports');
      await key(rowOf(host, 'b.pdf'), '{Control>}v{/Control}');

      expect(calls).toContain('renamed top.txt to reports/top.txt');
    });

    it('does nothing for a paste into the folder the file is in, nor in Home', async () => {
      const host = await app();
      await press(host, 'top.txt');
      await clickOn(command('Cut'));
      await tree.open(host, 'Home');
      expect(command('Paste').disabled).toBe(true);
      await tree.open(host, 'workspace');

      await clickOn(command('Paste'));

      expect(renamesOf(calls)).toEqual([]);
      expect(command('Paste').disabled).toBe(true);
    });
  });

  describe('uploading files', () => {
    const file = new File(['buy low'], 'plan.txt', { type: 'text/plain' });
    /** An upload the test settles, and the options it was given. */
    const pending = () => {
      const started: { file: File; options: UploadOptions; folder: string; settle: (path: string) => void }[] = [];
      const onUpload = vi.fn((each: File, options: UploadOptions, folder: string) => new Promise<string>((resolve, reject) => {
        started.push({ file: each, options, folder, settle: resolve });
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      return { started, onUpload };
    };
    /** New, Upload, choosing these files in the browser's chooser: an input made for the choice and never drawn. */
    const choose = async (chosen: File[]) => {
      const opened = vi.spyOn(HTMLInputElement.prototype, 'click').mockReturnValue(undefined);
      await clickOn(command('New'));
      await menuItem('Upload');
      const chooser: unknown = opened.mock.contexts[0];
      opened.mockRestore();
      if (!(chooser instanceof HTMLInputElement)) throw new Error('no file chooser opened');
      expect([chooser.type, chooser.multiple, chooser.isConnected]).toEqual(['file', true, false]);
      Object.defineProperty(chooser, 'files', { value: chosen });
      const shown = chooser;
      await act(async () => shown.dispatchEvent(new Event('change')));
    };
    const progress = (host: HTMLElement) => [...host.querySelectorAll('[role="progressbar"]')].filter((bar) => bar.getAttribute('aria-label')?.startsWith('Uploading')).map((bar) => [bar.getAttribute('aria-label'), bar.getAttribute('aria-valuenow')]);

    it('uploads the files chosen from New, Upload into the open folder, showing each one’s progress until it ends', async () => {
      const { started, onUpload } = pending();
      const { host } = await windowWith({ files: [entry('reports/q3.pdf')], onUpload });
      await press(host, 'reports', 2);

      await choose([file]);
      expect(started.map(({ file: each, folder }) => [each.name, folder])).toEqual([['plan.txt', 'reports/']]);
      expect(progress(host)).toEqual([['Uploading plan.txt', '0']]);
      await act(async () => started[0]?.options.onProgress(0.5));
      expect(progress(host)).toEqual([['Uploading plan.txt', '0.5']]);

      await act(async () => started[0]?.settle('reports/plan.txt'));
      expect(progress(host)).toEqual([]);
    });

    it('cancels an upload from its row', async () => {
      const { started, onUpload } = pending();
      const { host } = await windowWith({ files: [], onUpload });
      await choose([file]);

      await clickOn(buttonIn(host, 'Cancel upload plan.txt'));

      expect(started[0]?.options.signal.aborted).toBe(true);
      await vi.waitFor(() => expect(progress(host)).toEqual([]));
    });

    it('uploads files dropped on the list into workspace from Home', async () => {
      const { started, onUpload } = pending();
      const { host } = await windowWith({ files: [entry('notes.txt')], onUpload });
      await tree.open(host, 'Home');
      const area = host.querySelector('[role="grid"]')?.parentElement;
      if (area === null || area === undefined) throw new Error('no list area');
      const drag = (type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
        return event;
      };

      const over = drag('dragover');
      await act(async () => area.dispatchEvent(over));
      expect(over.defaultPrevented).toBe(true);
      expect(getComputedStyle(area).outlineStyle).toBe('dashed');
      await act(async () => area.dispatchEvent(drag('drop')));

      expect(getComputedStyle(area).outlineStyle).not.toBe('dashed');
      expect(started.map(({ file: each, folder }) => [each.name, folder])).toEqual([['plan.txt', '']]);
    });

    it('says why an upload was refused, and lists Files again', async () => {
      const host = await app();
      failing = 503;

      await choose([file]);

      await vi.waitFor(() => expect(alertText(host)).toBe('refused'));
      expect(calls.at(-1)).toBe('GET https://chat.test/files');
    });
  });
});

const renamesOf = (requests: readonly string[]) => requests.filter((call) => call.startsWith('renamed'));
