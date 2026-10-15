# Copilot Design System

This file and `globals.css` are the design source; Claude designs from them. Mockups and screenshots live on one pinned
Design canvas (https://claude.ai/artifact/L1AfVQ3SBtUs86FfBrXER6): a page per flow plus Explorations. Add a
new design there as a board or page, and refresh its screenshot boards after a UI polish batch merges.

The values live in `src/app/globals.css`: the tokens in `:root`, each component's in its rule, with the why in its
comments. `src/app/globals.test.tsx` and the Storybook play tests pin the behaviour. This file keeps the rules and
references the code can't say; a cartridge's own stylesheet uses the same properties.

A component's colour, type size, weight and radius name a token, never a literal. The exceptions: the Agent Computer's
simulated desktop, which scales with its screen; the agent files' tints, which draw on the agent's colours (Agent
colours, below); and the translucent fills of the frosted header and overlays. Spacing has no tokens (see Spacing).

Components are plain CSS on these tokens. Tailwind serves the few that use its classes and any copied-in shadcn
component: the `@theme inline` block in `globals.css` sets shadcn's color names (`background`, `muted-foreground`,
`accent`…), the type roles (`text-detail`) and the weights to these tokens, and its radius classes read the radius
tokens. There is no dark theme; when `shadcn add` writes its own palette into `globals.css`, delete it.

## Style

Native minimal. A screen looks like the platform's own app (iPhone on a phone, ChatGPT's Mac app on a desktop) and keeps only what is essential: the system font, blue-grey neutrals, white cards, and colour only where it carries meaning. Drop a row, line or option that is only marginally useful.

The neutrals share Marq's blue hue (OKLCH hue 255, chroma 0.006 at each grey's lightness), so a screen holds two colour
families, not three. The user's bubble stands apart by fill; Marq's is white, lifted by `shadow-rest`.

## Typography

The phone uses iOS's Dynamic Type defaults (Title 2 22, Headline 17 semibold, Body 17, Subheadline 15, Footnote 13).
Desktop and tablet follow ChatGPT's newest Mac build. The maintainer chose both: "phone uses iPhone defaults,
desktop follows ChatGPT", "lets use their newest". Desktop sizes are read from the ChatGPT Mac app 26.1002.52244 webview
CSS (electron window type), which renders chat and UI in SF Pro. Each token is its desktop size in `:root` and its phone size in
the `max-width: 640px` query, as are `--weight-title`, `--weight-name` and `--weight-headline`; name the role, never a pixel size.

| Token      | CSS var           | Use                                                                                                                                                                                |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`    | `--font-title`    | A screen's title (`.plugins-title`, `.welcome-title`)                                                                                                                              |
| `name`     | `--font-name`     | The sidebar brand and the Agent Profile's name, as ChatGPT's identity-panel hero name (`text-lg font-semibold`)                                                                    |
| `headline` | `--font-headline` | A row's or sheet's title, a section heading (`.list-row-title`, `.list-group-heading`, `.agent-file h3`, `.profile-editor-title`, sign-ins), the desktop Side chats header         |
| `pill`     | `--font-pill`     | The agent's name pill under the avatar, ChatGPT Mac's mascot name                                                                                                                  |
| `message`  | `--font-message`  | The chat: messages, the composer's text                                                                                                                                            |
| `body`     | `--font-body`     | Sidebar rows, menus (account, model), fields, file text, the welcome's description, the agent computer's file list                                                                 |
| `detail`   | `--font-detail`   | Controls: buttons, the model picker and its options, field labels; errors, fenced code                                                                                             |
| `meta`     | `--font-meta`     | Secondary lines under a title (a row's subtitle, the profile's character and status, a file's caption, the Plugins intro, the empty Side chats' note), the desktop chat disclaimer |
| `label`    | `--font-label`    | Section labels (the phone's `SIDE CHATS`); status and Coming soon pills                                                                                                            |

The weights are each role's own. Sidebar rows (`--sidebar-row-weight`) take ChatGPT's weight on a desktop.

Code font: `--font-code`.

## Components

All but the File page and Close are React components in `src/components/ui/`, each over one CSS rule; the cartridge imports them
from `botcube-ui-web/ui`.

- **Sidebar row** (`<SidebarRow>`, `.sidebar-nav-item`): icon, then label, a full-width pill filled while its screen is
  open. The phone menu's glyph is 22px wide as drawn, matching dots.
  The desktop sidebar is shut by default, so the chat has the window: only the phone's round menu chip shows, over
  the chat's top left. The chip docks the sidebar beside the chat, which narrows to make room, with a hairline seam
  and no shadow, as the Agent Profile's on the chat's other side. It stays open until the menu control beside the open
  brand shuts it, without motion either way; a desktop opens it as the viewer last left it.
  Navigation icons stay centred in the first 44px. Side chats has a disclosure, as ChatGPT Mac's Recents on a desktop
  and Muse Fig 21's SIDE CHATS on a phone, with a down/right chevron and one plus control. The list collapse preference
  is remembered per viewer.
  The phone drawer follows Muse Fig 21, measured from the safe area's top; the chat strip (`.sidebar-strip-close`)
  closes it, showing the chat's menu chip faded where it sits with the drawer shut. Its Account avatar is iOS's list
  icon's size. The drawer and the chat card beside it run under the status and home bars; their contents keep to the
  safe area.
  The desktop sidebar takes the drawer's layout at its own positions on the chat's `white`, as ChatGPT's, its Account
  row as dots' account (Fig 1).
- **List row** (`<ListRow>` and its parts, `.list-row`): a round icon tile, then a title over muted lines (Muse Fig 13,
  15). Activity, Scheduled and Plugins use it; a failed row tints its tile. Scheduled rows sit under frequency headings
  (`.list-group-heading`, as Activity's days), each a button with one cut-short detail line (time · prompt) that opens
  the task's Sheet. A paused Scheduled row dims, a Paused status pill beside the title. A Sign-ins row has no tile: the
  site's `headline` name over its account, the status pill at the right, buttons below.
- **Section label** (`<SectionLabel>`, `.section-label`): `label` above the rows it names.
- **Sheet** (`<Sheet>` on Base UI's Drawer, `.sheet`; Scheduled's task actions): an iOS sheet that rises from the bottom
  of the Agent Profile over a dimmed backdrop; on phones a grabber, and a finger swipes it down; Edit profile's title bar
  (close at the left, title centred); its actions full-width Buttons, one under another. A destructive action asks
  first, as iOS does: the actions give way to a `destructive` confirm (Delete task) over Cancel.
- **Chat header** (`.chat-header`): a centered avatar over scrolling messages (memo 0049 Figs 1, 7, and 11).
  A shared safe content frame keeps controls clear of every screen inset.
  On desktop, messages fade out under the header (a mask on the scroller), so they never run into Marq or his name.
  Marq's hat sits under the window's top, as dots' avatar under its card's (Fig 1), in front of a crisp name capsule
  tucked behind his body, as on the phone.
  On phones, the chat scrolls the page, so messages run undimmed up under the status bar behind iOS Safari's own fade, as in Muse Fig 11 (#3613).
  While the agent works, the capsule reads the name over "is working" in `detail` `text-muted`, still, and Marq bobs,
  sitting a little smaller behind a laptop lid, after Muse's working avatar (the maintainer's screenshot of Muse).
  The closed-phone menu's frost has no saturation boost. The phone menu stands at Muse's spot; on phones the default
  figure stands as tall as Muse's avatar disc, hat included, in front of the capsule.
- **Chat stage** (`.app-shell`): on desktop the chat, or Plugins, fills the window, square with no edge, as it meets no
  rounded screen corner (Border Radius). Beside the chat, the open Agent Profile shares it, as dots' computer panel
  does (Fig 3). On a wide fine-pointer desktop window, the whole app (`.app-layout`) zooms by `--ui-zoom`, as a
  narrower window scaled up; phones and touch screens never zoom.
- **Button** (`<Button>`, `.button`): a pill. Secondary by default; primary for Save and Confirm; a destructive one
  (Delete) sets its text `danger`. Its height is `--button-height`. **Back** (`.agent-file-back`, an open file's
  header) is a round secondary Button that size, holding a 16px chevron.
- **Close** (`.agent-profile-close`, the Agent Profile): a filled circle holding a ✕ at the top left (Muse Figs 13-16).
- **Field** (`<Field>`, `.field`: `input`, `textarea`, `select`): a bordered box under its label. The sidebar's inline
  rename field is a pill, the shape of the row it replaces.
- **Settings rows** (`.settings-group`, `.settings-row`; a Scheduled task's sheet and its Edit form): Codex's Schedule a
  task dialog, measured from the maintainer's screenshot. A card of rows, the label at the left and the value at the
  right. An editable value is a bare select ending in a chevron; a date or time in words over the same chevron (Tue,
  Oct 6, 3:02 PM ET), a native picker unseen over the row (`.settings-when`); a read-only one has no chevron. Text
  fields above the cards (`.settings-text`) are the cards' box. Under them, every task's Edit form has the same card,
  after Codex's Schedule a task: Repeat (one menu: Interval, Daily, Weekdays, Weekly, Once; Custom only for a schedule
  none of them says, a rate of hours or days among them, read in its words and saved as written), then the one row it
  needs: Interval's Every, minutes only, a bare count then "minutes" with no unit control; Time; Day over Time; or
  Once's date and time. More, shut by default, holds Starts, Ends and Model (Model alone for Once). A task's sheet is
  laid out the same: that card read-only, then a card of Next run and Last run, Last run's status before its time,
  then More, shut, over Edit's rows; each time carries its zone. Cancel and Save end the form at the right.
- **Composer** (`.copilotKitInput`, the chat input): `message` text and a `detail` model picker; on a phone both clear
  the 16px under which iOS Safari zooms into a field, and a touch tablet keeps the text at 16px for the same reason. The
  disclaimer (`.chat-disclaimer`) sits under it. It is white and rests in `shadow-rest`, on a phone too; focus lifts
  it to `shadow-elevated`, its only focus mark. The desktop composer is ChatGPT's one row (#3962). Once its text takes
  two lines (CopilotKit's `expanded`), it goes across the top, over a row of the + at the left and the picker and Send
  at the right, scrolling past CopilotKit's five lines. That follows ChatGPT's pattern on the measured controls and
  padding; its multi-line values were not measured. The phone stacks the text over the picker and Send; its controls
  have 44px targets.
- **Add menu** (`AddMenu`, `.add-menu`; the composer's +): ChatGPT's + menu, a popover on the composer's left edge. As
  ChatGPT splits them: Add photos, beside a paperclip, picks images; Add files, beside a file-plus, picks any file; both
  upload alike. Only items we support. Measured from a 2x screenshot of chatgpt.com, logged out (2026-10-12), whose
  Cloudflare check blocked a live reading; the hover is ours, as nothing was hovered in it.
- **File tile** (`FileTile`, `.file-tile`): a square in a file's kind tint holding a white icon; a file wears the same
  tile in the composer and once sent.
- **Composer files** (`<ComposerFileChips>`, `.composer-file`): a chip per attached file inside the composer above its
  text: the file tile, the name over its upload's progress, its kind or why it failed, and Remove. An image (by name,
  as in Sent files; `.composer-image`) is its sent thumbnail instead, from the local file, with a Remove circle in its
  top right corner and no text on it: uploading, it dims under a progress ring; failed, under a Retry ringed in
  `danger`, and a line under the chips says why ("Couldn't upload name: reason"). One the browser can't show is a chip.
  On a phone Retry's and Remove's hit areas grow, Remove's only up and right, so a tap on either circle reaches it.
  Pasting an image alone attaches it; pasting text that carries an image too pastes only the text.
- **Sent files** (`<SentFileCards>`, `.sent-files`; a sent or queued message's attachments): one card per file above
  the bubble, right-aligned: the file tile, then the file's name, cut short, over its kind (such as PDF). An image
  (`.image-thumb`) is ChatGPT's square thumbnail instead (by extension: PNG, JPG, JPEG, GIF, WEBP, as in the composer),
  from the cartridge's `fileUrl`; one that can't load keeps its tile beside its name and why. The bubble holds only
  what the user typed; a message of files alone has none.
- **Worklog** (`Worklog`, `.worklog`; layout in `globals.css`): a Turn's work under one head, "Working · 9s" while it
  runs. From the run's start (RUN_STARTED) until its first row, the head alone, with no chevron, stands in for the cursor.
  One live line shimmers at a time, a grey band sweeping left to right with no colour: the live step's label while the
  Worklog is open, otherwise the head; the chat header's "is working" never does. Notes inside a Turn wear no bubble.
- **Status pill** (`<StatusPill>`, `.status-pill`; Sign-ins, Scheduled's Paused, Coming soon): a pill on a soft tint
  of its colour.
- **Profile header** (`.agent-profile-header`): the 96px avatar with a pencil badge (`.agent-profile-edit`, Edit agent)
  that opens Identity's editor, the `name`, Identity's character as one line cut short (`.agent-profile-character`,
  left out when blank), then the Connected status.
- **File tint** (`.agent-file-tint-*`; Agent files): each file's gradient (`--file-tint`) and shadow (`--file-shadow`),
  after Muse's file cards (Fig 16), in the agent's colours (Agent colours, below). Identity wears Soul's colours. It
  fills the file's card and its page's header tile, each with a white glyph; Soul's and Memory's glyphs are solid.
- **File cards** (`.agent-file-cards`; the Personalization tab, under the fingerprint icon): Soul and Memory side by
  side as Muse's (Fig 16). Each card is one button in its tint under a fine grain, white type: the title, under it a
  monospace hint (Values and habits, What it knows), and bottom-left a monospace count (3 lines, Empty; 3 memories, No
  memories yet), both at least 4.5:1 on the tint, measured on the rendered card. A solid heart or speech bubble sits
  bottom-right. Hover lifts the card.
- **File page** (`.agent-file`; an opened Soul or Memory card, or Identity from the pencil): Back, then the file's
  tinted tile, then the title. Under it a caption on what the file is. The content is a grouped list, as iOS Settings:
  one group, its rows split by hairlines inset to the text. Memory has one row per memory; Soul's text sits in the
  group as it is. Identity opens straight into its editor: an 80px avatar centred over its fields; Cancel, Back or
  Save returns to the tab the user was on.

## Color Palette

| Token           | CSS var                 | Use                                                                                                    |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `text`          | `--color-text`          | Primary text, primary buttons, the selected tab                                                        |
| `text-subtle`   | `--color-text-subtle`   | Picker pill text (in-input), sheet notes                                                               |
| `text-muted`    | `--color-text-muted`    | Secondary lines, placeholders, section labels, muted icons (AA on `surface`), the fallback avatar disc |
| `surface`       | `--color-surface`       | App and sidebar background, tab bar                                                                    |
| `surface-hover` | `--color-surface-hover` | Secondary buttons, icon tiles, hover states                                                            |
| `selected`      | `--color-selected`      | The open row in the phone drawer (Muse Fig 21)                                                         |
| `border`        | `--color-border`        | Borders, separators, secondary button hover, the desktop sidebar's open row                            |
| `control`       | `--color-control`       | Scrollbar thumbs, disabled send and primary buttons                                                    |
| `white`         | `--color-white`         | Cards, dropdowns, field background, the desktop sidebar (as ChatGPT's)                                 |
| `blue`          | `--color-blue`          | Checkmarks, selection, focus rings, Linked                                                             |
| `blue-soft`     | `--color-blue-soft`     | The Linked pill, the composer's sign-in chip                                                           |
| `success`       | `--color-success`       | The Connected badge                                                                                    |
| `danger`        | `--color-danger`        | Errors, failed rows, Delete, Re-link required (AA on white)                                            |
| `danger-soft`   | `--color-danger-soft`   | A failed row's icon tile, the Re-link required pill                                                    |
| `black`         | `--color-black`         | CopilotKit primary, active send button                                                                 |
| `file-pdf`      | `--color-file-pdf`      | A sent PDF's tile (white icon 4.7:1)                                                                   |
| `file-sheet`    | `--color-file-sheet`    | A sent spreadsheet's tile: CSV, XLS, XLSX (white icon 3.2:1)                                           |

The file tints are ours, after ChatGPT's coloured file tiles, not measured from it.

**Bubbles**: the chat's two bubbles, both with `text`.

| Token            | CSS var            | Use                                                                            |
| ---------------- | ------------------ | ------------------------------------------------------------------------------ |
| `bubble-user-bg` | `--bubble-user-bg` | The user's bubble, a pale tint of Marq's blue                                  |
| `bubble-marq-bg` | `--bubble-marq-bg` | Marq's bubble, white, lifted by the resting shadow it shares with the composer |

A table in Marq's reply is as wide as its content and sits flat in the bubble, with no fill or frame, only row lines;
its first and last columns line up with the text, and a table wider than the bubble fades out at each edge it can
still scroll past.

**Agent colours**: the Soul and Memory cards' colours, after Marq's avatar; a cartridge `theme` may bring its own.
Each card's white captions keep 4.5:1 on its `to`, measured on the rendered card.

| Token               | CSS var               | Use                                                                 |
| ------------------- | --------------------- | ------------------------------------------------------------------- |
| `agent-soul-from`   | `--agent-soul-from`   | Soul's tint where it lifts at the bottom right; its card's shadow   |
| `agent-soul-to`     | `--agent-soul-to`     | Soul's tint, deep under the white type on the left                  |
| `agent-soul-glow`   | `--agent-soul-glow`   | The glow in the top right corner of Soul's tint                     |
| `agent-memory-from` | `--agent-memory-from` | Memory's tint where it lifts at the bottom right; its card's shadow |
| `agent-memory-to`   | `--agent-memory-to`   | Memory's tint, deep under the white type on the left                |
| `agent-memory-glow` | `--agent-memory-glow` | The glow in the top right corner of Memory's tint                   |

## Border Radius

A panel rounds only where it reaches into the safe zone, following an iPhone's rounded screen corners, as the phone's
chat card beside the drawer does; a panel that meets no rounded corner, such as the desktop chat stage, stays square.
Controls inside a panel, such as the composer and message bubbles, keep their own radius.

| Token  | CSS var         | Use                                                                  |
| ------ | --------------- | -------------------------------------------------------------------- |
| `sm`   | `--radius-sm`   | Inline code, the sidebar's delete button                             |
| `md`   | `--radius-md`   | Header and sidebar icon buttons, the computer's window, + menu items |
| `lg`   | `--radius-lg`   | Fields, dropdowns, chat error, proposal card                         |
| `xl`   | `--radius-xl`   | Agent files' grouped lists, Plugin placeholders, the + menu          |
| `2xl`  | `--radius-2xl`  | Message bubbles, the sign-in sheet, the Scheduled sheet, file cards  |
| `3xl`  | `--radius-3xl`  | The composer                                                         |
| `4xl`  | `--radius-4xl`  | The chat card beside the phone drawer (Muse Fig 21) or profile       |
| `pill` | `--radius-pill` | Buttons, pills, tabs, scrollbar thumbs (circles: 50%)                |

## Shadows

A white surface resting on the page takes `rest`; what floats over it keeps its own.

| Token      | CSS var             | Use                                                                                                 |
| ---------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `rest`     | `--shadow-rest`     | Marq's bubble, the composer at rest, the scroll-to-bottom chevron, the Agent Computer's status pill |
| `subtle`   | `--shadow-subtle`   | The Agent Computer's desktop and touch tools                                                        |
| `elevated` | `--shadow-elevated` | Dropdowns, popovers, the Scheduled sheet, the focused composer                                      |
| `popover`  | `--shadow-popover`  | The composer's + menu (ChatGPT's)                                                                   |
| `soft`     | `--shadow-soft`     | The chat card beside the phone drawer (Muse Fig 21) or profile                                      |

## Transitions

| Token    | CSS var               | Use                                       |
| -------- | --------------------- | ----------------------------------------- |
| `fast`   | `--transition-fast`   | Hover backgrounds, opacity, color changes |
| `layout` | `--transition-layout` | Border-color, the phone chat card's slide |

## Spacing

A 4px grid, with 2px steps inside a row (the list row's 14px gap, a pill's 6px × 14px). Screens pad 20px at the side on
phones and 16–24px on desktop; sections sit 24–28px apart, rows 4–12px.
