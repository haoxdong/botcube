// ProseMirror asks the DOM where the caret is; jsdom answers with the stubs below, happy-dom can't.
// @vitest-environment jsdom
import { HttpAgent } from '@ag-ui/client';
import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider, useAgent } from '@copilotkit/react-core/v2';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOC_WRITES, DocFrame } from './artifact-doc';
import { ArtifactLayout } from './artifact-panel';

const PLAN = `# Q4 plan

What we ship, and **when**. Track it in [the tracker](https://tracker.test/q4).

## Milestones

1. Beta
2. Launch

- [x] Hire the team
- [ ] Set the price

| Month | Goal |
| --- | --- |
| Oct | Beta |
| Nov | Launch |
`;
const PUBLISHED = {
  id: '/plans/q4.md', type: 'doc', title: 'Q4 plan', description: 'What ships in Q4', version: 1,
  path: '/artifacts/plans/q4.md.versions/1.md',
};
const V1 = 'artifacts/plans/q4.md.versions/1.md';
type Save = { id: string; version: number; files: Record<string, string> };
/** The chat's agent when no turn runs: these chats show saved messages. */
const IDLE = new HttpAgent({ url: 'https://chat.test/agent' });
/** A one-pixel PNG, made here, held in the Doc as a data: URI as the checker requires. */
const PIXEL = `data:image/png;base64,${png().toString('base64')}`;

/** A 1×1 white PNG: its signature, then its header, pixel and end chunks, each with its length and CRC. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sizes = Buffer.alloc(8);
    sizes.writeUInt32BE(data.length, 0);
    sizes.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([sizes.subarray(0, 4), body, sizes.subarray(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

// jsdom has no matchMedia.
const phone = (matches: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query === '(max-width: 640px)', media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_ARTIFACTS', '1');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom lays nothing out; ProseMirror asks where the caret is after each keystroke.
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Object.defineProperty(Range.prototype, 'getClientRects', { value: rects, configurable: true });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: () => new DOMRect(), configurable: true });
  Object.defineProperty(Text.prototype, 'getClientRects', { value: rects, configurable: true });
  Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Files holding version 1, and the Chat Service's save, which answers with version 2, the User's. */
function docInFiles(markdown = PLAN, answer?: Response) {
  const stored: Record<string, string> = { [V1]: markdown };
  const saves: Save[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith('https://files.test/')) return new Response(stored[decodeURIComponent(input.slice('https://files.test/'.length))]);
    if (new URL(input).pathname === '/files/artifact-save') {
      const save = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Save;
      saves.push(save);
      if (answer) return answer;
      stored['artifacts/plans/q4.md.versions/2.md'] = save.files['q4.md'] ?? '';
      return Response.json({ ...PUBLISHED, version: 2, author: 'user', path: '/artifacts/plans/q4.md.versions/2.md' });
    }
    const name = new URL(input).searchParams.get('name') ?? '';
    return name in stored ? Response.json({ url: `https://files.test/${encodeURIComponent(name)}` }) : Response.json({ detail: `No file named ${name}` }, { status: 404 });
  }));
  return { saves, stored };
}

async function openDoc() {
  phone(false);
  const published = (call: string, artifact: object) => [
    { id: `a-${call}`, role: 'assistant' as const, content: '', toolCalls: [{ id: call, type: 'function' as const, function: { name: 'Artifact', arguments: JSON.stringify({ file_path: '/plans/q4.md' }) } }] },
    { id: `t-${call}`, role: 'tool' as const, toolCallId: call, content: JSON.stringify(artifact) },
  ];
  const first = [{ id: 'u', role: 'user' as const, content: 'Write the Q4 plan' }, ...published('c', PUBLISHED)];
  const chat = (messages: object[]) => (
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider threadId="thread">
        <ArtifactLayout agent={IDLE}><div className="app-chat"><CopilotChatMessageView messages={messages} isRunning={false} /></div></ArtifactLayout>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
  const { rerender } = render(chat(first));
  const card = await screen.findByRole('button', { name: /Q4 plan/ });
  expect(card).toHaveTextContent('Doc · version 1');
  await userEvent.click(card);
  const panel = screen.getByRole('region', { name: 'Q4 plan' });
  const doc = await within(panel).findByRole('textbox', { name: 'Q4 plan' });
  await waitFor(() => expect(within(doc).getByRole('heading', { level: 1 })).toHaveTextContent('Q4 plan'));
  const agentPublishes = (artifact: object) => rerender(chat([...first, ...published('c2', artifact)]));
  return { panel, doc, agentPublishes };
}

/** Puts the caret at the start of `node`'s text; a click would land on the resize handle jsdom lays over everything. */
function caretAt(doc: HTMLElement, node: HTMLElement) {
  act(() => {
    doc.focus();
    const range = document.createRange();
    range.setStart(node.firstChild ?? node, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

type Event = { atMs: number; type: string } & Record<string, unknown>;
const CHUNK = 12;
const STEP_MS = 80;

/** A turn that writes the Doc as deepagents streams write_file, a few characters at a time, then publishes it. */
function docTurn() {
  const args = JSON.stringify({ file_path: '/plans/q4.md', content: PLAN });
  const events: Event[] = [
    { atMs: 0, type: 'RUN_STARTED', threadId: 'thread', runId: 'run' },
    { atMs: 10, type: 'TOOL_CALL_START', toolCallId: 'write', toolCallName: 'write_file', parentMessageId: 'm-write' },
  ];
  let at = 10;
  for (let from = 0; from < args.length; from += CHUNK) {
    at += STEP_MS;
    events.push({ atMs: at, type: 'TOOL_CALL_ARGS', toolCallId: 'write', delta: args.slice(from, from + CHUNK) });
  }
  const written = at + 40;
  events.push(
    { atMs: at + 1, type: 'TOOL_CALL_END', toolCallId: 'write' },
    { atMs: written, type: 'TOOL_CALL_RESULT', messageId: 'r-write', toolCallId: 'write', role: 'tool', content: 'Updated file /plans/q4.md' },
    { atMs: written + 600, type: 'TOOL_CALL_START', toolCallId: 'publish', toolCallName: 'Artifact', parentMessageId: 'm-publish' },
    { atMs: written + 601, type: 'TOOL_CALL_ARGS', toolCallId: 'publish', delta: JSON.stringify({ file_path: '/plans/q4.md' }) },
    { atMs: written + 602, type: 'TOOL_CALL_END', toolCallId: 'publish' },
    { atMs: written + 640, type: 'TOOL_CALL_RESULT', messageId: 'r-publish', toolCallId: 'publish', role: 'tool', content: JSON.stringify(PUBLISHED) },
    { atMs: written + 650, type: 'RUN_FINISHED', threadId: 'thread', runId: 'run' },
  );
  /** When the stream has sent `text` of the Doc. */
  const sent = (text: string) => 10 + STEP_MS * Math.ceil(args.indexOf(JSON.stringify(text).slice(1, -1)) / CHUNK + 1);
  return { events, written, sent, ends: written + 651 };
}

describe('while the agent writes a Doc', () => {
  beforeEach(() => {
    // The clock the stream and the panel run on, and no more: a faked setImmediate stalls Node's streams under the turn.
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens it beside the chat and fills it as the Markdown streams, then the card opens the published version', async () => {
    const { events, written, sent, ends } = docTurn();
    phone(false);
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const { atMs, ...event } of events) setTimeout(() => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)), atMs);
        setTimeout(() => controller.close(), ends);
      },
    }), { headers: { 'content-type': 'text/event-stream' } })));
    const agent = new HttpAgent({ url: 'https://chat.test/agent', threadId: 'thread' });
    function Messages() {
      const { agent: running } = useAgent();
      return <CopilotChatMessageView messages={running.messages} isRunning={running.isRunning} />;
    }
    render(
      <CopilotKitProvider selfManagedAgents={{ default: agent }}>
        <CopilotChatConfigurationProvider threadId="thread">
          <ArtifactLayout agent={agent}><div className="app-chat"><Messages /></div></ArtifactLayout>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>,
    );
    // A frame at a time, React rendering between frames as a browser would.
    const until = async (ms: number): Promise<void> => {
      if (Date.now() >= ms) return;
      await act(() => vi.advanceTimersByTimeAsync(Math.min(16, ms - Date.now())));
      return until(ms);
    };
    await act(async () => {
      void agent.runAgent();
      await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    });

    await until(sent('## Milestones') + 260);
    expect(sent('## Milestones') + 260).toBeLessThan(sent('| Month'));
    const panel = screen.getByRole('region', { name: 'q4.md' });
    const doc = within(panel).getByRole('textbox', { name: 'q4.md' });
    expect(within(panel).getByText('Doc · writing…')).toBeVisible();
    expect(within(doc).getByRole('heading', { level: 1 })).toHaveTextContent('Q4 plan');
    expect(within(doc).queryByRole('table')).toBeNull();
    expect(doc).toHaveAttribute('contenteditable', 'false');

    await until(written + 300);
    expect(within(panel).getByText('Doc')).toBeVisible();
    expect(within(doc).getByRole('cell', { name: 'Launch' })).toBeVisible();

    await until(ends + 300);
    expect(screen.getByRole('button', { name: /Q4 plan/ })).toHaveTextContent('Doc · version 1');
  });
});

/** A file inside a zip, read through its central directory, as Word reads a .docx. */
function unzipped(zip: Buffer, name: string): string {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  for (let entry = 0; entry < zip.readUInt16LE(end + 10); entry += 1) {
    const [method, size, nameLength, extraLength, commentLength, local] = [zip.readUInt16LE(at + 10), zip.readUInt32LE(at + 20), zip.readUInt16LE(at + 28), zip.readUInt16LE(at + 30), zip.readUInt16LE(at + 32), zip.readUInt32LE(at + 42)];
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`No ${name} in the zip`);
}

describe('Download as Word', () => {
  it('gives a Word file with the Doc\'s headings, lists, task list, table, link and image', async () => {
    docInFiles(`${PLAN}\n![Pixel](${PIXEL})\n`);
    const { panel } = await openDoc();
    // jsdom has no object URLs; the Blob the panel hands one is the file the browser would save. They stay for the
    // file, so the revoke that follows a save finds one after this test ends.
    const made = vi.fn((_blob: Blob) => 'blob:word');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: made });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    const saved = new Promise<string>((resolve) => {
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        resolve(this.download);
      });
    });

    await userEvent.click(within(panel).getByRole('button', { name: 'Download as Word' }));

    expect(await saved).toBe('Q4 plan.docx');
    const docx = Buffer.from(await (made.mock.lastCall?.[0] as Blob).arrayBuffer());
    const xml = unzipped(docx, 'word/document.xml');
    const paragraphs = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/g)].map(([p]) => ({
      style: /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? null,
      listed: p.includes('<w:numPr>'),
      text: [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(([, text]) => text).join(''),
    }));
    expect(paragraphs.filter(({ style }) => style?.startsWith('Heading')).map(({ style, text }) => [style, text])).toEqual([
      ['Heading1', 'Q4 plan'], ['Heading2', 'Milestones'],
    ]);
    expect(paragraphs.filter(({ listed }) => listed).map(({ text }) => text)).toEqual(['Beta', 'Launch', '☑ Hire the team', '☐ Set the price']);
    expect(xml.match(/<w:tbl>/g)).toHaveLength(1);
    expect(xml.match(/<w:tr[ >]/g)).toHaveLength(3);
    expect(paragraphs.map(({ text }) => text)).toEqual(expect.arrayContaining(['Month', 'Goal', 'Nov', 'Launch']));
    expect(xml).toMatch(/<w:hyperlink r:id="([^"]+)"[\s\S]*?the tracker/);
    expect(unzipped(docx, 'word/_rels/document.xml.rels')).toContain('Target="https://tracker.test/q4"');
    expect(xml).toContain('<w:drawing>');
    expect(unzipped(docx, 'word/_rels/document.xml.rels')).toMatch(/Target="media\/[^"]+\.png"/);
    // The Export names `global` only for its own call.
    expect('global' in globalThis).toBe(true);
  });

  it('says why a Word file could not be made and offers PDF', async () => {
    docInFiles();
    const { panel } = await openDoc();
    vi.spyOn(Response.prototype, 'text').mockRejectedValueOnce(new Error('Files went away'));

    await userEvent.click(within(panel).getByRole('button', { name: 'Download as Word' }));

    const failure = await within(panel).findByRole('alert');
    expect(failure).toHaveTextContent("Couldn't make the Word file: Files went away.");
    expect(within(failure).getByRole('button', { name: 'Download as PDF' })).toBeVisible();
  });
});

describe('Download as PDF', () => {
  it("prints the Doc's HTML from a sandboxed frame that runs no script", async () => {
    docInFiles(`${PLAN}\n![Pixel](${PIXEL})\n`);
    const { panel } = await openDoc();

    await userEvent.click(within(panel).getByRole('button', { name: 'Download as PDF' }));

    const frame = await waitFor(() => {
      const found = document.querySelector<HTMLIFrameElement>('iframe[title="Q4 plan for print"]');
      expect(found).not.toBeNull();
      return found as HTMLIFrameElement;
    });
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
    expect(frame.srcdoc).toContain('<h1>Q4 plan</h1>');
    expect(frame.srcdoc).toContain(`<img src="${PIXEL}" alt="Pixel">`);
    expect(frame.srcdoc).not.toMatch(/<script/);
  });
});

describe('Download while the User edits an older version', () => {
  it('gives the version on screen, not the newer one that arrived nor the unsaved edits, and says so', async () => {
    const { stored } = docInFiles();
    const { panel, doc, agentPublishes } = await openDoc();
    caretAt(doc, within(doc).getByRole('heading', { name: 'Q4 plan' }));
    await userEvent.keyboard('Draft ');
    stored['artifacts/plans/q4.md.versions/2.md'] = '# Q5 plan\n';

    agentPublishes({ ...PUBLISHED, version: 2, path: '/artifacts/plans/q4.md.versions/2.md' });

    expect(await within(panel).findByRole('status')).toHaveTextContent('Version 2 arrived while you edited version 1.');
    expect(within(panel).getByRole('note')).toHaveTextContent('The Word file and the PDF are version 1, without your unsaved edits');
    await userEvent.click(within(panel).getByRole('button', { name: 'Download as PDF' }));

    const frame = await waitFor(() => {
      const found = document.querySelector<HTMLIFrameElement>('iframe[title="Q4 plan for print"]');
      expect(found).not.toBeNull();
      return found as HTMLIFrameElement;
    });
    expect(frame.srcdoc).toContain('<h1>Q4 plan</h1>');
    expect(frame.srcdoc).not.toMatch(/Q5 plan|Draft/);
  });
});

describe('a Markdown write', () => {
  it.each([
    ['/plans/q4.md', true],
    ['notes/Q4.MD', true],
    ['/tmp/scratch.md', false],
    ['/botcube-harness-deepagents/skills/artifacts/SKILL.md', false],
    ['/artifacts/plans/q4.md.versions/2.md', false],
    ['/.drafts/q4.md', false],
    ['/plans/q4.html', false],
  ])('%s previews as a Doc: %s', (written, previews) => {
    expect(DOC_WRITES.matches(written)).toBe(previews);
  });
});

describe("the User's edit of a published Doc", () => {
  it('saves the edited heading and table cell as Markdown, the next version, saved by you', async () => {
    const { saves } = docInFiles();
    const { panel, doc } = await openDoc();

    expect(within(doc).getAllByRole('listitem')).toHaveLength(4);
    expect(within(doc).getByRole('checkbox', { name: 'Task item checkbox for Hire the team' })).toBeChecked();
    expect(within(doc).getByRole('checkbox', { name: 'Task item checkbox for Set the price' })).not.toBeChecked();
    expect(within(doc).getByRole('link', { name: 'the tracker' })).toHaveAttribute('href', 'https://tracker.test/q4');
    caretAt(doc, within(doc).getByRole('heading', { name: 'Milestones' }));
    await userEvent.keyboard('Q4 ');
    caretAt(doc, within(doc).getByRole('cell', { name: 'Launch' }));
    await userEvent.keyboard('Public ');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(panel).getByText('Doc · version 2 · saved by you')).toBeVisible());
    expect(saves).toHaveLength(1);
    const [{ id, version, files } = { id: '', version: 0, files: {} }] = saves;
    expect([id, version, Object.keys(files)]).toEqual(['/plans/q4.md', 1, ['q4.md']]);
    const saved = files['q4.md'] ?? '';
    expect(saved).toContain('## Q4 Milestones\n');
    expect(saved).toMatch(/\| Nov +\| Public Launch +\|/);
    expect(saved).toContain('[the tracker](https://tracker.test/q4)');
    expect(saved).toContain('- [x] Hire the team');
    expect(saved).toContain('1. Beta');
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps the text of a look Markdown cannot hold, and drops the look on save', async () => {
    const { saves } = docInFiles(`${PLAN}\nPay is <span style="color:#c00;font-size:20px">due Friday</span>.\n\n<p align="center">Signed off by finance</p>\n`);
    const { panel, doc } = await openDoc();

    caretAt(doc, within(doc).getByRole('heading', { name: 'Q4 plan' }));
    await userEvent.keyboard('Final ');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saves).toHaveLength(1));
    const saved = saves[0]?.files['q4.md'] ?? '';
    expect(saved).toContain('# Final Q4 plan\n');
    expect(saved).toContain('Pay is due Friday.');
    expect(saved).toContain('Signed off by finance');
    expect(saved).not.toMatch(/<|style|color|align/);
  });

  it("keeps the User's underlined text, and drops the underline on save", async () => {
    const { saves } = docInFiles();
    const { panel, doc } = await openDoc();

    caretAt(doc, within(doc).getByRole('heading', { name: 'Milestones' }));
    await userEvent.keyboard('{Control>}u{/Control}Key ');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saves).toHaveLength(1));
    const saved = saves[0]?.files['q4.md'] ?? '';
    expect(saved).toContain('## Key Milestones\n');
    expect(saved).not.toMatch(/<\/?u>/);
  });

  it('shows an image held in the Doc', async () => {
    docInFiles(`${PLAN}\n![Pixel](${PIXEL})\n`);
    const { doc } = await openDoc();

    expect(within(doc).getByRole('img', { name: 'Pixel' })).toHaveAttribute('src', PIXEL);
  });

  it('drops the edit on Discard', async () => {
    const { saves } = docInFiles();
    const { panel, doc } = await openDoc();

    caretAt(doc, within(doc).getByRole('heading', { name: 'Q4 plan' }));
    await userEvent.keyboard('Draft ');
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeEnabled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Discard' }));

    const reopened = await within(panel).findByRole('textbox', { name: 'Q4 plan' });
    await waitFor(() => expect(within(reopened).getByRole('heading', { level: 1 })).toHaveTextContent(/^Q4 plan$/));
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(saves).toHaveLength(0);
  });

  it("keeps the User's edit and says why when the save is refused", async () => {
    docInFiles(PLAN, Response.json({ detail: 'Version 2 of /plans/q4.md is newer than the version 1 you edited. Open the newest and edit again.' }, { status: 409 }));
    const { panel, doc } = await openDoc();

    caretAt(doc, within(doc).getByRole('heading', { name: 'Q4 plan' }));
    await userEvent.keyboard('Draft ');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent("Couldn't save: Version 2 of /plans/q4.md is newer than the version 1 you edited. Open the newest and edit again.");
    expect(within(doc).getByRole('heading', { level: 1 })).toHaveTextContent('Draft Q4 plan');
    expect(within(panel).getByText('Doc · version 1')).toBeVisible();
  });
});

describe("the skill page's Doc examples", () => {
  const lines = readFileSync(path.join(import.meta.dirname, '../../../../harness/deepagents/artifact-check/skills/artifacts/SKILL.md'), 'utf8').split('\n');
  // The Doc section runs to the next section's heading outside a fence.
  const start = lines.indexOf('## Doc');
  let fenced = false;
  const end = lines.findIndex((line, index) => index > start && (fenced = fenced !== line.startsWith('```'), !fenced && line.startsWith('## ')));
  const section = lines.slice(start, end < 0 ? undefined : end).join('\n');
  const examples = [...section.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map(([, markdown]) => markdown ?? '');

  it('has examples', () => {
    expect(start).toBeGreaterThan(0);
    expect(examples.length).toBeGreaterThanOrEqual(3);
  });

  it("says a look Markdown cannot hold is dropped on the User's save", () => {
    expect(section).toContain('Markdown holds no look.');
    expect(section).toContain("the User's next save would drop the HTML");
  });

  it.each(examples)('loads in the Doc viewer with no Markdown syntax left as text: %s', (example) => {
    render(<DocFrame title="Example" markdown={example} complete />);
    const doc = screen.getByRole('textbox', { name: 'Example' });

    expect(doc.textContent).not.toMatch(/\||\]\(|\[ \]|\*\*|^#|^- /m);
    if (/^#{1,6} /m.test(example)) expect(within(doc).getAllByRole('heading').length).toBeGreaterThan(0);
    if (/^\|/m.test(example)) expect(within(doc).getByRole('table')).toBeVisible();
    if (/^- \[ \]/m.test(example)) expect(within(doc).getAllByRole('checkbox').length).toBeGreaterThan(0);
    if (/\]\(https:/.test(example)) expect(within(doc).getAllByRole('link').length).toBeGreaterThan(0);
    if (/^(- |\d+\. )/m.test(example)) expect(within(doc).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
