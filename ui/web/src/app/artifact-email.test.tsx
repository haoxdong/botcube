// @vitest-environment jsdom
import { HttpAgent, type Message } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { Editor } from '@tiptap/react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { downloadAs, openDownloads } from './download-menu.testing';
import { EMAIL_ELEMENTS } from 'botcube-artifact-check/email-html';
import PostalMime from 'postal-mime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMAIL_EDITOR, EML } from './artifact-email';
import { ArtifactLayout } from './artifact-panel';

const DRAFT = {
  to: ['dana@example.com'],
  cc: ['finance@example.com'],
  subject: 'Q3 numbers for review',
  htmlBody: '<p>Hi Dana,</p><p>The Q3 review is attached.</p>',
  body: 'Hi Dana,\n\nThe Q3 review is attached.',
  attachments: [{ file: '/reports/q3 review.pdf', filename: 'Q3 review.pdf', mimeType: 'application/pdf' }],
};
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0x80]);
const PUBLISHED = {
  id: '/drafts/q3.email.json', type: 'email', title: 'Q3 numbers for review', description: 'The Q3 note to Dana', version: 1,
  path: '/artifacts/drafts/q3.email.json.versions/1.email.json',
};
const V1 = 'artifacts/drafts/q3.email.json.versions/1.email.json';
const V2 = 'artifacts/drafts/q3.email.json.versions/2.email.json';
const RECORD = 'artifacts/drafts/q3.email.json.versions/1.json';
const COPY = 'artifacts/drafts/q3.email.json.versions/imports/0a1b.pdf';
type Save = { id: string; version: number; files: Record<string, string> };

/** Each property a test redefines, with what it was, restored after the test. */
const redefined: { target: object; key: PropertyKey; was: PropertyDescriptor | undefined }[] = [];
function redefine(target: object, key: PropertyKey, value: unknown) {
  redefined.push({ target, key, was: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom has no matchMedia; the panel asks whether it is on a phone.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
  // jsdom lays nothing out; ProseMirror asks where the caret is after each keystroke.
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  redefine(Range.prototype, 'getClientRects', rects);
  redefine(Range.prototype, 'getBoundingClientRect', () => new DOMRect());
  redefine(Text.prototype, 'getClientRects', rects);
  redefine(document, 'elementFromPoint', () => null);
});
afterEach(async () => {
  // Each .eml a test started is made before its stubs go, so none saves into the next test's array.
  await Promise.allSettled(making.splice(0));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const { target, key, was } of redefined.splice(0).reverse()) {
    if (was === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, was);
  }
});

/** Files holding the draft's version 1 and its attachment, and the Chat Service's save: it stores what it is sent, or refuses. */
function draftInFiles(draft: object | string = DRAFT, refusal?: Response) {
  const record = { author: 'agent', title: PUBLISHED.title, description: PUBLISHED.description, imports: [{ edit: 0, from: '/reports/q3 review.pdf', path: `/${COPY}` }] };
  // The attachment is read from the version's copy, never from the File, which is not even there.
  const stored: Record<string, string | Uint8Array<ArrayBuffer>> = {
    [V1]: typeof draft === 'string' ? draft : JSON.stringify(draft), [RECORD]: JSON.stringify(record), [COPY]: PDF,
  };
  const saves: Save[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (new URL(input).pathname === '/files') return Response.json({ files: Object.keys(stored).map((name) => ({ name, size: 1, lastModified: '2026-11-15T18:00:00Z' })) });
    if (input.startsWith('https://files.test/')) {
      const file = stored[decodeURIComponent(input.slice('https://files.test/'.length))];
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file);
    }
    if (new URL(input).pathname === '/files/artifact-save') {
      if (refusal !== undefined) return refusal;
      const save = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Save;
      saves.push(save);
      stored[V2] = Object.values(save.files)[0] ?? '';
      return Response.json({ ...PUBLISHED, version: 2, author: 'user', path: `/${V2}` });
    }
    const name = new URL(input).searchParams.get('name') ?? '';
    return name in stored ? Response.json({ url: `https://files.test/${encodeURIComponent(name)}` }) : Response.json({ detail: `No file named ${name}` }, { status: 404 });
  }));
  return { saves, stored };
}

const published = (call: string, artifact: object) => [
  { id: `a-${call}`, role: 'assistant' as const, content: '', toolCalls: [{ id: call, type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: '/drafts/q3.email.json' }) } }] },
  { id: `t-${call}`, role: 'tool' as const, toolCallId: call, content: JSON.stringify(artifact) },
];

async function openDraft({ loads = true } = {}) {
  const agent = new HttpAgent({ url: 'https://chat.test/agent', threadId: 'thread' });
  const chat = (messages: Message[]) => (
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout agent={agent}><div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div></ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
  const first = [{ id: 'u', role: 'user' as const, content: 'Draft the Q3 note to Dana' }, ...published('c', PUBLISHED)];
  const { rerender } = render(chat(first));
  await userEvent.click(await screen.findByRole('button', { name: /Q3 numbers for review/ }));
  const panel = screen.getByRole('region', { name: 'Q3 numbers for review' });
  if (loads) await waitFor(() => expect(within(panel).getByRole('textbox', { name: 'To' })).toHaveValue('dana@example.com'));
  const agentPublishes = (artifact: object) => rerender(chat([...first, ...published('c2', artifact)]));
  return { panel, agentPublishes };
}

/** Types at the end of a field; a click would land on the resize handle, which jsdom lays out over everything. */
async function typeInto(field: HTMLElement, text: string) {
  act(() => field.focus());
  await userEvent.keyboard(text);
}

/** The .eml files the running test asked for, still being made. */
const making: Promise<void>[] = [];
/** How long a test waits for its .eml: CI took 1.2 s to make the first. */
const SAVED = { timeout: 5000 };

/** The file the panel hands the browser to save, as the browser would save it. */
function downloads() {
  const saved: { name: string; blob: Blob }[] = [];
  const run = EML.run;
  vi.spyOn(EML, 'run').mockImplementation((target) => {
    const made = Promise.resolve(run(target));
    making.push(made);
    return made;
  });
  const blobs = new Map<string, Blob>();
  redefine(URL, 'createObjectURL', (blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  // Not restored: the revoke that follows a save may run after the test ends.
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob) saved.push({ name: this.download, blob });
  });
  return saved;
}

function only<T>(list: readonly T[]): T {
  const [one] = list;
  if (list.length !== 1 || one === undefined) throw new Error(`expected one, got ${list.length}`);
  return one;
}

it('keeps the reading position when the open Email receives a new version', async () => {
  const { stored } = draftInFiles();
  const { panel, agentPublishes } = await openDraft();
  const scroller = panel.querySelector('.artifact-email');
  if (!(scroller instanceof HTMLElement)) throw new Error('The Email needs its scroll container');
  scroller.scrollTop = 240;
  fireEvent.scroll(scroller);
  stored[V2] = JSON.stringify({ ...DRAFT, subject: 'Updated subject' });
  stored['artifacts/drafts/q3.email.json.versions/2.json'] = JSON.stringify({ author: 'agent', title: PUBLISHED.title, description: '', imports: [] });
  agentPublishes({ ...PUBLISHED, version: 2, path: `/${V2}` });
  await waitFor(() => expect(within(panel).getByRole('textbox', { name: 'Subject' })).toHaveValue('Updated subject'));
  expect(panel.querySelector('.artifact-email')).toBe(scroller);
  expect(scroller.scrollTop).toBe(240);
});

describe('an Email in the panel', () => {
  it('shows the draft as Gmail does, with the .eml as its one Export', async () => {
    draftInFiles();
    const { panel } = await openDraft();

    expect(within(panel).getByRole('button', { name: /^Edited by BotCube/ })).toBeVisible();
    expect(within(panel).getByRole('textbox', { name: 'Cc' })).toHaveValue('finance@example.com');
    expect(within(panel).getByRole('textbox', { name: 'Subject' })).toHaveValue('Q3 numbers for review');
    expect(within(panel).getByRole('textbox', { name: 'Body' })).toHaveTextContent('Hi Dana,The Q3 review is attached.');
    expect(within(panel).getByRole('list', { name: 'Attachments' })).toHaveTextContent('Q3 review.pdf');
    expect((await openDownloads(panel)).map(({ textContent }) => textContent)).toEqual(['.eml']);
  });

  it('saves an edited recipient and body as the next version, saved by you', async () => {
    const { saves } = draftInFiles();
    const { panel } = await openDraft();

    await typeInto(within(panel).getByRole('textbox', { name: 'To' }), ', lee@example.com');
    await typeInto(within(panel).getByRole('textbox', { name: 'Body' }), 'Updated: ');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(panel).getByRole('button', { name: /^Edited by you/ })).toBeVisible());
    expect(saves).toHaveLength(1);
    const [save] = saves;
    expect({ id: save?.id, version: save?.version, names: Object.keys(save?.files ?? {}) }).toEqual({ id: '/drafts/q3.email.json', version: 1, names: ['q3.email.json'] });
    expect(JSON.parse(save?.files['q3.email.json'] ?? '')).toEqual({
      ...DRAFT,
      to: ['dana@example.com', 'lee@example.com'],
      htmlBody: '<p>Updated: Hi Dana,</p><p>The Q3 review is attached.</p>',
      body: 'Updated: Hi Dana,\n\nThe Q3 review is attached.',
    });
    await waitFor(() => expect(within(panel).getByRole('textbox', { name: 'To' })).toHaveValue('dana@example.com, lee@example.com'));
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows each error of a save the Chat Service refuses, and keeps the draft to fix', async () => {
    const refusal = 'q3.email.json cc[1] — is not in the allowed form. Nearest: a plain address, such as dana@example.com.\nq3.email.json htmlBody <table> — is not an element the email editor holds';
    const { saves } = draftInFiles(DRAFT, Response.json({ detail: refusal }, { status: 400 }));
    const { panel } = await openDraft();

    await typeInto(within(panel).getByRole('textbox', { name: 'Cc' }), ', Lee <lee@example.com>');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    const alerts = (await within(panel).findAllByRole('alert')).map((alert) => alert.textContent);
    expect(alerts).toEqual([
      "Couldn't save: q3.email.json cc[1] — is not in the allowed form. Nearest: a plain address, such as dana@example.com.",
      "Couldn't save: q3.email.json htmlBody <table> — is not an element the email editor holds",
    ]);
    expect(saves).toEqual([]);
    expect(within(panel).getByRole('textbox', { name: 'Cc' })).toHaveValue('finance@example.com, Lee <lee@example.com>');
    expect(within(panel).getByRole('button', { name: /^Edited by BotCube/ })).toBeVisible();
  });

  it("keeps the User's edits on the version they edit when the agent publishes a newer one, until they discard them", async () => {
    const { stored, saves } = draftInFiles();
    const { panel, agentPublishes } = await openDraft();
    await typeInto(within(panel).getByRole('textbox', { name: 'Subject' }), ' (draft)');
    stored[V2] = JSON.stringify({ ...DRAFT, subject: 'Q3 numbers, final' });

    agentPublishes({ ...PUBLISHED, title: 'Q3 numbers, final', version: 2, path: `/${V2}` });

    const newer = await within(panel).findByRole('status');
    expect(newer).toHaveTextContent('Version 2 arrived while you edited version 1. Your edits are kept.');
    expect(within(panel).getByRole('textbox', { name: 'Subject' })).toHaveValue('Q3 numbers for review (draft)');
    expect(saves).toEqual([]);

    await userEvent.click(within(newer).getByRole('button', { name: 'Discard edits and open version 2' }));

    await waitFor(() => expect(within(panel).getByRole('textbox', { name: 'Subject' })).toHaveValue('Q3 numbers, final'));
    expect(within(panel).queryByRole('status')).toBeNull();
  });

  it('says a stored version is no email draft rather than showing part of it', async () => {
    draftInFiles({ ...DRAFT, htmlBody: 42 });
    const { panel } = await openDraft({ loads: false });

    expect(await within(panel).findByRole('alert')).toHaveTextContent("Couldn't open Q3 numbers for review: it is not an email draft");
    expect(within(panel).queryByRole('textbox', { name: 'To' })).toBeNull();
  });

  it('downloads the stored version as an unsent .eml with its plain text and attached files', async () => {
    draftInFiles();
    const saved = downloads();
    const { panel } = await openDraft();

    await downloadAs(panel, '.eml');

    await waitFor(() => expect(saved).toHaveLength(1), SAVED);
    const file = only(saved);
    expect(file.name).toBe('Q3 numbers for review.eml');
    expect(file.blob.type).toBe('message/rfc822');
    const email = await PostalMime.parse(await file.blob.arrayBuffer());
    expect(email.headers.find(({ key }) => key === 'x-unsent')?.value).toBe('1');
    expect(email.from).toBeUndefined();
    const { to, cc, bcc } = email;
    expect(to?.map(({ address }) => address)).toEqual(['dana@example.com']);
    expect(cc?.map(({ address }) => address)).toEqual(['finance@example.com']);
    expect(bcc).toBeUndefined();
    expect(email.subject).toBe('Q3 numbers for review');
    expect(email.html).toBe(DRAFT.htmlBody);
    expect(email.text).toBe(DRAFT.body);
    expect(email.attachments.map(({ filename, mimeType, disposition }) => ({ filename, mimeType, disposition }))).toEqual([
      { filename: 'Q3 review.pdf', mimeType: 'application/pdf', disposition: 'attachment' },
    ]);
    expect(new Uint8Array(email.attachments[0]?.content as ArrayBuffer)).toEqual(PDF);
  });

  it('downloads the stored version, not unsaved edits, and says so by the Download button', async () => {
    draftInFiles();
    const saved = downloads();
    const { panel } = await openDraft();
    expect(within(panel).queryByText(/without your unsaved edits/)).toBeNull();
    await typeInto(within(panel).getByRole('textbox', { name: 'Bcc' }), 'records@example.com');
    await typeInto(within(panel).getByRole('textbox', { name: 'Subject' }), ' (draft)');

    expect(within(panel).getByText('The .eml is version 1, without your unsaved edits')).toBeVisible();
    await downloadAs(panel, '.eml');

    await waitFor(() => expect(saved).toHaveLength(1), SAVED);
    const email = await PostalMime.parse(await only(saved).blob.arrayBuffer());
    expect(email.bcc).toBeUndefined();
    expect(email.subject).toBe('Q3 numbers for review');
    expect(within(panel).getByRole('textbox', { name: 'Subject' })).toHaveValue('Q3 numbers for review (draft)');
  });

  it('downloads the version the User edits when a newer one arrives mid-edit', async () => {
    const { stored } = draftInFiles();
    const saved = downloads();
    const { panel, agentPublishes } = await openDraft();
    await typeInto(within(panel).getByRole('textbox', { name: 'Subject' }), ' (draft)');
    stored[V2] = JSON.stringify({ ...DRAFT, subject: 'Q3 numbers, final' });
    agentPublishes({ ...PUBLISHED, title: 'Q3 numbers, final', version: 2, path: `/${V2}` });
    await within(panel).findByRole('status');

    expect(within(panel).getByText('The .eml is version 1, without your unsaved edits')).toBeVisible();
    await downloadAs(panel, '.eml');

    await waitFor(() => expect(saved).toHaveLength(1), SAVED);
    expect((await PostalMime.parse(await only(saved).blob.arrayBuffer())).subject).toBe('Q3 numbers for review');
  });

  it('names what failed when an attachment cannot be read, and offers a PDF of the draft as shown', async () => {
    const { stored } = draftInFiles();
    delete stored[COPY];
    const saved = downloads();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const { panel } = await openDraft();

    await downloadAs(panel, '.eml');

    const failure = await within(panel).findByRole('alert');
    expect(failure).toHaveTextContent("Couldn't make the .eml: the attachment /reports/q3 review.pdf couldn't be read");
    expect(saved).toEqual([]);
    await userEvent.click(within(failure).getByRole('button', { name: 'Download as PDF' }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('derives the plain text from the body when the draft has none', async () => {
    const { body: _, ...withoutText } = DRAFT;
    draftInFiles({ ...withoutText, attachments: [] });
    const saved = downloads();
    const { panel } = await openDraft();

    await downloadAs(panel, '.eml');

    await waitFor(() => expect(saved).toHaveLength(1), SAVED);
    const email = await PostalMime.parse(await only(saved).blob.arrayBuffer());
    expect(email.text).toBe('Hi Dana,\n\nThe Q3 review is attached.');
    expect(email.attachments).toEqual([]);
  });
});

describe("the body editor's schema", () => {
  /** The editor's own spelling: `<b>` and `<i>` hold the same marks as `<strong>` and `<em>`. */
  const spelled = (html: string) => html.replace(/<(\/?)b>/g, '<$1strong>').replace(/<(\/?)i>/g, '<$1em>');

  it.each(Object.entries(EMAIL_ELEMENTS))('holds <%s> as the email format allows it, so an edit loses nothing', (_, { sample }) => {
    const editor = new Editor({ extensions: EMAIL_EDITOR, content: sample });
    try {
      expect(editor.getHTML()).toBe(spelled(sample));
    } finally {
      editor.destroy();
    }
  });

  it('holds nothing the email format refuses', () => {
    const editor = new Editor({ extensions: EMAIL_EDITOR });
    try {
      const { nodes, marks } = editor.schema;
      const tags = [
        ...Object.values(nodes).flatMap((type) => {
          const levels: unknown = type.spec.attrs?.level !== undefined ? editor.extensionManager.extensions.find(({ name }) => name === 'heading')?.options.levels : [undefined];
          return (levels as (number | undefined)[]).map((level) => {
            const dom = type.spec.toDOM?.(type.create(level === undefined ? null : { level }));
            return Array.isArray(dom) ? String(dom[0]) : null;
          });
        }),
        ...Object.values(marks).map((type) => {
          const dom = type.spec.toDOM?.(type.create(), true);
          return Array.isArray(dom) ? String(dom[0]) : null;
        }),
      ].filter((tag) => tag !== null);
      expect(tags.length).toBeGreaterThan(10);
      expect(tags.filter((tag) => !(tag in EMAIL_ELEMENTS))).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});
