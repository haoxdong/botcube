import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import type { Window as HappyDomWindow } from 'happy-dom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Streamdown } from 'streamdown';
import './composer.css';

import { KeptChat } from './kept-chat';
import { ScheduledTaskProposalCard } from './scheduled-tasks';

const happyDOM = (window as unknown as HappyDomWindow).happyDOM;

// The page's own stylesheet. happy-dom skips its imports and layers (CopilotKit's Tailwind Typography
// quotes inline code in a layer), and every unlayered rule here wins over a layered one, so these
// tests read what this sheet decides. The Radix Colors scales it imports, which its colour tokens name, are
// inlined ahead of it as the import would. happy-dom styles no pseudo-elements, so each `::before`,
// `::after` or `::placeholder` rule styles a `.pseudo-before`, `.pseudo-after` or `.pseudo-placeholder`
// child instead. It matches no `:placeholder-shown` either, so a test marks an empty text box
// `.placeholder-shown` instead. The Files component's sheet and the motion sheet follow it, as the layout imports them.
const here = path.dirname(fileURLToPath(import.meta.url));
// globals.css with the sheets it imports by surface inlined where it imports them, as Tailwind bundles them.
const sheet = readFileSync(path.join(here, 'globals.css'), 'utf8').replace(/^@import "\.\/([\w-]+\.css)";$/gm, (_line, file: string) => readFileSync(path.join(here, file), 'utf8'));
const files = readFileSync(path.join(here, 'files.css'), 'utf8');
const motion = readFileSync(path.join(here, 'motion.css'), 'utf8');
const radix = [...sheet.matchAll(/@import "(@radix-ui\/colors\/[a-z]+\.css)";/g)]
  .map(([, file = '']) => readFileSync(createRequire(import.meta.url).resolve(file), 'utf8'))
  .join('\n');
// happy-dom parses no space-separated `rgb(r g b / a)`, so the page's light and shade are given in the comma form.
const page = radix + `${sheet}\n${files}\n${motion}`.replace(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/g, 'rgba($1, $2, $3, $4)');
const style = document.createElement('style');

beforeAll(() => {
  style.textContent = page.replace(/::(before|after|placeholder)\b/g, ' > .pseudo-$1').replace(/:placeholder-shown\b/g, '.placeholder-shown');
  document.head.append(style);
});
afterAll(() => style.remove());

const styleOf = (parent: ParentNode, selector: string) => {
  const element = parent.querySelector(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return getComputedStyle(element);
};

const inAssistantMessage = (markup: string) => {
  const message = document.createElement('div');
  message.className = 'copilotKitMessage copilotKitAssistantMessage';
  const prose = document.createElement('div');
  prose.className = 'cpk:prose';
  prose.innerHTML = markup;
  message.append(prose);
  document.body.append(message);
  return { message, prose };
};

it("shows an assistant message's inline code as a chip without backticks", () => {
  const { message } = inAssistantMessage(
    '<p>Use <code data-streamdown="inline-code">at()<span class="pseudo-before"></span><span class="pseudo-after"></span></code></p>',
  );

  expect(styleOf(message, '.pseudo-before').content).toBe('none');
  expect(styleOf(message, '.pseudo-after').content).toBe('none');
});

it("shows an assistant message's prose in a white bubble in the resting shadow, up to 90% of the column, and a message with only tool rows, or a Worklog's note, without one", () => {
  const reply = inAssistantMessage('<div><p>Run <code>echo</code> now.</p></div>');
  const toolOnly = inAssistantMessage('<div></div>');
  const worklog = document.createElement('div');
  worklog.className = 'worklog-body';
  const note = inAssistantMessage('<div><p>Checking the curve.</p></div>');
  worklog.append(note.message);
  document.body.append(worklog);

  try {
    const bubble = styleOf(reply.prose, ':scope > div');
    expect(bubble.backgroundColor).toBe('#fff');
    expect(bubble.color).toBe('#202020');
    expect(bubble.boxShadow).toBe('0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.08)');
    expect(bubble.borderRadius).toBe('20px');
    // One line is twice the corner tall, an exact pill (Muse).
    expect(bubble.padding).toBe('calc(20px - 0.5lh) 16px');
    expect(bubble.maxWidth).toBe('90%');
    expect(styleOf(reply.prose, 'p').marginTop).toBe('0px');
    expect(styleOf(reply.prose, 'p').marginBottom).toBe('0px');
    expect(styleOf(reply.prose, 'code').backgroundColor).toBe('#fff');
    expect(styleOf(reply.prose, 'code').borderWidth).toBe('1px');
    const toolBox = styleOf(toolOnly.prose, ':scope > div');
    expect(toolBox.backgroundColor).not.toBe('#fff');
    expect(toolBox.boxShadow || 'none').toBe('none');
    const noteBox = styleOf(note.prose, ':scope > div');
    expect([noteBox.backgroundColor, noteBox.boxShadow || 'none']).toEqual(['transparent', 'none']);
  } finally {
    worklog.remove();
  }
});

it("starts a Turn well clear of the last, its Worklog under the question and its answer under the Worklog", () => {
  const question = document.createElement('div');
  question.className = 'copilotKitMessage copilotKitUserMessage';
  const worklog = document.createElement('div');
  worklog.className = 'worklog';
  const { message: answer } = inAssistantMessage('<div><p>Done.</p></div>');
  const next = document.createElement('div');
  next.className = 'copilotKitMessage copilotKitUserMessage';
  answer.before(question, worklog);
  answer.after(next);

  expect(getComputedStyle(worklog).marginTop).toBe('12px');
  expect(getComputedStyle(answer).marginTop).toBe('8px');
  expect(getComputedStyle(next).marginTop).toBe('32px');
  worklog.remove();
  expect(getComputedStyle(answer).marginTop).toBe('14px');
});

it('hides a Worklog row with nothing to show, so it adds no gap', () => {
  const body = document.createElement('div');
  body.className = 'worklog-body';
  body.innerHTML = '<div></div><div class="worklog-step"><div class="worklog-step-head">Ran</div></div>';
  document.body.append(body);

  expect(styleOf(body, ':scope > :empty').display).toBe('none');
  expect(styleOf(body, '.worklog-step').display).toBe('flex');
  body.remove();
});

it("reads a Worklog's notes on the loose line and its steps on the note's, under an answer on the page's line", () => {
  const worklog = document.createElement('div');
  worklog.className = 'worklog';
  worklog.innerHTML = `<button class="worklog-head">Worked for 38s</button><div class="worklog-body">
    <div class="copilotKitMessage copilotKitAssistantMessage"><div class="cpk:prose"><div>Checking the curve.</div></div>
    </div></div>`;
  const { message: answer } = inAssistantMessage('<p>Done.</p>');
  answer.before(worklog);
  try {
    expect(getComputedStyle(answer).lineHeight).toBe('1.3');
    const note = styleOf(worklog, '.copilotKitAssistantMessage');
    expect({ note: note.lineHeight, words: styleOf(worklog, '[class*="cpk:prose"]').lineHeight, head: styleOf(worklog, '.worklog-head').fontSize })
      .toEqual({ note: '1.5', words: '1.5', head: '13px' });
  } finally {
    worklog.remove();
    answer.remove();
  }
});

it("shows a citation as a pill of its number, its brackets dropped", () => {
  const { message, prose } = inAssistantMessage(
    '<div><p>Steeper.<a href="https://example.com" data-citation=""><span data-citation-bracket="">[</span>1<span data-citation-bracket="">]</span></a></p></div>',
  );

  expect(styleOf(prose, 'a').borderRadius).toBe('9999px');
  expect(styleOf(prose, 'a').textDecoration).toBe('none');
  expect(styleOf(prose, '[data-citation-bracket]').display).toBe('none');
  message.remove();
});

it("puts the agent's avatar on the chat's grey page, with no other band above the chat", () => {
  const shell = document.createElement('main');
  shell.className = 'app-shell';
  document.body.append(shell);

  expect(getComputedStyle(shell).backgroundColor).toBe('#f9f9f9');
  shell.remove();
});

it("shows Connected as plain text after a white bolt on a green badge (Muse Fig 13)", () => {
  const status = document.createElement('p');
  status.className = 'agent-profile-status agent-profile-status-online';
  status.innerHTML = '<svg></svg>Connected';
  document.body.append(status);

  expect(getComputedStyle(status).color).toBe('#202020');
  expect(styleOf(status, 'svg').backgroundColor).toBe('#30a46c');
  expect(styleOf(status, 'svg').borderRadius).toBe('9999px');
  expect(styleOf(status, 'svg').color).toBe('#fff');
});

it("shows the user's own messages in Marq's light blue bubble with dark text", () => {
  const message = document.createElement('div');
  message.className = 'copilotKitMessage copilotKitUserMessage';
  message.innerHTML = '<div>Hello</div>';
  document.body.append(message);

  const bubble = styleOf(message, 'div');
  expect([bubble.backgroundColor, bubble.color]).toEqual(['#d6e4f3', '#202020']);
  // The same pill as Marq's, so one line of either is 40px tall, and the same 90% cap.
  expect(bubble.padding).toBe('calc(20px - 0.5lh) 16px');
  expect(bubble.maxWidth).toBe('90%');
  message.remove();
});

// The Oct 14 design, now back: Marq's bubble white in the resting shadow, the chat's page a slight grey,
// and CopilotKit's own white boxes clear so that grey shows between the bubbles.
it("lets the chat's grey page show between the bubbles, through CopilotKit's own white boxes", () => {
  const { container, unmount } = render(
    <main className="app-shell">
      <div className="app-chat">
        <div data-copilotkit="" className="copilotKitMessages">
          <div className="copilotKitMessage copilotKitAssistantMessage">
            <div className="cpk:prose"><div className="chat-markdown">Treasuries rallied.</div></div>
          </div>
        </div>
      </div>
    </main>,
  );
  expect(styleOf(container, '.app-shell').backgroundColor).toBe('#f9f9f9');
  expect(styleOf(container, '.copilotKitMessages').backgroundColor).toBe('transparent');
  unmount();
});

// On a desktop the composer frames the column, 12px past the messages' text at each side, and nothing scrolled shows
// under it: the canvas is opaque behind its disclaimer and up behind its lower half. A phone keeps both.
it("widens a desktop's composer past the messages and keeps scrolled replies from showing under it", () => {
  const desktop = sheet.match(/@media \(min-width: 768px\) \{\n {2}\.copilotKitInput,\n {2}\.composer-accessory \{[\s\S]*?\n\}/)?.[0] ?? '';
  expect(desktop).toMatch(/width: calc\(min\(720px, 100%\) - 1\.5rem\) !important;/);
  expect(desktop).toMatch(/\.app-chat \.chat-disclaimer \{\s*position: relative;\s*background: var\(--color-canvas\);/);
  expect(desktop).toMatch(/\.app-chat \.chat-disclaimer::before \{[^}]*z-index: -1;[^}]*inset: -26px 0 100%;[^}]*background: var\(--color-canvas\);/);
  expect(sheet).toMatch(/\.copilotKitInput \{\n {2}margin: 0 auto !important;\n {2}width: calc\(min\(720px, 100%\) - 3rem\) !important;/);
});

// happy-dom misreads the `:has()` that picks the rest of a group, Marq's included; the chat-in-a-row story checks them.
it("joins the user's bubble to their one before, 4px under it, unless a file card parts them", () => {
  const list = document.createElement('div');
  list.className = 'copilotKitMessages';
  const asked = '<div class="copilotKitMessage copilotKitUserMessage"><div class="cpk:prose">Steeper?</div></div>';
  list.innerHTML = `${asked}${asked}<div class="copilotKitMessage copilotKitUserMessage"><ul class="sent-files"></ul><div class="cpk:prose">This?</div></div>`;
  document.body.append(list);
  const [, joined, afterFiles] = [...list.querySelectorAll<HTMLElement>('.copilotKitUserMessage')].map((message) => ({
    corner: styleOf(message, '[class*="cpk:prose"]').borderTopRightRadius,
    gap: getComputedStyle(message).marginTop || '0px',
  }));

  expect(joined).toEqual({ corner: '4px', gap: '4px' });
  expect(afterFiles).toEqual({ corner: '20px', gap: '0px' });
  list.remove();
});

it("shows a sent message's files as white cards above its blue bubble, each with its type's icon in its box", () => {
  const message = document.createElement('div');
  message.className = 'copilotKitMessage copilotKitUserMessage';
  message.innerHTML = `<ul class="sent-files">
      <li class="sent-file"><span class="file-icon"><span class="file-type-icon"><svg></svg></span></span><span class="sent-file-name">a.pdf</span><span class="sent-file-kind">PDF</span></li>
    </ul><div class="bubble">check this</div>`;
  document.body.append(message);

  expect(styleOf(message, '.bubble').backgroundColor).toBe('#d6e4f3');
  const card = styleOf(message, '.sent-file');
  expect([card.backgroundColor, card.borderColor, card.borderRadius]).toEqual(['#fff', '#e8e8e8', '12px']);
  const box = styleOf(message, '.file-icon');
  expect([box.width, box.height]).toEqual(['40px', '40px']);
  const icon = styleOf(message, '.file-icon svg');
  expect([icon.width, icon.height]).toEqual(['34px', '40px']);
  expect(styleOf(message, '.sent-file-name').fontWeight).toBe('600');
  expect(styleOf(message, '.sent-file-kind').color).toBe('#646464');
  message.remove();
});

// focus anywhere in the composer, on the model pill or an empty text box, turned send dark with nothing to send.
it('shows the send button grey at rest and while the empty composer has focus, and dark once it can send', () => {
  const input = document.createElement('div');
  input.className = 'copilotKitInput';
  input.innerHTML =
    '<textarea></textarea><div><button class="mep-pill">Model</button><button type="button" data-testid="copilot-send-button" disabled>Send</button></div>';
  document.body.append(input);
  try {
    const [textarea, pill, send] = ['textarea', '.mep-pill', 'button[type="button"]'].map((selector) => {
      const element = input.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`no ${selector}`);
      return element;
    });
    if (textarea === undefined || pill === undefined || send === undefined) {
      throw new Error('The test composer is missing an expected element');
    }

    expect(getComputedStyle(send).backgroundColor).toBe('#e8e8e8');
    textarea.focus();
    expect(getComputedStyle(send).backgroundColor).toBe('#e8e8e8');
    pill.focus();
    expect(getComputedStyle(send).backgroundColor).toBe('#e8e8e8');
    send.removeAttribute('disabled');
    expect(getComputedStyle(send).backgroundColor).toBe('#202020');
  } finally {
    input.remove();
  }
});

it("lifts the composer on a clear border in the resting shadow, on a desktop and a phone alike", () => {
  // A fresh composer per viewport, as happy-dom keeps an element's computed style. happy-dom matches no
  // `:focus-within`, so this reads the composer at rest.
  const composer = (width: number) => {
    happyDOM.setViewport({ width, height: 844 });
    const input = document.createElement('div');
    input.className = 'copilotKitInput';
    input.innerHTML = '<span class="pseudo-before"></span><span class="pseudo-after"></span>';
    document.body.append(input);
    const { backgroundColor, borderTopColor, boxShadow } = getComputedStyle(input);
    const resting = styleOf(input, '.pseudo-before');
    const lifted = styleOf(input, '.pseudo-after');
    const appearance = {
      fill: backgroundColor,
      border: borderTopColor,
      parentShadow: boxShadow,
      resting: { shadow: resting.boxShadow, opacity: resting.opacity },
      lifted: { shadow: lifted.boxShadow, opacity: lifted.opacity },
    };
    input.remove();
    return appearance;
  };

  try {
    const resting = {
      fill: '#fff',
      border: 'transparent',
      parentShadow: 'none',
      resting: { shadow: '0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.08)', opacity: '1' },
      lifted: { shadow: '0 4px 20px rgba(0, 0, 0, 0.15)', opacity: '0' },
    };
    expect(composer(1024)).toEqual(resting);
    expect(composer(440)).toEqual(resting);
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it("gives the composer's placeholder the muted text, and every scrollbar, CopilotKit's too, the line grey's thumb", () => {
  const input = document.createElement('div');
  input.className = 'copilotKitInput';
  input.innerHTML = '<textarea><span class="pseudo-placeholder"></span></textarea>';
  document.body.append(input);
  try {
    expect(styleOf(input, '.pseudo-placeholder').color).toBe('#646464');
  } finally {
    input.remove();
  }
  // happy-dom computes no scrollbar-color, so this reads the sheet: the root's, and CopilotKit's elements' own.
  expect(sheet).toMatch(/\n:root,\s*:root \[data-copilotkit\] \* \{\s*scrollbar-color: var\(--color-line\) transparent;\s*\}/);
  // A pane with its own thin `::-webkit-scrollbar` sets none, or Chrome would drop its thumb.
  expect(sheet).toMatch(/\n:root \.copilotKitMessages,\s*:root \.sidebar-list \{\s*scrollbar-color: auto;\s*\}/);
});

// The text is the `body` size and the picker `small`, whose phone sizes start at 640px.
const composerSizes = [[440, '17px', '15px'], [641, '14px', '13px'], [767, '14px', '13px'], [768, '14px', '13px'], [1440, '14px', '13px']] as const;
// CopilotKit lays a phone's out `expanded` always, a desktop's once its text takes two lines. A phone's is measured
// open, its two rows; at rest it is one (see below).
const composerCases = composerSizes.flatMap(([width, textSize, pickerSize]) =>
  (width < 768
    ? [['empty', '', 'expanded'], ['one-line', 'What moved US rates?', 'expanded']] as const
    : [['empty', '', 'compact'], ['one-line', 'What moved US rates?', 'compact'], ['two-line', 'What moved US rates?\nAnd why?', 'expanded']] as const
  ).map(([draft, text, layoutName]) => ({ width, textSize, pickerSize, draft, text, layoutName })),
);
// Paddings read top, right, bottom, left.
const composerLayouts = {
  phone: { rows: 'minmax(44px, auto) 44px', textColumn: '1 / -1', controlsRow: '2', textPadding: ['8px', '0px', '0px', '0px'], padding: ['0px', '15px', '0px', '15px'], columnGap: undefined, target: '44px' },
  // ChatGPT's desktop composer: 36px controls in a 52px row, inside 7px of padding and the 1px border.
  compact: { rows: 'auto', textColumn: '1', controlsRow: '1', textPadding: ['8px', '0px', '8px', '0px'], padding: ['7px', '10px', '7px', '8px'], columnGap: '12px', target: '36px' },
  // Two lines on a desktop, ChatGPT's pattern: the text across the top, its left edge on the +'s glyph, over the 36px
  // row of controls.
  expanded: { rows: 'auto 36px', textColumn: '1 / -1', controlsRow: '2', textPadding: ['8px', '8px', '8px', '8px'], padding: ['7px', '10px', '7px', '8px'], columnGap: '12px', target: '36px' },
} as const;

it.each(composerCases)('keeps phone text above right controls, and desktop text beside them until it takes two lines ($width px, $draft draft)', ({ width, textSize, pickerSize, text, layoutName }) => {
  try {
    happyDOM.setViewport({ width, height: 844 });
    // The type roles are the root's tokens, whose kept style a changed attribute drops.
    document.documentElement.dataset.width = String(width);
    const input = document.createElement('div');
    input.className = 'copilotKitInput';
    input.toggleAttribute('data-open', width < 768);
    input.innerHTML = `<div class="cpk:grid" data-layout="${layoutName}">
      <div class="cpk:col-start-1"></div>
      <div class="cpk:col-span-3"><textarea placeholder="Ask anything"></textarea></div>
      <div class="cpk:col-start-3"><div class="chat-model-picker"><div class="mep">
        <button class="mep-pill"><span class="mep-pill-model">Model</span><span class="mep-pill-effort">Medium</span></button><div class="mep-dropdown"></div>
      </div></div><button type="button" data-testid="copilot-send-button">Send</button></div>
    </div>`;
    const textarea = input.querySelector('textarea');
    if (textarea === null) throw new Error('no textarea');
    textarea.value = text;
    textarea.classList.toggle('placeholder-shown', text === '');
    document.body.append(input);
    const expected = composerLayouts[width < 768 ? 'phone' : layoutName];

    const layout = styleOf(input, '[data-layout]');
    expect(layout.gridTemplateRows).toBe(expected.rows);
    expect([layout.paddingTop, layout.paddingRight, layout.paddingBottom, layout.paddingLeft]).toEqual(expected.padding);
    if (expected.columnGap !== undefined) expect(layout.columnGap).toBe(expected.columnGap);
    const textStyle = styleOf(input, 'textarea');
    expect([textStyle.paddingTop, textStyle.paddingRight, textStyle.paddingBottom, textStyle.paddingLeft]).toEqual(expected.textPadding);
    expect(styleOf(input, '[class*="col-start-1"]').display).toBe('none');
    expect(styleOf(input, '[class*="col-span-3"]').gridColumn).toBe(expected.textColumn);
    expect(styleOf(input, '[class*="col-span-3"]').gridRow).toBe('1');
    expect(styleOf(input, '[class*="col-start-3"]').gridRow).toBe(expected.controlsRow);
    expect(textStyle.fontSize).toBe(textSize);
    // The text sits on the page's line at every width, over CopilotKit's `leading-relaxed`.
    expect(textStyle.lineHeight).toBe('1.3');
    expect(styleOf(input, '.mep-pill').fontSize).toBe(pickerSize);
    expect(styleOf(input, '.mep-pill-effort').display).not.toBe('none');
    expect(styleOf(input, '.mep-pill').minHeight).toBe(expected.target);
    expect(styleOf(input, '[data-testid="copilot-send-button"]').width).toBe(expected.target);
    expect(styleOf(input, '[data-testid="copilot-send-button"]').height).toBe(expected.target);
    expect(getComputedStyle(input).position).toBe('relative');
    expect(styleOf(input, '.mep').position).toBe('static');
    expect(styleOf(input, '.mep-dropdown').bottom).toBe('calc(100% + 8px)');
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    delete document.documentElement.dataset.width;
    document.querySelectorAll('.copilotKitInput').forEach((input) => input.remove());
  }
});

// Like the Claude app's, a phone's composer rests on one row, the + | the text | Send, its picker out of the row and out
// of sight but still rendered for its width glide, until its text is tapped.
it.each([440, 767])("rests a phone's composer on one row with no picker until it opens (%i px)", (width) => {
  try {
    happyDOM.setViewport({ width, height: 844 });
    // A fresh composer per state, as happy-dom keeps an element's computed style.
    const cells = (open: boolean) => {
      const host = document.createElement('div');
      host.className = 'composer-can-attach';
      host.innerHTML = `<div class="copilotKitInput picker-ready"${open ? ' data-open' : ''}><div class="cpk:grid" data-layout="expanded">
        <div class="cpk:col-start-1"><button data-testid="copilot-add-menu-button">+</button></div>
        <div class="cpk:col-span-3"><textarea></textarea></div>
        <div class="cpk:col-start-3"><div class="chat-model-picker"><button class="mep-pill">Model</button></div>
        <button type="button" data-testid="copilot-send-button">Send</button></div>
      </div></div>`;
      document.body.append(host);
      const cell = (selector: string) => [styleOf(host, selector).gridColumn, styleOf(host, selector).gridRow];
      const picker = styleOf(host, '.chat-model-picker');
      const read = {
        rows: styleOf(host, '[data-layout]').gridTemplateRows,
        add: cell('[class*="col-start-1"]'),
        text: cell('[class*="col-span-3"]'),
        controls: cell('[class*="col-start-3"]'),
        picker: [picker.visibility || 'visible', picker.display],
      };
      host.remove();
      return read;
    };

    expect(cells(false)).toEqual({ rows: 'minmax(44px, auto)', add: ['1', '1'], text: ['2', '1'], controls: ['3', '1'], picker: ['hidden', 'block'] });
    expect(cells(true)).toEqual({ rows: 'minmax(44px, auto) 44px', add: ['1', '2'], text: ['1 / -1', '1'], controls: ['3', '2'], picker: ['visible', 'block'] });
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it("puts a desktop's + under two lines of text, at the left of the controls' row, and beside one line", () => {
  try {
    happyDOM.setViewport({ width: 1440, height: 844 });
    for (const [layoutName, cells] of [
      ['compact', { add: ['1', '1'], text: ['2', '1'], controls: ['3', '1'] }],
      ['expanded', { add: ['1', '2'], text: ['1 / -1', '1'], controls: ['3', '2'] }],
    ] as const) {
      const input = document.createElement('div');
      input.className = 'copilotKitInput';
      const host = document.createElement('div');
      host.className = 'composer-can-attach';
      host.append(input);
      input.innerHTML = `<div class="cpk:grid" data-layout="${layoutName}">
        <div class="cpk:col-start-1"><button type="button" data-testid="copilot-add-menu-button">+</button></div>
        <div class="cpk:col-span-3"><textarea></textarea></div>
        <div class="cpk:col-start-3"><button type="button" data-testid="copilot-send-button">Send</button></div>
      </div>`;
      document.body.append(host);
      const place = (selector: string) => [styleOf(input, selector).gridColumn, styleOf(input, selector).gridRow];
      expect({ add: place('[class*="col-start-1"]'), text: place('[class*="col-span-3"]'), controls: place('[class*="col-start-3"]') }).toEqual(cells);
      expect(styleOf(input, '[data-testid="copilot-add-menu-button"]').width).toBe('36px');
      host.remove();
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    document.querySelectorAll('.copilotKitInput').forEach((input) => input.remove());
  }
});

// iOS Safari zooms into a field under 16px as it takes focus, so a touch tablet keeps the composer's text at 16px.
it("keeps the composer's text at 16px on a touch tablet, the desktop's 14px with a mouse and the phone's 17px", () => {
  // A fresh composer per device, as happy-dom keeps an element's computed style; the root's tokens, kept likewise, are
  // dropped by a changed attribute.
  const textSize = (width: number, maxTouchPoints: number) => {
    happyDOM.setViewport({ width, height: 1024 });
    happyDOM.settings.navigator.maxTouchPoints = maxTouchPoints;
    document.documentElement.dataset.width = `${width}-${maxTouchPoints}`;
    const input = document.createElement('div');
    input.className = 'copilotKitInput';
    input.innerHTML = '<textarea></textarea>';
    document.body.append(input);
    const { fontSize } = styleOf(input, 'textarea');
    input.remove();
    return fontSize;
  };

  try {
    expect([textSize(768, 5), textSize(1024, 5), textSize(1024, 0), textSize(440, 5)]).toEqual(['16px', '16px', '14px', '17px']);
  } finally {
    happyDOM.settings.navigator.maxTouchPoints = 0;
    happyDOM.setViewport({ width: 1024, height: 768 });
    delete document.documentElement.dataset.width;
  }
});

// a long URL or token in the user's message ran past the bubble's right edge and was cut off.
it("wraps a long unbroken string in the user's own message inside its bubble", () => {
  const message = document.createElement('div');
  message.className = 'copilotKitMessage copilotKitUserMessage';
  message.innerHTML = `<div>${'x'.repeat(160)}</div>`;
  document.body.append(message);

  expect(styleOf(message, 'div').overflowWrap).toBe('anywhere');
  message.remove();
});

it("shows an initial or emoji avatar on a blackish disc, and the agent's own figure with no disc", () => {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  const agent = document.createElement('span');
  agent.className = 'avatar avatar-agent';
  document.body.append(avatar, agent);

  expect(getComputedStyle(avatar).backgroundColor).toBe('#202020');
  expect(getComputedStyle(agent).backgroundColor).not.toBe('#202020');
  avatar.remove();
  agent.remove();
});

// streamdown 2.7 marks the table data-streamdown="table" in a table-wrapper card; these rules once targeted 1.6's
// markup, which marked the <table> table-wrapper too, so the card's padding and Typography's table margins showed.
it("shows a message's markdown table flat on the bubble, as wide as its content, its edge cells in line with the text, fading where it scrolls, its controls in no row of their own", () => {
  const { container, unmount } = render(
    <div data-copilotkit="" className="copilotKitMessage copilotKitAssistantMessage">
      <div className="cpk:prose">
        <Streamdown>{`Scenarios:

| Currency | Spot level | Outlook |
| --- | ---: | --- |
| Australian dollar | 0.6543 | Continued gains against the US dollar |`}</Streamdown>
      </div>
    </div>,
  );

  try {
    expect(container.querySelector('td')?.textContent).toBe('Australian dollar');
    const card = styleOf(container, 'div[data-streamdown="table-wrapper"]');
    expect(card.padding).toBe('0px');
    expect(card.borderWidth || '0px').toBe('0px');
    const scroller = styleOf(container, 'div[data-streamdown="table-wrapper"] > div:last-child');
    expect(scroller.borderWidth || '0px').toBe('0px');
    expect(scroller.borderRadius || '0px').toBe('0px');
    // happy-dom reads `background: none` back as a `none` colour.
    expect(['transparent', 'none']).toContain(scroller.backgroundColor || 'transparent');
    expect(scroller.backgroundImage || 'none').toBe('none');
    const table = styleOf(container, 'table[data-streamdown="table"]');
    expect(table.marginTop).toBe('0px');
    expect(table.width).toBe('max-content');
    expect(table.minWidth || 'auto').toBe('auto');
    expect(styleOf(container, 'td:nth-child(2)').whiteSpace).toBe('nowrap');
    expect([styleOf(container, 'th:first-child').paddingLeft, styleOf(container, 'td:last-child').paddingRight]).toEqual(['0px', '0px']);
    const controls = styleOf(container, 'div[data-streamdown="table-wrapper"] > div:first-child:not(:last-child)');
    expect(controls.justifyContent).toBe('flex-end');
    expect(styleOf(container, 'div[data-streamdown="table-wrapper"] > div:first-child button').padding).toBe('4px');
  } finally {
    unmount();
  }
  // happy-dom loads no streamdown classes and runs no scroll-driven animations, so this reads the sheet: the box drops
  // streamdown's frame and gates the fade on support. Firefox and Chromium prove the fallback and scrolling.
  expect(sheet).toMatch(
    /\[data-streamdown="table-wrapper"\] > div:last-child \{[^}]*overflow: auto;\s*border: 0;\s*border-radius: 0;\s*background: none;/,
  );
  expect(sheet).toMatch(/@supports \(animation-timeline: scroll\(self inline\)\) \{[\s\S]*?mask-image: linear-gradient[\s\S]*?animation: tableEdgeFade linear both;\s*animation-timeline: scroll\(self inline\);/);
  expect(motion).toMatch(/@keyframes tableEdgeFade \{/);
});

// a white band ran from the scroll-to-bottom chevron's row down to the composer, hiding the messages behind it.
it("scrolls the messages behind CopilotKit's scroll-to-bottom chevron down to the composer, with no band around it (memo 0049 Fig 7)", () => {
  const chat = document.createElement('div');
  chat.setAttribute('data-copilotkit', '');
  chat.innerHTML = '<div class="row"><button data-testid="copilot-scroll-to-bottom"></button></div>';
  document.body.append(chat);

  // The chevron keeps CopilotKit's own white disc and border over the text, in the resting shadow.
  expect(styleOf(chat, 'button').boxShadow).toBe('0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.08)');
  const row = styleOf(chat, '.row');
  expect(row.backgroundImage).toBe('');
  expect(row.backgroundColor).toBe('');
  expect(row.paddingTop).toBe('');
  expect(row.marginBottom).toBe('');
  chat.remove();
});

it("fills the visible viewport, so iOS Safari's toolbars never let the page scroll under the menu button", () => {
  // happy-dom drops the dvh unit, so this reads the sheet itself.
  expect(sheet).toMatch(/\n\.app-layout \{[^}]*height: calc\(100dvh - var\(--app-safe-top\) - var\(--app-safe-bottom\)\);/);
  expect(sheet).toMatch(/\n\.sidebar \{[^}]*height: 100dvh;/);
  // A phone's layout runs under the status and home bars (memo 0049 Fig 21), its contents padded clear of them, and
  // grows with the chat that scrolls the page.
  expect(sheet).toMatch(/\n {2}\.app-layout \{\s*height: auto;\s*min-height: 100dvh;\s*margin: 0 var\(--app-safe-right\) 0 var\(--app-safe-left\);\s*padding-top: var\(--app-safe-top\);\s*transform: none;/);
});

it("keeps a phone's messages one gutter from the screen edge (dots Fig 7), with the column's own padding dropped", () => {
  const column = (className: string) => {
    const element = document.createElement('div');
    element.className = className;
    document.body.append(element);
    return getComputedStyle(element);
  };

  expect(column('copilotKitMessages').paddingLeft).toBe('24px');
  happyDOM.setViewport({ width: 390, height: 844 });
  try {
    const messages = column('copilotKitMessages');
    expect(messages.paddingLeft).toBe('0px');
    expect(messages.paddingRight).toBe('0px');
    expect(column('chat-run-error').width).toBe('100%');
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// the composer took 90% of CopilotKit's column, so its edges missed the grey panel's on a phone and a desktop.
it("lines the composer and its accessory up with the messages' column, the grey panel's edges, but on a phone the composer and its accessory reach into the gutter", () => {
  const box = (className: string) => {
    const element = document.createElement('div');
    element.className = className;
    document.body.append(element);
    return getComputedStyle(element);
  };

  // A desktop's messages' column: 720px at most, less its 1.5rem side padding, in CopilotKit's 768px column.
  // happy-dom leaves calc() and min() unresolved, so this reads the sheet.
  expect(sheet).toMatch(/\n\.copilotKitInput \{[^}]*\n {2}width: calc\(min\(720px, 100%\) - 3rem\) !important;/);
  expect(sheet).toMatch(/\n\.composer-accessory \{[^}]*\n {2}width: calc\(min\(720px, 100%\) - 3rem\);/);
  expect(box('copilotKitInput').maxWidth).toBe('');
  expect(box('composer-accessory').maxWidth).toBe('');
  happyDOM.setViewport({ width: 390, height: 844 });
  try {
    // A phone's messages' column drops its side padding, and the composer reaches 4px into CopilotKit's 1rem gutter,
    // 12px from the screen's edges like ChatGPT Work's; its accessory shares its left edge.
    for (const className of ['copilotKitInput', 'composer-accessory']) {
      expect(box(className).width).toBe('calc(100% + 8px)');
      expect(box(className).marginLeft).toBe('-4px');
      expect(box(className).marginRight).toBe('-4px');
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it('opens the Agent Profile as a narrow right sidebar beside the chat on a desktop, over the chat on a tablet, and as a full-screen sheet on a phone', () => {
  // A fresh element per viewport, as happy-dom keeps an element's computed style; removed, so no later test finds it.
  const profileStyle = (width: number, height: number) => {
    happyDOM.setViewport({ width, height });
    const profile = document.createElement('div');
    profile.className = 'agent-profile';
    document.body.append(profile);
    const { position, inset, right, flexShrink, width: profileWidth } = getComputedStyle(profile);
    profile.remove();
    return { position, inset, right, flexShrink, width: profileWidth };
  };

  try {
    const desktop = profileStyle(1440, 900);
    expect(desktop.position).not.toBe('fixed');
    expect(desktop.flexShrink).toBe('0');
    expect(desktop.width).toBe('440px');
    const tablet = profileStyle(900, 1200);
    expect(tablet.position).toBe('fixed');
    expect(tablet.right).toBe('0px');
    expect(tablet.width).toBe('440px');
    const phone = profileStyle(390, 844);
    expect(phone.position).toBe('fixed');
    // The safe area's, as a phone's layout runs under the status and home bars
    expect(phone.inset).toBe('env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px)');
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it("dims a paused scheduled task's icon and name", () => {
  const { container, unmount } = render(
    <ul>
      <li className="list-row scheduled-task scheduled-task-paused">
        <span className="list-row-icon" />
        <span className="list-row-title scheduled-task-title">Oil brief</span>
      </li>
    </ul>,
  );

  expect(styleOf(container, '.list-row-icon').color).toBe('#646464');
  expect(styleOf(container, '.scheduled-task-title').color).toBe('#646464');
  unmount();
});

it('opens a file full screen on a phone, keeping a profile refresh error in view (ADR 0030)', () => {
  happyDOM.setViewport({ width: 390, height: 844 });
  const { container, unmount } = render(
    <div className="agent-profile">
      <div className="agent-profile-header">
        <div className="agent-profile-identity">
          <h2 className="agent-profile-name">Marq</h2>
        </div>
        <p className="agent-profile-error">Agent profile failed: 503</p>
      </div>
      <div className="agent-profile-tabs" />
      <div className="agent-profile-panel">
        <article className="agent-file" />
      </div>
    </div>,
  );

  try {
    // They fold away to no height, hidden once folded.
    expect(styleOf(container, '.agent-profile-header').gridTemplateRows).toBe('0fr');
    expect(styleOf(container, '.agent-profile-identity').visibility).toBe('hidden');
    expect(styleOf(container, '.agent-profile-tabs').height).toBe('0px');
    expect(styleOf(container, '.agent-profile-tabs').visibility).toBe('hidden');
    // A hidden parent would hide the error whatever its own display, so the header must stay shown too.
    expect(styleOf(container, '.agent-profile-header').display).not.toBe('none');
    expect(styleOf(container, '.agent-profile-error').display).not.toBe('none');
    expect(styleOf(container, '.agent-profile-error').visibility).not.toBe('hidden');
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it('hides the kept Agent Profile when closed and shows it again at each viewport', () => {
  try {
    for (const width of [1440, 900, 390]) {
      happyDOM.setViewport({ width, height: 900 });
      // A fresh element per state avoids happy-dom's computed-style cache. Closing keeps the DOM,
      // including the Computer live view; visibility must follow hidden rather than an attribute filter.
      for (const closed of [false, true, false]) {
        const profile = document.createElement('div');
        profile.className = 'agent-profile';
        profile.hidden = closed;
        document.body.append(profile);
        try {
          expect(getComputedStyle(profile).display).toBe(closed ? 'none' : 'flex');
        } finally {
          profile.remove();
        }
      }
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// a scheduled task's edit fields had no border or background, so they read as static text.
it("shows a scheduled task's Title and instructions as fields, and its schedule as settings rows after Codex's", () => {
  const form = document.createElement('div');
  form.innerHTML =
    '<input class="settings-text" value="Morning brief" /><textarea class="settings-text"></textarea>' +
    '<div class="settings-group"><label class="settings-row"><span>Repeat</span><span class="settings-select"><select></select></span></label></div>';
  document.body.append(form);

  for (const control of ['input', 'textarea']) {
    expect(styleOf(form, control).borderStyle).toBe('solid');
    expect(styleOf(form, control).backgroundColor).toBe('#fff');
    expect(styleOf(form, control).borderRadius).toBe('12px');
  }
  expect(styleOf(form, 'textarea').minHeight).toBe('120px');
  expect([styleOf(form, '.settings-group').borderStyle, styleOf(form, '.settings-group').borderRadius]).toEqual(['solid', '12px']);
  expect([styleOf(form, '.settings-row').minHeight, styleOf(form, '.settings-row').padding]).toEqual(['48px', '8px 20px']);
  expect(styleOf(form, '.settings-row').color).toBe('#202020');
  expect(styleOf(form, 'select').color).toBe('#646464');
  form.remove();
});

it('spaces a scheduled-task proposal in a message by its own gap, not prose paragraph margins', () => {
  const { message, prose } = inAssistantMessage('');
  render(
    <ScheduledTaskProposalCard
      result='Proposed. Nothing is scheduled until the user confirms it in the chat.'
      chatServiceUrl="http://chat.test"
      proposalId="call-1"
      proposal={{ title: 'Morning brief', prompt: 'Brief me on rates', frequency: 'weekdays', time: '08:00' }}
    />,
    { container: prose },
  );

  const lines = [...message.querySelectorAll('.scheduled-proposal p')];
  expect(lines.map((line) => line.className)).toEqual(['scheduled-task-title', 'scheduled-task-prompt', 'scheduled-task-schedule']);
  expect(lines.map((line) => getComputedStyle(line).margin)).toEqual(['0px', '0px', '0px']);
  expect(styleOf(message, '.scheduled-proposal').gap).toBe('4px');
});

it("shows the agent's name in a capsule over the avatar's bottom edge, which sinks when pressed (memo 0049 Figs 1, 7 and 11)", () => {
  const { container } = render(
    <header className="chat-header">
      <button className="chat-header-agent">
        <span className="avatar" />
        <span className="chat-header-name">Pebble</span>
      </button>
    </header>,
  );

  const name = styleOf(container, '.chat-header-name');
  // Over the avatar's bottom edge, crisp white on desktop (Fig 1; the phone's frosted one is pinned with the phone below).
  expect(name.marginTop).toBe('-11px');
  expect(name.position).toBe('relative');
  expect(name.borderRadius).toBe('9999px');
  expect(name.backgroundColor).toBe('#fff');
  expect(sheet).toMatch(/\.chat-header-agent:active:not\(:disabled\)\s*\{\s*transform: scale\(0\.95\);/);
  expect(sheet).toMatch(/\.chat-header-agent:active:not\(:disabled\) \.chat-header-name \{\s*background: var\(--color-line\);/);
});

it("answers a mouse over the agent's capsule and rings it on keyboard focus", () => {
  // happy-dom applies no :hover or :focus-visible, so these read the sheet. A mouse lifts the capsule; a phone, which
  // has no hover, keeps the press. The keyboard's focus rings the capsule in blue.
  expect(sheet).toMatch(
    /@media \(hover: hover\) \{\s*\.chat-header-agent:hover:not\(:disabled\) \.chat-header-name \{\s*background: var\(--color-white\);\s*box-shadow: var\(--shadow-rest\);/,
  );
  // Forced colors drop box-shadows but paint a transparent outline, so keyboard focus stays visible there.
  expect(sheet).toMatch(/\.chat-header-agent:focus-visible \{\s*outline: 2px solid transparent;\s*\}/);
  expect(sheet).toMatch(
    /\.chat-header-agent:focus-visible:not\(:disabled\) \.chat-header-name \{\s*box-shadow: 0 0 0 2px var\(--color-white\), 0 0 0 4px var\(--color-blue\);/,
  );
});

it('lays inline steering out as a normal user message', () => {
  expect(sheet).toMatch(/:is\(\.copilotKitAssistantMessage, \.worklog\) \+ \.copilotKitUserMessage \{\s*margin-top: 32px;/);
  expect(sheet).toMatch(/\.copilotKitUserMessage > div:first-of-type \{[^}]*padding: calc\(var\(--radius-xl\) - 0\.5lh\) 16px !important;[^}]*line-height: var\(--leading\);/);
  expect(sheet).not.toContain('.chat-queued-');
});

it("keeps the profile's status where it lands as the agent's character line comes", () => {
  // Without the line, the status takes its place: the line's height in the small role, and the header's 4px gap.
  expect(motion).toMatch(/\.agent-profile-name \+ \.agent-profile-status \{\s*margin-top: calc\(var\(--font-small\) \* var\(--leading\) \+ 4px\);/);
  expect(sheet).toMatch(/\n\.agent-profile-identity \{[^}]*gap: 4px;/);
  expect(sheet).toMatch(/\n\.agent-profile-character \{[^}]*font-size: var\(--font-small\);/);
});

it("fades the Agent Computer's dock apps in, leaving the next tap to the dock", () => {
  // A View Transition takes every tap while it runs, so the dock fades in CSS and only the sheet's zoom glides.
  expect(motion).toMatch(/\.agent-computer-app,\s*\.agent-computer-cover \{\s*transition: opacity var\(--motion-quick\) var\(--ease\);/);
  expect(motion).toMatch(/@starting-style \{\s*\.agent-computer-app,\s*\.agent-computer-cover \{\s*opacity: 0;/);
  expect(readFileSync(path.join(here, '../computer/agent-computer.tsx'), 'utf8')).toMatch(/onClick=\{\(\) => onOpenApp\(dockApp\)\}/);
});

it('bobs Marq while the agent works', () => {
  // happy-dom runs no animations, so this reads the sheet.
  expect(sheet).toMatch(/\.chat-header-agent\[data-working\] \.avatar-agent svg \{\s*animation: chatHeaderBob var\(--motion-loop\) ease-in-out infinite;/);
});

it('keeps the avatar keyboard focus ring while the pointer is over it', () => {
  // happy-dom does not track hover or focus-visible. Equivalent classes preserve selector specificity
  // and exercise their combined cascade using the actual stylesheet, including the disabled control.
  const states = document.createElement('style');
  states.textContent = page.replace(/:hover\b/g, '.pointer-over').replace(/:focus-visible\b/g, '.keyboard-focused').replace(/\(hover: hover\)/g, 'all');
  const button = document.createElement('button');
  button.className = 'chat-header-agent pointer-over keyboard-focused';
  button.innerHTML = '<span class="chat-header-name">Astra</span>';
  document.head.append(states);
  document.body.append(button);
  try {
    const focusRing = '0 0 0 2px #fff, 0 0 0 4px #0d74ce';
    expect(styleOf(button, '.chat-header-name').boxShadow).toBe(focusRing);
    button.classList.remove('pointer-over');
    expect(styleOf(button, '.chat-header-name').boxShadow).toBe(focusRing);
    button.classList.remove('keyboard-focused');
    button.classList.add('pointer-over');
    expect(styleOf(button, '.chat-header-name').boxShadow).toBe('0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.08)');
    button.disabled = true;
    expect(styleOf(button, '.chat-header-name').boxShadow || 'none').toBe('none');
  } finally {
    button.remove();
    states.remove();
  }
});

it("floats the agent's header over the chat, which scrolls beneath it without a backing band, and starts the first message below it (memo 0049 Figs 7 and 11)", () => {
  const { container } = render(
    <main className="app-shell">
      <header className="chat-header">
        <span className="pseudo-before" />
        <button className="chat-header-agent" />
      </header>
      <div className="app-chat">
        <div className="copilotKitMessages" />
      </div>
    </main>,
  );

  const header = styleOf(container, '.chat-header');
  expect(header.position).toBe('absolute');
  expect(header.top).toBe('0px');
  expect(header.zIndex).toBe('30');
  // Taps between the avatar and the screen edge reach the chat beneath.
  expect(header.pointerEvents).toBe('none');
  expect(styleOf(container, '.chat-header-agent').pointerEvents).toBe('auto');
  expect(styleOf(container, '.pseudo-before').backdropFilter || 'none').toBe('none');
  expect(styleOf(container, '.pseudo-before').backgroundImage || 'none').toBe('none');
  // happy-dom leaves var() and calc() unresolved, so this reads the sheet: the header's height, then the column's gap.
  expect(sheet).toMatch(/\n\.app-shell \{[^}]*--chat-header-height: 97px;/);
  expect(sheet).toMatch(/\n\.chat-header \+ \.app-chat \.copilotKitMessages \{\s*padding-top: calc\(var\(--chat-header-height\) \+ 0\.5rem\);/);
  expect(sheet).toMatch(/\n\.welcome-screen \{[^}]*top: var\(--chat-header-height\);/);
});

it('starts an alert under the header below it, and the chat below the alert with no room left for the header', () => {
  const { container } = render(
    <main className="app-shell">
      <header className="chat-header" />
      <p className="chat-account-error" role="alert" />
      <div className="app-chat">
        <div className="copilotKitMessages" />
      </div>
    </main>,
  );

  // happy-dom leaves var() unresolved, so this reads the sheet for the alert's margin.
  expect(sheet).toMatch(/\n\.chat-header \+ :not\(\.app-chat\) \{\s*margin-top: var\(--chat-header-height\);/);
  expect(styleOf(container, '.copilotKitMessages').paddingTop).toBe('20px');
});

// A phone's chat scrolls the page, so alerts above the chat sat at the page's top, off screen below a long chat.
it('keeps the alerts on screen under the phone header as the chat scrolls the page', () => {
  happyDOM.setViewport({ width: 390, height: 844 });
  try {
    const { container } = render(
      <main className="app-shell">
        <header className="chat-header" />
        <div className="chat-alerts">
          <p className="chat-account-error" role="alert" />
        </div>
        <div className="app-chat" />
      </main>,
    );
    const alerts = styleOf(container, '.chat-alerts');
    expect(alerts.position).toBe('sticky');
    expect(alerts.backgroundColor).not.toBe('');
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
  // happy-dom leaves var() unresolved, so this reads the sheet: they stand just under the fixed header.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-alerts \{\s*position: sticky;\s*top: var\(--chat-header-height\);/);
});

it("cuts the agent's character to one line with an ellipsis", () => {
  const { container } = render(<p className="agent-profile-character" />);

  const style = styleOf(container, '.agent-profile-character');
  expect([style.whiteSpace, style.overflow, style.textOverflow]).toEqual(['nowrap', 'hidden', 'ellipsis']);
});

it("sets Personalization's file cards side by side, as Muse's (Fig 16)", () => {
  const { container } = render(<div className="agent-file-cards" />);

  expect(styleOf(container, '.agent-file-cards').gridTemplateColumns).toBe('1fr 1fr');
});

// The template ships Marq's Soul and Memory colours, so a Cartridge brings none.
it("paints the Soul card periwinkle and the Memory card a deeper navy unless a cartridge's theme brings its own", () => {
  // happy-dom leaves var() unresolved, so this reads the sheet.
  expect(sheet).toMatch(/:root \{[^}]*--agent-body: #aec6e3;\s*--agent-outline: #6f93bf;\s*--agent-deep: #3f5f8a;\s*--agent-deepest: #1c2b45;/);
  for (const [file, from, to] of [['soul', 'outline', 'deep'], ['memory', 'deep', 'deepest']]) {
    expect(sheet).toMatch(
      new RegExp(`\\.agent-file-tint-${file} \\{\\s*--file-from: var\\(--agent-${from}\\);\\s*--file-to: var\\(--agent-${to}\\);\\s*--file-glow: var\\(--agent-body\\);`),
    );
  }
});

// a Side Chat row showed rename and delete inline; touch now opens its menu with a long-press, so only a
// mouse shows the row's ⋯, and only on hover, focus or while its menu is open; on touch it stays for VoiceOver, out of sight.
it("shows a Side Chat's actions button only with a mouse, on hover, focus or while its menu is open, and never on a touch screen", () => {
  // happy-dom matches no :hover or :focus-within, so a copy of the sheet marking those states with classes stands in for it.
  const states = document.createElement('style');
  states.textContent = page.replace(/:hover\b/g, '.pointer-over').replace(/:focus-within\b/g, '.focus-inside');
  style.replaceWith(states);
  // A fresh row per case, as happy-dom keeps an element's computed style; removed, so no later test finds it.
  const shown = (maxTouchPoints: number, state = '') => {
    happyDOM.settings.navigator.maxTouchPoints = maxTouchPoints;
    const row = document.createElement('div');
    row.className = `sidebar-item ${state}`;
    row.innerHTML = '<button class="sidebar-item-btn">Rates</button><button class="sidebar-item-more"></button>';
    document.body.append(row);
    const more = styleOf(row, '.sidebar-item-more');
    const seen = more.display === 'none' ? 'none' : more.position === 'absolute' ? 'out of sight' : 'shown';
    row.remove();
    return seen;
  };

  try {
    // On touch it stays in reach of VoiceOver, clipped out of sight (happy-dom computes no clip-path).
    expect(shown(5)).toBe('out of sight');
    expect(shown(5, 'pointer-over sidebar-item-held')).toBe('out of sight');
    // At rest with a mouse it takes no room, so a long title runs the row's full width.
    expect(shown(0)).toBe('none');
    expect(shown(0, 'pointer-over')).toBe('shown');
    // Tabbing to the title reveals it, so the next Tab reaches it.
    expect(shown(0, 'focus-inside')).toBe('shown');
    expect(shown(0, 'sidebar-item-held')).toBe('shown');
  } finally {
    happyDOM.settings.navigator.maxTouchPoints = 0;
    states.replaceWith(style);
  }
});

// the Main chat pill was filled at rest, so with a Side Chat open both looked selected; and on a phone the
// drawer was a 260 px panel with 13 px rows where Muse Fig 12 is a list with large rows. Muse Fig 21 then left a strip
// of the chat in view beside it, and its Side Chat rows step at the nav rows' 44px pitch.
it('fills the Main chat pill only while it is the open chat, and opens the drawer beside the chat with large rows on a phone', () => {
  // A fresh drawer per case, as happy-dom keeps an element's computed style; removed, so no later test finds it.
  // The type tokens are the root's, whose kept style a changed attribute drops.
  const drawer = (mainChatClass: string) => {
    document.documentElement.dataset.width = String(window.innerWidth);
    const aside = document.createElement('aside');
    aside.className = 'sidebar sidebar-expanded';
    aside.innerHTML =
      `<nav class="sidebar-nav sidebar-main"><button class="sidebar-nav-item sidebar-main-chat ${mainChatClass}">` +
      '<span class="sidebar-nav-label">Main chat</span></button></nav>' +
      '<div class="sidebar-item"><button class="sidebar-item-btn">Rates</button></div>';
    document.body.append(aside);
    const styles = {
      width: getComputedStyle(aside).width,
      mainChat: { ...styleOf(aside, '.sidebar-main-chat') },
      sideChat: { ...styleOf(aside, '.sidebar-item-btn') },
    };
    aside.remove();
    return styles;
  };

  expect(drawer('').mainChat.backgroundColor).not.toBe(drawer('sidebar-nav-item-active').mainChat.backgroundColor);
  expect(drawer('').width).toBe('260px');
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    const phone = drawer('');
    expect(phone.width).toBe('80%');
    expect(phone.mainChat.fontSize).toBe('17px');
    expect(phone.sideChat.fontSize).toBe('17px');
    // A Side Chat's title fills its row's height, centred in it, on the nav rows' line.
    expect([zero(phone.sideChat.paddingTop), phone.sideChat.alignSelf]).toEqual(['0px', 'stretch']);
    expect(phone.sideChat.lineHeight).toBe(phone.mainChat.lineHeight);
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// the open drawer covered the whole chat; memo 0049 Fig 21 slides the chat right as a rounded card beside it, its
// soft shadow on the drawer.
it("slides the chat right by the phone drawer's width as a rounded, shadowed card", () => {
  // happy-dom leaves :has() and vw unresolved, so this reads the sheet.
  expect(sheet).toMatch(
    /\.app-layout:has\(> \.sidebar-expanded\) \.app-shell \{\s*transform: translateX\(80vw\);[^}]*border-radius: var\(--radius-screen\);\s*box-shadow: var\(--shadow-float\);/,
  );
});

// on a phone the messages were 14px beside the drawer's 17px rows; phone body text is 17px (Muse Fig 11,
// dots Fig 7, iOS body), as on desktop the messages are ChatGPT Mac's 14px, both on the page's line.
it("sets the messages at the drawer rows' 17px on a phone, and at 14px on desktop", () => {
  // A fresh pair per viewport, as happy-dom keeps an element's computed style; removed, so no later test finds them.
  // The token is the root's, whose kept style a changed attribute drops.
  const sizes = () => {
    document.documentElement.dataset.width = String(window.innerWidth);
    const user = document.createElement('div');
    user.className = 'copilotKitMessage copilotKitUserMessage';
    user.innerHTML = '<div>Chart the 10y</div>';
    document.body.append(user);
    const { prose } = inAssistantMessage('<p>The curve steepened.</p>');
    const bubble = styleOf(user, ':scope > div');
    const reply = getComputedStyle(prose);
    const result = { user: [bubble.fontSize, bubble.lineHeight], assistant: [reply.fontSize, reply.lineHeight] };
    user.remove();
    prose.parentElement?.remove();
    return result;
  };

  expect(sizes()).toEqual({ user: ['14px', '1.3'], assistant: ['14px', '1.3'] });
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    expect(sizes()).toEqual({ user: ['17px', '1.3'], assistant: ['17px', '1.3'] });
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    delete document.documentElement.dataset.width;
  }
});


// DESIGN.md's four sizes, each its desktop size and iOS's text style on a phone, in its two weights: one or more
// samples of each, among them the sidebar rows and the menu, which stay regular, and the agent's name pill, a `body`
// heading in semibold on both.
it("sets each type size at its desktop size and iOS's phone one, in its weight", () => {
  const samples = [
    ['title', '<h1 class="plugins-title"></h1>', '18px', '600', '22px', '600'],
    ['identity title', '<h2 class="agent-profile-name"></h2>', '18px', '600', '22px', '600'],
    ['brand', '<aside class="sidebar sidebar-expanded"><span class="sidebar-brand-text"></span></aside>', '18px', '600', '22px', '600'],
    ['body heading', '<div class="list-row-title"></div>', '14px', '600', '17px', '600'],
    ['name pill', '<div class="chat-header-name"></div>', '14px', '600', '17px', '600'],
    ['body', '<p class="welcome-desc"></p>', '14px', '400', '17px', '400'],
    ['sidebar row', '<aside class="sidebar sidebar-expanded"><button class="sidebar-nav-item"></button></aside>', '14px', '400', '17px', '400'],
    ['side chat row', '<button class="sidebar-item-btn"></button>', '14px', '400', '17px', '400'],
    ['menu item', '<button class="user-menu-item"></button>', '14px', '400', '17px', '400'],
    ['small', '<p class="plugins-intro"></p>', '13px', '400', '15px', '400'],
    ['worklog header', '<button class="worklog-head"></button>', '13px', '400', '15px', '400'],
    ['label', '<div class="chat-disclaimer"></div>', '12px', '400', '13px', '400'],
  ] as const;
  try {
    for (const [width, phone] of [[1440, false], [440, true]] as const) {
      happyDOM.setViewport({ width, height: 956 });
      document.documentElement.dataset.width = String(width);
      for (const [role, markup, size, weight, phoneSize, phoneWeight] of samples) {
        const host = document.createElement('div');
        host.innerHTML = markup;
        document.body.append(host);
        const element = host.querySelector(':scope > * > *') ?? host.firstElementChild;
        if (element === null) throw new Error(`no ${role}`);
        const style = getComputedStyle(element);
        // An unset weight inherits the page's `normal`, 400.
        const fontWeight = style.fontWeight === 'normal' ? '400' : style.fontWeight;
        expect([role, style.fontSize, fontWeight]).toEqual(phone ? [role, phoneSize, phoneWeight] : [role, size, weight]);
        host.remove();
      }
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    delete document.documentElement.dataset.width;
  }
});

// Shut, the desktop sidebar leaves the window to the chat but for its round menu chip; open, it docks beside the chat
// with the profile's hairline seam, mirrored.
it('shows only the round menu chip while the desktop sidebar is shut, and docks the open one beside the chat', () => {
  const shut = render(
    <aside className="sidebar sidebar-collapsed">
      <div className="sidebar-brand"><button className="sidebar-logo-btn"><svg className="sidebar-icon-menu" /></button></div>
      <nav className="sidebar-nav sidebar-main" />
      <div className="sidebar-recents" />
      <div className="sidebar-bottom" />
    </aside>,
  );
  try {
    const sidebar = styleOf(shut.container, '.sidebar');
    expect({ position: sidebar.position, top: zero(sidebar.top), left: zero(sidebar.left), zIndex: sidebar.zIndex }).toEqual({ position: 'fixed', top: '0px', left: '0px', zIndex: '90' });
    for (const selector of ['.sidebar-nav', '.sidebar-recents', '.sidebar-bottom']) {
      expect(styleOf(shut.container, selector).display).toBe('none');
    }
    expect(styleOf(shut.container, '.sidebar-icon-menu').display).not.toBe('none');
    const chip = styleOf(shut.container, '.sidebar-logo-btn');
    expect({ width: chip.width, height: chip.height, radius: chip.borderRadius }).toEqual({ width: '44px', height: '44px', radius: '9999px' });
  } finally {
    shut.unmount();
  }
  const open = render(
    <div className="app-layout">
      <aside className="sidebar sidebar-expanded"><div className="sidebar-brand"><button className="sidebar-logo-btn" /></div></aside>
      <main className="app-shell" />
      <aside className="agent-profile" />
    </div>,
  );
  try {
    const sidebar = styleOf(open.container, '.sidebar');
    // The seam lies outside the 260px, so the rows keep their places
    expect({ position: sidebar.position, width: sidebar.width, boxSizing: sidebar.boxSizing, flexShrink: sidebar.flexShrink, background: sidebar.backgroundColor }).toEqual({ position: 'relative', width: '260px', boxSizing: 'content-box', flexShrink: '0', background: '#fff' });
    // White beside the chat's grey page, the seam between them
    expect(styleOf(open.container, '.app-shell').backgroundColor).toBe('#f9f9f9');
    expect(sidebar.boxShadow || 'none').toBe('none');
    expect(sidebar.animation || 'none').toBe('none');
    expect(sidebar.borderRight).toBe('1px solid #e8e8e8');
    expect(sidebar.borderRight).toBe(styleOf(open.container, '.agent-profile').borderLeft);
    // Open, the chip shuts it from beside the title
    expect(styleOf(open.container, '.sidebar-logo-btn').display).toBe('flex');
  } finally {
    open.unmount();
  }
});

it('gives Side Chats space and phone sidebar controls full targets', () => {
  try {
    for (const width of [1440, 440]) {
      happyDOM.setViewport({ width, height: 956 });
      const { container, unmount } = render(
        <aside className="sidebar sidebar-expanded">
          <div className="sidebar-brand" />
          <nav className="sidebar-nav sidebar-main" />
          <div className="sidebar-section-header"><button className="sidebar-side-chats-toggle">Side chats</button><button className="header-btn sidebar-new-chat"><svg /></button></div>
          <div className="sidebar-list" />
          <div className="sidebar-bottom"><button className="user-menu-trigger"><span className="user-avatar" /></button></div>
        </aside>,
      );
      try {
        // Side chats sit right under their header on both (memo 0049 Fig 21)
        expect(zero(styleOf(container, '.sidebar-list').paddingTop)).toBe('0px');
        for (const selector of ['.sidebar-new-chat']) {
          expect(styleOf(container, selector).width).toBe('44px');
          expect(styleOf(container, selector).height).toBe('44px');
          // A phone's plus is as light as the rows' icons
          expect(styleOf(container, `${selector} svg`).width).toBe('20px');
        }
        // On a phone, memo 0049 Fig 21's drawer
        if (width === 440) {
          expect(styleOf(container, '.sidebar-main').paddingBottom).toBe('10px');
          expect(styleOf(container, '.sidebar-section-header').paddingTop).toBe('10px');
          expect(styleOf(container, '.sidebar-section-header').paddingBottom).toBe('0px');
          expect(styleOf(container, '.sidebar-brand').padding).toBe('0px 20px');
          expect(styleOf(container, '.sidebar-bottom').padding).toBe('4px 20px 8px');
          expect(styleOf(container, '.user-menu-trigger').height).toBe('44px');
          expect(styleOf(container, '.user-menu-trigger').padding).toBe('0px');
          expect(styleOf(container, '.user-menu-trigger').gap).toBe('13px');
        }
      } finally {
        unmount();
      }
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});


it('floats translucent phone controls over the scrolling chat with the pill overlapping the avatar', () => {
  happyDOM.setViewport({ width: 440, height: 956 });
  const { container, unmount } = render(
    <div className="app-layout">
      <aside className="sidebar sidebar-collapsed"><div className="sidebar-top"><div className="sidebar-brand"><button className="sidebar-logo-btn" /></div></div></aside>
      <main className="app-shell"><header className="chat-header"><button className="chat-header-agent"><span className="avatar avatar-agent" style={{ width: 72, height: 72 }}><svg width="72" height="72" /></span><span className="chat-header-name">Marq</span></button></header><div className="app-chat" /></main>
    </div>,
  );
  try {
    expect(styleOf(container, '.sidebar-logo-btn').backgroundColor).toBe('rgba(255, 255, 255, 0.8)');
    expect(styleOf(container, '.sidebar-logo-btn').boxShadow).toBe('none');
    expect(styleOf(container, '.app-chat').paddingTop || '0px').toBe('0px');
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// Muse's chat runs up under the iPhone status bar, behind its fade, and beside the avatar at full strength, its name on
// a pill of its own (memo 0049 Fig 11). In an iOS Safari tab only the page's own scroll runs under the status bar, so a
// phone's chat scrolls the page, its header and composer fixed on screen. A dimming band of ours had to start below
// the status bar, as iOS Safari paints the bar white over a fixed fill at its edge, and left a strip of undimmed text
// between Safari's fade and its own. Desktop keeps the chat's own scroll view.
it('scrolls the phone chat with the page, up under the status bar, under no band of its own, and leaves desktop its own scroll view', () => {
  // A fresh layout per viewport, as happy-dom keeps an element's computed style.
  const chat = () => {
    const { container, unmount } = render(
      <div className="app-layout">
        <main className="app-shell">
          <header className="chat-header">
            <span className="pseudo-before" />
            <button className="chat-header-agent"><span className="chat-header-name">Marq</span></button>
          </header>
          <div className="app-chat">
            <div data-testid="copilot-input-overlay" />
          </div>
        </main>
      </div>,
    );
    const { backdropFilter, backgroundImage } = styleOf(container, '.pseudo-before');
    const pill = styleOf(container, '.chat-header-name');
    const result = {
      layout: styleOf(container, '.app-layout').transform,
      scroll: styleOf(container, '.app-chat').overflow,
      header: styleOf(container, '.chat-header').position,
      composer: styleOf(container, "[data-testid='copilot-input-overlay']").position || 'static',
      band: { backdropFilter: backdropFilter || 'none', backgroundImage: backgroundImage || 'none' },
      pill: { backgroundColor: pill.backgroundColor, boxShadow: pill.boxShadow || 'none' },
    };
    unmount();
    return result;
  };

  expect(chat()).toMatchObject({ layout: 'translateZ(0)', scroll: 'auto', header: 'absolute', composer: 'static', band: { backdropFilter: 'none', backgroundImage: 'none' } });
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    expect(chat()).toEqual({
      // A transform would hold the fixed header and composer to the layout, which scrolls away.
      layout: 'none',
      scroll: 'visible',
      header: 'fixed',
      composer: 'fixed',
      band: { backdropFilter: 'none', backgroundImage: 'none' },
      // The name's own frosted backing, over the text that runs beneath it, with no glow around Marq.
      pill: { backgroundColor: 'rgba(255, 255, 255, 0.8)', boxShadow: 'none' },
    });
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
  // happy-dom leaves calc(), dvh and :has() unresolved, so this reads the sheet: the phone header starts at the
  // shell's top, which the shell pulls up over the status bar inset; the layout grows with the chat (the viewport test
  // above reads it).
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.app-shell:has\(> \.chat-header\) \{\s*margin-top: calc\(-1 \* var\(--app-safe-top\)\);/);
  // WebKit's scroll anchoring moved the page 103px up the chat as it opened, which the chat took for the user's scroll
  // and stopped keeping to its bottom: the chat keeps its own place, as on desktop (.copilotKitMessages).
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.app-chat \{\s*display: flex;\s*flex-direction: column;\s*overflow: visible;\s*\/\*[^*]*\*\/\s*overflow-anchor: none;/);
  // The kept Main Chat stays on the screen at its latest message while the opening chat, laid out unseen under it, grows
  // and scrolls the page to its own: neither moves as the chat takes over. The cold open check measures them.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.app-chat \.kept-chat \{\s*position: fixed;\s*inset: 0 var\(--app-safe-right\) var\(--app-safe-bottom\) var\(--app-safe-left\);\s*\}\s*\.app-chat \.kept-chat :is\(\.chat-wrapper, \.copilotKitChat\) \{\s*height: 100%;/);
  // The page that scrolls a phone's chat keeps no scrollbar gutter, so the kept Main Chat's scroll view keeps none.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.app-chat \.kept-chat \.copilotKitChat > :first-child > div \{\s*scrollbar-width: none;/);
  // Muse's avatar and 44pt menu, 24pt in, stand at the top of the screen below the status bar (Fig 11), where Marq's hat,
  // 1px above his box, and the menu button, 2px below the sidebar's safe area, meet it. The drawer's strip keeps the
  // menu's faded copy where the menu stood. The layout check measures them.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-header \{\s*position: fixed;[^}]*padding-top: calc\(1px \+ var\(--chat-header-safe-top\)\);/);
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.sidebar-collapsed \.sidebar-brand \{\s*padding: 2px 12px 12px 24px;/);
  expect(sheet).toMatch(/\.sidebar-strip-close-menu \{\s*position: absolute;\s*top: calc\(var\(--app-safe-top\) \+ 2px\);\s*left: 24px;/);
  expect(sheet).not.toMatch(/\}\s*\.app-chat \[data-testid='copilot-input-overlay'\] > \[data-copilotkit\] \{\s*transform: none/);
});

// iOS Safari 26 paints a solid band under its toolbar when a fixed element covers the bottom edge's midpoint 4px in
// (WebKit's LocalFrameView::fixedContainerEdges). The composer's overlay stands 6px clear, so the chat runs on under
// the toolbar in Safari's own blur, as under the status bar; its disclaimer keeps about its earlier gap to the bar.
it("keeps a phone's composer overlay 6px clear of the bottom edge, its disclaimer on it", () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.app-chat \[data-testid='copilot-input-overlay'\] \{\s*position: fixed;\s*bottom: max\(calc\(var\(--app-safe-bottom\) \+ 6px\), var\(--keyboard-inset, 0px\)\);/);
  const padding = () => {
    const { container, unmount } = render(<div className="app-chat"><div className="chat-disclaimer" /></div>);
    const bottom = styleOf(container, '.chat-disclaimer').paddingBottom || '0px';
    unmount();
    return bottom;
  };

  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    expect(padding()).toBe('0px');
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// The maintainer found the profile under the sliding chat backwards: the profile now slides in over the still
// chat, and it and the drawer's card take one shape, all four corners rounded as the screen's.
it('slides the phone profile in over the chat in the drawer card\'s shape', () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.agent-profile \{\s*position: fixed;[^}]*border-radius: var\(--radius-screen\);\s*box-shadow: var\(--shadow-float\);/);
  expect(sheet).toMatch(/\.app-layout\[data-profile-swiping\] > \.agent-profile \{\s*transform: translateX\(calc\(100% - var\(--profile-drag-offset\)\)\);/);
  expect(sheet).toMatch(/@starting-style \{\s*\.agent-profile \{\s*transform: translateX\(100%\);/);
  // The chat no longer moves for the profile, nor rises over it.
  expect(sheet).not.toMatch(/\.app-layout\[data-profile-swiping\] \.app-shell \{[^}]*(transform|z-index)/);
  // Its fade dims the chat under the profile, not the profile.
  expect(sheet).toMatch(/\.app-layout\[data-profile-swiping\] \.app-shell \{\s*isolation: isolate;\s*\}/);
});



// iOS 26.2 Simulator, Safari tab: the strip behind the clock and the band under Safari's bar showed flat white, drawer
// open or shut, over the runways the page had scrolled into view. Safari spreads the colour of a fixed element
// found at the middle of the screen's top or bottom edge, and keeps spreading it while that element stays rendered and
// visible, a `header` even hidden (WebKit's LocalFrameView::fixedContainerEdges, Page::updateFixedContainerEdges): the
// full-width fixed header at the top, the fixed composer at the bottom. The header keeps to Marq's width, too narrow to
// count, and the held composer hides its own empty box.
it("leaves Safari no fixed edge colour to spread behind the clock or, held, under its bar", () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-header \{\s*position: fixed;\s*left: 50%;\s*right: auto;\s*translate: -50% 0;/);
});

// iOS 26.2 Simulator: with the keyboard up, Safari panned the screen 347px down the page, past the fixed header and
// menu, which stayed at the layout viewport's top. They follow the pan useHeaderFollowsKeyboardPan measures.
// happy-dom resolves no phone query, so the sheet is read.
it('keeps the phone header and menu on screen with the keyboard up', () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-header,\s*\.sidebar-collapsed \{\s*top: var\(--viewport-top, 0px\);/);
});


// iOS Safari tints the strip behind the clock with the page's colour, so the open drawer's grey reaches up to the clock
// only when the page itself turns grey. happy-dom resolves neither :has nor the phone query, so the sheet is read.
it("turns the page the drawer's grey while the phone drawer is open, up behind the clock", () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*html:has\(\.sidebar-expanded\),\s*html:has\(\.sidebar-expanded\) body \{\s*background: var\(--color-fill\);/);
});

// An earlier design drew a 99px Marq, about 77px tall with his hat, behind a shadowed pill over his body. Muse's 68px avatar sits
// in front of its pill, which tucks about 6px behind it (memo 0049 Fig 11). The layout check measures the heights and
// the tuck; the desktop has its own, below.
it("draws the phone's Marq 68px tall in front of the pill tucked behind him", () => {
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    const { container, unmount } = render(
      <div className="app-layout">
        <aside className="sidebar sidebar-collapsed"><div className="sidebar-brand"><button className="sidebar-logo-btn" /></div></aside>
        <main className="app-shell"><header className="chat-header"><button className="chat-header-agent"><span className="avatar avatar-agent"><svg /></span><span className="chat-header-name">Marq</span></button></header></main>
      </div>,
    );
    const pill = { marginTop: styleOf(container, '.chat-header-name').marginTop };
    const { width, height, position, zIndex, transform } = styleOf(container, '.chat-header-agent .avatar-agent svg');
    const marq = { width, height, position, zIndex, transform };
    unmount();
    // 120 viewBox units hold his 93-unit height, hat to body, so 88px draws him 68px tall. His hat, 17 units (12.5px)
    // down the 88px svg, which overhangs his 72px box, set 1px down, by 8px, meets the screen's top 5.5px higher.
    expect(marq).toEqual({ width: '88px', height: '88px', position: 'relative', zIndex: '1', transform: 'translateY(-5.5px)' });
    expect(pill.marginTop).toBe('-12px');
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// The desktop takes the phone's top of chat and drawer layout, measured against memo 0049
// Fig 1 (dots desktop): the avatar's top 1.5pt under the window's, a 44pt row pitch and the account row 4px up.
// happy-dom reports an unset length as '' and a written `0` as '0'.
const zero = (value: string) => (value === '' || value === '0' ? '0px' : value);
const desktopApp = (sidebar: 'sidebar-collapsed' | 'sidebar-expanded') => (
  <div className="app-layout">
    <aside className={`sidebar ${sidebar}`}>
      <div className="sidebar-top">
        <div className="sidebar-brand"><span className="sidebar-brand-text">Bot</span></div>
        <nav className="sidebar-nav sidebar-main">
          <button className="sidebar-nav-item sidebar-main-chat sidebar-nav-item-active"><svg className="sidebar-nav-icon" /><span className="sidebar-nav-label">Main chat</span></button>
          <button className="sidebar-nav-item"><svg className="sidebar-nav-icon" /><span className="sidebar-nav-label">Plugins</span></button>
          <span className="pseudo-after" />
        </nav>
      </div>
      <div className="sidebar-recents">
        <div className="sidebar-section-header">
          <button className="sidebar-side-chats-toggle"><span>Side chats</span></button>
          <button className="header-btn sidebar-new-chat"><svg /></button>
        </div>
        <div className="sidebar-list">
          <div className="sidebar-item sidebar-item-active"><button className="sidebar-item-btn">Rates</button><button className="sidebar-item-more"><svg /></button></div>
        </div>
      </div>
      <div className="sidebar-bottom"><button className="user-menu-trigger"><span className="avatar" style={{ width: 28, height: 28 }} /></button></div>
    </aside>
    <main className="app-shell">
      <header className="chat-header">
        <button className="chat-header-agent"><span className="avatar avatar-agent" style={{ width: 72, height: 72 }}><svg width="72" height="72" /></span><span className="chat-header-name">Marq</span></button>
      </header>
      <div className="app-chat" />
    </main>
  </div>
);

// Only a panel that reaches a rounded screen corner rounds; a desktop window has none, so its chat and profile are
// square, edge to edge.
it('sets the desktop chat square and edge to edge, as it meets no rounded screen corner', () => {
  happyDOM.setViewport({ width: 1440, height: 900 });
  const { container, unmount } = render(desktopApp('sidebar-collapsed'));
  try {
    const chat = styleOf(container, '.app-shell');
    expect(chat.backgroundColor).toBe('#f9f9f9');
    expect({ margin: zero(chat.margin), radius: chat.borderRadius || '0px', shadow: chat.boxShadow || 'none' }).toEqual({ margin: '0px', radius: '0px', shadow: 'none' });
    // Only the phone's profile, which runs up behind the clock, rounds
    expect(sheet.match(/\.agent-profile \{[^}]*border-radius[^}]*\}/g)?.length).toBe(1);
    expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.agent-profile \{[^}]*border-radius: var\(--radius-screen\);/);
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it("sets Marq 1.5px under the desktop card's top, in front of a crisp white name pill with no frost or glow (memo 0049 Fig 1)", () => {
  happyDOM.setViewport({ width: 1440, height: 900 });
  const { container, unmount } = render(desktopApp('sidebar-collapsed'));
  try {
    // His hat sits 9.5px into his 72px box: 2px of padding less 10px puts it 1.5px under the card's top, as Fig 1's.
    expect(styleOf(container, '.chat-header').paddingTop).toBe('2px');
    expect(styleOf(container, '.chat-header-agent .avatar-agent').marginTop).toBe('-10px');
    const marq = styleOf(container, '.chat-header-agent .avatar-agent svg');
    expect({ position: marq.position, zIndex: marq.zIndex }).toEqual({ position: 'relative', zIndex: '1' });
    const pill = styleOf(container, '.chat-header-name');
    // Tucked about 6px behind his body, as the phone's
    expect(pill.marginTop).toBe('-11px');
    expect(pill.backgroundColor).toBe('#fff');
    expect(pill.backdropFilter || 'none').toBe('none');
    expect(pill.boxShadow || 'none').toBe('none');
    // No band behind the header: the chat scrolls beneath it clear.
    expect(styleOf(container, '.chat-header').backdropFilter || 'none').toBe('none');
    expect(styleOf(container, '.chat-header').backgroundImage || 'none').toBe('none');
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it("lays out the desktop sidebar as the phone drawer: a 44px pitch, a grey Side chats header, a grey selected fill, a plain plus and the account row 4px off the bottom (memo 0049 Fig 1)", () => {
  happyDOM.setViewport({ width: 1440, height: 900 });
  try {
    const { container, unmount } = render(desktopApp('sidebar-expanded'));
    try {
      // Fig 1's rows step at 44pt, meeting with no gap.
      expect(zero(styleOf(container, '.sidebar-main').gap)).toBe('0px');
      // The open row takes the line grey, a pill on the white sidebar
      expect(styleOf(container, '.sidebar-nav-item-active').backgroundColor).toBe('#e8e8e8');
      expect(styleOf(container, '.sidebar-brand').minHeight).toBe('64px');
      // The account row ends 4px above the window's bottom, as Fig 1's does.
      expect(styleOf(container, '.sidebar-bottom').paddingBottom).toBe('4px');
      expect(styleOf(container, '.sidebar-section-header').paddingTop).toBe('4px');
      // The label 20px in, on the title and the icons' edge; the plus at the header's right, as before.
      expect(styleOf(container, '.sidebar-section-header').padding).toBe('4px 12px 0px 20px');
      const label = styleOf(container, '.sidebar-side-chats-toggle');
      // ChatGPT Mac's Recents: a grey semibold `body` heading in sentence case.
      expect({ size: label.fontSize, weight: label.fontWeight, spacing: label.letterSpacing || 'normal', transform: label.textTransform || 'none', color: label.color })
        .toEqual({ size: '14px', weight: '600', spacing: 'normal', transform: 'none', color: '#646464' });
      const plus = styleOf(container, '.sidebar-new-chat');
      expect({ shadow: plus.boxShadow || 'none', color: plus.color }).toEqual({ shadow: 'none', color: '#646464' });
      expect(plus.backgroundColor || 'transparent').toMatch(/^(transparent|none|rgba\(0, 0, 0, 0\))$/);
      expect(styleOf(container, '.sidebar-new-chat svg').width).toBe('20px');
      // Every row a 40px fill inset 2px in its 44px slot, so no two fills touch; Side chats across the nav pills' width.
      for (const selector of ['.sidebar-nav-item', '.sidebar-item']) {
        expect({ height: styleOf(container, selector).height, margin: styleOf(container, selector).margin }).toEqual({ height: '40px', margin: '2px 0px' });
      }
      expect(styleOf(container, '.sidebar-list').padding).toBe('0px 8px');
      expect(styleOf(container, '.sidebar-item-active').backgroundColor).toBe('#e8e8e8');
      expect(styleOf(container, '.sidebar-item').borderRadius).toBe('9999px');
      // happy-dom matches no :hover, so this reads the sheet: a hovered row takes the lighter fill, never the open row.
      for (const name of ['sidebar-nav-item', 'sidebar-item']) {
        expect(sheet).toMatch(new RegExp(`\\.${name}:not\\(\\.${name}-active\\):hover \\{\\s*background: var\\(--color-fill\\);`));
      }
      // A Side Chat's title is as tall as its 40px fill, its text centred in it on the labels' 20px edge.
      const row = styleOf(container, '.sidebar-item-btn');
      expect({ top: zero(row.paddingTop), bottom: zero(row.paddingBottom), left: row.paddingLeft, align: row.alignSelf }).toEqual({ top: '0px', bottom: '0px', left: '12px', align: 'stretch' });
      // With a mouse, a 32px ⋯ centred under the plus, 26px from the row's end (10px in); happy-dom leaves calc() as written.
      const more = styleOf(container, '.sidebar-item-more');
      expect({ width: more.width, padding: more.padding, end: more.marginRight }).toEqual({ width: '32px', padding: '0px', end: 'calc(26px - 32px / 2)' });
      expect(styleOf(container, '.user-menu-trigger').padding).toBe('8px');
    } finally {
      unmount();
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// The menu, plus and Close buttons were 8px squares, the account row and the name field rectangles among pill rows, and
// a Side Chat's row icons sat on their buttons' left edge (DESIGN.md: buttons and sidebar rows are round).
it("rounds the sidebar's buttons and rows, and centres a Side Chat's actions icon in its button", () => {
  // The row is held, as with its menu open, so a mouse shows its actions button.
  const { container, unmount } = render(
    <aside className="sidebar sidebar-expanded">
      <div className="sidebar-brand"><button className="sidebar-logo-btn"><svg /></button></div>
      <div className="sidebar-section-header"><button className="header-btn sidebar-new-chat"><svg /></button></div>
      <div className="sidebar-list">
        <div className="sidebar-item sidebar-item-held"><button className="sidebar-item-btn">Rates</button><button className="sidebar-item-more"><svg /></button></div>
        <div className="sidebar-item"><input className="sidebar-item-name" /></div>
      </div>
      <div className="sidebar-bottom"><button className="user-menu-trigger" /></div>
    </aside>,
  );
  try {
    for (const selector of ['.sidebar-logo-btn', '.header-btn']) {
      expect(styleOf(container, selector).borderRadius).toBe('9999px');
    }
    for (const selector of ['.user-menu-trigger', '.sidebar-item-name', '.sidebar-item-more']) {
      expect(styleOf(container, selector).borderRadius).toBe('9999px');
    }
    const more = styleOf(container, '.sidebar-item-more');
    expect({ display: more.display, align: more.alignItems, justify: more.justifyContent })
      .toEqual({ display: 'inline-flex', align: 'center', justify: 'center' });
  } finally {
    unmount();
  }
});

it('keeps the phone as it was: no desktop card, frame, header or sidebar value reaches 640px and below', () => {
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    const shut = render(desktopApp('sidebar-collapsed'));
    try {
      const card = styleOf(shut.container, '.app-shell');
      expect({ margin: zero(card.margin), radius: card.borderRadius || '0px', shadow: card.boxShadow || 'none' }).toEqual({ margin: '0px', radius: '0px', shadow: 'none' });
      expect(styleOf(shut.container, '.app-layout').backgroundColor || 'transparent').toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
      // The phone's own frosted pill over the page-scrolled chat, not the desktop's white one.
      const pill = styleOf(shut.container, '.chat-header-name');
      expect({ background: pill.backgroundColor, frost: pill.backdropFilter, top: pill.marginTop })
        .toEqual({ background: 'rgba(255, 255, 255, 0.8)', frost: 'blur(4px)', top: '-12px' });
      expect(zero(styleOf(shut.container, '.chat-header-agent .avatar-agent').marginTop)).toBe('0px');
    } finally {
      shut.unmount();
    }
    // A phone is a touch screen.
    happyDOM.settings.navigator.maxTouchPoints = 5;
    const open = render(desktopApp('sidebar-expanded'));
    try {
      expect(styleOf(open.container, '.sidebar').backgroundColor).toBe('#f0f0f0');
      expect(zero(styleOf(open.container, '.sidebar-main').gap)).toBe('0px');
      expect(styleOf(open.container, '.sidebar-main').padding).toBe('38px 10px 10px');
      expect(styleOf(open.container, '.sidebar-section-header').padding).toBe('10px 20px 0px');
      // happy-dom keeps :root's custom properties from their first read, whatever the viewport since, so this reads
      // the sheet: the label still takes the phone's 13px `label` role, tracked, in capitals.
      expect(sheet).toMatch(/@media \(max-width: 640px\) \{\s*(\/\*[^*]*\*\/\s*)?:root \{[^}]*--font-label: 0\.8125rem;/);
      expect(sheet).toMatch(/@media \(max-width: 640px\) \{\s*\.sidebar-side-chats-toggle \{\s*font-size: var\(--font-label\);\s*letter-spacing: var\(--tracking-caps\);/);
      expect(styleOf(open.container, '.sidebar-side-chats-toggle').textTransform).toBe('uppercase');
      expect(styleOf(open.container, '.sidebar-list').padding).toBe('0px 10px');
      expect(styleOf(open.container, '.sidebar-bottom').padding).toBe('4px 20px 8px');
      expect(styleOf(open.container, '.sidebar-nav-item-active').backgroundColor).toBe('#e8e8e8');
      const nav = styleOf(open.container, '.sidebar-nav-item');
      expect({ top: nav.paddingTop, margin: nav.margin }).toEqual({ top: '8px', margin: '2px 0px' });
      const row = styleOf(open.container, '.sidebar-item-btn');
      expect({ top: zero(row.paddingTop), left: row.paddingLeft }).toEqual({ top: '0px', left: '10px' });
      // Touch opens a row's menu with a long-press, so the phone's rows show no actions button.
      expect(styleOf(open.container, '.sidebar-item-more').clipPath).toBe('inset(50%)');
      expect(styleOf(open.container, '.user-menu-trigger').gap).toBe('13px');
    } finally {
      open.unmount();
    }
  } finally {
    happyDOM.settings.navigator.maxTouchPoints = 0;
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it('fades the account tooltip out under its open menu, rather than dropping it', () => {
  const trigger = document.body.appendChild(document.createElement('button'));
  trigger.className = 'user-menu-trigger menu-open';
  trigger.dataset.tooltip = 'Hao Dong';
  trigger.innerHTML = '<span class="pseudo-after"></span>';
  const tooltip = styleOf(trigger, '.pseudo-after');
  // Shown at opacity 0, so its opacity transition runs; display: none would drop it in one frame.
  expect({ hidden: tooltip.display === 'none', opacity: tooltip.opacity }).toEqual({ hidden: false, opacity: '0' });
  trigger.remove();
});

function keptChat() {
  return (
    <div className="kept-chat">
      <div className="chat-wrapper">
        <div className="kept-chat-composer"><div className="cpk:pointer-events-auto"><div className="copilotKitInput" /></div></div>
      </div>
    </div>
  );
}

it('shows the kept composer while a loading chat has no composer of its own yet', () => {
  const fallback = render(<div className="app-chat app-chat-opening">{keptChat()}</div>);
  try {
    expect(styleOf(fallback.container, '.kept-chat-composer').opacity).not.toBe('0');
  } finally {
    fallback.unmount();
  }

  const placingPicker = render(
    <div className="app-chat app-chat-opening">
      <div className="chat-wrapper">
        <div data-testid="copilot-input-overlay"><div className="copilotKitInput"><textarea /></div></div>
      </div>
      {keptChat()}
    </div>,
  );
  try {
    expect(styleOf(placingPicker.container, '.app-chat-opening > .chat-wrapper .copilotKitInput').visibility).toBe('hidden');
    expect(styleOf(placingPicker.container, '.kept-chat-composer').opacity).not.toBe('0');
  } finally {
    placingPicker.unmount();
  }
});

it('shows the kept composer\'s + where the chat\'s own composer shows it, so the text keeps its place as that one takes over', () => {
  for (const width of [1024, 390]) {
    happyDOM.setViewport({ width, height: 844 });
    const { container, unmount } = render(<KeptChat messages={[]} disclaimer="" />);
    try {
      expect(styleOf(container, '.kept-chat-composer .copilotKitInput > [data-layout] > :first-child').display).not.toBe('none');
    } finally {
      unmount();
    }
  }
  happyDOM.setViewport({ width: 1024, height: 768 });
});

it('stands a phone\'s kept composer 6px off the bottom, where the chat\'s own composer takes its place', () => {
  happyDOM.setViewport({ width: 390, height: 844 });
  const { container, unmount } = render(<div className="app-chat app-chat-opening">{keptChat()}</div>);
  try {
    expect(styleOf(container, '.kept-chat-composer').bottom).toBe('6px');
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it('keeps the opening chat\'s composer shown over its kept view, so the draft can be typed while the chat lands', () => {
  const { container, unmount } = render(
    <div className="app-chat app-chat-opening">
      <div className="chat-wrapper">
        <div data-testid="copilot-message-list" />
        <div data-testid="copilot-input-overlay"><div className="copilotKitInput picker-ready"><textarea /></div></div>
      </div>
      {keptChat()}
    </div>,
  );

  try {
    expect(styleOf(container, '.app-chat-opening > .chat-wrapper [data-testid="copilot-message-list"]').visibility).toBe('hidden');
    expect(styleOf(container, '.app-chat-opening > .chat-wrapper textarea').visibility).toBe('visible');
    expect(styleOf(container, '.kept-chat-composer').opacity).toBe('0');
    expect(styleOf(container, '.kept-chat-composer .copilotKitInput').pointerEvents).toBe('none');
  } finally {
    unmount();
  }
});

it('shows a message the chat held as it opened at once, and fades in one that arrives later', () => {
  const { container, unmount } = render(
    <div>
      <div className="copilotKitMessage history" data-opened="" />
      <div className="copilotKitMessage arriving" />
      <div className="copilotKitMessage" data-opened=""><div className="reply-image"><img className="history-image" /></div></div>
    </div>,
  );

  try {
    expect(styleOf(container, '.history').animation).toBe('none');
    expect(styleOf(container, '.arriving').animation).toMatch(/messageIn/);
    expect(styleOf(container, '.history-image').transition).toMatch(/^none|^all 0s/);
  } finally {
    unmount();
  }
});

it("shows the kept view's reply image without waiting to fade it in", () => {
  const { container, unmount } = render(
    <div aria-label="Loading chat controls">
      <div className="copilotKitMessage"><div className="reply-image"><img className="kept-image" /></div></div>
    </div>,
  );

  try {
    expect(styleOf(container, '.kept-image').opacity).toBe('1');
  } finally {
    unmount();
  }
});

// The + and the model picker's hover fill went behind `(hover: hover)`, so on a phone a tap showed no colour where
// a desktop's press shows the fill. A press fills them everywhere; on touch the fill also holds while the
// control's menu is open, as under a resting mouse, and a mouse with its pointer away keeps them clear.
it.each([
  ['the +', '<button data-testid="copilot-add-menu-button">+</button>', '[data-testid="copilot-add-menu-button"]'],
  ['the model picker', '<div class="chat-model-picker"><button class="mep-pill">Model</button></div>', '.mep-pill'],
])('fills %s on press and, on touch, while its menu is open', (_name, html, selector) => {
  // happy-dom matches no :hover or :active, so a copy of the sheet marking those states with classes stands in for it.
  const states = document.createElement('style');
  states.textContent = page.replace(/:hover\b/g, '.pointer-over').replace(/:active\b/g, '.pressed');
  style.replaceWith(states);
  const fill = (maxTouchPoints: number, state: string, open = false) => {
    happyDOM.settings.navigator.maxTouchPoints = maxTouchPoints;
    const input = document.createElement('div');
    input.className = 'copilotKitInput';
    input.innerHTML = html;
    const control = input.querySelector(selector);
    if (control === null) throw new Error(`no ${selector}`);
    control.classList.add(...state.split(' ').filter(Boolean));
    if (open) control.setAttribute('data-popup-open', '');
    document.body.append(input);
    const background = getComputedStyle(control).backgroundColor;
    input.remove();
    return background;
  };

  try {
    const filled = fill(0, 'pointer-over');
    expect(filled).not.toBe(fill(0, ''));
    expect(fill(5, '')).toBe(fill(0, ''));
    expect(fill(5, 'pressed')).toBe(filled);
    expect(fill(5, '', true)).toBe(filled);
    expect(fill(0, 'pressed')).toBe(filled);
    // Desktop unchanged: an open menu with the pointer elsewhere leaves the control clear.
    expect(fill(0, '', true)).toBe(fill(0, ''));
  } finally {
    happyDOM.settings.navigator.maxTouchPoints = 0;
    states.replaceWith(style);
  }
});

// The maintainer on an iPhone: the +'s and the picker's pressed fill reached into the composer's rounded edge,
// and the disclaimer under the composer is dropped on a phone. A phone draws each fill 32px tall inside its 44px
// target, as its Send's circle; a desktop keeps its 36px controls and the disclaimer.
it.each([[440, true], [767, true], [768, false], [1440, false]] as const)('keeps phone fills inside the composer and drops its disclaimer (%i px)', (width, phone) => {
  try {
    happyDOM.setViewport({ width, height: 844 });
    const host = document.createElement('div');
    host.innerHTML = `<div class="copilotKitInput picker-ready"><div data-layout="compact">
      <div><button data-testid="copilot-add-menu-button">+</button></div><div><textarea></textarea></div>
      <div><div class="chat-model-picker"><button class="mep-pill">Model</button></div></div>
    </div></div><div class="chat-disclaimer">AI can make mistakes.</div>`;
    document.body.append(host);
    const add = styleOf(host, '[data-testid="copilot-add-menu-button"]');
    const pill = styleOf(host, '.mep-pill');
    const read = {
      disclaimer: styleOf(host, '.chat-disclaimer').display,
      add: [add.borderTopWidth, add.borderLeftWidth, add.backgroundClip],
      pill: [pill.borderTopWidth, pill.borderBottomWidth],
    };
    host.remove();
    expect(read).toEqual(phone
      ? { disclaimer: 'none', add: ['6px', '6px', 'padding-box'], pill: ['6px', '6px'] }
      : { disclaimer: 'block', add: [expect.not.stringMatching(/^6px$/), expect.not.stringMatching(/^6px$/), expect.not.stringMatching(/^padding-box$/)], pill: [expect.not.stringMatching(/^6px$/), expect.not.stringMatching(/^6px$/)] });
    // happy-dom lets the pill's later `background` shorthand reset its clip; the sheet keeps it, over the press's fill.
    expect(sheet).toMatch(/@media \(max-width: 767px\) \{[^@]*\.chat-model-picker \.mep-pill \{\s*border-top: 6px solid transparent;\s*border-bottom: 6px solid transparent;\s*background-clip: padding-box !important;/);
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});
