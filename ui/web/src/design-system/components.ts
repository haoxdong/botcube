// The registry's components list (ADR 0094); its format is in this folder's README. A new or changed row needs the
// maintainer's review (.github/CODEOWNERS). one-source.test.ts fails a part built outside its row's one file.

import { PHONE_MAX_WIDTH } from './viewport';

/** What a copy of a part looks like in a stylesheet or component, so the check can find it; `within`, the sources it
    looks in, by path from botcube/ui/web, every one when absent. */
type Mark = { what: string; pattern: RegExp; within?: RegExp };
export type Row = {
  name: string;
  /** Its one file, from botcube/ui/web. */
  file: string;
  marks?: Mark[];
  /** Today's copies, by file, with the ticket that removes each; they leave the list as those land. */
  exceptions?: Record<string, string>;
};
export type Part = Row & (
  | { kind: 'stock'; from: 'shadcn' | 'AI Elements'; stories?: string[] }
  | { kind: 'ours'; stories: string[]; intended: string[] }
);

/** A stock library outside shadcn and AI Elements, imported only `under` its folder, whose files are its stock. */
export type Library = { name: string; kind: 'stock'; from: 'Fluent'; packages: RegExp; under: string };

const WHOLE_APP = ['chat-iphone-15', 'chat-1440'];

// The stock parts, by where each comes from: shadcn's parts keep their own colour names and corners, which tokens.css
// maps onto the tokens.
const SHADCN = [
  'alert', 'alert-dialog', 'avatar', 'badge', 'button', 'button-group', 'collapsible', 'context-menu', 'dialog', 'dropdown-menu', 'empty',
  'field', 'hover-card', 'input', 'input-group', 'item', 'label', 'popover', 'resizable', 'select', 'separator',
  'skeleton', 'slider', 'textarea', 'tooltip', 'trace',
];
const AI_ELEMENTS = ['attachments', 'conversation', 'message'];
/** A stock part's one file. */
const stockFile = (name: string) => `src/components/ui/${name}.tsx`;
// Ours, not stock: every file but the stock parts' own, wherever it sits, so a part of ours beside them (the sheet) keeps
// to the tokens too.
const OURS = new RegExp(`^(?!(?:${[...SHADCN, ...AI_ELEMENTS].map((name) => stockFile(name).replaceAll('.', '\\.')).join('|')})$)`);
// shadcn's colour names, which tokens.css maps onto ours for the stock parts and CopilotKit: ours name colours by the
// tokens. `text-muted` is our token's own name.
const SHADCN_COLOUR = '(?:background|foreground|(?:card|popover|primary|secondary|muted|accent)(?:-foreground)?|destructive|border|input|ring)';
// A width query at any other three-digit px value than the phone's last and the desktop's first, in media-query or
// Tailwind arbitrary-variant form.
const [phoneEdge, desktopEdge] = [PHONE_MAX_WIDTH, PHONE_MAX_WIDTH + 1];
const OTHER_WIDTH = `(?!(?:${phoneEdge}|${desktopEdge})px)\\d{3}(?:\\.\\d+)?px`;

/** Stock parts, each with its marks, and with the whole-app stories for those `shown` there. */
const stock = (from: 'shadcn' | 'AI Elements', names: string[], marked: Record<string, Pick<Row, 'marks' | 'exceptions'>> = {}, shown: string[] = []): Part[] =>
  names.map((name) => ({ name, kind: 'stock', from, file: stockFile(name), ...marked[name], ...(shown.includes(name) ? { stories: WHOLE_APP } : {}) }));

/** What a hand-built copy of a stock part looks like. */
const STOCK_MARKS: Record<string, Pick<Row, 'marks' | 'exceptions'>> = {
  'alert-dialog': { marks: [{ what: 'asks to confirm by hand', pattern: /role=["']alertdialog["']|\bconfirming[A-Z]\w*/ }] },
  attachments: { marks: [{ what: 'builds a file chip by hand', pattern: /(?<![\w-])sent[-]file(-text|-name|-kind|-error)?(?![\w-])/ }] },
  avatar: { marks: [{ what: 'builds on the Avatar primitive', pattern: /@base-ui\/react\/avatar/ }] },
  dialog: {
    marks: [
      { what: 'hides the stock close', pattern: /showCloseButton=\{false\}/ },
      { what: 'builds a close of its own', pattern: /<[\w.]*Close\b[^>]*\baria-label=["']Close["']/ },
      // The popup surface sets every dialog's one backdrop.
      { what: 'dims the page its own way', pattern: /\[data-slot="(alert-)?dialog-overlay"\][^{]*\{[^}]*\b(background|backdrop-filter)\s*:/, within: /^(?!src\/app\/popup\.css$)/ },
    ],
  },
  badge: { marks: [{ what: 'draws an unread dot by hand', pattern: /<(?:span|div|i|b)\b[^>]*\bunread/i }] },
  collapsible: {
    marks: [
      { what: 'folds a section by hand', pattern: /<Collapse[\s>]/ },
      { what: 'tweens a fold on grid rows', pattern: /grid-template-rows:\s*0fr/ },
    ],
  },
  'dropdown-menu': {
    marks: [
      { what: 'builds a menu item by hand', pattern: /className=\{?["'`][^"'`]*(?<![\w/-])[\w-]*menu-(item|sep)(?![\w-])|role=["']menuitem["']/ },
      { what: 'styles a hand-built menu item', pattern: /\.[\w-]*menu-(item|sep)(?![\w-])/ },
    ],
  },
  empty: {
    marks: [{ what: 'lays out an empty state by hand', pattern: /<(?:motionElement\.)?(?:div|p|span|section)\b[^>]*\bclassName=["'`][^"'`]*-empty(?![\w-])/ }],
  },
  item: {
    marks: [{ what: 'builds a row or card from a raw button', pattern: /<button\b[^>]*\bclassName=\{?["'`][^"'`]*-(row|card|item-btn)\b/ }],
  },
  // A label styled as a button (the picture field's Upload) is a button, not a field's label.
  label: { marks: [{ what: 'builds a raw label', pattern: /<(label)\b(?![^>]*[bB]uttonVariants)/ }] },
  select: { marks: [{ what: 'builds a raw select box', pattern: /<(select)\b/ }] },
  skeleton: {
    marks: [
      { what: 'pulses a loading placeholder', pattern: /(?<![\w-])animation(?:-name)?\s*:[^;]*[pP]ulse/ },
      { what: 'pulses in Tailwind', pattern: /(?<![\w-])animate-[p]ulse(?![\w-])/ },
    ],
  },
  tooltip: {
    marks: [
      { what: 'draws a CSS tooltip', pattern: /data-tooltip[\]=)]/ },
      // A control: a button, a trigger, or a stock or raw form control.
      {
        what: 'shows a browser tooltip on a control',
        pattern: /<(?:Button|button|MenuButton|SidebarRow|[A-Z]\w*Trigger|Input|Textarea|InputGroup(?:Input|Textarea|Button)|Slider|Checkbox|Switch|input|textarea|select)\b(?:[^<>]|=>)*?\stitle=/,
      },
    ],
  },
  // The one reply part: MessageResponse (Streamdown). CopilotKit stays the transport; its message view is not used.
  // Each pattern's [A] keeps this file from matching itself.
  message: {
    marks: [
      { what: "renders a reply through CopilotKit's message view", pattern: /<CopilotChat[A]ssistantMessage\b|CopilotChat[A]ssistantMessage\.MarkdownRenderer/ },
      { what: "styles CopilotKit's reply", pattern: /copilotKit[A]ssistantMessage/ },
    ],
  },
};

export const COMPONENTS: readonly Part[] = [
  {
    name: 'viewport',
    kind: 'ours',
    file: 'src/design-system/viewport.ts',
    stories: [...WHOLE_APP, 'artifact open across the phone breakpoint', 'chat-steering-breakpoint'],
    intended: [],
    marks: [
      { what: 'sets its own phone breakpoint', pattern: new RegExp(`\\((?:max|min)-width:\\s*${OTHER_WIDTH}\\)|\\b(?:max|min)-\\[${OTHER_WIDTH}\\]:`) },
      { what: 'asks matchMedia for the viewport', pattern: /matchMedia\(\s*(?:[A-Z_]*_QUERY\b|['"`]\((?:max|min)-width)/ },
    ],
  },
  {
    name: 'tokens',
    kind: 'ours',
    file: 'src/design-system/tokens.css',
    stories: [
      ...WHOLE_APP, 'a-menu-opens-over-the-artifact-sheet-iphone-15', 'a-menu-opens-over-the-artifact-sheet-1440',
      'a-menu-opens-over-the-agent-profile-iphone-15', 'a-menu-opens-over-the-agent-profile-1440', 'chat-scrolled-safe-area',
    ],
    intended: [],
    marks: [
      { what: 'reads the raw safe-area insets', pattern: /env\(\s*safe-area-inset-/ },
      // The layers: a z-index names a --layer-* token, in a stylesheet, a style or a Tailwind class (`z-(--layer-raised)`).
      { what: 'sets a layer by number', pattern: /z-index:\s*-?\d|zIndex:\s*['"]?-?\d|(?<![\w-])-?z-(\d|\[-?\d)/ },
      {
        what: "names a colour by shadcn's name, not the tokens'",
        pattern: new RegExp(`(?<![\\w\`-])(?!text-muted(?![\\w-]))(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|divide|placeholder|caret|decoration|from|via|to)-${SHADCN_COLOUR}(?![\\w-])|var\\(--${SHADCN_COLOUR}\\)`),
        within: OURS,
      },
      { what: 'hard-codes a shadow', pattern: /(?<![\w-])shadow-\[|\bboxShadow\s*:/, within: OURS },
      { what: 'hard-codes a corner', pattern: /(?<![\w-])rounded(?:-[trblse]{1,2})?-(?:\[|(?:xs|2xl|3xl|4xl)(?![\w-]))|\bborderRadius\s*:/, within: OURS },
      { what: 'hard-codes a curve', pattern: /cubic-bezier\(|(?<![\w-])ease-\[|\bease:\s*\[/ },
    ],
  },
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
    stories: [
      ...WHOLE_APP, 'phone-sidebar-is-muse-fig-21-iphone-15', 'phone-sidebar-is-muse-fig-21-1440', 'sidebar', 'sidebar-shut', 'sidebar positions',
      'sidebar-unread', 'sidebar-unread-shut', 'sidebar-list-collapsed', 'sidebar-empty', 'sidebar-show-more', 'sidebar-load-failed',
      'drawer animates moving panels only', 'visual drawer',
    ],
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
    stories: [
      ...WHOLE_APP, 'phone-agent-profile-covers-the-chat-iphone-15', 'phone-agent-profile-covers-the-chat-1440', 'profile-swipe',
      'profile-closed-by-tap', 'profile-long-character', 'edit-profile', 'personalization', 'sign-ins', 'visual profile', 'profile-personalization',
      'profile-computer', 'a-menu-opens-over-the-agent-profile-iphone-15', 'a-menu-opens-over-the-agent-profile-1440',
    ],
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
      'chat-one-liners',
      'chat-in-a-row',
      'artifact turn one bubble',
      'visual table bubble',
      'visual chart bubble',
    ],
    intended: ['Marq may sit over a bubble.', "A bubble's shadow follows its corners.", 'A wide table scrolls behind its edge fade.'],
  },
  {
    name: 'motion',
    kind: 'ours',
    file: 'src/app/motion.tsx',
    stories: [
      ...WHOLE_APP, 'a streamed reply enters in one motion', 'artifact pane geometry glides',
      'motion budget: worklog opens', 'motion budget: worklog closes, scrolled up', 'motion budget: worklog step opens',
      'motion budget: worklog step closes',
    ],
    intended: [],
    marks: [
      { what: 'fades, shows or swaps on Motion', pattern: /\b(Animate[P]resence|presence[M]otion|zoom[M]otion|use[I]sPresent|use[P]resence|use[A]nimationControls)\b/ },
      { what: 'fades on the Web Animations API', pattern: /\.animate\(\s*\[\s*\{\s*opacity\b/ },
      { what: 'springs a layout on Motion', pattern: /\b(layout[D]ependency|layout[I]d|use[S]pring)\b|\blayout:\s*true\b/ },
      { what: 'writes out a fold by hand', pattern: /<Collapsible\b[^>]*\bclassName=["']fold["']|<CollapsibleContent\b[^>]*\bclassName=["']collapsible["']/ },
    ],
  },
  {
    name: 'pill button',
    kind: 'ours',
    file: 'src/components/pill-button.tsx',
    stories: [...WHOLE_APP, 'scheduled-actions', 'sign-ins', 'edit-profile', 'gate-parked'],
    intended: [],
    marks: [{ what: 'rounds a stock button into a pill', pattern: /buttonVariants\(\{[^)]*rounded-full|["'\s]pill-button["'\s]/ }],
  },
  {
    name: 'composer add button',
    kind: 'ours',
    file: 'src/app/composer-attach.tsx',
    stories: [...WHOLE_APP, 'composer-add-menu', 'composer-shadow', 'visual composer'],
    intended: [],
    marks: [{ what: "draws the composer's +", pattern: /["'\s]composer-add["'\s]/ }],
  },
  {
    name: 'error line',
    kind: 'ours',
    file: 'src/app/alert-line.tsx',
    stories: [...WHOLE_APP, 'composer-file-upload-failed', 'reply-file-card-failed', 'memory-save-failed-390', 'memory-save-failed-1440', 'scheduled-failed', 'sidebar-load-failed'],
    intended: [],
    marks: [
      // On one line, so stock parts that spell out their own role (Alert, FieldError) across lines are not copies.
      { what: 'puts role="alert" on an element of its own', pattern: /<[a-z][\w.]*\b[^>\n]*\brole="alert"/ },
      {
        what: 'styles a small red line',
        pattern: /\{[^}]*(font-size:\s*var\(--font-small\)[^}]*color:\s*var\(--color-red\)|color:\s*var\(--color-red\)[^}]*font-size:\s*var\(--font-small\))/,
      },
      { what: 'says "Couldn\'t open"', pattern: /Couldn(&apos;|')t open/ },
      { what: 'announces a newer version over edits', pattern: /arrived while you edited\s+version/ },
    ],
  },
  {
    name: 'load-failed retry',
    kind: 'ours',
    file: 'src/app/load-state.tsx',
    stories: [...WHOLE_APP, 'artifact library unavailable'],
    intended: [],
    marks: [{ what: 'offers its own Try again', pattern: /Try again<\/Button>/ }],
  },
  {
    name: 'agent avatar',
    kind: 'ours',
    file: 'src/app/avatar.tsx',
    stories: [
      ...WHOLE_APP, 'capsule stays with avatar through every panel', 'marq-may-sit-over-a-bubble-iphone-15', 'marq-may-sit-over-a-bubble-1440',
    ],
    intended: [],
    marks: [{ what: 'draws Marq', pattern: /["'\s]avatar-(figure|monocle|monocle-chain|laptop)["'\s]/ }],
  },
  {
    name: 'popup surface',
    kind: 'ours',
    file: 'src/app/popup.css',
    stories: [
      ...WHOLE_APP, 'account-menu', 'account-menu fades in place', 'account-menu by keyboard', 'side-chat-row-menu', 'composer-add-menu', 'files-menu',
      'artifact pane download menu', 'model-picker',
    ],
    intended: [],
    marks: [
      { what: 'fades a popup by a class of its own', pattern: /className[=:]\s*"[^"]*\bstandard-popup\b/ },
      { what: 'skins a stock popup again', pattern: /<(Popover|DropdownMenu|ContextMenu|Select|HoverCard)Content\b[^>]*\bclassName="[^"]*\b(rounded|bg|ring|border)-/ },
    ],
  },
  {
    // Ours, not stock: shadcn's sheet is a Dialog; this is one built on Base UI's Drawer, with its snap points and height.
    name: 'sheet',
    kind: 'ours',
    file: 'src/components/ui/sheet.tsx',
    stories: [
      ...WHOLE_APP, 'scheduled-sheet', 'scheduled-sheet-dismiss', 'worklog step sheet', 'a-menu-opens-over-the-artifact-sheet-iphone-15',
      'a-menu-opens-over-the-artifact-sheet-1440',
    ],
    intended: [],
    marks: [{ what: 'builds on the Drawer primitive', pattern: /@base-ui\/react\/drawer/ }],
  },
  ...stock('shadcn', SHADCN, STOCK_MARKS, ['button', 'input-group']),
  ...stock('AI Elements', AI_ELEMENTS, STOCK_MARKS, ['conversation', 'message']),
];

// The agent computer's Fluent UI v9, its approved add-ons and react-rnd (ADR 0093, ADR 0094).
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

/** Today's UI files outside any row, until a ticket rebuilds each as a listed part. */
export const UNLISTED: Readonly<Record<string, string>> = Object.fromEntries([
  'src/app/artifacts.css', 'src/app/code-blocks.css', 'src/app/components.css', 'src/app/composer.css', 'src/app/files.css',
  'src/app/globals.css', 'src/app/header.css', 'src/app/list-rows.css', 'src/app/markdown.css', 'src/app/menus.css',
  'src/app/plugins.css', 'src/app/scheduled-tasks.css', 'src/app/side-chats.css',
  'src/app/step-sheet.css', 'src/app/waiting-steering.css', 'src/computer/live-browser.css', 'src/computer/styles.css',
  'src/components/file-type-icon.tsx', 'src/components/plotly-chart.tsx',
].map((file) => [file, BEFORE_THE_LIST]));
