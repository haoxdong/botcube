// The one-source check (ADR 0094): each listed part is built once, in its one file.
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMPONENTS, LIBRARIES, UNLISTED } from './components';
import { libraryOffences, oneSourceOffences, sourcesOf, unlistedOffences } from './one-source';

const web = path.resolve(import.meta.dirname, '../..');
const sources = sourcesOf(web);

describe('the one-source check', () => {
  it('passes the app as it is', () => {
    expect(oneSourceOffences(sources, COMPONENTS)).toEqual([]);
    expect(unlistedOffences(sources, COMPONENTS, UNLISTED)).toEqual([]);
    expect(libraryOffences(sources, LIBRARIES)).toEqual([]);
  });

  it('takes Fluent UI in the agent computer only, naming an import elsewhere', () => {
    const planted = {
      ...sources,
      'src/computer/files-grid.tsx': "import { DataGrid } from '@fluentui/react-components';\nimport { Rnd } from 'react-rnd';",
      'src/app/panel.tsx': "import { Button } from '@fluentui/react-components';",
      'src/app/window.tsx': "const Rnd = await import('react-rnd');",
    };
    expect(libraryOffences(planted, LIBRARIES)).toEqual([
      'src/app/panel.tsx imports Fluent UI (@fluentui/react-components) outside src/computer/: use shadcn or AI Elements',
      'src/app/window.tsx imports Fluent UI (react-rnd) outside src/computer/: use shadcn or AI Elements',
    ]);
  });

  it('fails UI built outside a listed part, naming the file', () => {
    const planted = { ...sources, 'src/app/banner.css': '.banner { color: var(--color-text); }' };
    expect(unlistedOffences(planted, COMPONENTS, UNLISTED)).toEqual([
      'src/app/banner.css builds UI outside a listed part: add its row to the components list',
    ]);
  });

  it('fails a hand-built sidebar, naming the part', () => {
    const planted = { ...sources, 'src/app/gate.tsx': '<aside className="sidebar sidebar-collapsed" inert />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      "src/app/gate.tsx copies the phone sidebar (it builds the sidebar): use the one in src/app/sidebar.css",
    ]);
  });

  it('names no copies as exceptions: code-level ones are in the UI-exception register', () => {
    expect(COMPONENTS.flatMap((part) => Object.keys(part.exceptions ?? {}).map((file) => `${part.name}: ${file}`))).toEqual([]);
  });

  it('fails a second menu button, naming the part', () => {
    const planted = { ...sources, 'src/app/second-header.tsx': '<Button variant="outline" size="icon-lg" className="rounded-full"><svg className="sidebar-icon-menu" /></Button>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/second-header.tsx copies the menu button (it draws the menu icon): use the one in src/app/menu-icon.tsx',
    ]);
  });

  it('fails a raw safe-area inset read outside the tokens, naming the part', () => {
    const planted = { ...sources, 'src/app/sheet.css': '.sheet { padding-top: env(safe-area-inset-top); }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/sheet.css copies the tokens (it reads the raw safe-area insets): use the one in src/design-system/tokens.css',
    ]);
  });

  it('fails an inset token applied outside the shell, naming the part', () => {
    const planted = { ...sources, 'src/app/sheet.css': '.sheet { padding-bottom: var(--app-safe-bottom); }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/sheet.css copies the shell (it applies the safe-area inset tokens): use the one in src/app/shell.css',
    ]);
  });

  it('fails a second phone drawer, naming the part', () => {
    const planted = { ...sources, 'src/app/drawer.css': '.app-layout[data-sidebar-swiping] .app-shell { transform: translateX(80vw); }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      "src/app/drawer.css copies the phone sidebar (it moves the sidebar's swipe): use the one in src/app/sidebar.css",
    ]);
  });

  it('fails a second Agent Profile layout, naming the part', () => {
    const planted = { ...sources, 'src/app/sheet.css': '@media (max-width: 640px) { .agent-profile { position: fixed; inset: 0; } }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/sheet.css copies the agent profile (it lays out the Agent Profile): use the one in src/app/agent-profile.css',
    ]);
  });

  it('fails a second fade engine, naming the motion part', () => {
    const planted = { ...sources, 'src/app/banner.tsx': '<AnimatePresence>{shown && <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}</AnimatePresence>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/banner.tsx copies the motion (it fades, shows or swaps on Motion): use the one in src/app/motion.tsx',
    ]);
  });

  it('fails a hand-rolled WAAPI fade outside the motion part, naming it', () => {
    const planted = { ...sources, 'src/app/banner.tsx': 'node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/banner.tsx copies the motion (it fades on the Web Animations API): use the one in src/app/motion.tsx',
    ]);
  });

  it('fails a Motion layout spring outside the motion part, naming it', () => {
    const planted = { ...sources, 'src/app/banner.tsx': '<m.div layout layoutDependency={open} transition={{ layout: move }} />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/banner.tsx copies the motion (it springs a layout on Motion): use the one in src/app/motion.tsx',
    ]);
  });

  it('fails a second phone breakpoint, naming the part', () => {
    const planted = { ...sources, 'src/app/composer-wide.css': '@media (max-width: 767px) { .chat-disclaimer { display: none; } }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/composer-wide.css copies the viewport (it sets its own phone breakpoint): use the one in src/design-system/viewport.ts',
    ]);
  });

  it('fails a width asked of matchMedia outside the viewport, naming the part', () => {
    const planted = { ...sources, 'src/app/chart.tsx': "const wide = () => !window.matchMedia('(max-width: 640px)').matches;" };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/chart.tsx copies the viewport (it asks matchMedia for the viewport): use the one in src/design-system/viewport.ts',
    ]);
  });

  it('fails a raw select box, naming the part', () => {
    const planted = { ...sources, 'src/app/form.tsx': '<select value={day} onChange={pick}><option>Monday</option></select>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/form.tsx copies the select (it builds a raw select box): use the one in src/components/ui/select.tsx',
    ]);
  });

  it('fails a raw label, naming the part', () => {
    const planted = { ...sources, 'src/app/form.tsx': '<label className="form-row"><span>Subject</span><Input /></label>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/form.tsx copies the label (it builds a raw label): use the one in src/components/ui/label.tsx',
    ]);
  });

  it('fails a confirmation built by hand, naming the part', () => {
    const planted = { ...sources, 'src/app/sheet.tsx': 'const [confirmingDelete, setConfirmingDelete] = useState(false);' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/sheet.tsx copies the alert-dialog (it asks to confirm by hand): use the one in src/components/ui/alert-dialog.tsx',
    ]);
  });

  it('fails a hand-built folding section, naming the part', () => {
    const planted = { ...sources, 'src/app/notice.tsx': '<Collapse open={error !== null}><AlertLine>{error}</AlertLine></Collapse>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/notice.tsx copies the collapsible (it folds a section by hand): use the one in src/components/ui/collapsible.tsx',
    ]);
  });

  it('fails a fold tweened on grid rows, naming the part', () => {
    const planted = { ...sources, 'src/app/notice.css': '.notice[data-closed] { grid-template-rows: 0fr; }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/notice.css copies the collapsible (it tweens a fold on grid rows): use the one in src/components/ui/collapsible.tsx',
    ]);
  });

  it('fails a fold written out by hand, naming the motion part', () => {
    const planted = {
      ...sources,
      'src/app/notice.tsx': '<Collapsible open={shown} className="fold"><CollapsibleContent className="collapsible" inert={!shown || undefined}><div>{text}</div></CollapsibleContent></Collapsible>',
    };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/notice.tsx copies the motion (it writes out a fold by hand): use the one in src/app/motion.tsx',
    ]);
  });

  it('fails a second reply renderer, naming the part', () => {
    const planted = { ...sources, 'src/app/tool-reply.tsx': '<CopilotChatAssistantMessage.MarkdownRenderer content={text} />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      "src/app/tool-reply.tsx copies the message (it renders a reply through CopilotKit's message view): use the one in src/components/ui/message.tsx",
    ]);
  });

  it('fails a second set of reply styles, naming the part', () => {
    const planted = { ...sources, 'src/app/tool-reply.css': '.copilotKitAssistantMessage [class*="cpk:prose"] pre { margin: 0; }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      "src/app/tool-reply.css copies the message (it styles CopilotKit's reply): use the one in src/components/ui/message.tsx",
    ]);
  });

  it('fails a hand-built error line, naming the part', () => {
    const planted = { ...sources, 'src/app/second-panel.tsx': '<p className="panel-error" role="alert">{error}</p>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/second-panel.tsx copies the error line (it puts role="alert" on an element of its own): use the one in src/app/alert-line.tsx',
    ]);
  });

  it('fails a stylesheet that draws an error line, naming the part', () => {
    const planted = { ...sources, 'src/app/panel.css': '.panel-error {\n  font-size: var(--font-small);\n  color: var(--color-red);\n}' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/panel.css copies the error line (it styles a small red line): use the one in src/app/alert-line.tsx',
    ]);
  });

  it('fails a second "Couldn\'t open" or newer-version notice, naming the part', () => {
    const planted = {
      ...sources,
      'src/app/artifact-video.tsx': '<p>Couldn&apos;t open {title}: {why}</p><div>Version {newest} arrived while you edited version {held}.</div>',
    };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/artifact-video.tsx copies the error line (it says "Couldn\'t open"): use the one in src/app/alert-line.tsx',
      'src/app/artifact-video.tsx copies the error line (it announces a newer version over edits): use the one in src/app/alert-line.tsx',
    ]);
  });

  it('fails a hand-built load-failed retry, naming the part', () => {
    const planted = { ...sources, 'src/app/second-list.tsx': '<Button type="button" onClick={() => retry((n) => n + 1)}>Try again</Button>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/second-list.tsx copies the load-failed retry (it offers its own Try again): use the one in src/app/load-state.tsx',
    ]);
  });

  it('fails a hand-built menu item, naming the part', () => {
    const planted = { ...sources, 'src/app/account-menu.tsx': '<button className="account-menu-item" onClick={onLogout}>Sign out</button>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/account-menu.tsx copies the dropdown-menu (it builds a menu item by hand): use the one in src/components/ui/dropdown-menu.tsx',
    ]);
  });

  it("fails a hand-built menu item's styles, naming the part", () => {
    const planted = { ...sources, 'src/app/account-menu.css': '.account-menu-sep { height: 1px; }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/account-menu.css copies the dropdown-menu (it styles a hand-built menu item): use the one in src/components/ui/dropdown-menu.tsx',
    ]);
  });

  it('fails a hard-coded layer, in a stylesheet or a class, naming the part', () => {
    const planted = {
      ...sources,
      'src/app/sheet.css': '.sheet { position: fixed; z-index: 500; }',
      'src/app/sheet.tsx': '<div className="fixed inset-0 z-50" />',
    };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/sheet.css copies the tokens (it sets a layer by number): use the one in src/design-system/tokens.css',
      'src/app/sheet.tsx copies the tokens (it sets a layer by number): use the one in src/design-system/tokens.css',
    ]);
  });

  it("leaves a stock part's own layer to it, unedited", () => {
    const layers = COMPONENTS.filter((part) => part.name === 'tokens' || part.name === 'popover');
    expect(oneSourceOffences({ 'src/components/ui/popover.tsx': '<div className="isolate z-50" />' }, layers)).toEqual([]);
  });

  it('leaves the agent computer to Fluent UI, its stock library (ADR 0093)', () => {
    const planted = { ...sources, 'src/computer/clock.tsx': '<Button title="Clock" /><p className="clock-empty">No alarms</p><span role="alert">Lost</span>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([]);
  });

  it('fails a second sheet built on the Drawer primitive, naming the part', () => {
    const planted = { ...sources, 'src/app/task-drawer.tsx': 'import { Drawer } from "@base-ui/react/drawer";' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/task-drawer.tsx copies the sheet (it builds on the Drawer primitive): use the one in src/components/ui/sheet.tsx',
    ]);
  });

  it('fails a second drawing of Marq, naming the part', () => {
    const planted = { ...sources, 'src/app/session-gate.tsx': '<svg><g className="avatar-figure"><circle className="avatar-monocle" /></g></svg>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/session-gate.tsx copies the agent avatar (it draws Marq): use the one in src/app/avatar.tsx',
    ]);
  });

  it('fails a second avatar built on the Avatar primitive, naming the part', () => {
    const planted = { ...sources, 'src/app/account-chip.tsx': 'import { Avatar } from "@base-ui/react/avatar";' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/account-chip.tsx copies the avatar (it builds on the Avatar primitive): use the one in src/components/ui/avatar.tsx',
    ]);
  });

  it.each([
    ['a colour by shadcn\'s name in a class', 'src/app/notice.tsx', '<p className="text-muted-foreground">Saved</p>', "names a colour by shadcn's name, not the tokens'"],
    ['a colour by shadcn\'s name in a sheet', 'src/app/notice.css', '.notice { border-color: var(--border); }', "names a colour by shadcn's name, not the tokens'"],
    ['a hard-coded shadow', 'src/app/notice.tsx', '<p className="shadow-[0_1px_4px_rgb(0_0_0/0.18)]" />', 'hard-codes a shadow'],
    ['a hard-coded corner', 'src/app/notice.tsx', '<p className="rounded-[18px]" />', 'hard-codes a corner'],
    ["a corner from Tailwind's own scale", 'src/app/notice.tsx', '<p className="rounded-2xl" />', 'hard-codes a corner'],
    ['a hard-coded curve', 'src/app/notice.tsx', '<p className="ease-[cubic-bezier(0.32,0.72,0,1)]" />', 'hard-codes a curve'],
  ])('fails %s outside the tokens, naming the part', (_, file, text, what) => {
    expect(oneSourceOffences({ ...sources, [file]: text }, COMPONENTS)).toEqual([
      `${file} copies the tokens (it ${what}): use the one in src/design-system/tokens.css`,
    ]);
  });

  it("lets a stock part keep shadcn's colour names and its own corners", () => {
    const planted = { ...sources, 'src/components/ui/popover.tsx': '<p className="rounded-4xl border-border text-muted-foreground" />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([]);
  });

  it("holds a part of ours beside the stock parts to the tokens, as any other", () => {
    const planted = { ...sources, 'src/components/ui/sheet.tsx': '<div className="sheet rounded-2xl text-muted-foreground" />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      "src/components/ui/sheet.tsx copies the tokens (it names a colour by shadcn's name, not the tokens'): use the one in src/design-system/tokens.css",
      'src/components/ui/sheet.tsx copies the tokens (it hard-codes a corner): use the one in src/design-system/tokens.css',
    ]);
  });

  it('fails a popup that fades by a class of its own, naming the part', () => {
    const planted = { ...sources, 'src/app/second-menu.tsx': '<DropdownMenuContent className="second-menu standard-popup" />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/second-menu.tsx copies the popup surface (it fades a popup by a class of its own): use the one in src/app/popup.css',
    ]);
  });

  it('fails a stock popup given a second skin, naming the part', () => {
    const planted = { ...sources, 'src/app/second-picker.tsx': '<PopoverContent side="top" className="picker rounded-lg">' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/second-picker.tsx copies the popup surface (it skins a stock popup again): use the one in src/app/popup.css',
    ]);
  });

  it('fails a dialog that hides the stock close to build its own, naming the part', () => {
    const planted = {
      ...sources,
      'src/app/second-dialog.tsx': '<DialogContent showCloseButton={false}><DialogClose className="header-btn" aria-label="Close"><X /></DialogClose></DialogContent>',
    };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/second-dialog.tsx copies the dialog (it hides the stock close): use the one in src/components/ui/dialog.tsx',
      'src/app/second-dialog.tsx copies the dialog (it builds a close of its own): use the one in src/components/ui/dialog.tsx',
    ]);
  });

  it('fails a second dialog backdrop, naming the part', () => {
    const planted = { ...sources, 'src/app/second-dialog.css': '[data-slot="dialog-overlay"]:has(~ .popup) {\n  background: var(--scrim);\n}' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/second-dialog.css copies the dialog (it dims the page its own way): use the one in src/components/ui/dialog.tsx',
    ]);
  });

  it('fails a hand-built pill button, naming the part', () => {
    const planted = { ...sources, 'src/app/upload.tsx': '<label className={buttonVariants({ variant: "secondary", className: "upload rounded-full" })}>Upload</label>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/upload.tsx copies the pill button (it rounds a stock button into a pill): use the one in src/components/pill-button.tsx',
    ]);
  });

  it("fails a second composer's add button, naming the part", () => {
    const planted = { ...sources, 'src/app/replica.tsx': '<InputGroupButton size="icon-sm" className="composer-add" aria-label="Add photos & files"><Plus /></InputGroupButton>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      "src/app/replica.tsx copies the composer add button (it draws the composer's +): use the one in src/app/composer-attach.tsx",
    ]);
  });

  it('fails a raw button used as a row or card, naming the part', () => {
    const planted = { ...sources, 'src/app/list.tsx': '<button type="button" className="task-row" onClick={open}>Rates</button>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/list.tsx copies the item (it builds a row or card from a raw button): use the one in src/components/ui/item.tsx',
    ]);
  });

  it("fails a browser tooltip on a button, naming the part", () => {
    const planted = { ...sources, 'src/app/second-header.tsx': '<Button variant="ghost" onClick={() => open(null)} aria-label="Close" title="Close"><XIcon /></Button>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      "src/app/second-header.tsx copies the tooltip (it shows a browser tooltip on a control): use the one in src/components/ui/tooltip.tsx",
    ]);
  });

  it.each([
    ['an input', '<Input aria-label="Memory line 1" disabled={pending} title={pending ? "Available after saving" : undefined} onChange={(event) => edit(event.target.value)} />'],
    ['a textarea', '<Textarea aria-label="Soul" title="Read-only while it saves" />'],
    ['a raw input', '<input type="checkbox" checked={on} title="Turn on" />'],
  ])("fails a browser tooltip on %s, naming the part", (_, text) => {
    expect(oneSourceOffences({ ...sources, 'src/app/form.tsx': text }, COMPONENTS)).toEqual([
      "src/app/form.tsx copies the tooltip (it shows a browser tooltip on a control): use the one in src/components/ui/tooltip.tsx",
    ]);
  });

  it('fails a CSS tooltip, naming the part', () => {
    const planted = { ...sources, 'src/app/menus.css': '.user-menu-trigger[data-tooltip]::after { content: attr(data-tooltip); }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/menus.css copies the tooltip (it draws a CSS tooltip): use the one in src/components/ui/tooltip.tsx',
    ]);
  });

  it('fails a hand-built empty state, naming the part', () => {
    const planted = { ...sources, 'src/app/inbox.tsx': '<p className="inbox-empty">No messages yet.</p>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/inbox.tsx copies the empty (it lays out an empty state by hand): use the one in src/components/ui/empty.tsx',
    ]);
  });

  it('fails a hand-built loading placeholder, naming the part', () => {
    const planted = { ...sources, 'src/app/inbox.css': '.inbox-loading { background: var(--color-line); animation: loadPulse var(--motion-loop) infinite; }' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/inbox.css copies the skeleton (it pulses a loading placeholder): use the one in src/components/ui/skeleton.tsx',
    ]);
  });

  it('fails a pulsing placeholder in Tailwind, naming the part', () => {
    const planted = { ...sources, 'src/app/inbox.tsx': '<div className="h-4 animate-pulse rounded-md bg-(--color-fill)" />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/inbox.tsx copies the skeleton (it pulses in Tailwind): use the one in src/components/ui/skeleton.tsx',
    ]);
  });

  it('fails a hand-built unread dot, naming the part', () => {
    const planted = { ...sources, 'src/app/inbox.tsx': '<span className="inbox-unread-dot" role="img" aria-label="Unread" />' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/inbox.tsx copies the badge (it draws an unread dot by hand): use the one in src/components/ui/badge.tsx',
    ]);
  });

  it('fails a hand-built file chip, naming the part', () => {
    const planted = { ...sources, 'src/app/sent.tsx': '<li className="sent-file"><span className="sent-file-name">a.pdf</span></li>' };
    expect(oneSourceOffences(planted, COMPONENTS)).toEqual([
      'src/app/sent.tsx copies the attachments (it builds a file chip by hand): use the one in src/components/ui/attachments.tsx',
    ]);
  });

  it('fails an exception whose copy is gone, so the list shrinks as copies go', () => {
    const listed = COMPONENTS.map((part) => (part.name === 'menu button' ? { ...part, exceptions: { 'src/app/chat-app.tsx': 'a fixed ticket' } } : part));
    expect(oneSourceOffences(sources, listed)).toEqual([
      'src/app/chat-app.tsx no longer copies the menu button: drop it from the menu button\'s exceptions',
    ]);
  });
});

describe('the components list', () => {
  const intended = readFileSync(path.join(web, 'DESIGN.md'), 'utf8').split('## Intended')[1]?.split('\n## ')[0] ?? '';
  const lines = [...intended.matchAll(/^- (.+)$/gm)].map(([, line = '']) => line);

  it("names each part's one file", () => {
    expect(COMPONENTS.filter((part) => !(part.file in sources))).toEqual([]);
  });

  it('gives each part of ours its stories at 390 and at 1440', () => {
    const unseen = COMPONENTS.filter((part) => part.kind === 'ours' && !(part.stories.some((story) => story.endsWith('-iphone-15')) && part.stories.some((story) => story.endsWith('-1440'))));
    expect(unseen.map((part) => part.name)).toEqual([]);
  });

  // Each bot's Storybook beside this one, `<bot>/ui/web/storybook`. The whole-app stories live in the bots' books, so a
  // checkout that holds botcube alone (its public mirror) can't check their names.
  const repository = path.join(web, '../../..');
  // scripts/ci/reader-tests.mjs selects this test when any of these change.
  const stories = globSync('*/ui/web/storybook/**/*.stories.tsx', { cwd: repository });

  it.skipIf(new Set(stories.map((file) => file.split('/')[0])).size < 2)("names only stories a bot's Storybook has", () => {
    const named = new Set(stories.flatMap((file) => [...readFileSync(path.join(repository, file), 'utf8').matchAll(/\bname: '([^']+)'/g)].map(([, name = '']) => name)));
    const missing = COMPONENTS.flatMap((part) => (part.kind === 'ours' ? part.stories.filter((story) => !named.has(story)).map((story) => `${part.name}: ${story}`) : []));
    expect(missing).toEqual([]);
  });

  it('gives each Intended line of DESIGN.md to one part of ours', () => {
    const owned = COMPONENTS.flatMap((part) => (part.kind === 'ours' ? part.intended : []));
    expect(owned.toSorted()).toEqual(lines.toSorted());
  });
});
