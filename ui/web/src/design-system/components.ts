type Mark = { what: string; pattern: RegExp };
export type Row = {
  name: string;
  file: string;
  marks?: Mark[];
  exceptions?: Record<string, string>;
};
export type Part = Row & (
  | { kind: 'stock'; from: 'shadcn' | 'AI Elements'; stories?: string[] }
  | { kind: 'ours'; stories: string[]; intended: string[] }
);

export type Library = { name: string; kind: 'stock'; from: 'Fluent'; packages: RegExp; under: string };

const WHOLE_APP = ['chat-iphone-15', 'chat-1440'];

const stock = (from: 'shadcn' | 'AI Elements', names: string[], shown: string[] = []): Part[] =>
  names.map((name) => ({ name, kind: 'stock', from, file: `src/components/ui/${name}.tsx`, ...(shown.includes(name) ? { stories: WHOLE_APP } : {}) }));

export const TOKENS: Row = {
  name: 'tokens',
  file: 'src/design-system/tokens.css',
  marks: [{ what: 'reads the raw safe-area insets', pattern: /env\(\s*safe-area-inset-/ }],
};

export const COMPONENTS: readonly Part[] = [
  {
    name: 'shell',
    kind: 'ours',
    file: 'src/app/shell.css',
    stories: [...['', '-sidebar-open', '-agent-profile-open', '-mid-swipe', '-landscape'].map((state) => `chat-runs-under-the-clock${state}-iphone-15`), 'chat-1440'],
    intended: ['On an iPhone the chat runs under the clock, blurred, no band.'],
    marks: [{ what: 'applies the safe-area inset tokens', pattern: /var\(\s*--app-safe-(top|right|bottom|left)\b/ }],
  },
  {
    name: 'menu button',
    kind: 'ours',
    file: 'src/app/menu-icon.tsx',
    stories: ['menu-button-iphone-15', 'menu-button-1440'],
    intended: ['The menu button floats over the chat, always round.'],
    marks: [{ what: 'draws the menu icon', pattern: /["'\s]sidebar-icon-menu["'\s]/ }],
  },
  {
    name: 'phone sidebar',
    kind: 'ours',
    file: 'src/app/sidebar.css',
    stories: [...WHOLE_APP, 'phone-sidebar-is-muse-fig-21-iphone-15', 'phone-sidebar-is-muse-fig-21-1440'],
    intended: ['The phone sidebar is Muse Fig 21: the chat slides right, faded, rounded.'],
    marks: [
      { what: "moves the sidebar's swipe", pattern: /\[data-sidebar-(swiping|dragging)\]/ },
      { what: 'draws the chat strip', pattern: /[.]sidebar-strip-close(?![\w-])/ },
      { what: 'builds the sidebar', pattern: /["'`]sidebar sidebar-(collapsed|expanded)\b/ },
    ],
  },
  {
    name: 'agent profile',
    kind: 'ours',
    file: 'src/app/agent-profile.css',
    stories: [...WHOLE_APP, 'phone-agent-profile-covers-the-chat-iphone-15', 'phone-agent-profile-covers-the-chat-1440'],
    intended: ['The phone Agent Profile covers the chat, full width.'],
    marks: [
      { what: 'lays out the Agent Profile', pattern: /\.agent-profile\s*\{/ },
      { what: "moves the Agent Profile's swipe", pattern: /\[data-profile-(swiping|dragging)\]/ },
    ],
  },
  {
    name: 'bubble',
    kind: 'ours',
    file: 'src/app/chat.css',
    stories: [
      ...WHOLE_APP,
      'marq-may-sit-over-a-bubble-iphone-15',
      'marq-may-sit-over-a-bubble-1440',
      'a-bubbles-shadow-follows-its-corners-iphone-15',
      'a-bubbles-shadow-follows-its-corners-1440',
      'a-wide-table-scrolls-behind-its-edge-fade-iphone-15',
      'a-wide-table-scrolls-behind-its-edge-fade-1440',
    ],
    intended: ['Marq may sit over a bubble.', "A bubble's shadow follows its corners.", 'A wide table scrolls behind its edge fade.'],
  },
  ...stock('shadcn', [
    'alert-dialog', 'badge', 'button', 'button-group', 'collapsible', 'context-menu', 'dialog', 'dropdown-menu', 'field',
    'hover-card', 'input', 'input-group', 'item', 'label', 'popover', 'resizable', 'select', 'separator', 'sheet', 'slider',
    'textarea', 'tooltip',
  ], ['button', 'input-group']),
  ...stock('AI Elements', ['attachments', 'conversation', 'message'], ['conversation', 'message']),
];

export const LIBRARIES: readonly Library[] = [
  {
    name: 'Fluent UI',
    kind: 'stock',
    from: 'Fluent',
    packages: /^(@fluentui\/.+|@fluentui-contrib\/react-(data-grid-react-window|virtualizer|resize-handle|keytips)|react-rnd)$/,
    under: 'src/computer/',
  },
];

const BEFORE_THE_LIST = 'built before ADR 0094; listed when a ticket rebuilds it';

export const UNLISTED: Readonly<Record<string, string>> = Object.fromEntries([
  'src/app/artifacts.css', 'src/app/code-blocks.css', 'src/app/components.css', 'src/app/composer.css', 'src/app/files.css',
  'src/app/globals.css', 'src/app/header.css', 'src/app/list-rows.css', 'src/app/markdown.css', 'src/app/menus.css',
  'src/app/motion.css', 'src/app/plugins.css', 'src/app/scheduled-tasks.css', 'src/app/side-chats.css',
  'src/app/step-sheet.css', 'src/app/waiting-steering.css', 'src/computer/live-browser.css', 'src/computer/styles.css',
  'src/components/file-type-icon.tsx', 'src/components/pill-button.tsx', 'src/components/plotly-chart.tsx',
  'src/components/ui/trace.tsx',
].map((file) => [file, BEFORE_THE_LIST]));
