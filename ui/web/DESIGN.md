# BotCube Design System

Consistent, clean, quiet, the way Apple designs: a screen feels and moves like the platform's own app (iOS on a
phone, macOS on a desktop) and keeps only what is essential. The products we measure against are the ChatGPT and
Claude apps on the same platform. Every value has one job. The system shrinks over time, never grows: a new value
must first merge or drop another.

The values live in `:root` of `src/app/tokens.css`, with the why in its comments. Nothing here is advisory:
`src/app/design-system.test.ts` fails on a value outside the set, and Stylelint (`pnpm lint`) keeps raw values out of
components. An exception carries an inline disable with its reason and is listed under Exceptions first. Components
are plain CSS on these tokens; Tailwind's `@theme inline` and shadcn's colour names map onto them, and there is no
dark theme.

| Kind    | Count | Values                                                                                    |
| ------- | ----- | ----------------------------------------------------------------------------------------- |
| Colour  | 10    | `text`, `text-muted`, `fill`, `line`, `white`, `canvas`, `blue`, `bubble`, `red`, `green` |
| Type    | 4     | `title` 18, `body` 14, `small` 13, `label` 12 (desktop px)                                |
| Weight  | 2     | `regular` 400, `semibold` 600                                                             |
| Leading | 2     | `--leading` 1.3, `--leading-loose` 1.5                                                    |
| Shadow  | 2     | `rest`, `float`                                                                           |
| Radius  | 6     | `sm` 4, `md` 8, `lg` 12, `xl` 20, `screen` 64, `pill`                                     |
| Motion  | 4     | `--motion-quick` 150ms, `--motion-move` 300ms, `--ease`, `--motion-loop` 1.6s             |
| Spacing | 7     | `--space-4` to `--space-32` on a 4px grid                                                 |

## Motion

Motion is calm and continuous, as iOS and macOS move. Four rules, each checkable in a frame strip:

- **Nothing snaps.** Every change of size, place or presence settles with a spring, never a cut or a bounce.
- **The finger leads.** A drag moves the surface with the finger; on release, and on a tap, it settles with the move
  spring.
- **Interrupted motion carries on** from where it is, at the speed it had.
- **What you read stays put.** New content arrives without moving the line being read.

`--motion-quick` settles what changes in place, fades included; `--motion-move` what moves or resizes; `--ease`
serves CSS transitions not yet on the spring; `--motion-loop` is the one ambient loop (the Worklog shimmer, Marq's
bob). Only `transform` and `opacity` animate, each moving element has one owner, and an exiting element stays until
its fade ends. Full motion always, Reduce Motion or not (the maintainer, 2026-11-03). A change to motion ships with a
frame strip at 390 and 1440 px beside today's.

## Spacing

Seven steps, each a space token named by its px; 2 and 6 only nudge inside one row. A gap is set by what the two
things are to each other, never by which element happens to sit above, so a new row between them takes the same gap.

| Step | Job                                                                               |
| ---- | --------------------------------------------------------------------------------- |
| 4    | Bubbles in a row from one sender; a note under its bubble ("Send now", a time)    |
| 8    | Icon to its label; a heading to its text in a reply; menu and sidebar rows        |
| 12   | A question to its answer; one waiting message to the next; blocks in a reply      |
| 16   | A table, code block or card clear of the text around it; a desktop's side padding |
| 20   | A phone's side padding; a heading clear of the text above it                      |
| 24   | Sections of a screen or sheet; the desktop chat column's side padding             |
| 32   | One Turn to the next: Marq's reply, or its Worklog, to the user's next message    |

## Colour

Radix Colors' pure `gray` for the greys, Radix steps for blue, red and green.

| Token        | Value     | Job                                                                     |
| ------------ | --------- | ----------------------------------------------------------------------- |
| `text`       | gray-12   | Text, primary buttons, the tooltip                                      |
| `text-muted` | gray-11   | Secondary lines, placeholders, labels, icons                            |
| `fill`       | gray-3    | Resting surfaces: secondary buttons, icon tiles, pills, code in a reply |
| `line`       | gray-4    | Borders, separators, the open row, hover on a fill, disabled controls   |
| `white`      | `#fff`    | Marq's bubble, the composer, cards, menus, fields, the desktop sidebar  |
| `canvas`     | gray-2    | The chat's canvas, a slight grey under its white cards                  |
| `blue`       | blue-11   | Meaning: links, selection, focus, checkmarks; a document's file label   |
| `bubble`     | `#d6e4f3` | The user's bubble, a pale tint of Marq's blue                           |
| `red`        | red-11    | Errors, failed rows, Delete; a PDF's or a deck's file label             |
| `green`      | green-9   | Connected; a spreadsheet's file label                                   |

- A hover takes the next grey up: `fill` on white, `line` on a fill.
- A status shows in its own text colour on `fill`, never a soft tint; only an Artifact's card is tinted.
- `--scrim` darkens under sheets and overlays; `--frost` is glass. `--agent-body`, `--agent-outline`,
  `--agent-deep` and `--agent-deepest` are for Marq's illustrations only.

## Type

The system font (SF Pro on Apple) and `--font-code` (Menlo, at `--font-code-size`, 0.9em of the text beside it). Each
size is its desktop size in `:root` and iOS's text style in the 640px query; name the role, never a pixel size.

| Token   | Desktop | Phone (iOS)      | Job                                                               |
| ------- | ------- | ---------------- | ----------------------------------------------------------------- |
| `title` | 18      | 22 (Title 2)     | A screen's title, an identity's name                              |
| `body`  | 14      | 17 (Body)        | Everything read: messages, rows, menus, fields; headings semibold |
| `small` | 13      | 15 (Subheadline) | Controls, secondary lines, errors, code, the Worklog              |
| `label` | 12      | 13 (Footnote)    | Uppercase labels, badges, citations, the disclaimer               |

- `semibold` is for titles and headings only; buttons, controls and the open sidebar row stay `regular`.
- `--leading-loose` is for reading blocks: code, a Worklog note, the welcome, a file's text.
- `--tracking-caps` (0.04em) is for uppercase labels only.

## Shape

- **Shadow:** `rest` for a white surface on the page (the composer, a file card); `float` for what floats over it
  (menus, sheets, the focused composer, the phone's chat card).
- **Radius:** `sm` inline code and small marks; `md` icon buttons, menu items; `lg` fields, menus, grouped lists;
  `xl` bubbles, the composer, sheets, file cards; `screen` a panel that reaches an iPhone's screen corner; `pill`
  buttons, pills, tabs. The desktop chat stage meets no rounded corner and stays square.

## Components

Each part copies its reference and states only where it differs. The chat parts follow the ChatGPT and Claude apps;
the rest follow iOS on a phone and macOS on a desktop. All but the File page and Close are React components in
`src/components/ui/` over one CSS rule each, which a cartridge imports from `botcube-ui-web/ui`; behaviour is pinned
by `src/app/globals.test.tsx` and the Storybook play tests.

- **Bubbles:** up to 90% of the column, `xl`, hugging the widest line (`src/app/bubble-width.ts`); one line is an exact
  pill, 40px tall. The user's is `text` on `bubble`; Marq's is `text` on `white` in `rest`. One reply is one bubble:
  tables, code, diagrams and its Artifacts stay inside and scroll sideways when wider. A table sits flat, row lines
  only. Where two bubbles from one sender meet, that side's corner is `sm`.
- **Waiting messages:** a message sent during a Turn is an ordinary bubble at the thread's end with "Send now" under
  it; hover or tap swaps that for Edit and Remove (Claude Code).
- **Worklog:** a Turn's work under one head, "Working · 9s"; one grey shimmer sweeps the live line, never colour.
- **Chat header:** Marq centred over the scrolling messages in a frosted capsule, "is working" in `small` while he
  bobs (Muse, Fig 11 of the [north star](../../../docs/northstars/muse-dots-and-grok-bot-for-always-on.md)). On an
  iPhone the chat runs edge to edge under the header and Safari's toolbar, with no band of its own.
- **Composer:** white in `rest`, `float` on focus as its only focus mark. On a desktop, ChatGPT's one row with the
  picker shown, 12px wider than the text at each side over an opaque `canvas`; on a phone, one row at rest that opens
  to two with 44px targets (the Claude app), and no disclaimer.
- **Sidebar:** icon then label, the open row a `line` pill; shut by default on a desktop, docked with a hairline seam.
  The phone drawer follows Muse Fig 21.
- **List row:** a round icon tile and a title over muted lines (Muse Figs 13, 15). **Settings rows:** Codex's Schedule
  a task, a card of label-left, value-right rows.
- **Sheet:** an iOS sheet over `--scrim`, a grabber on phones; full-width actions, a destructive one confirming first.
- **Button:** a pill, secondary on `fill`, primary in `text`, Delete in `red` text. Close and Back are round buttons of
  the same height. **Field:** a `line`-bordered white box under its label. **Status pill:** its colour's text on `fill`.
- **Files:** a file is its type's react-file-icon page, labelled `red` for PDF and deck, `green` sheet, `blue`
  document, `text-muted` the rest, the same everywhere it shows. An image is its own thumbnail, square as in ChatGPT.
- **Artifacts:** a card in its Type's Radix step 3 with step 11 ink (Doc blue, Sheet green, Slides red, Email amber,
  Page violet), with the Type's icon and word, so a Sheet never reads as a white `.xlsx` File. In a reply: words,
  then Artifact cards at equal width, then Files.
- **Agent files:** Soul and Memory cards in Marq's colours (Muse Fig 16), white type at 4.5:1; an opened file is an
  iOS grouped list.
- **Charts:** Plotly's `simple_white`, no gridlines; axes `line`, labels `text-muted` at 13px; series take Radix step 9
  in the order blue, orange, green, red, violet, teal, amber, pink. Long titles wrap; the source sits in the subtitle.

## Exceptions

Each is a real-world object the system doesn't draw, and the lock test names each one:

- Marq's avatar is an illustration in his colours.
- The Computer's simulated desktop scales with its screen (`cqw`); Chrome's dock icon keeps Google's colours.
- The composer's text stays 16px on a touch tablet, so iOS doesn't zoom into it.
- Code blocks take Shiki's `github-light` syntax colours.
