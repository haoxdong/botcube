import React, { act } from 'react';
import userEvent from '@testing-library/user-event';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesApp } from './files-app';
import { FilesWindow } from './files-explorer';
import { useDesktopWindows, WindowsDesktop, type DesktopWindow } from './windows-desktop';
import { groupsOf, itemsIn } from './files-items';
import { invalidateAttachmentAccount } from '../plugin/file-account';
import { deleteFile, fileDownloadUrl, listFiles, moveIntoFolder, pastedCopyName, renameFile, uploadCopyName, uploadFile, uploadInto, withUploadsSettled, type UploadOptions } from './files-service';

const entry = (name: string, size = 1, lastModified = '2026-10-01T09:00:00.000Z') => ({ name, size, lastModified });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = { chatServiceUrl: 'https://chat.test' };
type Chat = typeof CHAT & { fetchImpl: typeof fetch };

describe('the Files client', () => {
  const report = entry('report.csv', 12, '2026-10-01T12:00:00.000Z');
  const read = { method: 'GET', credentials: 'include' } as const;
  it.each<[string, Response, (chat: Chat) => Promise<unknown>, unknown, string, RequestInit]>([
    ["lists the account's Files, with its cookies", Response.json({ files: [report] }), listFiles, [report], 'https://chat.test/files', read],
    ['asks for a download URL by the file path', Response.json({ url: 'https://links.test/report' }), (chat) => fileDownloadUrl('notes/plan v2.txt', chat),
      'https://links.test/report', 'https://chat.test/files/download-url?name=notes%2Fplan+v2.txt', read],
    ['deletes a file by its path', new Response(null, { status: 204 }), (chat) => deleteFile('notes/plan v2.txt', chat),
      undefined, 'https://chat.test/files?name=notes%2Fplan+v2.txt', { method: 'DELETE', credentials: 'include' }],
    ['renames a file from one path to another', Response.json({ name: 'notes/plan v3.txt' }), (chat) => renameFile('notes/plan v2.txt', 'notes/plan v3.txt', chat),
      undefined, 'https://chat.test/files/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"from":"notes/plan v2.txt","to":"notes/plan v3.txt"}', credentials: 'include' }],
  ])('%s', async (_, answer, call, result, url, init) => {
    const fetchImpl = vi.fn(async () => answer);
    expect(await call({ ...CHAT, fetchImpl })).toEqual(result);
    expect(fetchImpl).toHaveBeenCalledWith(url, init);
  });

  it("fails loud with the Chat Service's reason, or the status", async () => {
    const refused = { ...CHAT, fetchImpl: vi.fn(async () => Response.json({ detail: 'Files are not configured' }, { status: 503 })) };
    const broken = { ...CHAT, fetchImpl: vi.fn(async () => new Response('Bad gateway', { status: 502 })) };
    await expect(listFiles(refused)).rejects.toThrow('Files are not configured');
    await expect(listFiles(broken)).rejects.toThrow('Files request failed: 502');
    await expect(fileDownloadUrl('x', broken)).rejects.toThrow('Download failed: 502');
    await expect(deleteFile('x', refused)).rejects.toThrow('Files are not configured');
    await expect(deleteFile('x', broken)).rejects.toThrow('Delete failed: 502');
    await expect(renameFile('x', 'y', refused)).rejects.toThrow('Files are not configured');
    await expect(renameFile('x', 'y', broken)).rejects.toThrow('Rename failed: 502');
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

const file = new File(['buy low'], 'plan.txt', { type: 'text/plain' });
const uploadOptions = (signal = new AbortController().signal) => ({ onProgress: vi.fn(), signal });

describe('uploading a file the user attached in the chat', () => {
  const service = (taken: string[] = []) => vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { name } = JSON.parse(init?.body as string) as { name: string };
    if (taken.includes(name)) return Response.json({ detail: `A file named ${name} is already in Files` }, { status: 409 });
    return Response.json({ url: `https://links.test/?t=${encodeURIComponent(name)}` });
  });
  const upload = (fetchImpl: typeof fetch, options: UploadOptions = uploadOptions(), body = file) => uploadFile(body, options, { ...CHAT, fetchImpl });
  const put = async (index = 0) => {
    await vi.waitFor(() => expect(puts).toHaveLength(index + 1));
    return puts[index] as FakeUpload;
  };
  const conflict = () => Response.json({ detail: 'A file named plan.txt is already in Files' }, { status: 409 });
  beforeEach(() => {
    puts.length = 0;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.includes('done=')
      ? Promise.resolve(new Response('ok')) : new FakeUpload(url, init).response);
  });

  it("PUTs the bytes as a new file to the Chat Service's presigned URL, reporting progress, and resolves to the agent's path", async () => {
    const fetchImpl = service();
    const options = uploadOptions();
    const uploading = upload(fetchImpl, options);
    const request = await put();
    request.respond(200);
    expect(await uploading).toBe('/plan.txt');
    expect(fetchImpl).toHaveBeenCalledWith('https://chat.test/files/upload-url', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"plan.txt"}', credentials: 'include', signal: expect.any(AbortSignal),
    });
    expect(request).toMatchObject({ method: 'PUT', url: 'https://links.test/?t=plan.txt&offset=0', headers: { 'content-type': 'application/octet-stream' } });
    expect(await request.body.text()).toBe(await file.text());
    expect(options.onProgress).toHaveBeenLastCalledWith(1);
  });

  it('uploads to a Files link from EFS in 4 MiB chunks, chunk 0 first, then finishes with the size and SHA-256', async () => {
    const big = new File([new Uint8Array(9 * 1024 * 1024).fill(7)], 'big.bin');
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent.push(`${new URL(url).search} ${(init.body as Blob).size}`);
      return new Response('ok');
    }));
    const options = uploadOptions();
    expect(await upload(vi.fn(async () => Response.json({ url: 'https://links.test/?t=signed' })), options, big)).toBe('/big.bin');
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await big.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(sent[0]).toBe('?t=signed&offset=0 4194304');
    expect(sent.slice(1, 3).sort()).toEqual(['?t=signed&offset=4194304 4194304', '?t=signed&offset=8388608 1048576']);
    expect(sent[3]).toBe(`?t=signed&offset=12582912&done=9437184&sha256=${sha256} 0`);
    expect(options.onProgress).toHaveBeenLastCalledWith(1);
    expect(puts).toHaveLength(0);
  });

  it('tries the next copy name when a Files link from EFS finds the name taken', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (new URL(url).searchParams.get('t') === 'plan.txt' && url.includes('done=')
      ? new Response('A file with this name is already in Files', { status: 409 })
      : new Response('ok'))));
    expect(await upload(service())).toBe('/plan (2).txt');
  });

  it.each([
    ['plan.txt', 1, 'plan - Copy.txt'],
    ['plan.txt', 2, 'plan - Copy (2).txt'],
    ['Makefile', 1, 'Makefile - Copy'],
    ['a.' + 'b'.repeat(253), 1, 'a - Copy.' + 'b'.repeat(246)],
  ])('names copy %s, number %i, pasted beside it %s as Windows does', (name, copy, named) => {
    expect(pastedCopyName(name, copy)).toBe(named);
  });

  it('names a folder\'s copy at the end of its name, never splitting an extension', () => {
    expect([pastedCopyName('v1.2', 1, true), pastedCopyName('v1.2', 2, true), uploadCopyName('v1.2', 2, true)]).toEqual(['v1.2 - Copy', 'v1.2 - Copy (2)', 'v1.2 (2)']);
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
    const body = new File(['new bytes'], original);
    const uploading = upload(service(taken), uploadOptions(), body);
    const request = await put();
    request.respond(200);
    expect(await uploading).toBe(`/${stored}`);
    expect(request.url).toBe(`https://links.test/?t=${encodeURIComponent(stored)}&offset=0`);
    expect(await request.body.text()).toBe(await body.text());
  });

  it('keeps both composer attachments when Files already holds the name', async () => {
    const fetchImpl = service(['plan.txt']);
    const uploading = upload(fetchImpl);
    (await put()).respond(200);
    expect(await uploading).toBe('/plan (2).txt');
    expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual(['{"name":"plan.txt"}', '{"name":"plan (2).txt"}']);
  });

  it("fails with the Chat Service's reason when it refuses an upload URL", async () => {
    await expect(upload(vi.fn(async () => Response.json({ detail: 'Files are not configured' }, { status: 503 })))).rejects.toThrow('Files are not configured');
    await expect(upload(vi.fn(async () => new Response('Bad gateway', { status: 502 })))).rejects.toThrow('Upload failed: 502');
    expect(puts).toEqual([]);
  });

  it('fails with the status when the storage refuses the PUT, or says the network failed', async () => {
    const refused = upload(service());
    (await put()).respond(403);
    await expect(refused).rejects.toThrow('Upload failed: 403');
    const offline = upload(service());
    (await put(1)).onerror();
    await expect(offline).rejects.toThrow('Upload failed: network error');
  });

  it('advances when concurrent uploaders claim the same name at the conditional PUT', async () => {
    const uploading = upload(service());
    (await put()).respond(412);
    const second = await put(1);
    expect(second.url).toBe('https://links.test/?t=plan%20(2).txt&offset=0');
    expect(second.headers).toEqual({ 'content-type': 'application/octet-stream' });
    second.respond(412);
    (await put(2)).respond(200);
    expect(await uploading).toBe('/plan (3).txt');
  });

  it.each([
    ['aborts the PUT when the user removes the file', 0],
    ['aborts the active PUT after selecting a new name for a concurrent collision', 1],
  ])('%s', async (_, collisions) => {
    const controller = new AbortController();
    const uploading = upload(service(), uploadOptions(controller.signal));
    if (collisions === 1) (await put()).respond(412);
    const request = await put(collisions);
    controller.abort();
    await expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.aborted).toBe(true);
  });

  it('stops collision advancement when the attachment is removed', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      return conflict();
    });
    await expect(upload(fetchImpl, uploadOptions(controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([]);
  });

  it.each([
    ['an unavailable service after a name collision', conflict(), 'Files unavailable', ['{"name":"plan.txt"}', '{"name":"plan (2).txt"}']],
    ['an account conflict without allocating another attachment name', Response.json({ detail: 'Account deletion is pending' }, { status: 409 }), 'Account deletion is pending', ['{"name":"plan.txt"}']],
  ])('propagates %s', async (_, first, reason, asked) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(Response.json({ detail: 'Files unavailable' }, { status: 503 }));
    await expect(upload(fetchImpl)).rejects.toThrow(reason);
    expect(fetchImpl.mock.calls.map(([, init]) => (init as RequestInit).body)).toEqual(asked);
    await expect(withUploadsSettled(async () => 'settled')).resolves.toBe('settled');
  });

  it('drains uploads before an account change and refuses new uploads until the change finishes', async () => {
    const fetchImpl = service();
    const uploading = upload(fetchImpl);
    const request = await put();
    let finish!: () => void;
    const change = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const transition = withUploadsSettled(change);
    await expect(upload(fetchImpl)).rejects.toThrow('Uploads are paused while your account changes');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(change).not.toHaveBeenCalled();
    request.respond(200);
    await uploading;
    await vi.waitFor(() => expect(change).toHaveBeenCalledOnce());
    await expect(upload(fetchImpl)).rejects.toThrow('Uploads are paused while your account changes');
    finish();
    await transition;
    const next = upload(fetchImpl);
    (await put(1)).respond(200);
    expect(await next).toBe('/plan.txt');
  });

  it('propagates an upload failure without changing accounts and permits another upload', async () => {
    const uploading = upload(service());
    const request = await put();
    const change = vi.fn(async () => {});
    const transition = withUploadsSettled(change);
    request.respond(403);
    await expect(uploading).rejects.toThrow('Upload failed: 403');
    await expect(transition).rejects.toThrow('Upload failed: 403');
    expect(change).not.toHaveBeenCalled();
    const next = upload(service());
    (await put(1)).respond(200);
    expect(await next).toBe('/plan.txt');
  });

  it("waits for another tab's pending upload before claiming the shared account", async () => {
    vi.resetModules();
    const uploadingTab = await import('./files-service');
    vi.resetModules();
    const claimingTab = await import('./files-service');
    expect(uploadingTab.uploadFile).not.toBe(claimingTab.uploadFile);
    const uploading = uploadingTab.uploadFile(file, uploadOptions(), { ...CHAT, fetchImpl: service() });
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
});

describe('an upload into a folder, and a move into one', () => {
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
    return { renames, chat: { ...CHAT, fetchImpl } };
  };
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response('ok'));
  });

  it.each([
    ['leaves an upload to workspace at the top', '', [], 'plan.txt', []],
    ['moves an upload into the open folder', 'reports/2026/', [], 'reports/2026/plan.txt', ['plan.txt to reports/2026/plan.txt']],
    ["moves it in as the next copy name where the folder holds the file's name", 'reports/', ['reports/plan.txt', 'reports/plan (2).txt'], 'reports/plan (3).txt',
      ['plan.txt to reports/plan.txt', 'plan.txt to reports/plan (2).txt', 'plan.txt to reports/plan (3).txt']],
  ])('%s', async (_, folder, taken, uploaded, renamed) => {
    const { renames, chat } = service(taken);
    expect(await uploadInto(file, uploadOptions(), folder, chat)).toBe(uploaded);
    expect(renames).toEqual(renamed);
  });

  it('says the upload stayed in workspace when the move is refused', async () => {
    await expect(uploadInto(file, uploadOptions(), 'reports/', service([], 'Files are not configured').chat)).rejects.toThrow('“plan.txt” was uploaded to workspace: Files are not configured');
  });

  it("moves a file into another folder under its own name, or a copy name", async () => {
    const { renames, chat } = service(['reports/a.md']);
    expect(await moveIntoFolder('notes/a.md', 'reports/', chat)).toBe('reports/a (2).md');
    expect(await moveIntoFolder('notes/b.md', '', chat)).toBe('b.md');
    expect(renames).toEqual(['notes/a.md to reports/a.md', 'notes/a.md to reports/a (2).md', 'notes/b.md to b.md']);
  });
});

/** The Chat Service as the app sees it: the account's Files, and the requests it got. */
const calls: string[] = [];
let stored: { name: string; size: number; lastModified: string }[] = [];
let emptyFolders: { name: string; lastModified: string }[] = [];
let failing: number | null = null;
const assign = vi.fn();
type Moving = { from: string; to: string; name: string };
const taken = (to: string) => stored.some(({ name }) => name === to || name.startsWith(`${to}/`)) || emptyFolders.some(({ name }) => name === to);
const moved = (name: string, from: string, to: string) => (name === from ? to : name.startsWith(`${from}/`) ? `${to}${name.slice(from.length)}` : name);
const ROUTES: Record<string, (body: Moving) => Response> = {
  '/files/rename': ({ from, to }) => {
    if (taken(to)) return Response.json({ detail: `A file named ${to} is already in Files` }, { status: 409 });
    calls.push(`renamed ${from} to ${to}`);
    stored = stored.map((each) => ({ ...each, name: moved(each.name, from, to) }));
    emptyFolders = emptyFolders.map((folder) => ({ ...folder, name: moved(folder.name, from, to) }));
    return Response.json({ name: to });
  },
  '/files/folder': ({ name }) => {
    if (taken(name)) return Response.json({ detail: `A folder named ${name} is already in Files` }, { status: 409 });
    calls.push(`made ${name}`);
    emptyFolders.push({ name, lastModified: '2026-10-02T09:00:00.000Z' });
    return Response.json({ name }, { status: 201 });
  },
  '/files/copy': ({ from, to }) => {
    if (taken(to)) return Response.json({ detail: `A file named ${to} is already in Files` }, { status: 409 });
    const inside = stored.filter(({ name }) => name.startsWith(`${from}/`));
    const source = stored.find(({ name }) => name === from);
    if (source === undefined && inside.length === 0) return Response.json({ detail: `No file ${from} in Files` }, { status: 404 });
    if (source === undefined && to.startsWith(`${from}/`)) return Response.json({ detail: `${from} can't be copied into itself` }, { status: 400 });
    calls.push(`copied ${from} to ${to}`);
    stored = [...stored, ...(source === undefined ? inside : [source]).map((each) => ({ ...each, name: moved(each.name, from, to) }))];
    return Response.json({ name: to });
  },
};
beforeEach(() => {
  invalidateAttachmentAccount();
  calls.length = 0;
  stored = [];
  emptyFolders = [];
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
    const route = ROUTES[url.pathname];
    if (route !== undefined && init?.method === 'POST') return route(JSON.parse(init.body as string) as Moving);
    if (url.pathname === '/files') return Response.json({ files: stored, folders: emptyFolders });
    if (url.pathname === '/files/download-url') return Response.json({ url: `https://links.test/${url.searchParams.get('name')}` });
    throw new Error(`Unexpected request: ${input}`);
  });
  // Tabster, which moves focus in Fluent's menus and dialogs, finds nothing to focus in a page whose body has no size,
  // as a page with no layout has.
  vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 1280, height: 720 }));
});

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const listings = (count: number) => Array<string>(count).fill('GET https://chat.test/files');
const renames = () => calls.filter((call) => call.startsWith('renamed'));

async function render(element: React.ReactElement) {
  // In the document, so focus moves and a tap outside the app reaches it.
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
}
async function app(...files: ReturnType<typeof entry>[]): Promise<HTMLElement> {
  stored.push(...files);
  return render(React.createElement(FilesApp, CHAT));
}
type WindowProps = React.ComponentProps<typeof FilesWindow>;
async function windowWith(given: Partial<WindowProps>) {
  const props: WindowProps = {
    files: [], error: null, onDownload: vi.fn(), onDelete: vi.fn(), onRename: vi.fn(() => null), onMove: vi.fn(), onReload: vi.fn(),
    onCopy: vi.fn(), onNewFolder: vi.fn((folder: string) => `${folder}New folder/`),
    onUpload: vi.fn(() => Promise.reject(new Error('The test has no uploads'))), thumbnailUrl: vi.fn(async () => 'https://links.test/chart'),
    ...given,
  };
  return { host: await render(React.createElement(FilesWindow, props)), props };
}
/** Holds the Chat Service's answers to the requests `when` picks until the returned function lets them through. */
const holdFetch = (when: (input: string, init?: RequestInit) => boolean = () => true, answerFirst = false) => {
  const answer = globalThis.fetch;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const early = answerFirst ? await answer(input, init) : undefined;
    if (when(input, init)) await held;
    return early ?? answer(input, init);
  });
  return () => act(async () => release());
};

const found = <T>(element: T | null | undefined, what: string): T => {
  if (element === null || element === undefined) throw new Error(`no ${what}`);
  return element;
};
const shows = (element: Element | null) => element !== null && getComputedStyle(element).display !== 'none';
const onScreen = (element: Element, seen = new Map<Element, boolean>()): boolean => {
  const known = seen.get(element);
  if (known !== undefined) return known;
  const answer = shows(element) && (element.parentElement === null || onScreen(element.parentElement, seen));
  seen.set(element, answer);
  return answer;
};
const rows = (host: HTMLElement) => {
  const seen = new Map<Element, boolean>();
  return [...host.querySelectorAll<HTMLElement>('.agent-computer-file')].filter((row) => onScreen(row, seen));
};
const cards = (host: HTMLElement) => rows(host).filter((row) => row.classList.contains('fui-ListItem'));
const nameOf = (row: Element) => row.querySelector('.agent-computer-file-name')?.textContent ?? '';
const names = (host: HTMLElement) => rows(host).map(nameOf);
const rowOf = (host: HTMLElement, name: string) => found(rows(host).find((candidate) => nameOf(candidate) === name), `${name} row`);
const cellsAsRead = (host: HTMLElement) =>
  rows(host).map((row) => [...row.querySelectorAll('[role="gridcell"]')].map((cell) => cell.textContent.replace(/\s/g, ' ')));
const visibleHeaders = (host: HTMLElement) => [...host.querySelectorAll('[role="columnheader"]')].filter((header) => onScreen(header)).map((header) => header.textContent);
const selected = (host: HTMLElement) => rows(host).filter((row) => row.getAttribute('aria-selected') === 'true').map(nameOf);
const press = async (host: HTMLElement, name: string, count = 1) => {
  const row = rowOf(host, name);
  await act(async () => {
    for (let detail = 1; detail <= count; detail++) row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    if (count === 2) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  });
};
const ctrlClick = async (host: HTMLElement, name: string, keys: MouseEventInit = { ctrlKey: true }) =>
  act(async () => rowOf(host, name).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, ...keys })));
/**
 * Holds the clock still to the test's end. Type-to-find starts afresh after a pause in the keys' event time, and the
 * keyboard here types at the machine's pace: with the clock still, letters typed in a row are one name, however slowly
 * a loaded machine types them.
 */
const stillClock = () => {
  const now = performance.now();
  vi.spyOn(performance, 'now').mockReturnValue(now);
};
const key = async (target: Element | null, keys: string) => {
  if (!(target instanceof HTMLElement)) throw new Error('Keyboard target is missing');
  target.focus();
  await act(async () => userEvent.keyboard(keys));
};
const escape = () => act(async () => userEvent.keyboard('{Escape}'));
const buttonIn = (scope: ParentNode, label: string) =>
  found([...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === label), `${label} button`);
// Popups draw outside the window, so a button is looked for in the whole page.
const command = (label: string) => buttonIn(document.querySelector('[role="toolbar"][aria-label="Commands"]') ?? document, label);
const address = (label: string) => buttonIn(document, label);
const clickOn = async (element: HTMLElement) => act(async () => element.click());
const menu = () => document.querySelector('[role="menu"]');
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
const findMenuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label);
const menuItem = async (label: string) => clickOn(found(findMenuItem(label), `${label} menu item`));
const FILE_MENU = ['Open', 'Cut', 'Copy', 'Download', 'Rename', 'Delete', 'Copy path', 'Properties'];
const FOLDER_MENU = ['View', 'Sort by', 'Group by', 'Refresh', 'Paste', 'New', 'Properties'];
const contextMenu = async (host: HTMLElement, name: string) => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  await act(async () => rowOf(host, name).dispatchEvent(event));
  return event;
};
const listArea = (host: HTMLElement) => found(host.querySelector('.agent-computer-files-list'), 'list area');
const checks = (role: 'menuitemradio' | 'menuitemcheckbox') =>
  [...document.querySelectorAll(`[role="${role}"]`)].map((item) => `${item.getAttribute('aria-checked') === 'true' ? '●' : '○'} ${item.textContent}`);
/** An item of the menu opened last: a submenu, if one is open. */
const choose = async (role: 'menuitemradio' | 'menuitemcheckbox', label: string) => {
  const last = [...document.querySelectorAll('[role="menu"]')].at(-1) ?? document;
  await clickOn(found([...last.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((candidate) => candidate.textContent === label), `${label} ${role}`));
};
const pick = async (menuName: 'View' | 'Sort', label: string) => {
  await clickOn(command(menuName));
  await choose('menuitemradio', label);
  await escape();
};
const currentView = async () => {
  await clickOn(command('View'));
  const checked = checks('menuitemradio').filter((item) => item.startsWith('●'));
  await escape();
  return checked;
};
const dialog = () => document.querySelector('[role="alertdialog"]');
const shownDialog = () => document.querySelector('[role="dialog"]');
// Fluent's motion and Tabster's focus moves end on timers.
const settled = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
const settledUntil = async (done: () => boolean, turns: number): Promise<void> => {
  if (turns === 0 || done()) return;
  await settled();
  await settledUntil(done, turns - 1);
};
const gone = async () => {
  await settledUntil(() => dialog() === null, 100);
  expect(dialog()).toBeNull();
};
const closeProperties = async () => {
  await clickOn(buttonIn(shownDialog() ?? document, 'OK'));
  await settledUntil(() => shownDialog() === null, 100);
};
const dialogButton = (label: string) => buttonIn(found(dialog(), 'dialog'), label);
const alertText = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent;
const status = (host: HTMLElement) => [...(host.querySelector('[role="status"]')?.children ?? [])].map((part) => part.textContent).filter(Boolean);
const searchBox = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label="Search"]');
const treeItems = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const treeName = (item: Element) => item.querySelector('.fui-TreeItemLayout__main')?.textContent;
const treePart = (host: HTMLElement, name: string, part: string) =>
  found(treeItems(host).find((item) => treeName(item) === name)?.querySelector<HTMLElement>(part), `${name} ${part} in the tree`);
const tree = {
  names: (host: HTMLElement) => treeItems(host).map(treeName),
  current: (host: HTMLElement) => treeItems(host).filter((item) => item.getAttribute('aria-current') === 'true').map(treeName),
  open: async (host: HTMLElement, name: string) => clickOn(treePart(host, name, '.fui-TreeItemLayout')),
  expand: async (host: HTMLElement, name: string) => clickOn(treePart(host, name, '.fui-TreeItemLayout__expandIcon')),
};
const path = {
  names: (host: HTMLElement) => [...host.querySelectorAll('[aria-label="Path"] button')].map((button) => button.textContent),
  current: (host: HTMLElement) => host.querySelector('[aria-label="Path"] [aria-current="page"]')?.textContent,
  open: async (host: HTMLElement, name: string) => clickOn(buttonIn(host.querySelector('[aria-label="Path"]') ?? host, name)),
};
const search = async (host: HTMLElement, text: string) => {
  const box = found(searchBox(host), 'search box');
  await act(async () => {
    box.focus();
    await userEvent.clear(box);
    if (text !== '') await userEvent.type(box, text);
  });
};
async function sortOn(host: HTMLElement, column: string) {
  const header = await vi.waitFor(() => {
    const cell = found([...host.querySelectorAll<HTMLElement>('[role="columnheader"]')].find((candidate) => candidate.textContent === column && onScreen(candidate)), `${column} header on screen`);
    return cell.querySelector('button') ?? cell;
  });
  await act(async () => header.click());
}
const field = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label^="Rename "]');
const rename = async (host: HTMLElement, name: string) => {
  await contextMenu(host, name);
  await menuItem('Rename');
  return found(host.querySelector<HTMLInputElement>(`input[aria-label="Rename ${name}"]`), 'name field');
};
/** Types `name` over the field, then presses `pressed`; a null name leaves the field's own. */
const typeName = async (target: HTMLInputElement | null, name: string | null, pressed?: string, init: KeyboardEventInit = {}) => act(async () => {
  const input = found(target, 'name field');
  if (name !== null) input.value = name;
  if (pressed) input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: pressed, ...init }));
});

describe('FilesApp', () => {
  describe('while the listing loads', () => {
    const spinner = (host: HTMLElement) => host.querySelector('[role="progressbar"]')?.textContent;
    afterEach(() => vi.useRealTimers());

    it('shows nothing extra when the listing comes quickly, and says it is working on it once it is slow', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const release = holdFetch();
      const host = await app(entry('report.csv', 2048, '2026-10-01T12:00:00.000Z'));
      await act(async () => vi.advanceTimersByTime(499));
      expect(spinner(host)).toBe('');
      expect(names(host)).toEqual([]);
      expect(shows(host.querySelector('.agent-computer-files-empty'))).toBe(false);
      expect(status(host)).toEqual([]);
      await act(async () => vi.advanceTimersByTime(1));
      expect(spinner(host)).toBe('Working on it…');
      await release();
      expect(spinner(host)).toBeUndefined();
      expect(names(host)).toEqual(['report.csv']);
    });

    it('stops working on it when why it could not load arrives', async () => {
      failing = 502;
      const release = holdFetch();
      const host = await app();
      expect(spinner(host)).toBe('');
      await release();
      expect(spinner(host)).toBeUndefined();
      expect(alertText(host)).toBe('refused');
    });

    it('reopens on the last listing at once, with no spinner, and lists again quietly', async () => {
      await app(entry('report.csv', 1, '2026-10-01T12:00:00.000Z'));
      stored.push(entry('q4.pdf', 1, '2026-10-02T09:00:00.000Z'));
      const release = holdFetch();
      const again = await app();
      expect(names(again)).toEqual(['report.csv']);
      expect(spinner(again)).toBeUndefined();
      const row = rowOf(again, 'report.csv');
      await release();
      expect(names(again)).toEqual(['q4.pdf', 'report.csv']);
      expect(rowOf(again, 'report.csv')).toBe(row);
      expect(calls).toEqual(listings(2));
    });
  });

  it('says where files come from while there are none, and lists them when Files opens again', async () => {
    const host = await app();
    expect(shows(host.querySelector('.agent-computer-files-empty'))).toBe(true);
    expect(host.querySelector('.agent-computer-files-empty')?.textContent.trim()).toBe('No files yet. Files the agent saves appear here.');
    expect(names(host)).toEqual([]);
    expect(status(host)).toEqual(['0 items']);

    const again = await app(entry('report.csv', 2048, '2026-10-01T12:00:00.000Z'));
    expect(names(again)).toEqual(['report.csv']);
    expect(shows(again.querySelector('.agent-computer-files-empty'))).toBe(false);
    expect(calls).toEqual(listings(2));
  });

  it('says why when the Chat Service refuses, and stops once a download goes through', async () => {
    failing = 503;
    expect(alertText(await app())).toBe('refused');

    failing = null;
    const listed = await app(entry('report.csv', 12, '2026-10-01T12:00:00.000Z'));
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

  it("lists again as each of the agent's operations finishes: new files show, unchanged rows keep their selection and a rename in progress, and a download still being written stays hidden", async () => {
    stored.push(entry('notes.txt'), entry('plan.txt'));
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    roots.push(root);
    const agentDid = (changes: number) => act(async () => root.render(React.createElement(FilesApp, { ...CHAT, changes })));
    await agentDid(0);
    const notes = rowOf(host, 'notes.txt');
    const input = await rename(host, 'plan.txt');
    const chosen = selected(host);

    stored.push(entry('report.pdf.crdownload'));
    await agentDid(1);
    // plan.txt's name is its rename field.
    expect(names(host)).toEqual(['notes.txt', '']);
    stored = [...stored.filter(({ name }) => !name.endsWith('.crdownload')), entry('report.pdf')];
    await agentDid(2);

    expect(calls).toEqual(listings(3));
    expect(names(host)).toEqual(['notes.txt', '', 'report.pdf']);
    expect(rowOf(host, 'notes.txt')).toBe(notes);
    expect(selected(host)).toEqual(chosen);
    expect(field(host)).toBe(input);
  });

  it('loads the Files of the Chat Service it is pointed at', async () => {
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => root.render(React.createElement(FilesApp, CHAT)));
    await act(async () => root.render(React.createElement(FilesApp, { chatServiceUrl: 'https://other.test' })));
    expect(calls).toEqual(['GET https://chat.test/files', 'GET https://other.test/files']);
  });

  it("lists the open folder in details view: folders first, then files, each by name, with Explorer's date, type and size", async () => {
    const host = await app(
      entry('prices.csv', 3_276_800, '2026-10-02T15:30:00.000Z'), entry('curve.png', 1), entry('Makefile', 0), entry('.env', 1024),
      entry('reports/a.txt', 1, '2026-09-01T09:00:00.000Z'), entry('reports/2026/b.txt', 1, '2026-10-03T08:05:00.000Z'), entry('charts/c.plotly.json', 1),
    );
    expect(visibleHeaders(host)).toEqual(['Name', 'Date modified', 'Type', 'Size']);
    expect(cellsAsRead(host)).toEqual([
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
    const host = await app(entry('b.txt', 5000), entry('a.md', 9000), entry('c.png', 10), entry('docs/x.txt'));
    await vi.waitFor(() => expect(names(host)).toEqual(['docs', 'a.md', 'b.txt', 'c.png']));
    await sortOn(host, 'Size');
    await vi.waitFor(() => expect(names(host)).toEqual(['docs', 'c.png', 'b.txt', 'a.md']));
    await sortOn(host, 'Size');
    await vi.waitFor(() => expect(names(host)).toEqual(['a.md', 'b.txt', 'c.png', 'docs']));
    await sortOn(host, 'Type');
    await vi.waitFor(() => expect(names(host)).toEqual(['docs', 'a.md', 'c.png', 'b.txt']));
  });

  it('draws a plain document for an extension named after an inherited object property', async () => {
    const host = await app(entry('report.constructor', 12, '2026-10-01T12:00:00.000Z'));
    expect(rowOf(host, 'report.constructor').dataset.kind).toBe('document');
    expect(cellsAsRead(host)[0]?.[2]).toBe('CONSTRUCTOR File');
  });

  it('selects a row on a click, and opens it on a double-click or Enter', async () => {
    const host = await app(entry('report.csv', 2048), entry('reports/q3.pdf'));
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
    const host = await app(entry('reports', 3), entry('reports/summary.csv', 12, '2026-10-02T09:00:00.000Z'));
    expect(rows(host).map((row) => [nameOf(row), row.dataset.kind])).toEqual([['reports', 'folder'], ['reports', 'document']]);
    await key(host.querySelector('[data-kind="folder"]'), '{Enter}');
    expect(names(host)).toEqual(['summary.csv']);
  });

  it('opens folders in place, its path running from workspace, each crumb opening its folder', async () => {
    const host = await app(entry('reports/summary.csv'), entry('reports/2026/q3.pdf'), entry('reports/2026/q2.pdf'), entry('reports/2026/drafts/q4.pdf'), entry('Notes.txt'));
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
    const host = await app(entry('reports/summary.csv'), entry('reports/2026/drafts/q4.pdf'), entry('Notes.txt'));
    expect([address('Back').disabled, address('Forward').disabled, address('Up').disabled]).toEqual([true, true, true]);
    await press(host, 'reports', 2);
    await press(host, '2026', 2);
    await path.open(host, 'workspace');
    const go = async (label: string) => {
      await clickOn(address(label));
      return path.current(host);
    };
    expect(await go('Back')).toBe('2026');
    expect(await go('Up')).toBe('reports');
    expect(names(host)).toEqual(['2026', 'summary.csv']);
    expect(await go('Back')).toBe('2026');
    expect(address('Forward').disabled).toBe(false);
    expect(await go('Forward')).toBe('reports');
    expect(address('Forward').disabled).toBe(true);

    await go('Back');
    await tree.open(host, 'Home');
    expect([address('Forward').disabled, address('Up').disabled]).toEqual([true, true]);
    expect(await go('Back')).toBe('2026');
  });

  it('reloads the listing as each place opens, and on Refresh', async () => {
    const host = await app(entry('reports/q3.pdf'));
    await press(host, 'reports', 2);
    stored.push(entry('reports/q4.pdf', 1, '2026-10-02T09:00:00.000Z'));
    await clickOn(address('Refresh'));
    expect(names(host)).toEqual(['q3.pdf', 'q4.pdf']);
    await clickOn(address('Back'));
    await tree.open(host, 'Home');
    expect(calls).toEqual(listings(5));
  });

  it("lists Home and workspace's folders to any depth in the navigation pane, marking the open place", async () => {
    const host = await app(entry('reports/2026/q3.pdf'), entry('notes/plan.md'), entry('rates-recap.md'));
    expect(host.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe('Navigation');
    expect(tree.names(host)).toEqual(['Home', 'workspace', 'notes', 'reports']);
    expect(tree.current(host)).toEqual(['workspace']);
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
    const host = await app(entry('reports/2026/q3.pdf', 1, '2026-10-03T09:00:00.000Z'), entry('notes/plan.md', 1, '2026-10-04T09:00:00.000Z'), entry('Notes.txt'));
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
    const layout = treePart(await app(entry(`${long}/notes.txt`)), long, '.fui-TreeItemLayout');
    expect(layout.getAttribute('title')).toBe(long);
    const main = layout.querySelector('.fui-TreeItemLayout__main');
    expect(main === null ? null : getComputedStyle(main).whiteSpace).toBe('nowrap');
  });

  it('shows Search as a button in a narrow window, which swaps the path for the search box until Escape', async () => {
    const host = await app(entry('rates.csv'), entry('notes.txt'));
    const box = searchBox(host);
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
    const host = await app(
      entry('reports/2026/q3.pdf', 1, '2026-10-03T09:00:00.000Z'), entry('rates-recap.md', 1, '2026-10-05T09:00:00Z'), entry('notes/plan.md', 1, '2026-10-04T09:00:00.000Z'),
      ...Array.from({ length: 20 }, (_, index) => entry(`old/${index}.txt`, 1, `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`)),
    );
    await tree.open(host, 'Home');
    expect(tree.current(host)).toEqual(['Home']);
    expect(path.names(host)).toEqual(['Home']);
    expect(searchBox(host)?.placeholder).toBe('Search Home');
    expect(names(host)).toEqual(['rates-recap.md', 'plan.md', 'q3.pdf', ...Array.from({ length: 17 }, (_, index) => `${19 - index}.txt`)]);
    expect(status(host)).toEqual(['20 items']);

    // A recent file opens, and renames in, its own folder.
    await press(host, 'q3.pdf', 2);
    expect(assign).toHaveBeenCalledWith('https://links.test/reports/2026/q3.pdf');
    await typeName(await rename(host, 'plan.md'), 'plan v2.md', 'Enter');
    expect(calls).toContain('renamed notes/plan.md to notes/plan v2.md');
  });

  it("filters the open place by name, whatever the case, until another place opens", async () => {
    const host = await app(entry('Rates-recap.md'), entry('rates.csv'), entry('notes.txt'), entry('reports/rates-2026.pdf'));
    expect(searchBox(host)?.placeholder).toBe('Search workspace');
    await search(host, 'RATES');
    expect(names(host)).toEqual(['Rates-recap.md', 'rates.csv']);
    expect(status(host)).toEqual(['2 items']);
    await tree.open(host, 'reports');
    expect(searchBox(host)?.value).toBe('');
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
    it("acts on the selected file, and is off for nothing selected; a folder has Copy and Rename", async () => {
      const { host, props } = await windowWith({ files: [entry('report.csv'), entry('reports/q3.pdf')] });
      const off = () => ['Cut', 'Copy', 'Download', 'Rename', 'Delete'].map((label) => command(label).disabled);
      expect(off()).toEqual([true, true, true, true, true]);
      await press(host, 'reports');
      expect(off()).toEqual([true, false, true, false, true]);
      await press(host, 'report.csv');
      expect(off()).toEqual([false, false, false, false, false]);
      await clickOn(command('Download'));
      expect(props.onDownload).toHaveBeenCalledExactlyOnceWith('report.csv');
      await clickOn(command('Rename'));
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Rename report.csv');
    });

    it('labels only New, View and Sort; the other commands are icons, each named by its tooltip, with See more at the end', async () => {
      await windowWith({ files: [entry('report.csv')] });
      const bar = document.querySelector('[role="toolbar"][aria-label="Commands"]');
      const icons = ['Cut', 'Copy', 'Paste', 'Download', 'Rename', 'Delete'];
      expect(command('New').textContent).toBe('New');
      expect(icons.map((label) => [command(label).getAttribute('aria-label'), command(label).textContent])).toEqual(icons.map((label) => [label, '']));
      expect(['View', 'Sort'].map((label) => command(label).textContent)).toEqual(['View', 'Sort']);
      // A page with no layout has nothing overflowing into See more; Tabster may add its focus guards around the bar's children.
      expect([...(bar?.children ?? [])].filter((child) => !child.hasAttribute('data-tabster-dummy')).at(-1)?.getAttribute('aria-label')).toBe('See more');
      expect(shows(command('See more'))).toBe(true);
      await clickOn(command('See more'));
      expect(menuItems().slice(-4)).toEqual(['Select all', 'Select none', 'Invert selection', 'Properties']);
      await act(async () => userEvent.hover(command('Download')));
      await settledUntil(() => document.querySelector('[role="tooltip"]') !== null, 50);
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Download');
    });
  });

  describe("a row's menu", () => {
    it('opens on a right-click with Open, Cut, Copy, Download, Rename, Delete, Copy path and Properties, selecting the row; a folder has Open, Copy, Rename, Copy path and Properties', async () => {
      const host = await app(entry('report.csv'), entry('reports/q3.pdf'));
      expect((await contextMenu(host, 'report.csv')).defaultPrevented).toBe(true);
      expect(menuItems()).toEqual(FILE_MENU);
      expect(selected(host)).toEqual(['report.csv']);
      expect(assign).not.toHaveBeenCalled();
      await escape();
      expect(menu()).toBeNull();
      await contextMenu(host, 'reports');
      expect(menuItems()).toEqual(['Open', 'Copy', 'Rename', 'Copy path', 'Properties']);
      await menuItem('Open');
      expect(names(host)).toEqual(['q3.pdf']);
    });

    it.each([
      ['downloads the file', 'Download', () => {
        expect(menu()).toBeNull();
        expect(assign).toHaveBeenCalledWith('https://links.test/reports/q3.pdf');
      }],
      ['copies the file’s path', 'Copy path', () => expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('reports/q3.pdf')],
    ])('%s', async (_, item, expectDone) => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
      try {
        const host = await app(entry('reports/q3.pdf'));
        await press(host, 'reports', 2);
        await contextMenu(host, 'q3.pdf');
        await menuItem(item);
        expectDone();
      } finally {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    });

    it('opens from the context-menu key on a focused row, its first item focused, and gives focus back on Escape', async () => {
      const host = await app(entry('report.csv'));
      const row = rowOf(host, 'report.csv');
      row.focus();
      // The browser sends the row a contextmenu event for the context-menu key and Shift+F10.
      await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      expect(document.activeElement?.textContent).toBe('Open');
      await escape();
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(row);
    });
  });

  describe('deleting a file', () => {
    const askToDelete = async (host: HTMLElement, name: string) => {
      await contextMenu(host, name);
      await menuItem('Delete');
    };

    it('deletes once the dialog confirms, then lists Files again; Cancel deletes nothing', async () => {
      const host = await app(entry('reports/q3.pdf'), entry('reports/q2.pdf'));
      await press(host, 'reports', 2);
      await askToDelete(host, 'q3.pdf');
      expect(dialog()?.textContent).toContain('Delete file');
      expect(dialog()?.textContent).toContain("Delete “q3.pdf”? This can't be undone.");
      await clickOn(dialogButton('Cancel'));
      await gone();
      expect(calls).toEqual(listings(2));

      await press(host, 'q3.pdf');
      await clickOn(command('Delete'));
      await clickOn(dialogButton('Delete'));
      await gone();
      expect(names(host)).toEqual(['q2.pdf']);
      expect(calls.slice(2)).toEqual(['DELETE https://chat.test/files?name=reports%2Fq3.pdf', 'GET https://chat.test/files']);
    });

    it("opens its dialog on the window's theme alone, not on a copy of the window that whites out the page", async () => {
      stored.push(entry('notes.txt'));
      const windows = [{ app: 'Files' as const, title: 'Files', children: React.createElement(FilesApp, CHAT) }];
      const Desktop = ({ windows: shown }: { windows: readonly DesktopWindow[] }) => React.createElement(WindowsDesktop, { windows: shown, desktop: useDesktopWindows('Files'), interactive: true });
      const host = await render(React.createElement(Desktop, { windows }));
      await press(host, 'notes.txt');
      await clickOn(command('Delete'));
      const surface = found(dialog(), 'dialog');
      // Fluent's Portal mounts the dialog on a node of its own under the body, with the classes of the providers above it.
      let mount: Element = surface;
      while (mount.parentElement !== null && mount.parentElement !== document.body) mount = mount.parentElement;
      const provider = (element: Element | null | undefined) => element != null && [...element.classList].some((name) => name.startsWith('fui-FluentProvider'));
      expect(mount).not.toBe(host);
      expect(provider(mount)).toBe(true);
      expect(mount.classList.contains('agent-computer-windows-window')).toBe(false);
      expect(mount.classList.contains('agent-computer-fluent')).toBe(true);
      // Fluent's own mount node sits at the top, as wide as the page and with no height.
      const place = getComputedStyle(mount);
      expect([place.bottom, place.height]).toEqual(['', '']);
      const frame = host.querySelector('.agent-computer-windows-window');
      expect(provider(frame?.parentElement)).toBe(true);
      expect(frame?.parentElement?.classList.contains('agent-computer-windows-window')).toBe(false);
      expect((frame?.parentElement as HTMLElement | null)?.style.display).toBe('contents');
    });

    it('takes a deleted file away at once, and keeps it out of a listing that answers late', async () => {
      const host = await app(entry('report.csv'), entry('notes.txt'));
      const release = holdFetch((_, init) => init?.method === 'DELETE', true);
      await askToDelete(host, 'report.csv');
      await clickOn(dialogButton('Delete'));
      await gone();
      expect(names(host)).toEqual(['notes.txt']);
      await release();
      expect(names(host)).toEqual(['notes.txt']);
    });

    it("says why a delete was refused, shows the file again, and gives its row focus", async () => {
      const host = await app(entry('report.csv'));
      await askToDelete(host, 'report.csv');
      expect(document.activeElement?.textContent).toBe('Cancel');
      failing = 404;
      await clickOn(dialogButton('Delete'));
      await gone();
      expect(alertText(host)).toBe('refused');
      expect(names(host)).toEqual(['report.csv']);
      expect(document.activeElement).toBe(rowOf(host, 'report.csv'));
    });

    it('gives focus back to the command that opened the dialog once Cancel closes it from the keyboard', async () => {
      const host = await app(entry('report.csv'));
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
    const renamingQ3 = async () => {
      const host = await app(entry('reports/q3.pdf', 12), entry('reports/q2.pdf', 12));
      await press(host, 'reports', 2);
      return { host, input: await rename(host, 'q3.pdf') };
    };

    it('edits the name in place with its stem selected, and commits once on Enter, then lists Files again', async () => {
      const { host, input } = await renamingQ3();
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
      const { host, input } = await renamingQ3();
      await typeName(input, '四半期.pdf', 'Enter', { isComposing: true });
      expect(renames()).toEqual([]);
      expect(field(host)).toBe(input);
    });

    it('commits on blur', async () => {
      const { host, input } = await renamingQ3();
      await typeName(input, 'q4.pdf');
      await act(async () => input.blur());
      expect(renames()).toEqual(['renamed reports/q3.pdf to reports/q4.pdf']);
      expect(names(host)).toEqual(['q2.pdf', 'q4.pdf']);
    });

    it('cancels on Escape, and commits nothing for an unchanged name', async () => {
      const { host, input } = await renamingQ3();
      await typeName(input, 'q4.pdf', 'Escape');
      await act(async () => input.blur());
      expect(field(host)).toBeNull();
      expect(names(host)).toEqual(['q2.pdf', 'q3.pdf']);
      await typeName(await rename(host, 'q3.pdf'), 'q3.pdf', 'Enter');
      expect(field(host)).toBeNull();
      expect(calls).toEqual(listings(2));
    });

    it('refuses a typed `/` without calling the Chat Service, and says why', async () => {
      const { host, input } = await renamingQ3();
      await typeName(input, 'drafts/q3.pdf', 'Enter');
      expect(alertText(host)).toBe('A file name can’t contain “/”.');
      expect(calls).toEqual(listings(2));
    });

    it('shows the new name at once and keeps the file selected, and takes it back when the Chat Service refuses', async () => {
      const { host, input } = await renamingQ3();
      const release = holdFetch((url) => new URL(url).pathname === '/files/rename');
      await typeName(input, 'q4.pdf', 'Enter');
      expect(names(host)).toEqual(['q2.pdf', 'q4.pdf']);
      expect(selected(host)).toEqual(['q4.pdf']);
      failing = 409;
      await release();
      expect(alertText(host)).toBe('refused');
      expect(names(host)).toEqual(['q2.pdf', 'q3.pdf']);
    });

    it("keeps the row's own shortcuts out of the field: a double-click edits, the context-menu key types", async () => {
      const { host, input } = await renamingQ3();
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

  describe('cutting or copying a file, and pasting it', () => {
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
      const host = await app(entry('reports/a.md'));
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
      expect(renames()).toEqual([]);
      expect(command('Paste').disabled).toBe(true);
    });

    it('copies a file into the folder it is pasted in, keeping the original and the copy to paste again', async () => {
      const host = await app();
      await tree.open(host, 'notes');
      await contextMenu(host, 'a.md');
      await menuItem('Copy');
      await tree.open(host, 'reports');
      await clickOn(command('Paste'));
      await settled();
      expect(calls).toContain('copied notes/a.md to reports/a.md');
      expect(names(host)).toEqual(['a.md', 'b.pdf']);
      expect(selected(host)).toEqual(['a.md']);
      expect(command('Paste').disabled).toBe(false);
      await clickOn(command('Paste'));
      await settled();
      expect(calls).toContain('copied notes/a.md to reports/a (2).md');
      expect(selected(host)).toEqual(['a (2).md']);
    });

    it('copies on Ctrl+C and pastes on Ctrl+V, a copy beside its file named as Windows names it, then selected', async () => {
      const host = await app();
      await press(host, 'top.txt');
      expect(command('Copy').disabled).toBe(false);
      await key(rowOf(host, 'top.txt'), '{Control>}c{/Control}');
      await key(rowOf(host, 'top.txt'), '{Control>}v{/Control}');
      await settled();
      expect(calls).toContain('copied top.txt to top - Copy.txt');
      expect(names(host)).toEqual(['notes', 'reports', 'top - Copy.txt', 'top.txt']);
      expect(selected(host)).toEqual(['top - Copy.txt']);
      await key(rowOf(host, 'top - Copy.txt'), '{Control>}v{/Control}');
      await settled();
      expect(calls).toContain('copied top.txt to top - Copy (2).txt');
      expect(selected(host)).toEqual(['top - Copy (2).txt']);
    });
  });

  describe('making a folder', () => {
    it('makes New folder in the open folder from New, at once, its name ready to type over', async () => {
      const host = await app(entry('reports/q3.pdf'));
      await tree.open(host, 'reports');
      await clickOn(command('New'));
      expect(menuItems()).toEqual(['Folder', 'Upload']);
      await menuItem('Folder');
      // Its row shows at once, as its name field.
      expect(names(host)).toEqual(['', 'q3.pdf']);
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Rename New folder');
      expect((document.activeElement as HTMLInputElement).value).toBe('New folder');
      // Its name stays open to type while it is made and Files lists again.
      await settled();
      expect(calls).toContain('made reports/New folder');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Rename New folder');
      await typeName(field(host), null, 'Escape');
      await settled();
      expect(calls).toContain('made reports/New folder');
      expect(names(host)).toEqual(['New folder', 'q3.pdf']);
    });

    it('names a second one New folder (2), on Ctrl+Shift+N', async () => {
      emptyFolders.push({ name: 'New folder', lastModified: '2026-10-01T09:00:00.000Z' });
      const host = await app(entry('top.txt'));
      await key(rowOf(host, 'top.txt'), '{Control>}{Shift>}N{/Shift}{/Control}');
      await typeName(field(host), null, 'Escape');
      await settled();
      expect(calls).toContain('made New folder (2)');
      expect(names(host)).toEqual(['New folder', 'New folder (2)', 'top.txt']);
    });

    it('renames the new folder to the name typed, after it is made', async () => {
      const host = await app();
      await clickOn(command('New'));
      await menuItem('Folder');
      await typeName(field(host), 'drafts', 'Enter');
      expect(names(host)).toEqual(['drafts']);
      await settled();
      expect(calls.filter((call) => /^(made|renamed) /.test(call))).toEqual(['made New folder', 'renamed New folder to drafts']);
      expect(names(host)).toEqual(['drafts']);
    });

    it('is off in Home', async () => {
      await tree.open(await app(), 'Home');
      await clickOn(command('New'));
      expect(findMenuItem('Folder')?.getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('copying and pasting a folder', () => {
    beforeEach(() => {
      stored.push(entry('notes/a.md'), entry('reports/2026/q1.csv'), entry('reports/b.pdf'));
    });

    it('copies a folder with everything in it beside itself as Windows names it, then selected, and again', async () => {
      const host = await app();
      await contextMenu(host, 'reports');
      await menuItem('Copy');
      await clickOn(command('Paste'));
      await settled();
      expect(calls).toContain('copied reports to reports - Copy');
      expect(names(host)).toEqual(['notes', 'reports', 'reports - Copy']);
      expect(selected(host)).toEqual(['reports - Copy']);
      expect(stored.map(({ name }) => name).filter((name) => name.startsWith('reports - Copy/')).sort()).toEqual(['reports - Copy/2026/q1.csv', 'reports - Copy/b.pdf']);
      await key(rowOf(host, 'reports - Copy'), '{Control>}v{/Control}');
      await settled();
      expect(calls).toContain('copied reports to reports - Copy (2)');
      expect(selected(host)).toEqual(['reports - Copy (2)']);
    });

    it('copies on Ctrl+C into another folder under its own name, then "name (2)", and never into itself', async () => {
      const host = await app(entry('notes/reports/old.txt'));
      await press(host, 'reports');
      expect(command('Copy').disabled).toBe(false);
      await key(rowOf(host, 'reports'), '{Control>}c{/Control}');
      await tree.open(host, 'notes');
      await clickOn(command('Paste'));
      await settled();
      expect(calls).toContain('copied reports to notes/reports (2)');
      expect(names(host)).toEqual(['reports', 'reports (2)', 'a.md']);
      expect(selected(host)).toEqual(['reports (2)']);

      await tree.open(host, 'reports');
      await press(host, '2026', 2);
      await clickOn(command('Paste'));
      await settled();
      expect(calls.filter((call) => call.startsWith('copied reports to reports/'))).toEqual([]);
      expect(host.textContent).toContain("reports can't be copied into itself");
    });
  });

  describe('uploading files', () => {
    const pending = () => {
      const started: { file: File; options: UploadOptions; folder: string; settle: (path: string) => void }[] = [];
      const onUpload = vi.fn((each: File, options: UploadOptions, folder: string) => new Promise<string>((resolve, reject) => {
        started.push({ file: each, options, folder, settle: resolve });
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      const chosen = () => started.map(({ file: each, folder }) => [each.name, folder]);
      return { started, onUpload, chosen };
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
      const { started, onUpload, chosen } = pending();
      const { host } = await windowWith({ files: [entry('reports/q3.pdf')], onUpload });
      await press(host, 'reports', 2);
      await choose([file]);
      expect(chosen()).toEqual([['plan.txt', 'reports/']]);
      expect(progress(host)).toEqual([['Uploading plan.txt', '0']]);
      await act(async () => started[0]?.options.onProgress(0.5));
      expect(progress(host)).toEqual([['Uploading plan.txt', '0.5']]);
      await act(async () => started[0]?.settle('reports/plan.txt'));
      expect(progress(host)).toEqual([]);
    });

    it('cancels an upload from its row', async () => {
      const { started, onUpload } = pending();
      const { host } = await windowWith({ onUpload });
      await choose([file]);
      await clickOn(buttonIn(host, 'Cancel upload plan.txt'));
      expect(started[0]?.options.signal.aborted).toBe(true);
      await vi.waitFor(() => expect(progress(host)).toEqual([]));
    });

    it('uploads files dropped on the list into workspace from Home', async () => {
      const { onUpload, chosen } = pending();
      const { host } = await windowWith({ files: [entry('notes.txt')], onUpload });
      await tree.open(host, 'Home');
      const area = listArea(host);
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
      expect(chosen()).toEqual([['plan.txt', '']]);
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

describe('File Explorer’s views, selection, panes, tabs and keys', () => {
  describe('View', () => {
    const pictureOf = (card: Element) => {
      const picture = card.querySelector('img');
      return picture !== null && onScreen(picture) && picture.dataset.loading === undefined ? picture.getAttribute('src') : 'icon';
    };
    const downloadLinks = () => calls.filter((call) => call.includes('download-url'));

    it('opens a folder of mostly pictures in Large icons, each picture its own once loaded, the rest in Details', async () => {
      const host = await app(entry('photos/a.png'), entry('photos/b.jpg'), entry('photos/notes.txt'), entry('notes.txt'));
      expect(rows(host).every((row) => row.getAttribute('role') === 'row' && row.classList.contains('fui-DataGridRow'))).toBe(true);
      expect(downloadLinks()).toEqual([]);
      await press(host, 'photos', 2);
      expect(cards(host).map(nameOf)).toEqual(['a.png', 'b.jpg', 'notes.txt']);
      expect(host.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')).toBe('true');
      await settledUntil(() => downloadLinks().length === 2, 20);
      expect(downloadLinks()).toEqual(['GET https://chat.test/files/download-url?name=photos%2Fa.png', 'GET https://chat.test/files/download-url?name=photos%2Fb.jpg']);
      // Each picture keeps its type icon until it loads; one the browser can't show keeps it for good.
      expect(cards(host).map(pictureOf)).toEqual(['icon', 'icon', 'icon']);
      const [first, second] = cards(host).map((card) => card.querySelector('img'));
      await act(async () => {
        first?.dispatchEvent(new Event('load'));
        second?.dispatchEvent(new Event('error'));
      });
      expect(cards(host).map(pictureOf)).toEqual(['https://links.test/photos/a.png', 'icon', 'icon']);
    });

    it('lists the eight views, the current one checked, and keeps a folder’s chosen view for the session', async () => {
      const host = await app(entry('reports/q3.pdf'), entry('notes.txt'));
      await clickOn(command('View'));
      expect(checks('menuitemradio')).toEqual(['○ Extra large icons', '○ Large icons', '○ Medium icons', '○ Small icons', '○ List', '● Details', '○ Tiles', '○ Content']);
      await choose('menuitemradio', 'Tiles');
      await escape();
      expect(cards(host).map(nameOf)).toEqual(['reports', 'notes.txt']);
      expect(cards(host).map((card) => [...card.querySelectorAll('.fui-CardHeader__description .fui-Text')].map((line) => line.textContent))).toEqual([['File folder'], ['TXT File', '1 KB']]);
      await press(host, 'reports', 2);
      expect(names(host)).toEqual(['q3.pdf']);
      expect(cards(host)).toEqual([]);
      await clickOn(address('Back'));
      expect(cards(host).map(nameOf)).toEqual(['reports', 'notes.txt']);
    });

    it('opens a card on a double-click or Enter, and gives it the row’s menu', async () => {
      const host = await app(entry('reports/q3.pdf'), entry('notes.txt'));
      await pick('View', 'Medium icons');
      await press(host, 'notes.txt', 2);
      expect(assign).toHaveBeenCalledWith('https://links.test/notes.txt');
      await contextMenu(host, 'notes.txt');
      expect(menuItems()).toEqual(FILE_MENU);
      await menuItem('Rename');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Rename notes.txt');
      await key(document.activeElement, '{Escape}');
      await key(rowOf(host, 'reports'), '{Enter}');
      expect(names(host)).toEqual(['q3.pdf']);
    });
  });

  describe('Sort and Group by', () => {
    const groupNames = (host: HTMLElement) => [...host.querySelectorAll('.fui-AccordionHeader')].filter((header) => onScreen(header)).map((header) => header.textContent);

    it('sorts from the Sort menu, sharing its sort with the column headers', async () => {
      const host = await app(entry('b.txt', 5000), entry('a.md', 9000), entry('c.png', 10));
      await clickOn(command('Sort'));
      expect(checks('menuitemradio')).toEqual(['● Name', '○ Date modified', '○ Type', '○ Size', '● Ascending', '○ Descending']);
      await choose('menuitemradio', 'Size');
      await escape();
      expect(names(host)).toEqual(['c.png', 'b.txt', 'a.md']);
      await pick('Sort', 'Descending');
      expect(names(host)).toEqual(['a.md', 'b.txt', 'c.png']);
      await sortOn(host, 'Type');
      await vi.waitFor(() => expect(names(host)).toEqual(['a.md', 'c.png', 'b.txt']));
      await clickOn(command('Sort'));
      expect(checks('menuitemradio').slice(0, 6)).toEqual(['○ Name', '○ Date modified', '● Type', '○ Size', '● Ascending', '○ Descending']);
    });

    it('groups by type into open sections under one row of headers, in Details and in icon views', async () => {
      const host = await app(entry('b.txt'), entry('a.md'), entry('c.txt'), entry('docs/x.txt'));
      await clickOn(command('Sort'));
      await menuItem('Group by');
      expect(checks('menuitemradio').slice(-5)).toEqual(['● None', '○ Name', '○ Date modified', '○ Type', '○ Size']);
      await choose('menuitemradio', 'Type');
      await escape();
      expect(groupNames(host)).toEqual(['File folder (1)', 'MD File (1)', 'TXT File (2)']);
      expect(names(host)).toEqual(['docs', 'a.md', 'b.txt', 'c.txt']);
      expect(visibleHeaders(host)).toEqual(['Name', 'Date modified', 'Type', 'Size']);
      // A section's header folds it away.
      await clickOn(host.querySelector<HTMLElement>('.fui-AccordionHeader button') ?? host);
      await settledUntil(() => names(host).length === 3, 100);
      expect(names(host)).toEqual(['a.md', 'b.txt', 'c.txt']);

      await pick('View', 'Large icons');
      expect(groupNames(host)).toEqual(['File folder (1)', 'MD File (1)', 'TXT File (2)']);
      expect(visibleHeaders(host)).toEqual([]);
      expect(cards(host).map(nameOf)).toEqual(['a.md', 'b.txt', 'c.txt']);
    });

    it('groups dates as Explorer does, names by letter ranges and sizes by bucket', () => {
      const now = new Date(2026, 9, 15, 12);
      const at = (day: number) => new Date(2026, 9, day, 9).toISOString();
      const items = itemsIn([
        entry('today.txt', 1, at(15)), entry('monday.txt', 20_000, at(12)), entry('last-week.txt', 2_000_000, at(6)),
        entry('month.txt', 200_000_000, at(2)), entry('old.txt', 1, new Date(2026, 8, 30).toISOString()), entry('9lives.txt'),
      ], '');
      expect(groupsOf(items, 'modified', now).map(({ label, items: inside }) => [label, inside.map(({ name }) => name)])).toEqual([
        ['Today (1)', ['today.txt']],
        ['Earlier this week (1)', ['monday.txt']],
        ['Last week (1)', ['last-week.txt']],
        ['Earlier this month (2)', ['month.txt', '9lives.txt']],
        ['Older (1)', ['old.txt']],
      ]);
      expect(groupsOf(items, 'name', now).map(({ label }) => label)).toEqual(['0–9 (1)', 'I–P (4)', 'Q–Z (1)']);
      expect(groupsOf(items, 'size', now).map(({ label }) => label)).toEqual(['Tiny (3)', 'Small (1)', 'Medium (1)', 'Large (1)']);
    });
  });

  describe('selecting several items', () => {
    beforeEach(() => {
      stored.push(entry('a.txt', 1024), entry('b.txt', 2048), entry('c.txt', 4096), entry('d.txt', 1024), entry('docs/x.txt'));
    });
    const appWith = async (...picked: string[]) => {
      const host = await app();
      const [first, ...rest] = picked;
      if (first !== undefined) await press(host, first);
      await rest.reduce(async (before, name) => { await before; await ctrlClick(host, name); }, Promise.resolve());
      return host;
    };
    const fromSeeMore = async (item: string) => {
      await clickOn(command('See more'));
      await menuItem(item);
    };

    it('adds with Ctrl, takes a range with Shift, and selects all with Ctrl+A', async () => {
      const host = await appWith('a.txt', 'c.txt');
      expect(selected(host)).toEqual(['a.txt', 'c.txt']);
      expect(status(host)).toEqual(['5 items', '2 items selected', '5 KB']);
      // Shift takes the range from the item clicked last, even one a Ctrl+click left out.
      await ctrlClick(host, 'a.txt');
      expect(selected(host)).toEqual(['c.txt']);
      await ctrlClick(host, 'c.txt', { shiftKey: true });
      expect(selected(host)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      await ctrlClick(host, 'docs', { shiftKey: true, ctrlKey: true });
      expect(selected(host)).toEqual(['docs', 'a.txt', 'b.txt', 'c.txt']);
      await key(rowOf(host, 'a.txt'), '{Control>}a{/Control}');
      expect(selected(host)).toEqual(['docs', 'a.txt', 'b.txt', 'c.txt', 'd.txt']);
      expect(command('Rename').disabled).toBe(true);
      expect([command('Cut').disabled, command('Download').disabled, command('Delete').disabled]).toEqual([false, false, false]);
    });

    it('selects none, or the others, from See more', async () => {
      const host = await appWith('a.txt', 'b.txt');
      await fromSeeMore('Invert selection');
      expect(selected(host)).toEqual(['docs', 'c.txt', 'd.txt']);
      await fromSeeMore('Select none');
      expect(selected(host)).toEqual([]);
      await fromSeeMore('Select all');
      expect(selected(host)).toHaveLength(5);
    });

    it('deletes every selected file once one dialog confirms, and downloads each', async () => {
      const host = await appWith('a.txt', 'b.txt', 'd.txt');
      await clickOn(command('Download'));
      expect(assign.mock.calls.map(([url]) => url)).toEqual(['https://links.test/a.txt', 'https://links.test/b.txt', 'https://links.test/d.txt']);
      await contextMenu(host, 'b.txt');
      expect(selected(host)).toEqual(['a.txt', 'b.txt', 'd.txt']);
      expect(findMenuItem('Rename')?.getAttribute('aria-disabled')).toBe('true');
      await menuItem('Delete');
      expect(dialog()?.textContent).toContain("Delete 3 items? This can't be undone.");
      await clickOn(dialogButton('Delete'));
      await gone();
      expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual([
        'DELETE https://chat.test/files?name=a.txt', 'DELETE https://chat.test/files?name=b.txt', 'DELETE https://chat.test/files?name=d.txt',
      ]);
      expect(names(host)).toEqual(['docs', 'c.txt']);
    });

    it('cuts every selected file, and pastes them all into another folder', async () => {
      const host = await appWith('a.txt', 'b.txt');
      await clickOn(command('Cut'));
      await tree.open(host, 'docs');
      await clickOn(command('Paste'));
      expect(renames()).toEqual(['renamed a.txt to docs/a.txt', 'renamed b.txt to docs/b.txt']);
    });

    it('shows Properties of one item, of several, and of the open folder', async () => {
      const host = await app();
      await contextMenu(host, 'b.txt');
      await menuItem('Properties');
      expect(shownDialog()?.textContent).toBe('b.txt PropertiesTypeTXT FileLocationworkspaceSize2 KBModified10/1/26, 9:00 AMOK');
      await closeProperties();
      await press(host, 'a.txt');
      await ctrlClick(host, 'c.txt');
      await fromSeeMore('Properties');
      expect(shownDialog()?.textContent).toBe('2 items PropertiesTypeAll of type TXT FileLocationAll in workspaceSize5 KBOK');
    });
  });

  describe('the Details and Preview panes', () => {
    const openShow = async () => {
      await clickOn(command('View'));
      await menuItem('Show');
    };
    const show = async (label: string) => {
      await openShow();
      await choose('menuitemcheckbox', label);
      await escape();
    };
    const pane = <T extends Element = Element>(label: string) => document.querySelector<T>(`[aria-label="${label}"].fui-InlineDrawer`);

    it('shows the selected item’s details beside the list, else the open folder’s', async () => {
      const { host } = await windowWith({ files: [entry('reports/q3.pdf', 3000), entry('notes.txt', 2048)] });
      await show('Details pane');
      expect(pane('Details pane')?.textContent).toContain('workspaceTypeFile folderLocation—Size5 KBContains2 items');
      await press(host, 'notes.txt');
      expect(pane('Details pane')?.textContent).toContain('notes.txtTypeTXT FileLocationworkspaceSize2 KBModified10/1/26, 9:00 AM');
      await openShow();
      expect(checks('menuitemcheckbox')).toEqual(['● Details pane', '○ Preview pane']);
    });

    it('previews a picture as itself, and any other file as No preview available with its Download', async () => {
      const { host, props } = await windowWith({ files: [entry('curve.png'), entry('notes.txt')] });
      await show('Preview pane');
      expect(pane('Preview pane')?.textContent).toContain('Select a file to preview.');
      expect(pane('Details pane')).toBeNull();
      await press(host, 'curve.png');
      await settledUntil(() => pane('Preview pane')?.querySelector('img[src]') != null, 20);
      expect(pane('Preview pane')?.querySelector('img')?.getAttribute('src')).toBe('https://links.test/chart');
      await press(host, 'notes.txt');
      await settled();
      expect(pane('Preview pane')?.textContent).toContain('No preview available.');
      await clickOn(buttonIn(pane('Preview pane') ?? document, 'Download'));
      expect(props.onDownload).toHaveBeenCalledExactlyOnceWith('notes.txt');
    });

    it('shows the Preview pane on Alt+P and the Details pane on Alt+Shift+P, each again hiding it', async () => {
      const { host } = await windowWith({ files: [entry('notes.txt')] });
      const showing = () => ['Details pane', 'Preview pane'].filter((label) => { const shown = pane(label); return shown !== null && onScreen(shown); });
      await key(rowOf(host, 'notes.txt'), '{Alt>}p{/Alt}');
      expect(showing()).toEqual(['Preview pane']);
      // A pane that closes stays a moment as it slides away.
      await key(rowOf(host, 'notes.txt'), '{Alt>}{Shift>}p{/Shift}{/Alt}');
      await settledUntil(() => showing().length === 1, 50);
      expect(showing()).toEqual(['Details pane']);
      await key(rowOf(host, 'notes.txt'), '{Alt>}{Shift>}p{/Shift}{/Alt}');
      await settledUntil(() => showing().length === 0, 50);
      expect(showing()).toEqual([]);
    });

    it('resizes the navigation and Details panes by a drag of their dividers or the arrow keys, within their bounds', async () => {
      // The DOM here lays nothing out: a pane measures as wide as its size variable says, else its starting width.
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const style = this instanceof HTMLElement ? this.style : null;
        const width = parseFloat(style?.getPropertyValue('--explorer-nav-size') || style?.getPropertyValue('--fui-Drawer--size') || '')
          || (this.tagName === 'NAV' ? 200 : 320);
        return DOMRect.fromRect({ width, height: 600 });
      });
      const { host } = await windowWith({ files: [entry('notes.txt')] });
      const nav = found(host.querySelector<HTMLElement>('nav[aria-label="Folders"]'), 'navigation pane');
      const divider = found(host.querySelector<HTMLElement>('[aria-label="Resize navigation pane"]'), 'navigation pane divider');
      const navSize = () => nav.style.getPropertyValue('--explorer-nav-size');
      const drag = async (handle: HTMLElement, from: number, to: number) => act(async () => {
        handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from, button: 0 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: to, button: 0 }));
      });
      await drag(divider, 200, 260);
      expect(navSize()).toBe('260px');
      await drag(divider, 260, 900);
      expect(navSize()).toBe('400px');
      await key(divider, '{ArrowLeft}');
      expect(navSize()).toBe('380px');
      await key(divider, '{ArrowLeft>20/}');
      expect(navSize()).toBe('120px');

      await key(rowOf(host, 'notes.txt'), '{Alt>}{Shift>}p{/Shift}{/Alt}');
      const details = found(pane<HTMLElement>('Details pane'), 'Details pane');
      const edge = found(host.querySelector<HTMLElement>('[aria-label="Resize details pane"]'), 'Details pane divider');
      const detailsSize = () => details.style.getPropertyValue('--fui-Drawer--size');
      // The pane is at the window's end: its divider grows it to the left.
      await drag(edge, 900, 800);
      expect(detailsSize()).toBe('420px');
      await key(edge, '{ArrowRight>20/}');
      expect(detailsSize()).toBe('200px');
      await drag(edge, 900, 100);
      expect(detailsSize()).toBe('560px');
    });
  });

  describe('tabs', () => {
    const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tab"]')]
      .map((tab) => `${tab.getAttribute('aria-selected') === 'true' ? '●' : '○'} ${tab.querySelector('.fui-Tab__content')?.textContent}`);
    const reportsThenNewTab = async () => {
      const host = await app(entry('reports/q3.pdf'));
      await press(host, 'reports', 2);
      await key(rowOf(host, 'q3.pdf'), '{Control>}t{/Control}');
      expect(tabs(host)).toEqual(['○ reports', '● workspace']);
      return host;
    };

    it('opens workspace in a new tab, each tab its own place and history, and closes them', async () => {
      const host = await app(entry('reports/q3.pdf'), entry('notes.txt'));
      expect(tabs(host)).toEqual(['● workspace']);
      await press(host, 'reports', 2);
      expect(tabs(host)).toEqual(['● reports']);
      await clickOn(address('New tab'));
      expect(tabs(host)).toEqual(['○ reports', '● workspace']);
      expect(names(host)).toEqual(['reports', 'notes.txt']);
      expect(path.names(host).filter(Boolean)).toContain('workspace');
      await clickOn(host.querySelectorAll<HTMLElement>('[role="tab"]')[0] ?? host);
      expect(names(host)).toEqual(['q3.pdf']);
      await clickOn(address('Close tab reports'));
      expect(tabs(host)).toEqual(['● workspace']);
      expect(names(host)).toEqual(['reports', 'notes.txt']);
    });

    it('opens a tab on Ctrl+T and closes one on Ctrl+W, leaving workspace when the last closes', async () => {
      const host = await reportsThenNewTab();
      await key(rowOf(host, 'reports'), '{Control>}w{/Control}');
      expect(tabs(host)).toEqual(['● reports']);
      await key(rowOf(host, 'q3.pdf'), '{Control>}w{/Control}');
      expect(tabs(host)).toEqual(['● workspace']);
      expect(names(host)).toEqual(['reports']);
    });

    it('moves to the next tab on Ctrl+Tab and back on Ctrl+Shift+Tab, round from the last', async () => {
      const host = await reportsThenNewTab();
      const switched = async (row: string, keys: string) => {
        await key(rowOf(host, row), keys);
        return tabs(host);
      };
      expect(await switched('reports', '{Control>}{Tab}{/Control}')).toEqual(['● reports', '○ workspace']);
      expect(await switched('q3.pdf', '{Control>}{Shift>}{Tab}{/Shift}{/Control}')).toEqual(['○ reports', '● workspace']);
      expect(await switched('reports', '{Control>}{Tab}{/Control}')).toEqual(['● reports', '○ workspace']);
    });
  });

  it('opens the open folder’s menu on a right-click of the list’s empty space with View, Sort by, Group by, Refresh, Paste, Upload and Properties', async () => {
    const host = await app(entry('reports/q3.pdf', 2048), entry('notes.txt', 1024));
    const rightClick = () => act(async () => listArea(host).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 })));
    await rightClick();
    expect(menuItems()).toEqual(FOLDER_MENU);
    await menuItem('Refresh');
    expect(calls).toEqual(listings(2));
    await rightClick();
    await menuItem('Properties');
    expect(shownDialog()?.textContent).toContain('workspace PropertiesTypeFile folder');
    expect(shownDialog()?.textContent).toContain('Size3 KBContains2 items');
  });

  describe('keys', () => {
    beforeEach(() => {
      stored.push(entry('reports/2026/q3.pdf'), entry('notes.txt'), entry('nine.txt'), entry('plan.md'));
    });

    it('renames on F2 and asks to delete on Delete', async () => {
      const host = await app();
      await press(host, 'plan.md');
      await key(rowOf(host, 'plan.md'), '{F2}');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Rename plan.md');
      await key(document.activeElement, '{Escape}');
      await key(rowOf(host, 'plan.md'), '{Delete}');
      expect(dialog()?.textContent).toContain('Delete “plan.md”?');
    });

    it('goes Back on Alt+Left, Forward on Alt+Right, up on Backspace and Alt+Up, and reloads on F5', async () => {
      const host = await app();
      await press(host, 'reports', 2);
      await press(host, '2026', 2);
      const go = async (row: string, keys: string) => {
        await key(rowOf(host, row), keys);
        return path.current(host);
      };
      expect(await go('q3.pdf', '{Alt>}{ArrowLeft}{/Alt}')).toBe('reports');
      expect(await go('2026', '{Alt>}{ArrowRight}{/Alt}')).toBe('2026');
      expect(await go('q3.pdf', '{Backspace}')).toBe('reports');
      expect(await go('2026', '{Alt>}{ArrowUp}{/Alt}')).toBe('workspace');
      const before = calls.length;
      await key(rowOf(host, 'reports'), '{F5}');
      expect(calls.slice(before)).toEqual(['GET https://chat.test/files']);
    });

    it.each([
      ['search', 'Ctrl+F', '{Control>}f{/Control}'],
      ['search', 'Ctrl+E', '{Control>}e{/Control}'],
      ['address', 'Ctrl+L', '{Control>}l{/Control}'],
      ['address', 'Alt+D', '{Alt>}d{/Alt}'],
      ['address', 'F4', '{F4}'],
    ])('focuses the %s on %s', async (target, _, keys) => {
      const host = await app();
      await key(rowOf(host, 'notes.txt'), keys);
      if (target === 'search') expect(document.activeElement).toBe(searchBox(host));
      else expect(document.activeElement?.textContent).toBe('workspace');
    });

    it('opens on Enter and shows Properties on Alt+Enter', async () => {
      const host = await app();
      await press(host, 'notes.txt');
      await key(rowOf(host, 'notes.txt'), '{Alt>}{Enter}{/Alt}');
      expect(shownDialog()?.textContent).toContain('notes.txt PropertiesTypeTXT File');
      expect(assign).not.toHaveBeenCalled();
      await closeProperties();
      await key(rowOf(host, 'reports'), '{Enter}');
      expect(names(host)).toEqual(['2026']);
    });

    it('switches to the eight views on Ctrl+Shift+1 to 8, in Windows’ order', async () => {
      const host = await app();
      const views = ['Extra large icons', 'Large icons', 'Medium icons', 'Small icons', 'List', 'Details', 'Tiles', 'Content'];
      const viewed = async (index: number) => {
        await key(rows(host)[0] ?? null, `{Control>}{Shift>}${index + 1}{/Shift}{/Control}`);
        return currentView();
      };
      const seen = await views.reduce<Promise<string[][]>>(async (before, _, index) => [...(await before), await viewed(index)], Promise.resolve([]));
      expect(seen).toEqual(views.map((view) => [`● ${view}`]));
    });

    it('steps the icons larger as Ctrl and the wheel roll up, and smaller as they roll down', async () => {
      const host = await app();
      const roll = async (deltaY: number, ctrlKey = true) => {
        const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
        // The test DOM's wheel event keeps no modifier keys: the roll holds Ctrl as a browser's would.
        Object.defineProperty(event, 'ctrlKey', { value: ctrlKey });
        await act(async () => listArea(host).dispatchEvent(event));
        return event.defaultPrevented;
      };
      expect(await roll(-100)).toBe(true);
      expect(await currentView()).toEqual(['● List']);
      await roll(-100);
      await roll(-100);
      expect(await currentView()).toEqual(['● Medium icons']);
      await roll(100);
      expect(await currentView()).toEqual(['● Small icons']);
      expect(await roll(-100, false)).toBe(false);
      expect(await currentView()).toEqual(['● Small icons']);
    });

    it('opens the selection’s menu on Shift+F10 and the menu key, and the folder’s with nothing selected', async () => {
      const host = await app();
      await press(host, 'plan.md');
      await key(rowOf(host, 'plan.md'), '{Shift>}{F10}{/Shift}');
      expect(menuItems()).toEqual(FILE_MENU);
      await escape();
      expect(menu()).toBeNull();
      await key(rowOf(host, 'plan.md'), '{ContextMenu}');
      expect(menuItems()).toEqual(FILE_MENU);
      await escape();
      const fresh = await app();
      await key(rowOf(fresh, 'plan.md'), '{ContextMenu}');
      expect(menuItems()).toEqual(FOLDER_MENU);
    });

    it('shows each command’s letter on Alt, and runs the command on its letter', async () => {
      const host = await app();
      const letters = () => [...document.querySelectorAll('[role="tooltip"]')].map((tip) => tip.textContent).filter(Boolean);
      await press(host, 'notes.txt');
      expect(command('Paste').disabled).toBe(true);
      await key(rowOf(host, 'notes.txt'), '{Alt}');
      // Paste has nothing to paste yet, so its letter waits.
      expect(letters().sort()).toEqual(['C', 'D', 'E', 'I', 'M', 'N', 'O', 'S', 'X']);
      await act(async () => userEvent.keyboard('x'));
      expect(letters()).toEqual([]);
      expect(command('Paste').disabled).toBe(false);
      // A letter typed with the letters gone finds an item again.
      await key(rowOf(host, 'notes.txt'), 'p');
      expect(selected(host)).toEqual(['plan.md']);
      await contextMenu(host, 'plan.md');
      await act(async () => userEvent.keyboard('{Alt}'));
      expect(letters()).toEqual(['O', 'T', 'C', 'W', 'M', 'D', 'A', 'R']);
      await act(async () => userEvent.keyboard('r'));
      expect(shownDialog()?.textContent).toContain('plan.md Properties');
    });

    it('finds an item by the letters typed, and moves the selection with the arrows', async () => {
      stillClock();
      const host = await app();
      await press(host, 'reports');
      await key(rowOf(host, 'reports'), 'n');
      expect(selected(host)).toEqual(['nine.txt']);
      expect(document.activeElement).toBe(rowOf(host, 'nine.txt'));
      // The same letter again steps to the next item it starts; more letters find the item they start.
      await key(document.activeElement, 'n');
      expect(selected(host)).toEqual(['notes.txt']);
      await key(document.activeElement, 'pl');
      expect(selected(host)).toEqual(['notes.txt']);
      const again = await app();
      await key(rowOf(again, 'reports'), 'no');
      expect(selected(again)).toEqual(['notes.txt']);

      // Fluent's arrow navigation moves focus by the rows' layout, which jsdom has none of: the test moves it as an arrow
      // would, and the selection follows.
      const arrow = async (from: string, to: string, keys: KeyboardEventInit = {}) => act(async () => {
        rowOf(host, from).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', ...keys }));
        rowOf(host, to).focus();
      });
      await arrow('nine.txt', 'notes.txt');
      expect(selected(host)).toEqual(['notes.txt']);
      await arrow('notes.txt', 'plan.md', { shiftKey: true });
      expect(selected(host)).toEqual(['notes.txt', 'plan.md']);
      // Ctrl+arrow moves focus alone; a click's focus is the click's, not an arrow's.
      await arrow('plan.md', 'reports', { ctrlKey: true });
      expect(selected(host)).toEqual(['notes.txt', 'plan.md']);
      await press(host, 'nine.txt');
      expect(selected(host)).toEqual(['nine.txt']);
    });
  });

  describe('a folder of thousands', () => {
    beforeEach(() => {
      for (let index = 0; index < 5000; index++) stored.push(entry(`item-${String(index).padStart(4, '0')}.txt`));
    });

    it('draws only the rows in view of 5,000 in Details, and scrolls a far one in for a typed name', async () => {
      const started = Date.now();
      stillClock();
      const host = await app();
      expect(rows(host).length).toBeGreaterThan(10);
      expect(rows(host).length).toBeLessThan(80);
      expect(names(host)[0]).toBe('item-0000.txt');
      // The test DOM has no layout for the grid to scroll by: a typed name scrolls it, to a row far out of view.
      await key(rows(host)[0] ?? null, 'item-4321');
      expect(selected(host)).toEqual(['item-4321.txt']);
      expect(document.activeElement).toBe(rowOf(host, 'item-4321.txt'));
      expect(rows(host).length).toBeLessThan(80);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('draws only the cards in view of 5,000 in an icon view, and brings a far one in for a typed name', async () => {
      const started = Date.now();
      stillClock();
      const host = await app();
      await pick('View', 'Medium icons');
      expect(cards(host).length).toBeGreaterThan(10);
      expect(cards(host).length).toBeLessThan(500);
      await key(cards(host)[0] ?? null, 'item-4321');
      expect(selected(host)).toEqual(['item-4321.txt']);
      expect(document.activeElement).toBe(rowOf(host, 'item-4321.txt'));
      expect(cards(host).length).toBeLessThan(500);
      // Unmeasured, the view draws a large window's worth of cards, each a full Fluent card: slower here than a browser.
      expect(Date.now() - started).toBeLessThan(10000);
    }, 20000);
  });
});
