# Copilot Design System

This file and `globals.css` are the design source; Claude designs from them. Mockups and screenshots live on one pinned
Design canvas (https://claude.ai/artifact/L1AfVQ3SBtUs86FfBrXER6): a page per flow plus Explorations. Add a
new design there as a board or page, and refresh its screenshot boards after a UI polish batch merges.

Every value below is a custom property in `:root` of `src/app/globals.css`; a cartridge's own
stylesheet uses the same properties. A component's colour, type size, weight and radius name a
token, never a literal. The exceptions: the Agent Computer's simulated desktop, which scales with its screen; the file
cards' tints (Card, below); and the translucent fills of the frosted header and overlays. Spacing has no tokens (see
Spacing).

Components are plain CSS on these tokens. Tailwind serves the few that use its classes and any copied-in shadcn
component: the `@theme inline` block in `globals.css` sets shadcn's color names (`background`, `muted-foreground`,
`accent`…), the type roles (`text-detail`) and the weights to these tokens, and its radius classes read the radius
tokens. There is no dark theme; when `shadcn add` writes its own palette into `globals.css`, delete it.

## Typography

The phone uses iOS's Dynamic Type defaults (Title 2 22, Headline 17 semibold, Body 17, Subheadline 15, Footnote 13).
Desktop and tablet follow ChatGPT's newest Mac build (26.930.61225, 6 Oct 2026), its 16px chat bubbles included. The
maintainer chose both: "phone uses iPhone defaults,
desktop follows ChatGPT", "lets use their newest". To change a size, re-measure its source: ChatGPT renders in OpenAI
Sans, and measuring it against SF Pro gave wrong sizes. Each token is its desktop size in `:root` and its phone size in
the `max-width: 640px` query, as are `--weight-title`, `--weight-name` and `--weight-headline`; name the role, never a pixel size.

| Token      | CSS var           | Desktop  | Phone (≤640px) | Use                                                                                                                                                                    |
| ---------- | ----------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`    | `--font-title`    | 24px/500 | 22px/700       | A screen's title (`.customize-title`, `.welcome-title`)                                                                                                                |
| `name`     | `--font-name`     | 18px/600 | 22px/700       | The sidebar brand and the Agent Profile's name, as ChatGPT's identity-panel hero name (`text-lg font-semibold`)                                                        |
| `headline` | `--font-headline` | 14px/500 | 17px/600       | A row's, card's or sheet's title, a section heading (`.list-row-title`, `.list-group-heading`, `.file-card-name`, `.agent-file h3`, `.profile-editor-title`, sign-ins) |
| `message`  | `--font-message`  | 16px/400 | 17px/400       | The chat: messages, the composer's text, the agent's name pill under the avatar                                                                                        |
| `body`     | `--font-body`     | 14px/400 | 17px/400       | Sidebar rows, menus (account, model), fields, file text, the welcome's description, the agent computer's file list                                                     |
| `detail`   | `--font-detail`   | 13px/400 | 15px/400       | Secondary lines (summary, time, account), intros, errors, field labels, buttons, the model picker, code                                                                |
| `label`    | `--font-label`    | 11px/600 | 13px/600       | Section labels, uppercase with 0.04em tracking (`SIDE CHATS`); status and Coming soon pills                                                                            |

The weights are each role's own. Sidebar rows are regular on a desktop, as in ChatGPT, and medium on a phone
(`--sidebar-row-weight`). The name pill is medium on a desktop, as ChatGPT's dot name under its avatar (`text-[16px] font-medium`), and semibold on a phone. The account menu's name stays semibold; a model
option's name, the Side chats header and buttons stay medium.

Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif` Code font:
`'Menlo', 'Monaco', 'Courier New', monospace`

## Components

All but the Info box and Close are React components in `src/components/ui/`, each over one CSS rule; the cartridge imports them
from `botcube-ui-web/ui`.

- **Sidebar row** (`<SidebarRow>`, `.sidebar-nav-item`): icon, then `body` label, a full-width pill filled while its screen is open.
  Phone: 44px tall, 24px icon viewport, 18px gap, the icon 20px from the screen edge under the brand (Muse Fig 21).
  The desktop rail is 60px wide, with every control centred in a 44px square, 20px glyphs (the account avatar stays 28px),
  at a 44px pitch, as dots' rail (memo 0049 Fig 1). It holds only Main chat, Customize and Account, with no divider
  (#3604).
  Sidebar menu and New side chat controls have 44px square targets with 20px glyphs. The phone menu has a 24px
  viewport and 22px drawn width, matching dots; the phone plus is a plain `text-muted` glyph, like the ×s.
  Desktop navigation and Account controls keep their x/y positions when the sidebar opens or closes.
  New side chat sits at the expanded header’s right at x204, y161, and leaves the rail.
  Main chat expands the desktop sidebar; a click on the main stage collapses it. The brand row has no control and
  keeps its 64px in both states, so the rail's icons stay level with their expanded rows.
  Navigation icons stay centred in the first 44px. Side chats has a disclosure in the `label` role at semibold, in
  capitals (Muse Fig 21's SIDE CHATS), with a down/right chevron and one plus control. The list collapse preference
  is remembered per viewer.
  The desktop brand has 12px top and 8px bottom padding.
  The phone drawer follows Muse Fig 21, measured from the safe area's top: a 44px brand row holding only the `name`
  at semibold (the chat strip closes the drawer, showing the chat's menu chip faded where it sits with the drawer
  shut); Main chat from 82px, the rows at a 44px pitch, the open one on
  `selected`; the divider 10px below them; the Side Chats header a 44px row 10px below the divider, its rows at the
  same pitch; content 20px from each side, the plus and each × in one 44px column; the Account row 8px above the
  bottom, on the rows' grid: a 29px avatar (iOS's list icon) at 20px and the name at the labels' 62px.
  The drawer and the chat card beside it run under the status and home bars; their contents keep to the safe area.
  The desktop sidebar takes the drawer's layout at its own positions on the `frame`: Main chat and Customize at a 44px
  pitch, the open row (nav or Side Chat) `white`, as dots' (Fig 1); 5px under them to the divider, then the header's 4px, in both states; the
  Side Chats header's label at 20px, its rows at the same 44px pitch right under it, each × in the plus's column; the
  Account row 4px above the bottom, on the chat card's bottom inset, as dots' account (Fig 1).
- **List row** (`<ListRow>` and its parts, `.list-row`): a round icon tile (`--row-icon`, 40px desktop, 44px phone) on `surface-hover`, a 14px gap,
  then a `headline` title over `detail` lines in `text-muted` (Muse Fig 13, 15). Activity, Scheduled and Customize use
  it (a Customize placeholder adds a dashed `border` edge); a failed row tints its tile `danger-soft` with a `danger`
  icon. A paused Scheduled row sets its icon `control` and its title `text-muted`, a Paused status pill beside the
  title. A Sign-ins row has no tile: the site's `headline` name over its account, the status pill at the right, buttons
  below.
- **Section label** (`<SectionLabel>`, `.section-label`): `label` above the rows it names.
- **Chat header** (`.chat-header`): a centered avatar over scrolling messages (memo 0049 Figs 1, 7, and 11).
  Messages remain clear behind it and extend under the phone status bar.
  On desktop Marq's hat sits 1.5px under the chat card's top, as dots' avatar under its card's (Fig 1), in front of a
  crisp `white` name capsule tucked 6px behind his body, as on the phone, with no frost or shadow at rest.
  A shared safe content frame keeps controls clear of every screen inset while phone chat alone extends to the top.
  On a phone the name capsule and closed menu use 4px blur on 60% white, with no saturation boost.
  The phone menu has no shadow and centers on the avatar. The default figure is about 66px wide, with the capsule overlapping its bottom edge.
- **Chat card** (`.app-shell`): on desktop the chat, or Customize, is a `white` card inside the sidebar's `frame`, 4px clear of the window's other edges, with `radius-lg` corners and the `card` edge (memo 0049 Fig 1). Beside
  the chat, the open Agent Profile shares the card, as dots' computer panel does (Fig 3).
- **Button** (`<Button>`, `.button`): a pill, `detail` at medium, 6px × 14px. Secondary is `text` on `surface-hover` (hover `border`); primary
  (Save, Confirm) is `white` on `text`; a destructive one (Delete) sets its text `danger`. Disabled primary is
  `control`. Its height is `--button-height`. **Back** (`.agent-file-back`, an open file's header) is a round
  secondary Button that size, holding a 16px chevron.
- **Close** (`.agent-profile-close`, the Agent Profile): a 44px circle on `surface` holding a `text` ✕ (hover
  `border`), 16px from the top and left edges (Muse Figs 13-16).
- **Field** (`<Field>`, `.field`: `input`, `textarea`, `select`): `body` text, 10px × 12px, a `border` line, `radius-lg`, its `detail`
  label 4px above.
- **Composer** (`.copilotKitInput`, the chat input): `message` text and a `detail` model picker, 16 : 13 on a desktop
  or tablet and 17 : 15 on a phone; both clear the 16px under which iOS Safari zooms into a field. The desktop composer is one 62px row. The phone stacks the text over the picker and Send in a
  90px box with a `composer` fill and shadow. Send has a 44px target; the phone draws a 32px circle inside it.
- **Status pill** (`<StatusPill>`, `.status-pill`; Sign-ins, Scheduled's Paused, Coming soon): `label` at medium, 3px × 10px, on a soft tint of its colour: `blue` on
  `blue-soft`, `danger` on `danger-soft`, `text-muted` on `surface-hover`.
- **Card** (`<FileCard>`, `.file-card`; Agent files): `radius-xl`, 16px padding, `headline` name over a `detail` hint. Each
  carries its own tint (`--card-tint`, `--card-edge`, `--card-ink`: blue Identity, violet Soul, amber Memory).
- **Info box** (About this file): `detail` in `text-muted` on `surface`, 12px × 14px, `radius-lg`.

## Color Palette

| Token           | Hex       | Use                                                                                                    |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `text`          | `#0d0d0d` | Primary text, primary buttons, the selected tab                                                        |
| `text-subtle`   | `#555`    | Picker pill text (in-input), card hints, sheet notes                                                   |
| `text-muted`    | `#6b6b6b` | Secondary lines, placeholders, section labels, muted icons (AA on `surface`), the fallback avatar disc |
| `surface`       | `#f7f7f8` | App and sidebar background, tab bar, info boxes                                                        |
| `surface-hover` | `#f4f4f4` | Secondary buttons, icon tiles, hover states, code blocks                                               |
| `composer`      | `#fbfbfb` | The phone composer's fill (ChatGPT Work's)                                                             |
| `selected`      | `#efefef` | The open row in the phone drawer (Muse Fig 21)                                                         |
| `frame`         | `#ebebec` | The desktop sidebar and the frame round the chat card (memo 0049 Fig 1)                                |
| `border`        | `#e0e0e0` | Borders, separators, secondary button hover                                                            |
| `control`       | `#bfbfbf` | Scrollbar thumbs, disabled send and primary buttons                                                    |
| `white`         | `#fff`    | Cards, dropdowns, field background                                                                     |
| `blue`          | `#2563eb` | Checkmarks, selection, focus rings, Linked                                                             |
| `blue-soft`     | `#eff6ff` | The Linked pill, the composer's sign-in chip                                                           |
| `success`       | `#22c55e` | The Connected badge, a finished tool call                                                              |
| `danger`        | `#dc2626` | Errors, failed rows, Delete, Re-link required (AA on white)                                            |
| `danger-soft`   | `#fef2f2` | A failed row's icon tile, the Re-link required pill                                                    |
| `black`         | `#000`    | CopilotKit primary, active send button                                                                 |

## Border Radius

| Token  | Value  | Use                                                                                               |
| ------ | ------ | ------------------------------------------------------------------------------------------------- |
| `sm`   | 4px    | Inline code, the sidebar's delete button                                                          |
| `md`   | 8px    | Header and sidebar icon buttons, the computer's window                                            |
| `lg`   | 12px   | Fields, dropdowns, info boxes, chat error, proposal card, the desktop chat card (memo 0049 Fig 1) |
| `xl`   | 16px   | Agent file cards, Customize placeholders                                                          |
| `2xl`  | 20px   | Message bubbles, the sign-in sheet                                                                |
| `3xl`  | 26px   | The composer                                                                                      |
| `4xl`  | 64px   | The chat card beside the phone drawer (Muse Fig 21)                                               |
| `pill` | 9999px | Buttons, pills, tabs, scrollbar thumbs (circles: 50%)                                             |

## Shadows

| Token      | Value                                                     | Use                                                                  |
| ---------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `subtle`   | `0 1px 6px rgba(0,0,0,0.08)`                              | The desktop composer (resting)                                       |
| `elevated` | `0 4px 20px rgba(0,0,0,0.15)`                             | Dropdowns, popovers                                                  |
| `composer` | `0 8px 36px rgba(0,0,0,0.11)`                             | The phone composer, focused or not (ChatGPT Work's)                  |
| `soft`     | `0 0 40px rgba(0,0,0,0.23)`                               | The chat card beside the phone drawer (Muse Fig 21)                  |
| `card`     | `0 0 0 0.5px rgba(0,0,0,0.06), 0 0 20px rgba(0,0,0,0.06)` | The desktop chat card's edge on the sidebar's grey (memo 0049 Fig 1) |

## Transitions

| Token    | Value       | Use                                       |
| -------- | ----------- | ----------------------------------------- |
| `fast`   | `0.1s`      | Hover backgrounds, opacity, color changes |
| `layout` | `0.2s ease` | Sidebar width, border-color               |

## Spacing

A 4px grid, with 2px steps inside a row (the list row's 14px gap, a pill's 6px × 14px). Screens pad 20px at the side on
phones and 16–24px on desktop; sections sit 24–28px apart, rows 4–12px. The phone chat's gutter is 16px; the composer
reaches 4px into it, 12px from the screen's edges like ChatGPT Work's.
