# Design-system registry

The one source of the web UI's tokens and parts ([ADR 0094](../../../../../docs/adr/0094-web-ui-is-built-from-one-design-system-registry.md)); the maintainer owns this folder.

- `tokens.css`: every token, the safe-area insets included. Nothing else reads the raw `env(safe-area-inset-*)`.
- `components.ts`: the components list, a typed TypeScript array, one row per part: `name`, `kind` (`stock` from shadcn or AI Elements, unedited, or `ours`), its one `file`, and for ours the names of its whole-app `stories`, which each bot's Storybook runs at 390 with iPhone 15 insets and at 1440, and the DESIGN.md Intended lines it owns. A row's `marks` say what a copy of it looks like; its `exceptions` name today's copies, by file, with the ticket that removes each. `TOKENS` is the tokens' row, apart from the parts; `UNLISTED` names today's UI files outside any row.
- `one-source.ts`: the check, run by `one-source.test.ts` in the `static` suite. It fails a listed part's mark outside its file and exceptions, naming the part; UI (a stylesheet or a `src/components` component) outside a listed part and `UNLISTED`; and an exception whose copy is gone.
- `screens.ts`: the iPhone 15 and 1440 screens the whole-app stories run at (`.storybook/screen.ts`).
