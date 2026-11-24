import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMPONENTS, LIBRARIES, TOKENS, UNLISTED } from './components';
import { libraryOffences, oneSourceOffences, sourcesOf, unlistedOffences } from './one-source';

const web = path.resolve(import.meta.dirname, '../..');
const sources = sourcesOf(web);
const REGISTRY = [TOKENS, ...COMPONENTS];

describe('the one-source check', () => {
  it('passes the app as it is, with its copies as named exceptions', () => {
    expect(oneSourceOffences(sources, REGISTRY)).toEqual([]);
    expect(unlistedOffences(sources, REGISTRY, UNLISTED)).toEqual([]);
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
    expect(unlistedOffences(planted, REGISTRY, UNLISTED)).toEqual([
      'src/app/banner.css builds UI outside a listed part: add its row to the components list',
    ]);
  });

  it('fails a hand-built sidebar, naming the part', () => {
    const planted = { ...sources, 'src/app/gate.tsx': '<aside className="sidebar sidebar-collapsed" inert />' };
    expect(oneSourceOffences(planted, REGISTRY)).toEqual([
      "src/app/gate.tsx copies the phone sidebar (it builds the sidebar): use the one in src/app/sidebar.css",
    ]);
  });

  it('fails a second menu button, naming the part', () => {
    const planted = { ...sources, 'src/app/second-header.tsx': '<Button variant="outline" size="icon-lg" className="rounded-full"><svg className="sidebar-icon-menu" /></Button>' };
    expect(oneSourceOffences(planted, REGISTRY)).toEqual([
      'src/app/second-header.tsx copies the menu button (it draws the menu icon): use the one in src/app/menu-icon.tsx',
    ]);
  });

  it('fails a raw safe-area inset read outside the tokens, naming the part', () => {
    const planted = { ...sources, 'src/app/sheet.css': '.sheet { padding-top: env(safe-area-inset-top); }' };
    expect(oneSourceOffences(planted, REGISTRY)).toEqual([
      'src/app/sheet.css copies the tokens (it reads the raw safe-area insets): use the one in src/design-system/tokens.css',
    ]);
  });

  it('fails an inset token applied outside the shell, naming the part', () => {
    const planted = { ...sources, 'src/app/sheet.css': '.sheet { padding-bottom: var(--app-safe-bottom); }' };
    expect(oneSourceOffences(planted, REGISTRY)).toEqual([
      'src/app/sheet.css copies the shell (it applies the safe-area inset tokens): use the one in src/app/shell.css',
    ]);
  });

  it('fails a second phone drawer, naming the part', () => {
    const planted = { ...sources, 'src/app/drawer.css': '.app-layout[data-sidebar-swiping] .app-shell { transform: translateX(80vw); }' };
    expect(oneSourceOffences(planted, REGISTRY)).toEqual([
      "src/app/drawer.css copies the phone sidebar (it moves the sidebar's swipe): use the one in src/app/sidebar.css",
    ]);
  });

  it('fails a second Agent Profile layout, naming the part', () => {
    const planted = { ...sources, 'src/app/sheet.css': '@media (max-width: 640px) { .agent-profile { position: fixed; inset: 0; } }' };
    expect(oneSourceOffences(planted, REGISTRY)).toEqual([
      'src/app/sheet.css copies the agent profile (it lays out the Agent Profile): use the one in src/app/agent-profile.css',
    ]);
  });

  it('fails an exception whose copy is gone, so the list shrinks as copies go', () => {
    const listed = REGISTRY.map((part) => (part.name === 'menu button' ? { ...part, exceptions: { 'src/app/chat-app.tsx': 'a fixed ticket' } } : part));
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

  it('gives each Intended line of DESIGN.md to one part of ours', () => {
    const owned = COMPONENTS.flatMap((part) => (part.kind === 'ours' ? part.intended : []));
    expect(owned.toSorted()).toEqual(lines.toSorted());
  });
});
