import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import type { Window as HappyDomWindow } from 'happy-dom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Streamdown } from 'streamdown';

import { ScheduledTaskProposalCard } from './scheduled-tasks';

// The page's own stylesheet. happy-dom skips its imports and layers (CopilotKit's Tailwind Typography
// quotes inline code in a layer), and every unlayered rule here wins over a layered one, so these
// tests read what this sheet decides. happy-dom styles no pseudo-elements, so each `::before` and
// `::after` rule styles a `.pseudo-before` or `.pseudo-after` child instead. It matches no
// `:placeholder-shown` either, so a test marks an empty text box `.placeholder-shown` instead.
const sheet = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'globals.css'), 'utf8');
const style = document.createElement('style');

beforeAll(() => {
  style.textContent = sheet.replace(/::(before|after)\b/g, ' > .pseudo-$1').replace(/:placeholder-shown\b/g, '.placeholder-shown');
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

it("shows an assistant message's prose in a grey bubble up to the column's right edge, and a message with only tool rows without one", () => {
  const reply = inAssistantMessage('<div><p>Run <code>echo</code> now.</p></div>');
  const toolOnly = inAssistantMessage('<div></div>');

  const bubble = styleOf(reply.prose, ':scope > div');
  expect(bubble.backgroundColor).toBe('#f4f4f4');
  expect(bubble.borderRadius).toBe('20px');
  expect(bubble.padding).toBe('12px 18px');
  expect(bubble.maxWidth).toBe('100%');
  expect(styleOf(reply.prose, 'p').marginTop).toBe('0px');
  expect(styleOf(reply.prose, 'p').marginBottom).toBe('0px');
  expect(styleOf(reply.prose, 'code').backgroundColor).toBe('#fff');
  expect(styleOf(reply.prose, 'code').borderWidth).toBe('1px');
  expect(styleOf(toolOnly.prose, ':scope > div').backgroundColor).not.toBe('#f4f4f4');
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

it("keeps the Worklog's lines as they were under the desktop chat's `leading-relaxed`", () => {
  const worklog = document.createElement('div');
  worklog.className = 'worklog';
  worklog.innerHTML = `<button class="worklog-head">Worked for 38s</button><div class="worklog-body">
    <div class="copilotKitMessage copilotKitAssistantMessage"><div class="cpk:prose"><div>Checking the curve.</div></div>
      <div class="worklog-step" data-kind="thought"><div class="worklog-step-head">Thought</div><div class="worklog-step-detail">Steeper.</div></div>
    </div></div>`;
  const { message: answer } = inAssistantMessage('<p>Done.</p>');
  answer.before(worklog);
  try {
    expect(getComputedStyle(answer).lineHeight).toBe('1.625');
    const note = styleOf(worklog, '.copilotKitAssistantMessage');
    expect({ note: note.lineHeight, words: styleOf(worklog, '[class*="cpk:prose"]').lineHeight, head: styleOf(worklog, '.worklog-head').fontSize })
      .toEqual({ note: '1.6', words: 'calc(14px + 8px)', head: '13px' });
    expect(styleOf(worklog, '.worklog-step-detail').lineHeight).toBe(styleOf(worklog, '.worklog-step').lineHeight);
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

it("puts the agent's avatar on the chat's white surface, with no grey band above the chat", () => {
  const shell = document.createElement('main');
  shell.className = 'app-shell';
  document.body.append(shell);

  expect(getComputedStyle(shell).backgroundColor).toBe('#fff');
  shell.remove();
});

it("shows Connected as plain text after a white bolt on a green badge (Muse Fig 13)", () => {
  const status = document.createElement('p');
  status.className = 'agent-profile-status agent-profile-status-online';
  status.innerHTML = '<svg></svg>Connected';
  document.body.append(status);

  expect(getComputedStyle(status).color).toBe('#0d0d0d');
  expect(styleOf(status, 'svg').backgroundColor).toBe('#22c55e');
  expect(styleOf(status, 'svg').borderRadius).toBe('50%');
  expect(styleOf(status, 'svg').color).toBe('#fff');
});

it("shows the user's own messages in blackish", () => {
  const message = document.createElement('div');
  message.className = 'copilotKitMessage copilotKitUserMessage';
  message.innerHTML = '<div>Hello</div>';
  document.body.append(message);

  expect(styleOf(message, 'div').backgroundColor).toBe('#0d0d0d');
  message.remove();
});

it("shows a sent message's files as white cards above its blackish bubble, each on its kind's tile", () => {
  const message = document.createElement('div');
  message.className = 'copilotKitMessage copilotKitUserMessage';
  message.innerHTML = `<ul class="sent-files">
      <li class="sent-file"><span class="file-tile" data-kind="pdf"></span><span class="sent-file-name">a.pdf</span><span class="sent-file-kind">PDF</span></li>
      <li class="sent-file"><span class="file-tile" data-kind="sheet"></span></li>
      <li class="sent-file"><span class="file-tile" data-kind="file"></span></li>
    </ul><div class="bubble">check this</div>`;
  document.body.append(message);

  expect(styleOf(message, '.bubble').backgroundColor).toBe('#0d0d0d');
  const card = styleOf(message, '.sent-file');
  expect([card.backgroundColor, card.borderColor, card.borderRadius]).toEqual(['#fff', '#e0e0e0', '16px']);
  const tile = styleOf(message, '.file-tile');
  expect([tile.width, tile.height, tile.color]).toEqual(['40px', '40px', '#fff']);
  expect(['pdf', 'sheet', 'file'].map((kind) => styleOf(message, `[data-kind="${kind}"]`).backgroundColor)).toEqual(['#e5484d', '#10a37f', '#6b6b6b']);
  expect(styleOf(message, '.sent-file-name').fontWeight).toBe('500');
  expect(styleOf(message, '.sent-file-kind').color).toBe('#6b6b6b');
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

    expect(getComputedStyle(send).backgroundColor).toBe('#bfbfbf');
    textarea.focus();
    expect(getComputedStyle(send).backgroundColor).toBe('#bfbfbf');
    pill.focus();
    expect(getComputedStyle(send).backgroundColor).toBe('#bfbfbf');
    send.removeAttribute('disabled');
    expect(getComputedStyle(send).backgroundColor).toBe('#0d0d0d');
  } finally {
    input.remove();
  }
});

// The text is the `message` role and the picker `detail`, whose phone sizes start at 640px.
const composerSizes = [[440, '17px', '15px'], [641, '14px', '13px'], [767, '14px', '13px'], [768, '14px', '13px'], [1440, '14px', '13px']] as const;
// CopilotKit lays a phone's out `expanded` always, a desktop's once its text takes two lines.
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
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  try {
    happyDOM.setViewport({ width, height: 844 });
    // The type roles are the root's tokens, whose kept style a changed attribute drops.
    document.documentElement.dataset.width = String(width);
    const input = document.createElement('div');
    input.className = 'copilotKitInput';
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
    // A desktop's text sits on ChatGPT Mac's 20px line; a phone's keeps CopilotKit's, which happy-dom does not load.
    if (width > 640) expect(textStyle.lineHeight).toBe('20px');
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

it("puts a desktop's + under two lines of text, at the left of the controls' row, and beside one line", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  try {
    happyDOM.setViewport({ width: 1440, height: 844 });
    for (const [layoutName, cells] of [
      ['compact', { add: ['1', '1'], text: ['2', '1'], controls: ['3', '1'] }],
      ['expanded', { add: ['1', '2'], text: ['1 / -1', '1'], controls: ['3', '2'] }],
    ] as const) {
      const input = document.createElement('div');
      input.className = 'copilotKitInput';
      input.innerHTML = `<div class="cpk:grid" data-layout="${layoutName}">
        <div class="cpk:col-start-1"><button type="button" data-testid="copilot-add-menu-button">+</button></div>
        <div class="cpk:col-span-3"><textarea></textarea></div>
        <div class="cpk:col-start-3"><button type="button" data-testid="copilot-send-button">Send</button></div>
      </div>`;
      document.body.append(input);
      const place = (selector: string) => [styleOf(input, selector).gridColumn, styleOf(input, selector).gridRow];
      expect({ add: place('[class*="col-start-1"]'), text: place('[class*="col-span-3"]'), controls: place('[class*="col-start-3"]') }).toEqual(cells);
      expect(styleOf(input, '[data-testid="copilot-add-menu-button"]').width).toBe('36px');
      input.remove();
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    document.querySelectorAll('.copilotKitInput').forEach((input) => input.remove());
  }
});

// iOS Safari zooms into a field under 16px as it takes focus, so a touch tablet keeps the composer's text at 16px.
it("keeps the composer's text at 16px on a touch tablet, the desktop's 14px with a mouse and the phone's 17px", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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

  expect(getComputedStyle(avatar).backgroundColor).toBe('#0d0d0d');
  expect(getComputedStyle(agent).backgroundColor).not.toBe('#0d0d0d');
  avatar.remove();
  agent.remove();
});

// streamdown 2.7 marks the table data-streamdown="table" in a table-wrapper card; these rules once targeted 1.6's
// markup, which marked the <table> table-wrapper too, so the card's padding and Typography's table margins showed.
it("shows a message's markdown table as a white sheet whose one frame is its scroll box, its controls in no row of their own", () => {
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
    expect(scroller.borderWidth).toBe('1px');
    expect(scroller.backgroundColor).toBe('#fff');
    expect(scroller.backgroundImage.match(/radial-gradient/g)).toHaveLength(2);
    const table = styleOf(container, 'table[data-streamdown="table"]');
    expect(table.marginTop).toBe('0px');
    expect(table.width).toBe('max-content');
    expect(table.minWidth).toBe('100%');
    expect(styleOf(container, 'td:nth-child(2)').whiteSpace).toBe('nowrap');
    const controls = styleOf(container, 'div[data-streamdown="table-wrapper"] > div:first-child:not(:last-child)');
    expect(controls.justifyContent).toBe('flex-end');
    expect(styleOf(container, 'div[data-streamdown="table-wrapper"] > div:first-child button').padding).toBe('4px');
  } finally {
    unmount();
  }
  // happy-dom drops background attachment lists, so the real-browser check proves their rendering.
  expect(sheet).toMatch(/\[data-streamdown="table-wrapper"\] > div:last-child \{[^}]*background-attachment: local, local, scroll, scroll;/);
});

// a white band ran from the scroll-to-bottom chevron's row down to the composer, hiding the messages behind it.
it("scrolls the messages behind CopilotKit's scroll-to-bottom chevron down to the composer, with no band around it (memo 0049 Fig 7)", () => {
  const chat = document.createElement('div');
  chat.setAttribute('data-copilotkit', '');
  chat.innerHTML = '<div class="row"><button data-testid="copilot-scroll-to-bottom"></button></div>';
  document.body.append(chat);

  // The chevron keeps CopilotKit's own white disc, border and shadow over the text.
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
  // grows with the chat that scrolls the page (#3613).
  expect(sheet).toMatch(/\n {2}\.app-layout \{\s*height: auto;\s*min-height: 100dvh;\s*margin: 0 var\(--app-safe-right\) 0 var\(--app-safe-left\);\s*padding-top: var\(--app-safe-top\);\s*transform: none;/);
});

it("keeps a phone's messages one gutter from the screen edge (dots Fig 7), with the column's own padding dropped", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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
it("lines the composer and its accessory up with the messages' column, the grey panel's edges, but on a phone the composer reaches into the gutter", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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
    // A phone's messages' column drops its side padding, so the accessory fills CopilotKit's column inside its 1rem
    // gutter, and the composer reaches 4px into the gutter, 12px from the screen's edges like ChatGPT Work's (#3615).
    expect(box('copilotKitInput').width).toBe('calc(100% + 8px)');
    expect(box('copilotKitInput').marginLeft).toBe('-4px');
    expect(box('copilotKitInput').marginRight).toBe('-4px');
    expect(box('composer-accessory').width).toBe('100%');
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it('opens the Agent Profile as a narrow right sidebar beside the chat on a desktop, over the chat on a tablet, and as a full-screen sheet on a phone', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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

  expect(styleOf(container, '.list-row-icon').color).toBe('#bfbfbf');
  expect(styleOf(container, '.scheduled-task-title').color).toBe('#6b6b6b');
  unmount();
});

it('opens a file full screen on a phone, keeping a profile refresh error in view (ADR 0030)', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 390, height: 844 });
  const { container, unmount } = render(
    <div className="agent-profile">
      <div className="agent-profile-header">
        <h2 className="agent-profile-name">Marq</h2>
        <p className="agent-profile-error">Agent profile failed: 503</p>
      </div>
      <div className="agent-profile-tabs" />
      <div className="agent-profile-panel">
        <article className="agent-file" />
      </div>
    </div>,
  );

  try {
    expect(styleOf(container, '.agent-profile-name').display).toBe('none');
    expect(styleOf(container, '.agent-profile-tabs').display).toBe('none');
    // A hidden parent would hide the error whatever its own display, so the header must stay shown too.
    expect(styleOf(container, '.agent-profile-header').display).not.toBe('none');
    expect(styleOf(container, '.agent-profile-error').display).not.toBe('none');
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it('hides the kept Agent Profile when closed and shows it again at each viewport', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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
    expect(styleOf(form, control).borderRadius).toBe('16px');
  }
  expect(styleOf(form, 'textarea').minHeight).toBe('120px');
  expect([styleOf(form, '.settings-group').borderStyle, styleOf(form, '.settings-group').borderRadius]).toEqual(['solid', '16px']);
  expect([styleOf(form, '.settings-row').minHeight, styleOf(form, '.settings-row').padding]).toEqual(['48px', '8px 20px']);
  expect(styleOf(form, '.settings-row').color).toBe('#0d0d0d');
  expect(styleOf(form, 'select').color).toBe('#6b6b6b');
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
  expect(sheet).toMatch(/\.chat-header-agent:active:not\(:disabled\) \.chat-header-name \{\s*background: rgba\(235, 235, 235, 0\.85\);/);
});

it("answers a mouse over the agent's capsule and rings it on keyboard focus", () => {
  // happy-dom applies no :hover or :focus-visible, so these read the sheet. A mouse lifts the capsule; a phone, which
  // has no hover, keeps the press. The keyboard's focus rings the capsule in blue.
  expect(sheet).toMatch(
    /@media \(hover: hover\) \{\s*\.chat-header-agent:hover:not\(:disabled\) \.chat-header-name \{\s*background: rgba\(255, 255, 255, 0\.95\);\s*box-shadow: 0 2px 8px rgba\(0, 0, 0, 0\.18\);/,
  );
  // Forced colors drop box-shadows but paint a transparent outline, so keyboard focus stays visible there.
  expect(sheet).toMatch(/\.chat-header-agent:focus-visible \{\s*outline: 2px solid transparent;\s*\}/);
  expect(sheet).toMatch(
    /\.chat-header-agent:focus-visible:not\(:disabled\) \.chat-header-name \{\s*box-shadow: 0 0 0 2px var\(--color-white\), 0 0 0 4px var\(--color-blue\);/,
  );
});

it('keeps the avatar keyboard focus ring while the pointer is over it', () => {
  // happy-dom does not track hover or focus-visible. Equivalent classes preserve selector specificity
  // and exercise their combined cascade using the actual stylesheet, including the disabled control.
  const states = document.createElement('style');
  states.textContent = sheet.replace(/:hover\b/g, '.pointer-over').replace(/:focus-visible\b/g, '.keyboard-focused').replace(/\(hover: hover\)/g, 'all');
  const button = document.createElement('button');
  button.className = 'chat-header-agent pointer-over keyboard-focused';
  button.innerHTML = '<span class="chat-header-name">Astra</span>';
  document.head.append(states);
  document.body.append(button);
  try {
    const focusRing = '0 0 0 2px #fff, 0 0 0 4px #2563eb';
    expect(styleOf(button, '.chat-header-name').boxShadow).toBe(focusRing);
    button.classList.remove('pointer-over');
    expect(styleOf(button, '.chat-header-name').boxShadow).toBe(focusRing);
    button.classList.remove('keyboard-focused');
    button.classList.add('pointer-over');
    expect(styleOf(button, '.chat-header-name').boxShadow).toBe('0 2px 8px rgba(0, 0, 0, 0.18)');
    button.disabled = true;
    expect(styleOf(button, '.chat-header-name').boxShadow).toBe('none');
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
it('keeps the alerts on screen under the phone header as the chat scrolls the page (#3613)', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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
  for (const [file, from, to, glow] of [['soul', '#6c90bc', '#3f5f8a', '#acc4e0'], ['memory', '#3f5f8a', '#1c2b45', '#acc4e0']]) {
    expect(sheet).toMatch(new RegExp(`:root \\{[^}]*--agent-${file}-from: ${from};\\s*--agent-${file}-to: ${to};\\s*--agent-${file}-glow: ${glow};`));
    expect(sheet).toMatch(new RegExp(`\\.agent-file-tint-${file} \\{[^}]*--file-from: var\\(--agent-${file}-from\\);`));
  }
});

// a Side Chat row revealed its delete button on hover, so iOS Safari spent the first tap on that hover and
// opened the chat only on the second.
it("shows a Side Chat's rename and delete buttons at rest on a touch screen, so the first tap opens the chat, and only on hover or focus with a mouse", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  // happy-dom matches no :hover or :focus-within, so a copy of the sheet marking those states with classes stands in for it.
  const states = document.createElement('style');
  states.textContent = sheet.replace(/:hover\b/g, '.pointer-over').replace(/:focus-within\b/g, '.focus-inside');
  style.replaceWith(states);
  // A fresh row per case, as happy-dom keeps an element's computed style; removed, so no later test finds it.
  const buttons = (maxTouchPoints: number, state = '') => {
    happyDOM.settings.navigator.maxTouchPoints = maxTouchPoints;
    const row = document.createElement('div');
    row.className = `sidebar-item ${state}`;
    row.innerHTML = '<button class="sidebar-item-btn">Rates</button><button class="sidebar-item-rename"></button><button class="sidebar-item-delete">×</button>';
    document.body.append(row);
    const shown = ['.sidebar-item-rename', '.sidebar-item-delete'].map((selector) => styleOf(row, selector).display !== 'none');
    row.remove();
    expect(shown[0]).toBe(shown[1]);
    return shown[1];
  };

  try {
    expect(buttons(5)).toBe(true);
    // At rest with a mouse they take no room, so a long title runs the row's full width.
    expect(buttons(0)).toBe(false);
    expect(buttons(0, 'pointer-over')).toBe(true);
    // Tabbing to the title reveals them, so the next Tab reaches rename.
    expect(buttons(0, 'focus-inside')).toBe(true);
  } finally {
    happyDOM.settings.navigator.maxTouchPoints = 0;
    states.replaceWith(style);
  }
});

// the Main chat pill was filled at rest, so with a Side Chat open both looked selected; and on a phone the
// drawer was a 260 px panel with 13 px rows where Muse Fig 12 is a list with large rows. Memo 0049 Fig 21 then left a strip
// of the chat in view beside it, and its Side Chat rows step at the nav rows' 44px pitch.
it('fills the Main chat pill only while it is the open chat, and opens the drawer beside the chat with large rows on a phone', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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
    expect(phone.sideChat.paddingTop).toBe('9px');
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
    /\.app-layout:has\(> \.sidebar-expanded\) \.app-shell \{\s*transform: translateX\(80vw\);[^}]*border-radius: var\(--radius-4xl\) var\(--radius-4xl\) 0 0;\s*box-shadow: var\(--shadow-soft\);/,
  );
});

// on a phone the messages were 14px beside the drawer's 17px rows; phone body text is 17px (Muse Fig 11,
// dots Fig 7, iOS body), as on desktop the messages are ChatGPT Mac's 14px at its `leading-relaxed`.
it("sets the messages at the drawer rows' 17px on a phone, and at 14px on desktop", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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

  expect(sizes()).toEqual({ user: ['14px', '1.625'], assistant: ['14px', '1.625'] });
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    expect(sizes()).toEqual({ user: ['17px', '1.5'], assistant: ['17px', '1.6'] });
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    delete document.documentElement.dataset.width;
  }
});


// The desktop follows ChatGPT's Mac app (26.1002.52244) and the phone iOS's defaults: one sample of each role, and the
// sidebar row and the agent's name pill, whose desktop weights differ from the phone's, the brand, a second `name`, the
// chat disclaimer, `meta` on a desktop and CopilotKit's 12px on a phone as before, and the Worklog header, `detail` as
// everything in the Worklog.
it("sets each type role at ChatGPT's desktop size and weight and iOS's phone one", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  const samples = [
    ['title', '<h1 class="plugins-title"></h1>', '18px', '600', '22px', '700'],
    ['headline', '<div class="list-row-title"></div>', '14px', '500', '17px', '600'],
    ['body', '<p class="welcome-desc"></p>', '14px', '400', '17px', '400'],
    ['sidebar row', '<aside class="sidebar sidebar-expanded"><button class="sidebar-nav-item"></button></aside>', '14px', '400', '17px', '500'],
    ['side chat row', '<button class="sidebar-item-btn"></button>', '14px', '400', '17px', '400'],
    ['menu item', '<button class="user-menu-item"></button>', '14px', '400', '17px', '400'],
    ['name pill', '<div class="chat-header-name"></div>', '16px', '500', '17px', '600'],
    ['meta', '<p class="plugins-intro"></p>', '12px', '400', '15px', '400'],
    ['disclaimer', '<div class="chat-disclaimer"></div>', '12px', '400', '12px', '400'],
    ['worklog header', '<button class="worklog-head"></button>', '13px', '400', '15px', '400'],
    ['name', '<h2 class="agent-profile-name"></h2>', '18px', '600', '22px', '700'],
    ['brand', '<aside class="sidebar sidebar-expanded"><span class="sidebar-brand-text"></span></aside>', '18px', '600', '22px', '600'],
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
    // The chat's white, so only the seam parts them, as ChatGPT's sidebar
    expect(sidebar.backgroundColor).toBe(styleOf(open.container, '.app-shell').backgroundColor);
    expect(sidebar.boxShadow || 'none').toBe('none');
    expect(sidebar.animation || 'none').toBe('none');
    expect(sidebar.borderRight).toBe('1px solid #e0e0e0');
    expect(sidebar.borderRight).toBe(styleOf(open.container, '.agent-profile').borderLeft);
    // Open, the chip shuts it from beside the title
    expect(styleOf(open.container, '.sidebar-logo-btn').display).toBe('flex');
  } finally {
    open.unmount();
  }
});

it('gives Side Chats space and phone sidebar controls full targets', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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
        // Side chats sit right under their header on both (memo 0049 Fig 21, #3624)
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
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 440, height: 956 });
  const { container, unmount } = render(
    <div className="app-layout">
      <aside className="sidebar sidebar-collapsed"><div className="sidebar-top"><div className="sidebar-brand"><button className="sidebar-logo-btn" /></div></div></aside>
      <main className="app-shell"><header className="chat-header"><button className="chat-header-agent"><span className="avatar avatar-agent" style={{ width: 72, height: 72 }}><svg width="72" height="72" /></span><span className="chat-header-name">Marq</span></button></header><div className="app-chat" /></main>
    </div>,
  );
  try {
    expect(styleOf(container, '.sidebar-logo-btn').backgroundColor).toBe('rgba(255, 255, 255, 0.6)');
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
it('scrolls the phone chat with the page, up under the status bar, under no band of its own, and leaves desktop its own scroll view (#3613)', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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
      pill: { backgroundColor: pill.backgroundColor, boxShadow: pill.boxShadow },
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
      // The name's own crisp white backing, over the text that runs beneath it, with no glow around Marq.
      pill: { backgroundColor: 'rgba(255, 255, 255, 0.92)', boxShadow: 'none' },
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
  // and scrolls the page to its own: neither moves as the chat takes over (#3697). The cold open check measures them.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.app-chat \.kept-chat \{\s*position: fixed;\s*inset: 0 var\(--app-safe-right\) var\(--app-safe-bottom\) var\(--app-safe-left\);\s*\}\s*\.app-chat \.kept-chat :is\(\.chat-wrapper, \.copilotKitChat\) \{\s*height: 100%;/);
  // The page that scrolls a phone's chat keeps no scrollbar gutter, so the kept Main Chat's scroll view keeps none.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.app-chat \.kept-chat \.copilotKitChat > :first-child > div \{\s*scrollbar-width: none;/);
  // Muse's avatar and 44pt menu, 24pt in, stand at the top of the screen below the status bar (Fig 11), where Marq's hat,
  // 1px above his box, and the menu button, 2px below the sidebar's safe area, meet it. The drawer's strip keeps the
  // menu's faded copy where the menu stood. The layout check measures them.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-header \{\s*position: fixed;[^}]*padding-top: calc\(1px \+ var\(--chat-header-safe-top\)\);/);
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.sidebar-collapsed \.sidebar-brand \{\s*padding: 2px 12px 12px 24px;/);
  expect(sheet).toMatch(/\.sidebar-strip-close-menu \{\s*position: absolute;\s*top: calc\(var\(--app-safe-top\) \+ 2px\);\s*left: 24px;/);
  // The page colour below the composer, which useComposerBacking places, over the chat the page runs on with there.
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-composer-backing \{\s*position: absolute;\s*left: 0;\s*right: 0;\s*z-index: 10;\s*background: var\(--color-white\);/);
  // iOS Safari keeps the fixed composer above its keyboard, so CopilotKit's keyboard lift is dropped there alone;
  // Android Chrome leaves fixed elements under its keyboard and keeps the lift, and the chat's room for it.
  expect(sheet).toMatch(/@supports \(-webkit-touch-callout: none\) \{\s*@media \(max-width: 640px\) \{\s*\.app-chat \[data-testid='copilot-input-overlay'\] > \[data-copilotkit\] \{\s*transform: none !important;\s*\}\s*\.chat-keyboard-room \{\s*display: none;/);
  expect(sheet).not.toMatch(/\}\s*\.app-chat \[data-testid='copilot-input-overlay'\] > \[data-copilotkit\] \{\s*transform: none/);
  // The open drawer or Agent Profile holds the page (usePageHold): the card beside it is the screen, its chat where the
  // page had it.
  expect(sheet).toMatch(/html\[data-page-held\] :is\(\.app-shell, \.sidebar-expanded, \.agent-profile\) \{\s*position: absolute;\s*top: 0;\s*height: calc\(100dvh \+ var\(--page-runway\) \+ var\(--page-runway-bottom, 0px\)\);\s*max-height: none;\s*border-top: var\(--page-runway\) solid var\(--color-white\);/);
  expect(sheet).toMatch(/html\[data-page-held\] :is\(\.app-chat, \.plugins\) \{\s*position: relative;\s*top: calc\(-1 \* var\(--page-scroll, 0px\)\);/);
});

// A Safari tab draws the strip behind the clock from the page's pixels only once the page has scrolled, and leaves fixed
// elements out of it. The held page scrolls past a runway (usePageHold), which the card and the drawer, standing on
// the page, reach up into. happy-dom resolves neither the phone query nor calc(), so the sheet is read.
it('draws the held phone card and drawer up into the runway behind the clock (#3640)', () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*:root \{\s*--page-runway: 62px;/);
  expect(sheet).toMatch(/html\[data-page-held\] \.sidebar-expanded \{\s*border-top-color: var\(--color-surface\);/);
  // Mid-swipe, a fixed header or the pill's blur turned the strip flat again.
  expect(sheet).toMatch(/html\[data-page-held\] \.chat-header \{\s*position: absolute;/);
  expect(sheet).toMatch(/html\[data-page-held\] \.chat-header-name \{\s*backdrop-filter: none;/);
});

// The maintainer found the profile under the sliding chat backwards (#3694): the profile now slides in over the still
// chat, and it and the drawer's card take one shape, top corners rounded as the screen's, a square bottom running on
// behind Safari's bar.
it('slides the phone profile in over the chat in the drawer card\'s shape (#3694)', () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.agent-profile \{\s*position: fixed;[^}]*border-radius: var\(--radius-4xl\) var\(--radius-4xl\) 0 0;\s*box-shadow: var\(--shadow-soft\);/);
  expect(sheet).toMatch(/\.app-layout\[data-profile-swiping\] > \.agent-profile \{\s*transform: translateX\(calc\(100% - var\(--profile-drag-offset\)\)\);/);
  expect(sheet).toMatch(/@starting-style \{\s*\.agent-profile \{\s*transform: translateX\(100%\);/);
  // The chat no longer moves for the profile, nor rises over it.
  expect(sheet).not.toMatch(/\.app-layout\[data-profile-swiping\] \.app-shell \{[^}]*(transform|z-index)/);
  // Its fade dims the chat under the profile, not the profile.
  expect(sheet).toMatch(/\.app-layout\[data-profile-swiping\] \.app-shell \{\s*isolation: isolate;\s*\}/);
});

// The drawer's grey and the card ran up under the status bar but stopped above Safari's bottom bar, over a white band.
it("runs the held phone card and drawer down behind Safari's bottom bar (#3640)", () => {
  expect(sheet).toMatch(/html\[data-page-held\] \.app-layout \{\s*min-height: calc\(100dvh \+ var\(--page-runway\) \+ var\(--page-runway-bottom, 0px\)\);/);
  expect(sheet).toMatch(/html\[data-page-held\] :is\(\.app-shell, \.sidebar-expanded, \.agent-profile\) \{[^}]*height: calc\(100dvh \+ var\(--page-runway\) \+ var\(--page-runway-bottom, 0px\)\);[^}]*border-bottom: var\(--page-runway-bottom, 0px\) solid var\(--color-white\);/);
  expect(sheet).toMatch(/html\[data-page-held\] \.sidebar-expanded \{\s*border-top-color: var\(--color-surface\);\s*border-bottom-color: var\(--color-surface\);/);
});

// The maintainer's iPhone, mid-swipe on 5f64597bf: the chat stopped 62pt down, over the held card's white border, with
// no chat behind the clock, and Safari's bottom bar showed a white band. The held card's runways are padding the chat
// runs on into, as it does at rest, and the composer, no longer fixed, gives Safari no fixed container at the bottom
// edge whose white it would spread under its bar (WebKit's LocalFrameView::fixedContainerEdges).
it('runs the held chat on behind the clock and under Safari\'s bar, mid-swipe and open (#3640)', () => {
  expect(sheet).toMatch(/html\[data-page-held\] \.app-shell \{\s*border-width: 0;\s*padding-top: var\(--page-runway\);\s*padding-bottom: var\(--page-runway-bottom, 0px\);/);
  expect(sheet).toMatch(/html\[data-page-held\] \.chat-header \{\s*position: absolute;\s*top: var\(--page-runway\);/);
  expect(sheet).toMatch(/html\[data-page-held\] \.app-chat \[data-testid='copilot-input-overlay'\] \{\s*position: absolute;\s*top: calc\(var\(--page-scroll, 0px\) \+ 100dvh - var\(--app-safe-bottom\)\);\s*bottom: auto;\s*translate: 0 -100%;/);
});

// iOS 26.2 Simulator, Safari tab: the strip behind the clock and the band under Safari's bar showed flat white, drawer
// open or shut, over the runways the page had scrolled into view (#3702). Safari spreads the colour of a fixed element
// found at the middle of the screen's top or bottom edge, and keeps spreading it while that element stays rendered and
// visible, a `header` even hidden (WebKit's LocalFrameView::fixedContainerEdges, Page::updateFixedContainerEdges): the
// full-width fixed header at the top, the fixed composer at the bottom. The header keeps to Marq's width, too narrow to
// count, and the held composer hides its own empty box.
it("leaves Safari no fixed edge colour to spread behind the clock or, held, under its bar (#3702)", () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-header \{\s*position: fixed;\s*left: 50%;\s*right: auto;\s*translate: -50% 0;/);
  expect(sheet).toMatch(/html\[data-page-held\] \.app-chat \[data-testid='copilot-input-overlay'\] \{[^}]*visibility: hidden;\s*\}\s*html\[data-page-held\] \.app-chat \[data-testid='copilot-input-overlay'\] > \* \{\s*visibility: visible;/);
});

// Held, the profile stands at the screen's top for its background to run on behind the clock, which left its Close 16px
// from the top under the status bar of an installed or fullscreen iPhone, whose safe area insets are not 0 (#3694).
it("keeps the held phone profile's controls inside the safe area, its background edge to edge (#3694)", () => {
  expect(sheet).toMatch(/html\[data-page-held\] \.agent-profile \{\s*padding-top: var\(--app-safe-top\);\s*padding-bottom: var\(--app-safe-bottom\);/);
});

// iOS Safari tints the strip behind the clock with the page's colour, so the open drawer's grey reaches up to the clock
// only when the page itself turns grey. happy-dom resolves neither :has nor the phone query, so the sheet is read.
it("turns the page the drawer's grey while the phone drawer is open, up behind the clock (#3613)", () => {
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*html:has\(\.sidebar-expanded\),\s*html:has\(\.sidebar-expanded\) body \{\s*background: var\(--color-surface\);/);
});

// #3564 drew a 99px Marq, about 77px tall with his hat, behind a shadowed pill over his body. Muse's 68px avatar sits
// in front of its pill, which tucks about 6px behind it (memo 0049 Fig 11). The layout check measures the heights and
// the tuck; #3624 gives the desktop its own.
it("draws the phone's Marq 68px tall in front of the pill tucked behind him (#3614)", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
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

// #3624: the desktop takes the phone's top of chat and drawer layout (#3613, #3614, #3616), measured against memo 0049
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
          <div className="sidebar-item sidebar-item-active"><button className="sidebar-item-btn">Rates</button><button className="sidebar-item-delete">×</button></div>
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
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 1440, height: 900 });
  const { container, unmount } = render(desktopApp('sidebar-collapsed'));
  try {
    const chat = styleOf(container, '.app-shell');
    expect(chat.backgroundColor).toBe('#fff');
    expect({ margin: zero(chat.margin), radius: chat.borderRadius || '0px', shadow: chat.boxShadow || 'none' }).toEqual({ margin: '0px', radius: '0px', shadow: 'none' });
    // Only the phone's profile, which runs up behind the clock, rounds (#3694)
    expect(sheet.match(/\.agent-profile \{[^}]*border-radius[^}]*\}/g)?.length).toBe(1);
    expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.agent-profile \{[^}]*border-radius: var\(--radius-4xl\) var\(--radius-4xl\) 0 0;/);
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it("sets Marq 1.5px under the desktop card's top, in front of a crisp white name pill with no frost or glow (memo 0049 Fig 1, #3624)", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 1440, height: 900 });
  const { container, unmount } = render(desktopApp('sidebar-collapsed'));
  try {
    // His hat sits 9.5px into his 72px box: 2px of padding less 10px puts it 1.5px under the card's top, as Fig 1's.
    expect(styleOf(container, '.chat-header').paddingTop).toBe('2px');
    expect(styleOf(container, '.chat-header-agent .avatar-agent').marginTop).toBe('-10px');
    const marq = styleOf(container, '.chat-header-agent .avatar-agent svg');
    expect({ position: marq.position, zIndex: marq.zIndex }).toEqual({ position: 'relative', zIndex: '1' });
    const pill = styleOf(container, '.chat-header-name');
    // Tucked about 6px behind his body, as the phone's (#3614)
    expect(pill.marginTop).toBe('-11px');
    expect(pill.backgroundColor).toBe('#fff');
    expect(pill.backdropFilter || 'none').toBe('none');
    expect(pill.boxShadow).toBe('none');
    // No band behind the header: the chat scrolls beneath it clear.
    expect(styleOf(container, '.chat-header').backdropFilter || 'none').toBe('none');
    expect(styleOf(container, '.chat-header').backgroundImage || 'none').toBe('none');
  } finally {
    unmount();
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

it("lays out the desktop sidebar as the phone drawer: a 44px pitch, a grey Side chats header, a grey selected fill, a plain plus and the account row 4px off the bottom (memo 0049 Fig 1, #3624)", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 1440, height: 900 });
  try {
    const { container, unmount } = render(desktopApp('sidebar-expanded'));
    try {
      // Fig 1's rows step at 44pt, meeting with no gap (#3555).
      expect(zero(styleOf(container, '.sidebar-main').gap)).toBe('0px');
      // The open row takes the profile controls' hover grey, which shows on the white sidebar
      expect(styleOf(container, '.sidebar-nav-item-active').backgroundColor).toBe('#e0e0e0');
      expect(styleOf(container, '.sidebar-brand').minHeight).toBe('64px');
      // The account row ends 4px above the window's bottom, as Fig 1's does.
      expect(styleOf(container, '.sidebar-bottom').paddingBottom).toBe('4px');
      expect(styleOf(container, '.sidebar-section-header').paddingTop).toBe('4px');
      // The label 20px in, on the title and the icons' edge; the plus at the header's right, as before (#3555).
      expect(styleOf(container, '.sidebar-section-header').padding).toBe('4px 12px 0px 20px');
      const label = styleOf(container, '.sidebar-side-chats-toggle');
      // ChatGPT Mac's Recents: the `headline` role in sentence case, grey.
      expect({ size: label.fontSize, weight: label.fontWeight, spacing: label.letterSpacing || 'normal', transform: label.textTransform || 'none', color: label.color })
        .toEqual({ size: '14px', weight: '500', spacing: 'normal', transform: 'none', color: '#6b6b6b' });
      const plus = styleOf(container, '.sidebar-new-chat');
      expect({ shadow: plus.boxShadow || 'none', color: plus.color }).toEqual({ shadow: 'none', color: '#6b6b6b' });
      expect(plus.backgroundColor || 'transparent').toMatch(/^(transparent|none|rgba\(0, 0, 0, 0\))$/);
      expect(styleOf(container, '.sidebar-new-chat svg').width).toBe('20px');
      // Every row a 40px fill inset 2px in its 44px slot, so no two fills touch; Side chats across the nav pills' width.
      for (const selector of ['.sidebar-nav-item', '.sidebar-item']) {
        expect({ height: styleOf(container, selector).height, margin: styleOf(container, selector).margin }).toEqual({ height: '40px', margin: '2px 0px' });
      }
      expect(styleOf(container, '.sidebar-list').padding).toBe('0px 8px');
      expect(styleOf(container, '.sidebar-item-active').backgroundColor).toBe('#e0e0e0');
      expect(styleOf(container, '.sidebar-item').borderRadius).toBe('9999px');
      // happy-dom matches no :hover, so this reads the sheet: a hovered row takes the lighter #efefef, never the open row.
      for (const name of ['sidebar-nav-item', 'sidebar-item']) {
        expect(sheet).toMatch(new RegExp(`\\.${name}:not\\(\\.${name}-active\\):hover \\{\\s*background: var\\(--color-selected\\);`));
      }
      const row = styleOf(container, '.sidebar-item-btn');
      expect({ top: row.paddingTop, bottom: row.paddingBottom, left: row.paddingLeft, lineHeight: row.lineHeight }).toEqual({ top: '9px', bottom: '9px', left: '12px', lineHeight: '22px' });
      // With a mouse, a 32px delete centred under the plus, 26px from the row's end (10px in); happy-dom leaves calc() as written.
      const remove = styleOf(container, '.sidebar-item-delete');
      expect({ width: remove.width, padding: remove.padding, end: remove.marginRight }).toEqual({ width: '32px', padding: '0px', end: 'calc(26px - 32px / 2)' });
      expect(styleOf(container, '.user-menu-trigger').padding).toBe('8px');
    } finally {
      unmount();
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// The menu, plus and Close buttons were 8px squares, the account row and the name field rectangles among pill rows, and
// a Side Chat's rename and delete icons sat on their buttons' left edge (DESIGN.md: buttons and sidebar rows are round).
it("rounds the sidebar's buttons and rows, and centres a Side Chat's icons in their buttons", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  // A touch screen shows rename and delete at rest.
  happyDOM.settings.navigator.maxTouchPoints = 5;
  const { container, unmount } = render(
    <aside className="sidebar sidebar-expanded">
      <div className="sidebar-brand"><button className="sidebar-logo-btn"><svg /></button></div>
      <div className="sidebar-section-header"><button className="header-btn sidebar-new-chat"><svg /></button></div>
      <div className="sidebar-list">
        <div className="sidebar-item"><button className="sidebar-item-btn">Rates</button><button className="sidebar-item-rename"><svg /></button><button className="sidebar-item-delete"><svg /></button></div>
        <div className="sidebar-item"><input className="sidebar-item-name" /></div>
      </div>
      <div className="sidebar-bottom"><button className="user-menu-trigger" /></div>
    </aside>,
  );
  try {
    for (const selector of ['.sidebar-logo-btn', '.header-btn']) {
      expect(styleOf(container, selector).borderRadius).toBe('50%');
    }
    for (const selector of ['.user-menu-trigger', '.sidebar-item-name', '.sidebar-item-rename', '.sidebar-item-delete']) {
      expect(styleOf(container, selector).borderRadius).toBe('9999px');
    }
    for (const selector of ['.sidebar-item-rename', '.sidebar-item-delete']) {
      const button = styleOf(container, selector);
      expect({ display: button.display, align: button.alignItems, justify: button.justifyContent })
        .toEqual({ display: 'inline-flex', align: 'center', justify: 'center' });
    }
  } finally {
    unmount();
    happyDOM.settings.navigator.maxTouchPoints = 0;
  }
});

it('keeps the phone as it was: no desktop card, frame, header or sidebar value reaches 640px and below (#3624)', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    const shut = render(desktopApp('sidebar-collapsed'));
    try {
      const card = styleOf(shut.container, '.app-shell');
      expect({ margin: zero(card.margin), radius: card.borderRadius || '0px', shadow: card.boxShadow || 'none' }).toEqual({ margin: '0px', radius: '0px', shadow: 'none' });
      expect(styleOf(shut.container, '.app-layout').backgroundColor || 'transparent').toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
      // The phone's own crisp pill over the page-scrolled chat (#3613), not the desktop's white one.
      const pill = styleOf(shut.container, '.chat-header-name');
      expect({ background: pill.backgroundColor, frost: pill.backdropFilter, top: pill.marginTop })
        .toEqual({ background: 'rgba(255, 255, 255, 0.92)', frost: 'blur(4px)', top: '-12px' });
      expect(zero(styleOf(shut.container, '.chat-header-agent .avatar-agent').marginTop)).toBe('0px');
    } finally {
      shut.unmount();
    }
    // A phone is a touch screen.
    happyDOM.settings.navigator.maxTouchPoints = 5;
    const open = render(desktopApp('sidebar-expanded'));
    try {
      expect(styleOf(open.container, '.sidebar').backgroundColor).toBe('#f7f7f8');
      expect(zero(styleOf(open.container, '.sidebar-main').gap)).toBe('0px');
      expect(styleOf(open.container, '.sidebar-main').padding).toBe('38px 10px 10px');
      expect(styleOf(open.container, '.sidebar-section-header').padding).toBe('10px 20px 0px');
      // happy-dom keeps :root's custom properties from their first read, whatever the viewport since, so this reads
      // the sheet: the label still takes the phone's 13px `label` role, tracked, in capitals.
      expect(sheet).toMatch(/@media \(max-width: 640px\) \{\s*(\/\*[^*]*\*\/\s*)?:root \{[^}]*--font-label: 0\.8125rem;/);
      expect(sheet).toMatch(/@media \(max-width: 640px\) \{\s*\.sidebar-side-chats-toggle \{\s*font-size: var\(--font-label\);\s*letter-spacing: 0\.04em;/);
      expect(styleOf(open.container, '.sidebar-side-chats-toggle').textTransform).toBe('uppercase');
      expect(styleOf(open.container, '.sidebar-list').padding).toBe('0px 10px');
      expect(styleOf(open.container, '.sidebar-bottom').padding).toBe('4px 20px 8px');
      expect(styleOf(open.container, '.sidebar-nav-item-active').backgroundColor).toBe('#efefef');
      const nav = styleOf(open.container, '.sidebar-nav-item');
      expect({ top: nav.paddingTop, margin: nav.margin }).toEqual({ top: '8px', margin: '2px 0px' });
      const row = styleOf(open.container, '.sidebar-item-btn');
      expect({ top: row.paddingTop, left: row.paddingLeft }).toEqual({ top: '9px', left: '10px' });
      const remove = styleOf(open.container, '.sidebar-item-delete');
      expect({ width: remove.width, end: remove.marginRight }).toEqual({ width: '44px', end: 'calc(32px - 44px / 2)' });
      expect(styleOf(open.container, '.user-menu-trigger').gap).toBe('13px');
    } finally {
      open.unmount();
    }
  } finally {
    happyDOM.settings.navigator.maxTouchPoints = 0;
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});
