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
  expect(bubble.padding).toBe('10px 16px');
  expect(bubble.maxWidth).toBe('100%');
  expect(styleOf(reply.prose, 'p').marginTop).toBe('0px');
  expect(styleOf(reply.prose, 'p').marginBottom).toBe('0px');
  expect(styleOf(reply.prose, 'code').backgroundColor).toBe('#fff');
  const toolRow = document.createElement('div');
  toolRow.className = 'not-prose';
  toolRow.innerHTML = '<p><code>agent --help</code></p>';
  toolOnly.message.append(toolRow);
  expect(styleOf(toolRow, 'code').backgroundColor).toBe('#f4f4f4');
  expect(styleOf(toolOnly.prose, ':scope > div').backgroundColor).not.toBe('#f4f4f4');
});

it("keeps the user's next message a paragraph's distance below the agent's bubble", () => {
  const { message } = inAssistantMessage('<div><p>Done.</p></div>');
  const next = document.createElement('div');
  next.className = 'copilotKitMessage copilotKitUserMessage';
  message.after(next);

  expect(getComputedStyle(next).marginTop).toBe('12px');
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

it('keeps phone text above right controls and desktop text beside controls for empty and typed drafts', () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  try {
    // The text is the `message` role and the picker `detail`, whose phone sizes start at 640px.
    for (const [width, textSize, pickerSize] of [[440, '17px', '15px'], [641, '16px', '13px'], [767, '16px', '13px'], [768, '16px', '13px'], [1440, '16px', '13px']] as const) {
      happyDOM.setViewport({ width, height: 844 });
      // The type roles are the root's tokens, whose kept style a changed attribute drops.
      document.documentElement.dataset.width = String(width);
      for (const text of ['', 'What moved US rates?']) {
        const input = document.createElement('div');
        input.className = 'copilotKitInput';
        input.innerHTML = `<div class="cpk:grid" data-layout="expanded">
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
        const expected = width < 768
          ? { rows: 'minmax(44px, auto) 44px', textColumn: '1 / -1', controlsRow: '2' }
          : { rows: 'auto', textColumn: '1', controlsRow: '1' };
        expect(styleOf(input, '[data-layout]').gridTemplateRows).toBe(expected.rows);
        if (width < 768) {
          const layout = styleOf(input, '[data-layout]');
          expect(layout.paddingTop).toBe('0px');
          expect(layout.paddingBottom).toBe('0px');
          expect(layout.paddingLeft).toBe('15px');
          expect(layout.paddingRight).toBe('15px');
          expect(styleOf(input, 'textarea').paddingTop).toBe('8px');
        }
        expect(styleOf(input, '[class*="col-start-1"]').display).toBe('none');
        expect(styleOf(input, '[class*="col-span-3"]').gridColumn).toBe(expected.textColumn);
        expect(styleOf(input, '[class*="col-span-3"]').gridRow).toBe('1');
        expect(styleOf(input, '[class*="col-start-3"]').gridRow).toBe(expected.controlsRow);
        expect(styleOf(input, 'textarea').paddingLeft).toBe('0px');
        expect(styleOf(input, 'textarea').fontSize).toBe(textSize);
        expect(styleOf(input, '.mep-pill').fontSize).toBe(pickerSize);
        expect(styleOf(input, '.mep-pill-effort').display).not.toBe('none');
        expect(styleOf(input, '.mep-pill').minHeight).toBe('44px');
        expect(styleOf(input, '[data-testid="copilot-send-button"]').width).toBe('44px');
        expect(getComputedStyle(input).position).toBe('relative');
        expect(styleOf(input, '.mep').position).toBe('static');
        expect(styleOf(input, '.mep-dropdown').bottom).toBe('calc(100% + 8px)');
      }
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    delete document.documentElement.dataset.width;
    document.querySelectorAll('.copilotKitInput').forEach((input) => input.remove());
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

it("lays out a message's markdown table as a table, though streamdown marks it as its own wrapper", () => {
  // streamdown 1.6.11 puts data-streamdown="table-wrapper" on the <table> as well as its wrapper, so
  // CopilotKit's flex column for the wrapper turns the table into a flexbox whose rows shrink to fit.
  const copilotKit = document.createElement('style');
  copilotKit.textContent = '[data-copilotkit] [data-streamdown="table-wrapper"] { display: flex; flex-direction: column; margin-top: 16px; margin-bottom: 16px; }';
  document.head.prepend(copilotKit);
  const { prose } = inAssistantMessage(
    '<div data-streamdown="table-wrapper"><div><table data-streamdown="table-wrapper"><tbody><tr><td>1</td></tr></tbody></table></div></div>',
  );
  prose.parentElement?.setAttribute('data-copilotkit', '');

  expect(styleOf(prose, 'table').display).toBe('table');
  expect(styleOf(prose, 'table').marginTop).toBe('0px');
  expect(styleOf(prose, 'div[data-streamdown]').display).toBe('flex');
  copilotKit.remove();
});

it("keeps a message's table copy and download buttons at the table's top right, spaced as streamdown spaces them", () => {
  // Tailwind compiles only the classes in this app's own source, not streamdown's `justify-end` and `p-1`.
  const { message, prose } = inAssistantMessage(
    '<div class="flex flex-col" data-streamdown="table-wrapper"><div class="flex items-center justify-end gap-1"><div class="relative"><button class="p-1" title="Copy table" type="button"></button></div></div><div class="overflow-x-auto"><table data-streamdown="table-wrapper"></table></div></div>',
  );
  prose.parentElement?.setAttribute('data-copilotkit', '');

  const controls = styleOf(prose, 'div[data-streamdown] > div:first-child');
  expect(controls.justifyContent).toBe('flex-end');
  expect(controls.gap).toBe('0.25rem');
  expect(styleOf(prose, 'button[title="Copy table"]').padding).toBe('4px');
  message.remove();
});

it("keeps Streamdown's table scroll box inside its card while extending the card to the bubble's right edge", () => {
  const { container, unmount } = render(
    <div data-copilotkit="" className="copilotKitMessage copilotKitAssistantMessage">
      <div className="cpk:prose">
        <Streamdown>{`Scenarios:

| Currency | Spot level | Outlook |
| --- | --- | --- |
| Australian dollar | 0.6543 | Continued gains against the US dollar |`}</Streamdown>
      </div>
    </div>,
  );

  try {
    expect(container.querySelector('td')?.textContent).toBe('Australian dollar');
    const card = styleOf(container, 'div[data-streamdown="table-wrapper"]');
    const scroller = styleOf(container, 'div[data-streamdown="table-wrapper"] > .overflow-x-auto');
    expect(scroller.marginRight || '0px').toBe('0px');
    expect(scroller.paddingRight || '0px').toBe('0px');
    expect(card.marginRight).toBe('-16px');
    expect(scroller.backgroundImage.match(/radial-gradient/g)).toHaveLength(2);
  } finally {
    unmount();
  }
  // happy-dom drops background attachment lists, so the real-browser check proves their rendering.
  expect(sheet).toMatch(/> \.overflow-x-auto \{[^}]*background-attachment: local, local, scroll, scroll;/);
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
it("shows a scheduled task's edit fields as fields", () => {
  const field = document.createElement('label');
  field.className = 'field scheduled-task-field';
  field.innerHTML = '<input value="Morning brief" /><select></select>';
  document.body.append(field);

  for (const control of ['input', 'select']) {
    expect(styleOf(field, control).borderStyle).toBe('solid');
    expect(styleOf(field, control).backgroundColor).toBe('#fff');
  }
  field.remove();
});

it('spaces a scheduled-task proposal in a message by its own gap, not prose paragraph margins', () => {
  const { message, prose } = inAssistantMessage('');
  render(
    <ScheduledTaskProposalCard
      chatServiceUrl="http://chat.test"
      proposalId="call-1"
      proposal={{ title: 'Morning brief', prompt: 'Brief me on rates', schedule: 'cron(0 8 ? * MON-FRI *)' }}
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

it('stacks the Identity tab\'s file cards, one per row at full width', () => {
  const { container } = render(<div className="agent-file-cards" />);

  expect(styleOf(container, '.agent-file-cards').gridTemplateColumns).toBe('1fr');
});

// a Side Chat row revealed its delete button on hover, so iOS Safari spent the first tap on that hover and
// opened the chat only on the second.
it("shows a Side Chat's delete button at rest on a touch screen, so the first tap opens the chat, and only on hover with a mouse", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  // A fresh row per device, as happy-dom keeps an element's computed style; removed, so no later test finds it.
  const deleteOpacity = (maxTouchPoints: number) => {
    happyDOM.settings.navigator.maxTouchPoints = maxTouchPoints;
    const row = document.createElement('div');
    row.className = 'sidebar-item';
    row.innerHTML = '<button class="sidebar-item-btn">Rates</button><button class="sidebar-item-delete">×</button>';
    document.body.append(row);
    const { opacity } = styleOf(row, '.sidebar-item-delete');
    row.remove();
    return opacity;
  };

  try {
    expect(deleteOpacity(5)).not.toBe('0');
    expect(deleteOpacity(0)).toBe('0');
    // happy-dom matches no :hover, so this reads the sheet: the hover reveal applies only where the device can hover.
    expect(sheet).toMatch(/@media \(hover: hover\) \{[^@]*\.sidebar-item:hover \.sidebar-item-delete \{\s*opacity: 1;/);
  } finally {
    happyDOM.settings.navigator.maxTouchPoints = 0;
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
    expect(phone.sideChat.paddingTop).toBe('11px');
    expect(phone.sideChat.lineHeight).toBe(phone.mainChat.lineHeight);
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});

// the open drawer covered the whole chat; memo 0049 Fig 21 slides the chat right as a rounded card beside it, its
// soft shadow on the drawer.
it("slides the chat right by the phone drawer's width as a rounded, shadowed card, and keeps the page from scrolling sideways", () => {
  // happy-dom leaves :has() and vw unresolved, so this reads the sheet.
  expect(sheet).toMatch(/\.app-layout:has\(> \.sidebar-expanded\) \{\s*overflow: hidden;/);
  expect(sheet).toMatch(
    /\.app-layout:has\(> \.sidebar-expanded\) \.app-shell \{\s*transform: translateX\(80vw\);[^}]*border-radius: var\(--radius-4xl\) var\(--radius-4xl\) 0 0;\s*box-shadow: var\(--shadow-soft\);/,
  );
});

// on a phone the messages were 14px beside the drawer's 17px rows; phone body text is 17px (Muse Fig 11,
// dots Fig 7, iOS body), as on desktop the messages are ChatGPT's 16px (dots Fig 1).
it("sets the messages at the drawer rows' 17px on a phone, and at 16px on desktop", () => {
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
    const result = { user: styleOf(user, ':scope > div').fontSize, assistant: getComputedStyle(prose).fontSize };
    user.remove();
    prose.parentElement?.remove();
    return result;
  };

  expect(sizes()).toEqual({ user: '16px', assistant: '16px' });
  happyDOM.setViewport({ width: 440, height: 956 });
  try {
    expect(sizes()).toEqual({ user: '17px', assistant: '17px' });
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
    delete document.documentElement.dataset.width;
  }
});


// The desktop follows ChatGPT's Mac app (6 Oct build) and the phone iOS's defaults: one sample of each role, and the
// sidebar row and the agent's name pill, whose desktop weights differ from the phone's, and the brand, a second `name`.
it("sets each type role at ChatGPT's desktop size and weight and iOS's phone one", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  const samples = [
    ['title', '<h1 class="plugins-title"></h1>', '24px', '500', '22px', '700'],
    ['headline', '<div class="list-row-title"></div>', '14px', '500', '17px', '600'],
    ['body', '<p class="welcome-desc"></p>', '14px', '400', '17px', '400'],
    ['sidebar row', '<aside class="sidebar sidebar-expanded"><button class="sidebar-nav-item"></button></aside>', '14px', '400', '17px', '500'],
    ['side chat row', '<button class="sidebar-item-btn"></button>', '14px', '400', '17px', '400'],
    ['menu item', '<button class="user-menu-item"></button>', '14px', '400', '17px', '400'],
    ['name pill', '<div class="chat-header-name"></div>', '16px', '500', '17px', '600'],
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

it('centres every desktop rail control on one 44px target with an aligned divider', () => {
  const { container, unmount } = render(
    <aside className="sidebar sidebar-collapsed">
      <div className="sidebar-brand" />
      <nav className="sidebar-nav sidebar-main"><button className="sidebar-nav-item"><svg className="sidebar-nav-icon" /></button></nav>
      <div className="sidebar-section-header"><button className="header-btn sidebar-new-chat"><svg /></button></div>
      <div className="sidebar-bottom"><button className="user-menu-trigger"><span className="user-avatar" /></button></div>
    </aside>,
  );
  try {
    expect(styleOf(container, '.sidebar').width).toBe('60px');
    for (const selector of ['.sidebar-nav-item', '.sidebar-new-chat', '.user-menu-trigger']) {
      const control = styleOf(container, selector);
      expect({ width: control.width, height: control.height, padding: control.padding }).toEqual({ width: '44px', height: '44px', padding: '0px' });
    }
    // Dots' rail steps at 44pt (memo 0049 Fig 1, #3624)
    expect(zero(styleOf(container, '.sidebar-main').gap)).toBe('0px');
    expect(styleOf(container, '.sidebar-main').paddingBottom).toBe('5px');
    expect(styleOf(container, '.sidebar-section-header').paddingTop).toBe('4px');
    expect(styleOf(container, '.sidebar-new-chat svg').width).toBe('20px');
  } finally {
    unmount();
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
          // A phone's plus is as light as the rows' × marks
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
  expect(sheet).toMatch(/@media \(max-width: 640px\) \{[^@]*\.chat-header \{\s*position: fixed;\s*padding-top: calc\(1px \+ var\(--chat-header-safe-top\)\);/);
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

// #3624: the desktop takes the phone's chat card, top of chat and drawer layout (#3613, #3614, #3616), measured
// against memo 0049 Fig 1 (dots desktop): a rounded white card 4px inside the sidebar's grey frame, the avatar's top
// 1.5pt under the card's, a 44pt rail pitch and the account row on the card's bottom inset.
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

it("sets the desktop chat as a rounded white card 4px inside the sidebar's grey frame, its edge soft (memo 0049 Fig 1, #3624)", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 1440, height: 900 });
  const { container, unmount } = render(desktopApp('sidebar-collapsed'));
  try {
    // The frame is Fig 1's grey, the sidebar on it (#3604)
    expect(styleOf(container, '.app-layout').backgroundColor).toBe('#ebebec');
    expect(styleOf(container, '.sidebar').backgroundColor).toBe('#ebebec');
    const card = styleOf(container, '.app-shell');
    expect(card.backgroundColor).toBe('#fff');
    expect(card.margin).toBe('4px 4px 4px 0px');
    expect(card.borderRadius).toBe('12px');
    expect(card.overflow).toBe('hidden');
    expect(card.boxShadow).toBe('0 0 0 0.5px rgba(0,0,0,0.06), 0 0 20px rgba(0,0,0,0.06)');
    // happy-dom matches no :has(), so this reads the sheet: beside the chat, the open profile shares its card (Fig 3).
    expect(sheet).toMatch(/@media \(min-width: 1140px\) \{[^@]*\.app-shell:has\(~ \.agent-profile:not\(\[hidden\]\)\) \{\s*margin-right: 0;\s*border-top-right-radius: 0;\s*border-bottom-right-radius: 0;/);
    expect(sheet).toMatch(/@media \(min-width: 1140px\) \{[^@]*\.agent-profile \{\s*margin: 4px 4px 4px 0;\s*border-radius: 0 var\(--radius-lg\) var\(--radius-lg\) 0;\s*box-shadow: var\(--shadow-card\);\s*\}/);
    // A clip would cut the full-window computer sheet the profile holds, so the seam clip waits for it to close
    expect(sheet).toMatch(/@media \(min-width: 1140px\) \{[^@]*\.agent-profile:not\(:has\(\.agent-computer-sheet\)\) \{\s*clip-path: inset\(-24px -24px -24px 0\);/);
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

it("lays out the desktop sidebar as the phone drawer: a 44px pitch, the SIDE CHATS label, a white selected fill, a plain plus and the account row on the card's bottom inset (memo 0049 Fig 1, #3624)", () => {
  const happyDOM = (window as unknown as HappyDomWindow).happyDOM;
  happyDOM.setViewport({ width: 1440, height: 900 });
  try {
    for (const state of ['sidebar-expanded', 'sidebar-collapsed'] as const) {
      const { container, unmount } = render(desktopApp(state));
      try {
        // Fig 1's rail steps at 44pt, so the rows meet with no gap in both states and keep their places (#3555).
        expect(zero(styleOf(container, '.sidebar-main').gap)).toBe('0px');
        // The open row is white, which shows on the frame (memo 0049 Fig 1, #3604)
        expect(styleOf(container, '.sidebar-nav-item-active').backgroundColor).toBe('#fff');
        // The brand row keeps its 64px in both states, so nothing under it moves (#3555)
        expect(styleOf(container, '.sidebar-brand').minHeight).toBe('64px');
        // The rail keeps only Main chat and Plugins, so it drops the divider under them (#3604)
        expect(styleOf(container, '.sidebar-main > .pseudo-after').display === 'none').toBe(state === 'sidebar-collapsed');
        // The account row ends 4px above the bottom, on the card's bottom inset, as Fig 1's does.
        expect(styleOf(container, '.sidebar-bottom').paddingBottom).toBe('4px');
        expect(styleOf(container, '.sidebar-section-header').paddingTop).toBe('4px');
      } finally {
        unmount();
      }
    }
    const { container, unmount } = render(desktopApp('sidebar-expanded'));
    try {
      // The label 20px in, on the title and the icons' edge; the plus at the header's right, as before (#3555).
      expect(styleOf(container, '.sidebar-section-header').padding).toBe('4px 12px 0px 20px');
      const label = styleOf(container, '.sidebar-side-chats-toggle');
      expect({ size: label.fontSize, weight: label.fontWeight, spacing: label.letterSpacing, transform: label.textTransform })
        .toEqual({ size: '11px', weight: '600', spacing: '0.44px', transform: 'uppercase' });
      const plus = styleOf(container, '.sidebar-new-chat');
      expect({ shadow: plus.boxShadow || 'none', color: plus.color }).toEqual({ shadow: 'none', color: '#6b6b6b' });
      expect(plus.backgroundColor || 'transparent').toMatch(/^(transparent|none|rgba\(0, 0, 0, 0\))$/);
      expect(styleOf(container, '.sidebar-new-chat svg').width).toBe('20px');
      // Side chats step at the rows' 44px pitch, the text on the labels' 20px, each × in the plus's 44px column.
      expect(styleOf(container, '.sidebar-list').padding).toBe('0px 12px 0px 8px');
      expect(zero(styleOf(container, '.sidebar-item').marginBottom)).toBe('0px');
      expect(styleOf(container, '.sidebar-item-active').backgroundColor).toBe('#fff');
      const row = styleOf(container, '.sidebar-item-btn');
      expect({ top: row.paddingTop, bottom: row.paddingBottom, lineHeight: row.lineHeight }).toEqual({ top: '11px', bottom: '11px', lineHeight: '22px' });
      const remove = styleOf(container, '.sidebar-item-delete');
      expect({ width: remove.width, padding: remove.padding }).toEqual({ width: '44px', padding: '0px' });
      expect(styleOf(container, '.user-menu-trigger').padding).toBe('8px');
    } finally {
      unmount();
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
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
    const open = render(desktopApp('sidebar-expanded'));
    try {
      expect(styleOf(open.container, '.sidebar').backgroundColor).toBe('#f7f7f8');
      expect(zero(styleOf(open.container, '.sidebar-main').gap)).toBe('0px');
      expect(styleOf(open.container, '.sidebar-main').padding).toBe('38px 10px 10px');
      expect(styleOf(open.container, '.sidebar-section-header').padding).toBe('10px 20px 0px');
      // happy-dom keeps :root's custom properties from their first read, whatever the viewport since, so this reads
      // the sheet: the label still takes the phone's 13px `label` role.
      expect(sheet).toMatch(/@media \(max-width: 640px\) \{\s*(\/\*[^*]*\*\/\s*)?:root \{[^}]*--font-label: 0\.8125rem;/);
      expect(sheet).toMatch(/\.sidebar-side-chats-toggle \{[^}]*font-size: var\(--font-label\);/);
      expect(styleOf(open.container, '.sidebar-list').padding).toBe('0px 20px 0px 8px');
      expect(styleOf(open.container, '.sidebar-bottom').padding).toBe('4px 20px 8px');
      expect(styleOf(open.container, '.sidebar-nav-item-active').backgroundColor).toBe('#efefef');
      expect(styleOf(open.container, '.sidebar-item-btn').paddingTop).toBe('11px');
      expect(styleOf(open.container, '.sidebar-item-delete').width).toBe('44px');
      expect(styleOf(open.container, '.user-menu-trigger').gap).toBe('13px');
    } finally {
      open.unmount();
    }
  } finally {
    happyDOM.setViewport({ width: 1024, height: 768 });
  }
});
