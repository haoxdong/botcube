# Copilot Design System

This file and `globals.css` are the design source; Claude designs from them. Mockups and screenshots live on one pinned
Design canvas (https://claude.ai/artifact/L1AfVQ3SBtUs86FfBrXER6): a page per flow plus Explorations. Add a
new design there as a board or page, and refresh its screenshot boards after a UI polish batch merges.

Every value below is a custom property in `:root` of `src/app/globals.css`; a cartridge's own
stylesheet uses the same properties. A component's colour, type size, weight and radius name a
token, never a literal. The exceptions: the Agent Computer's simulated desktop, which scales with its screen; the agent
files' tints, which draw on the agent's colours (Agent colours, below); and the translucent fills of the frosted header
and overlays. Spacing has no tokens (see Spacing).

Components are plain CSS on these tokens. Tailwind serves the few that use its classes and any copied-in shadcn
component: the `@theme inline` block in `globals.css` sets shadcn's color names (`background`, `muted-foreground`,
`accent`…), the type roles (`text-detail`) and the weights to these tokens, and its radius classes read the radius
tokens. There is no dark theme; when `shadcn add` writes its own palette into `globals.css`, delete it.

## Style

Native minimal. A screen looks like the platform's own app (iPhone on a phone, ChatGPT's Mac app on a desktop) and keeps only what is essential: the system font, neutral greys, white cards, and colour only where it carries meaning. Drop a row, line or option that is only marginally useful.

## Typography

The phone uses iOS's Dynamic Type defaults (Title 2 22, Headline 17 semibold, Body 17, Subheadline 15, Footnote 13).
Desktop and tablet follow ChatGPT's newest Mac build. The maintainer chose both: "phone uses iPhone defaults,
desktop follows ChatGPT", "lets use their newest". Desktop sizes are read from the ChatGPT Mac app 26.1002.52244 webview
CSS (electron window type), which renders chat and UI in SF Pro. Each token is its desktop size in `:root` and its phone size in
the `max-width: 640px` query, as are `--weight-title`, `--weight-name` and `--weight-headline`; name the role, never a pixel size.

| Token      | CSS var           | Desktop  | Phone (≤640px) | Use                                                                                                                                                                                |
| ---------- | ----------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`    | `--font-title`    | 18px/600 | 22px/700       | A screen's title (`.plugins-title`, `.welcome-title`)                                                                                                                              |
| `name`     | `--font-name`     | 18px/600 | 22px/700       | The sidebar brand and the Agent Profile's name, as ChatGPT's identity-panel hero name (`text-lg font-semibold`)                                                                    |
| `headline` | `--font-headline` | 14px/500 | 17px/600       | A row's or sheet's title, a section heading (`.list-row-title`, `.list-group-heading`, `.agent-file h3`, `.profile-editor-title`, sign-ins), the desktop Side chats header         |
| `pill`     | `--font-pill`     | 16px/500 | 17px/600       | The agent's name pill under the avatar, ChatGPT Mac's mascot name                                                                                                                  |
| `message`  | `--font-message`  | 14px/400 | 17px/400       | The chat: messages, the composer's text                                                                                                                                            |
| `body`     | `--font-body`     | 14px/400 | 17px/400       | Sidebar rows, menus (account, model), fields, file text, the welcome's description, the agent computer's file list                                                                 |
| `detail`   | `--font-detail`   | 13px/400 | 15px/400       | Controls: buttons, the model picker and its options, field labels; errors, fenced code                                                                                             |
| `meta`     | `--font-meta`     | 12px/400 | 15px/400       | Secondary lines under a title (a row's subtitle, the profile's character and status, a file's caption, the Plugins intro, the empty Side chats' note), the desktop chat disclaimer |
| `label`    | `--font-label`    | 11px/600 | 13px/600       | Section labels, uppercase with 0.04em tracking (the phone's `SIDE CHATS`); status and Coming soon pills                                                                            |

The weights are each role's own. Sidebar rows are regular on a desktop, as in ChatGPT, and medium on a phone
(`--sidebar-row-weight`). The name pill is medium on a desktop, as ChatGPT's dot name under its avatar (`font-medium`), and semibold on a phone. The account menu's name stays semibold; a model
option's name, the desktop Side chats header and buttons stay medium.

Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif` Code font:
`--font-code` (`'Menlo', 'Monaco', 'Courier New', monospace`). Inline code is 0.9em of the text beside it.

## Components

All but the File page and Close are React components in `src/components/ui/`, each over one CSS rule; the cartridge imports them
from `botcube-ui-web/ui`.

- **Sidebar row** (`<SidebarRow>`, `.sidebar-nav-item`): icon, then `body` label, a full-width pill filled while its screen is open.
  Phone: 44px tall, 24px icon viewport, 18px gap, the icon 20px from the screen edge under the brand (Muse Fig 21).
  Sidebar menu and New side chat controls have 44px square targets with 20px glyphs. The phone menu has a 24px
  viewport and 22px drawn width, matching dots; the phone plus is a plain `text-muted` glyph, like the ×s.
  New side chat sits at the expanded header’s right at x204, y161.
  The desktop sidebar is shut by default, so the chat has the window: only the phone's round menu chip shows, over
  the chat's top left. The chip docks the 260px sidebar beside the chat, which narrows to make room, with a 1px
  `border` seam outside its 260px and no shadow, as the Agent Profile's on the chat's other side. It stays open
  until the menu control beside the open brand shuts it, without motion either way; a desktop opens it as the viewer
  last left it. The brand row keeps its 64px.
  Navigation icons stay centred in the first 44px. Side chats has a disclosure, `text-muted`: on a desktop in the
  `headline` role, as ChatGPT Mac's Recents; on a phone in the `label` role at semibold, in capitals (Muse Fig 21's
  SIDE CHATS); with a down/right chevron and one plus control. The list collapse preference
  is remembered per viewer.
  The desktop brand has 12px top and 8px bottom padding.
  The phone drawer follows Muse Fig 21, measured from the safe area's top: a 44px brand row holding only the `name`
  at semibold (the chat strip, `.sidebar-strip-close`, closes the drawer, showing the chat's menu chip faded where it sits with the drawer
  shut); Main chat from 82px, the rows at a 44px pitch, the open one on
  `selected`; the divider 10px below them; the Side Chats header a 44px row 10px below the divider, its rows at the
  same pitch; content 20px from each side, the plus and each × in one 44px column; the Account row 8px above the
  bottom, on the rows' grid: a 29px avatar (iOS's list icon) at 20px and the name at the labels' 62px.
  The drawer and the chat card beside it run under the status and home bars; their contents keep to the safe area.
  The desktop sidebar takes the drawer's layout at its own positions on the chat's `white`, as ChatGPT's: Main chat
  and Plugins at a 44px pitch, the open row (nav or Side Chat) on `border`, the profile controls' hover grey; 5px under them to the divider, then the header's 4px, in both states; the
  Side Chats header's label at 20px, its rows at the same 44px pitch right under it, each × in the plus's column; the
  Account row 4px above the bottom, as dots' account (Fig 1).
- **List row** (`<ListRow>` and its parts, `.list-row`): a round icon tile (`--row-icon`, 40px desktop, 44px phone) on `surface-hover`, a 14px gap,
  then a `headline` title over `meta` lines in `text-muted` (Muse Fig 13, 15). Activity, Scheduled and Plugins use
  it (a Plugins placeholder adds a dashed `border` edge); a failed row tints its tile `danger-soft` with a `danger`
  icon. Scheduled rows sit under frequency headings (`.list-group-heading`, as Activity's days), each a button with one
  cut-short detail line (time · prompt) that opens the task's Sheet. A paused Scheduled row sets its icon `control` and its title `text-muted`, a Paused status pill beside the
  title. A Sign-ins row has no tile: the site's `headline` name over its account, the status pill at the right, buttons
  below.
- **Section label** (`<SectionLabel>`, `.section-label`): `label` above the rows it names.
- **Sheet** (`<Sheet>` on Base UI's Drawer, `.sheet`; Scheduled's task actions): an iOS sheet that rises from the bottom
  of the Agent Profile over a 32% black backdrop, `white` with `radius-2xl` top corners and `shadow-elevated`; on phones
  a 36 × 5px `control` grabber, and a finger swipes it down; Edit profile's title bar (close at the left, `headline`
  title centred); its actions full-width Buttons, one under another. A destructive action asks first, as iOS does: the
  actions give way to a `destructive` confirm (Delete task) over Cancel.
- **Chat header** (`.chat-header`): a centered avatar over scrolling messages (memo 0049 Figs 1, 7, and 11).
  A shared safe content frame keeps controls clear of every screen inset.
  On desktop, messages stay clear behind the header. Marq's hat sits 1.5px under the window's top, as dots' avatar under its card's (Fig 1), in front of a
  crisp `white` name capsule tucked 6px behind his body, as on the phone, with no frost or shadow at rest.
  On phones, the chat scrolls the page, so messages run undimmed up under the status bar behind iOS Safari's own fade, as in Muse Fig 11.
  The closed-phone menu uses 4px blur on 60% white, with no saturation boost; on phones the capsule is a crisp 92% white, and neither has a shadow.
  The phone menu stands at Muse's spot, 24px in at the top of the safe area. On phones the default figure stands 68px tall, hat included, like Muse's avatar disc, in front of the capsule, which tucks about 6px behind his body.
- **Chat stage** (`.app-shell`): on desktop the chat, or Plugins, fills the window, `white` and square with no edge,
  as it meets no rounded screen corner (Border Radius). Beside the chat, the open Agent Profile shares it, as dots'
  computer panel does (Fig 3).
- **Button** (`<Button>`, `.button`): a pill, `detail` at medium, 6px × 14px. Secondary is `text` on `surface-hover` (hover `border`); primary
  (Save, Confirm) is `white` on `text`; a destructive one (Delete) sets its text `danger`. Disabled primary is
  `control`. Its height is `--button-height`. **Back** (`.agent-file-back`, an open file's header) is a round
  secondary Button that size, holding a 16px chevron.
- **Close** (`.agent-profile-close`, the Agent Profile): a 44px circle on `surface` holding a `text` ✕ (hover
  `border`), 16px from the top and left edges (Muse Figs 13-16).
- **Field** (`<Field>`, `.field`: `input`, `textarea`, `select`): `body` text, 10px × 12px, a `border` line, `radius-lg`, its `detail`
  label 4px above. The sidebar's inline rename field is a pill, the shape of the row it replaces.
- **Settings rows** (`.settings-group`, `.settings-row`; a Scheduled task's sheet and its Edit form): Codex's Schedule a
  task dialog, measured from the maintainer's screenshot. A `white` `radius-xl` card with a `border` edge; its rows 48px
  tall with 20px sides, the label in `text` at the left, the value in `text-muted` at the right, split by `border`
  hairlines inset 16px. An editable value is a bare select ending in a 16px chevron; a date or time in words over the
  same chevron (Tue, Oct 6, 3:02 PM ET), a native picker unseen over the row (`.settings-when`); a read-only one has
  no chevron. Text fields above the cards (`.settings-text`)
  are the same `radius-xl` box with 14px × 18px padding, the instructions 120px tall with 18px padding. A More
  disclosure (`.settings-disclosure`, `text-muted`, shut by default) holds further cards 12px apart. Cancel and
  Save end the form at the right, pills 12px apart and at least 36px tall (44px on a phone).
- **Composer** (`.copilotKitInput`, the chat input): `message` text and a `detail` model picker; on a phone both clear
  the 16px under which iOS Safari zooms into a field, and a touch tablet keeps the text at 16px for the same reason. The
  disclaimer (`.chat-disclaimer`) sits under it: `meta` in `text-muted` on a desktop, CopilotKit's own small grey line
  on a phone. The desktop composer (768px and wider) is ChatGPT's one 52px row (#3962): 36px +, picker and Send inside
  7px of padding and the 1px border, the + 9px and Send 11px inside its outer edges, the text 12px right of the +. Once
  its text takes two lines (CopilotKit's `expanded`), it goes across the top, 8px in so its left edge sits on the +'s
  glyph, over a 36px row of the + at the left and the picker and Send at the right: 108px for two lines, scrolling past
  CopilotKit's five. That follows ChatGPT's pattern on the measured controls and padding; its multi-line values were not
  measured. The phone stacks the text over the picker and Send in a 90px box with a `composer` fill and shadow; its
  controls have 44px targets, and it draws a 32px Send circle inside its target.
- **Add menu** (`AddMenu`, `.add-menu`; the composer's +): ChatGPT's + menu, a `white` `radius-xl` popover with the
  `popover` shadow, at least 220px wide, 8px above the composer and on its left edge, 6px around its items. Each item is
  44px tall, 10px in from the sides, a 20px line icon 6px from its `body` label in `text`; the highlighted item fills
  `surface-hover` at `radius-md`. As ChatGPT splits them: Add photos, beside a paperclip, picks images; Add files, beside
  a file-plus, picks any file; both upload alike. Only items we support. Measured from a 2x
  screenshot of chatgpt.com, logged out (2026-10-12), whose Cloudflare check blocked a live reading; the hover is ours,
  as nothing was hovered in it.
- **File tile** (`FileTile`, `.file-tile`): a 40px `radius-lg` square in a file's kind tint (`file-pdf`, `file-sheet`,
  else `text-muted`) holding a white icon; a file wears the same tile in the composer and once sent.
- **Composer files** (`<ComposerFileChips>`, `.composer-file`): a `white` chip per attached file inside the composer
  above its text, a `border` edge and `radius-xl`: the file tile, the name over its upload's progress, its kind or why
  it failed, and Remove. An image (by name, as in Sent files; `.composer-image`) is its sent thumbnail instead, from
  the local file, with a 20px `text` Remove circle 4px inside its top right corner and no text on it: uploading, it
  dims under a white progress ring; failed, under a 24px Retry ringed in `danger`, and a `meta` line in `danger` under
  the chips says why ("Couldn't upload name: reason"), wrapping onto at most two lines. One the browser can't show
  is a chip. On a phone Retry's hit area grows 12px each way and Remove's only up and right, so a tap on either circle
  reaches it. Pasting an image alone attaches it; pasting text that carries an image too pastes only the text.
- **Sent files** (`<SentFileCards>`, `.sent-files`; a sent or queued message's attachments): one `white` card per file
  above the bubble, right-aligned, with a `border` edge and `radius-xl`: the file tile, then the file's name (`body`,
  medium, cut short) over its kind (`meta`, `text-muted`, such as PDF). An image (`.image-thumb`) is ChatGPT's square
  thumbnail instead (by extension: PNG, JPG, JPEG, GIF, WEBP, as in the composer), 56px at `radius-lg`, from the
  cartridge's `fileUrl`, `surface-hover` until it loads; one that
  can't load keeps its tile beside its name and why, `meta` in `danger`. The bubble holds only what the user typed; a
  message of files alone has none.
- **Status pill** (`<StatusPill>`, `.status-pill`; Sign-ins, Scheduled's Paused, Coming soon): `label` at medium, 3px × 10px, on a soft tint of its colour: `blue` on
  `blue-soft`, `danger` on `danger-soft`, `text-muted` on `surface-hover`.
- **Profile header** (`.agent-profile-header`): the 96px avatar with a pencil badge (`.agent-profile-edit`, Edit agent)
  that opens Identity's editor, the `name`, Identity's character as one `meta` line in `text-muted` cut short with an
  ellipsis (`.agent-profile-character`, left out when blank), then the Connected status.
- **File tint** (`.agent-file-tint-*`; Agent files): each file's gradient, after Muse's file cards (Fig 16), in the
  agent's colours (Agent colours, below): deep `to` under the white type on the left, lifting to `from` at the bottom
  right, with a `glow` in the top right corner (`--file-tint`), and a shadow of `from` (`--file-shadow`). Identity wears
  Soul's colours. It fills the file's card and its page's `radius-md` header tile (`headline` × 2 square), each with a
  white glyph; Soul's and Memory's glyphs are solid.
- **File cards** (`.agent-file-cards`; the Personalization tab, under the fingerprint icon): Soul and Memory side by
  side as Muse's (Fig 16), a two-column grid with a 12px gap. Each card is one 4:3 `radius-2xl` button in its tint under
  a fine SVG grain, no border, a soft `--file-shadow`; inside 16px of padding, white type: the `name` title bold
  and uppercase, under it a monospace `label` hint tracked 0.14em (Values and habits, What it knows), and bottom-left a
  monospace `detail` count (3 lines, Empty; 3 memories, No memories yet), both uppercase at 90% white (at least 4.5:1
  on the tint, measured on the rendered card); the count stops 32px short of the icon and wraps. A solid 24px heart or
  speech bubble at 80% white sits bottom-right. Hover lifts the card 2px, except under reduced motion; keyboard focus
  draws a 2px `text` ring.
- **File page** (`.agent-file`; an opened Soul or Memory card, or Identity from the pencil): Back, then the file's tinted tile,
  then the `headline` title. Under it a caption on what the file is, `meta` in `text-muted`. The
  content is a grouped list, as iOS Settings: one `white` `radius-xl` group with a `border` edge, its rows 12px × 16px
  and split by `border` hairlines inset to the text. Memory has one row per memory; Soul's text sits in the group as it
  is. Identity opens straight into its editor: an 80px avatar centred over its fields; Cancel, Back or Save returns to
  the tab the user was on.

## Color Palette

| Token           | Hex       | Use                                                                                                    |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `text`          | `#0d0d0d` | Primary text, primary buttons, the selected tab                                                        |
| `text-subtle`   | `#555`    | Picker pill text (in-input), sheet notes                                                               |
| `text-muted`    | `#6b6b6b` | Secondary lines, placeholders, section labels, muted icons (AA on `surface`), the fallback avatar disc |
| `surface`       | `#f7f7f8` | App and sidebar background, tab bar                                                                    |
| `surface-hover` | `#f4f4f4` | Secondary buttons, icon tiles, hover states                                                            |
| `composer`      | `#fbfbfb` | The phone composer's fill (ChatGPT Work's)                                                             |
| `selected`      | `#efefef` | The open row in the phone drawer (Muse Fig 21)                                                         |
| `border`        | `#e0e0e0` | Borders, separators, secondary button hover, the desktop sidebar's open row                            |
| `control`       | `#bfbfbf` | Scrollbar thumbs, disabled send and primary buttons                                                    |
| `white`         | `#fff`    | Cards, dropdowns, field background, the desktop sidebar (as ChatGPT's)                                 |
| `blue`          | `#2563eb` | Checkmarks, selection, focus rings, Linked                                                             |
| `blue-soft`     | `#eff6ff` | The Linked pill, the composer's sign-in chip                                                           |
| `success`       | `#22c55e` | The Connected badge                                                                                    |
| `danger`        | `#dc2626` | Errors, failed rows, Delete, Re-link required (AA on white)                                            |
| `danger-soft`   | `#fef2f2` | A failed row's icon tile, the Re-link required pill                                                    |
| `black`         | `#000`    | CopilotKit primary, active send button                                                                 |
| `file-pdf`      | `#e5484d` | A sent PDF's tile (white icon 4.7:1)                                                                   |
| `file-sheet`    | `#10a37f` | A sent spreadsheet's tile: CSV, XLS, XLSX (white icon 3.2:1)                                           |

The file tints are ours, after ChatGPT's coloured file tiles, not measured from it.

**Agent colours** (`--agent-soul-*`, `--agent-memory-*`): the Soul and Memory cards' colours, a cartridge `theme` hook,
so each agent brings its own; the defaults are a neutral grey, which the template keeps. Each card's white captions keep
4.5:1 on its `to`, measured on the rendered card.

| Token               | Default      | Marq (from its avatar)              |
| ------------------- | ------------ | ----------------------------------- |
| `agent-soul-from`   | `text-muted` | `#6c90bc`, its outline periwinkle   |
| `agent-soul-to`     | `text`       | `#3f5f8a`, a deeper navy periwinkle |
| `agent-soul-glow`   | `control`    | `#acc4e0`, its body                 |
| `agent-memory-from` | `text-muted` | `#3f5f8a`, Soul's navy              |
| `agent-memory-to`   | `text`       | `#1c2b45`, a deeper navy            |
| `agent-memory-glow` | `control`    | `#acc4e0`, its body, as Soul's      |

## Border Radius

A panel rounds only where it reaches into the safe zone, following an iPhone's rounded screen corners, as the phone's
chat card beside the drawer does; a panel that meets no rounded corner, such as the desktop chat stage, stays square.
Controls inside a panel, such as the composer and message bubbles, keep their own radius.

| Token  | Value  | Use                                                                  |
| ------ | ------ | -------------------------------------------------------------------- |
| `sm`   | 4px    | Inline code, the sidebar's delete button                             |
| `md`   | 8px    | Header and sidebar icon buttons, the computer's window, + menu items |
| `lg`   | 12px   | Fields, dropdowns, chat error, proposal card                         |
| `xl`   | 16px   | Agent files' grouped lists, Plugin placeholders, the + menu          |
| `2xl`  | 20px   | Message bubbles, the sign-in sheet, the Scheduled sheet, file cards  |
| `3xl`  | 26px   | The composer                                                         |
| `4xl`  | 64px   | The chat card beside the phone drawer (Muse Fig 21) or profile       |
| `pill` | 9999px | Buttons, pills, tabs, scrollbar thumbs (circles: 50%)                |

## Shadows

| Token      | Value                                                   | Use                                                            |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `subtle`   | `0 1px 6px rgba(0,0,0,0.08)`                            | The desktop composer (resting)                                 |
| `elevated` | `0 4px 20px rgba(0,0,0,0.15)`                           | Dropdowns, popovers, the Scheduled sheet                       |
| `composer` | `0 8px 36px rgba(0,0,0,0.11)`                           | The phone composer, focused or not (ChatGPT Work's)            |
| `popover`  | `0 8px 16px rgba(0,0,0,0.08), 0 0 1px rgba(0,0,0,0.62)` | The composer's + menu (ChatGPT's)                              |
| `soft`     | `0 0 40px rgba(0,0,0,0.23)`                             | The chat card beside the phone drawer (Muse Fig 21) or profile |

## Transitions

| Token    | Value       | Use                                       |
| -------- | ----------- | ----------------------------------------- |
| `fast`   | `0.1s`      | Hover backgrounds, opacity, color changes |
| `layout` | `0.2s ease` | Border-color, the phone chat card's slide |

## Spacing

A 4px grid, with 2px steps inside a row (the list row's 14px gap, a pill's 6px × 14px). Screens pad 20px at the side on
phones and 16–24px on desktop; sections sit 24–28px apart, rows 4–12px. The phone chat's gutter is 16px; the composer
reaches 4px into it, 12px from the screen's edges like ChatGPT Work's.
