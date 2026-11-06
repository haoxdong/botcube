# BotCube Design System

Consistent, clean, quiet, the way Apple designs: a screen looks like the platform's own app (iPhone on a phone,
ChatGPT's Mac app on a desktop) and keeps only what is essential. The system shrinks over time, never grows: each
colour, size and weight has one job, and a new one must first merge or drop another.

The values live in `:root` of `src/app/tokens.css`, which `globals.css` imports first, with the why in its comments. `src/app/design-system.test.ts`
locks the set below: a colour, size, weight, line-height, radius or shadow outside it fails the build. Mockups live
on the Design canvas (https://claude.ai/artifact/L1AfVQ3SBtUs86FfBrXER6).

Components are plain CSS on these tokens. Tailwind's `@theme inline` and shadcn's colour names map onto them; there
is no dark theme, and a palette that `shadcn add` writes into `globals.css` is deleted.

`pnpm lint` enforces this with Stylelint (`stylelint.config.mjs`); each exception carries an inline disable with its
reason, and a new one is added here first.

## Colour

Ten colours. The greys and white are Radix Colors' pure `gray`; blue, red and green are Radix steps too. Measured
against Muse and dots, which each use two fill greys and two text greys.

| Token        | Value     | Job                                                                               |
| ------------ | --------- | --------------------------------------------------------------------------------- |
| `text`       | gray-12   | Text, primary buttons, the tooltip                                                |
| `text-muted` | gray-11   | Secondary lines, placeholders, labels, icons                                      |
| `fill`       | gray-3    | Resting surfaces: secondary buttons, icon tiles, pills, code in a reply           |
| `line`       | gray-4    | Borders, separators, the open row, hover on a fill, scrollbars, disabled controls |
| `white`      | `#fff`    | Marq's bubble, the composer, cards, menus, fields, the desktop sidebar            |
| `canvas`     | gray-2    | The chat's canvas, a slight grey under its white cards                            |
| `blue`       | blue-11   | Meaning: links, selection, focus, checkmarks; a document's file label             |
| `bubble`     | `#d6e4f3` | The user's bubble, a pale tint of Marq's blue                                     |
| `red`        | red-11    | Errors, failed rows, Delete; a PDF's or a deck's file label                       |
| `green`      | green-9   | Connected; a spreadsheet's file label                                             |

- A hover takes the next grey up: `fill` on white, `line` on a fill.
- A status shows in its text colour on `fill`; there are no soft tints.
- Light and shade, black and white at a fixed opacity: `--scrim` under sheets and overlays, `--frost` for glass.
- The agent's colours (`--agent-body`, `-outline`, `-deep`, `-deepest`, from Marq's avatar) are for its
  illustrations only: the Soul and Memory cards and the Computer's desktop. A cartridge `theme` may bring its own.

## Type

The system font (SF Pro on Apple) and `--font-code` (Menlo, at 0.9em of the text beside it). Four sizes, each its
desktop size in `:root` and iOS's text style in the 640px query; name the role, never a pixel size.

| Token   | Desktop | Phone (iOS)      | Job                                                               |
| ------- | ------- | ---------------- | ----------------------------------------------------------------- |
| `title` | 18      | 22 (Title 2)     | A screen's title, an identity's name                              |
| `body`  | 14      | 17 (Body)        | Everything read: messages, rows, menus, fields; headings semibold |
| `small` | 13      | 15 (Subheadline) | Controls, secondary lines, errors, code, the Worklog              |
| `label` | 12      | 13 (Footnote)    | Uppercase labels, badges, citations, the disclaimer               |

- Two weights: `regular` 400 and `semibold` 600 for titles and headings. Buttons, controls and the open sidebar row
  stay regular.
- Two line-heights: `--leading` 1.3 for all text; `--leading-loose` 1.5 for reading blocks (code, a Worklog note, the
  welcome, a file's text).
- One tracking: `--tracking-caps` 0.04em, for uppercase labels only.

Code font: `--font-code`, at `--font-code-size` (0.9 of the text beside it) inline and in the Worklog.

## Shape

**Shadows**, two: `rest` for a white surface on the page (the composer, a file card, the header's capsule on hover);
`float` for what floats over it (menus, sheets, the focused composer, the phone's chat card).

**Radius**, six: `sm` 4 inline code and small marks; `md` 8 icon buttons, menu items, the Computer's window; `lg` 12
fields, menus, grouped lists; `xl` 20 bubbles, the composer, sheets, file cards; `screen` 64 a panel that reaches an
iPhone's rounded screen corner; `pill` buttons, pills, tabs. The desktop chat stage meets no rounded corner and stays
square.

**Motion**: calm and continuous, as iOS moves: nothing snaps, jumps or shifts under the reader. Two durations, one
curve, one loop, locked by `design-system.test.ts`:

| Token            | Value                            | Job                                                                                                                                |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--motion-quick` | 150ms                            | What changes in place: hover and press, a menu or chip fading in or out                                                            |
| `--motion-move`  | 300ms                            | What moves or resizes: sidebar, panels, sheets, expanding a Worklog, the composer growing, the Computer zooming, a thread arriving |
| `--ease`         | `cubic-bezier(0.32, 0.72, 0, 1)` | Every transition: iOS's sheet curve, fast out of the gate, settling softly                                                         |
| `--motion-loop`  | 1.6s                             | The one ambient loop: the Worklog shimmer, a loading pulse, Marq's bob                                                             |

- Animate `transform` and `opacity`; a height that opens (a Worklog, a step, the composer) animates its own height
  while the rest of the column follows, never a jump. Whatever enters fades in; whatever leaves fades out before it
  unmounts.
- A finger drives motion with none of its own; on release the surface settles with `--motion-move` and `--ease`. A tap
  plays the same settle.
- New content keeps the reading position still.
- Full motion always, Reduce Motion or not: BotCube has one experience, the full one (the maintainer, 2026-11-03).
  `design-system.test.ts` fails on any `prefers-reduced-motion`, `reducedMotion` or `useReducedMotion` in UI sources.

**Spacing**: a 4px grid, 2px steps inside a row. Screens pad 20px at the side on a phone, 16–24px on a desktop;
sections sit 24–28px apart, rows 4–12px.

## Components

All but the File page and Close are React components in `src/components/ui/` over one CSS rule each; a cartridge
imports them from `botcube-ui-web/ui`. Behaviour is pinned by `globals.test.tsx` and the Storybook play tests.

- **Bubbles**: up to 90% of the column, `xl`, `text` on `bubble` for the user and on `white` in `rest` for Marq, both on
  `canvas`. Notes inside a Turn wear none. A table in Marq's reply sits flat, only row lines, as wide as its
  content.
  - A wrapped bubble hugs its widest line, measured with Pretext (`bubble-width.ts`). One reply is one bubble: tables,
    code and diagrams stay inside it, and anything wider than the bubble scrolls sideways within it.
  - One line is an exact pill, twice `xl` tall (40px): the padding is `xl` less half a line, 16px at the sides.
  - Bubbles in a row from one sender, nothing between them, stack 4px apart; where two meet, the sender's side is `sm`.
- **Chat header**: Marq centred over the scrolling messages, his name in a frosted capsule; "is working" in `small`
  `text-muted` while he bobs behind a laptop lid (memo 0049, Muse). Messages fade under it on a desktop and run under
  iOS Safari's own fade on a phone.
- **Safe zones**: on an iPhone the chat runs edge to edge, under the status bar at the top and on past the composer
  under Safari's toolbar and the home indicator at the bottom, both under Safari's own blur. No band of its own at
  either edge.
- **Composer**: white in `rest`, `float` on focus, its only focus mark. ChatGPT's one row on a desktop, the text
  across the top once it wraps, the picker always shown. On a phone, one row at rest: the text with Send, no model
  picker. Tapping it opens two rows even when empty: the text over the picker and Send, with 44px targets (the Claude
  app's composer). No disclaimer under a phone's composer; a desktop keeps it. On a desktop the composer is 24px
  wider than the messages' text, 12px past it at each side, and `canvas` is opaque from its middle down, so a scrolled
  reply never shows under it.
- **Sidebar**: icon then label, the open row a `line` pill. Shut by default on a desktop and docked beside the chat
  with a hairline seam; the phone drawer follows Muse Fig 21.
- **List row**: a round icon tile, a title over muted lines (Muse Figs 13, 15): Activity, Scheduled, Plugins,
  Sign-ins.
- **Sheet**: an iOS sheet over the scrim, a grabber on phones; full-width actions, a destructive one confirming first.
- **Settings rows**: Codex's Schedule a task, a card of label-left, value-right rows.
- **Button**: a pill, secondary on `fill` by default, primary in `text`, Delete in `red` text. **Close** and **Back**
  are round buttons of the same height.
- **Field**: a `line`-bordered white box under its label.
- **Status pill**: its colour's text on `fill`.
- **Files**: a file is its type's icon from react-file-icon, a folded page with a label in its type's colour (`red`
  PDF and deck, `green` sheet, `blue` document, `text-muted` the rest), the same in Files, the composer, a sent
  message and a reply's card. An image is its own thumbnail, ChatGPT's square one in the composer and once sent.
- **Worklog**: a Turn's work under one head, "Working · 9s"; one grey shimmer sweeps the live line, never colour.
- **Agent files**: Soul and Memory cards side by side in the agent's colours (Muse Fig 16), white type at 4.5:1;
  an opened file is an iOS Settings grouped list.

## Exceptions

Each is a real-world object the system doesn't draw, and the lock test names each one:

- Marq's avatar is an illustration in the agent's colours.
- The Computer's simulated desktop scales with its screen (`cqw`); Chrome's dock icon keeps Google's colours.
- The composer's text stays 16px on a touch tablet, so iOS doesn't zoom into it.
- Code blocks take Shiki's `github-light` syntax colours: code is a real-world object the system doesn't draw.
