# BotCube

BotCube is the generic agent application foundation. Its web UI lives in
`ui/web/` and runs either with neutral defaults or with a Cartridge UI plugin.

This repository is a one-way publish mirror and forkable template. Development
happens in its private source monorepo; use this repository as the starting
point for a new application rather than as an independent development line.

## Wire Contract

Every Harness exposes the sandbox-neutral container contract on port 8080:

- `POST /invocations` streams AG-UI server-sent events.
- `GET /ping` reports container health.

The peer `chat/` project (TypeScript) is the UI-facing durable center. It exposes invoke
passthrough at `POST /`, Session listing, replay and deletion at `GET /threads`,
`GET /threads/{id}` and `DELETE /threads/{id}`, `POST /warmup`, authentication routes, and browser
live-view URL signing. `BOTCUBE_LOCAL_HARNESS_URL` selects plain HTTP to a
local Harness; otherwise the Chat Service signs AgentCore invocations with SigV4.
The Chat Service keeps only Session Metadata; it replays and purges Sessions through the
Harness's session API, so it never imports a framework.

## Web UI Cartridge contract

The typed contract is exported from `ui/web/src/cartridge/index.ts`. A web UI
plugin supplies six extension points:

- `config`: agent ID, Chat Service URL, browser storage key, and user-facing copy
- `toolResultRenderers`: optional tool-result renderers mounted in the chat
- `auxiliaryPanels`: optional panel hosts such as a live browser view
- `AuxiliaryView`: an optional standalone view for a panel pop-out route
- `AuthProvider`: account/session UI state and any authentication overlay
- `theme`: optional CSS custom-property values over the shell's tokens

The shell itself ships the rest: the effort levels the harness takes, reply file
links and composer uploads through the Chat Service's Files routes, the Agent
Computer's stylesheet, and the Soul and Memory card colours.

The template imports the selected plugin only through `@cartridge-ui`.
`ui/web/src/cartridge/default.tsx` is the neutral standalone implementation.
Set `CARTRIDGE_UI_PACKAGE` to a plugin package at build time to bind a
Cartridge. A cartridge that needs bundler configuration may also provide a
repository-relative module through `CARTRIDGE_UI_BUILD_CONFIG`. Plugins may
import this typed contract, but not template internals.

Storybook verification requires a repository-relative CommonJS module named by
`CARTRIDGE_STORYBOOK_BUILD_CONFIG`, and fails to start without it. It receives `{ appRoot, repoRoot }` and
returns optional `stories` (globs relative to the Cube `.storybook` directory),
`previewAnnotations` (absolute module paths), `staticDirs` (Storybook entries),
and `aliases` (bundler replacements). Keep product stories and fixtures in the
Cartridge. The `botcube-ui-web/storybook-page` export exposes the complete page
for verification; runtime plugins still bind only to the typed contract.

The build-config module must have a callable default/CommonJS export with this
shape:

```ts
({ appRoot, repoRoot }: { appRoot: string; repoRoot: string }) => ({
  cartridgeUiEntry?: string;
  transpilePackages?: string[];
  turbopackAliases?: Record<string, string>;
  webpackAliases?: Record<string, string>;
})
```

All returned fields are optional; paths should be absolute or resolvable from
the repository root. `cartridgeUiEntry` is the plugin's resolved entry file,
which `@cartridge-ui` then points at, because the template does not declare the
plugin package as a dependency. A build-config hook may materialize generated public
assets under `appRoot`; the Cartridge must not assume the template's repository
path.

## Harness and memory Cartridge contract

A Cartridge exposes a framework-neutral Harness definition through the
`botcube.cartridge` Python entry-point group. It supplies skills, agent
identity and copy, invocation identity handling, a shell environment, root
preparation, and the per-request session variable. A Harness
adapts those values to its own framework; Cartridge code never imports an agent
framework.

Every Harness memory backend provides three plain factory slots:

- `build_checkpointer` for conversation continuity;
- `build_store` for long-term records;
- `build_memory_tools` for the model-visible memory surface and middleware,
  including the middleware that loads Memory into a Session's system prompt once.

The in-memory backend is the credential-free presubmit default. Local sandbox
mode sets `BOTCUBE_CHECKPOINT_PATH` and uses SQLite so a replacement Harness
process resumes the same Session. Like AgentCore, it addresses a Session by (user ID,
Session ID): each user ID gets its own SQLite file. AgentCore supplies its own implementations
of the same three slots.

## Chat Service, tools, and deployment Cartridge contract

A Cartridge's Chat Service half is a TypeScript package whose entry point passes a
`CartridgeFactory` (`chat/src/cartridge.ts`) to `serveChatService`; a bundler
binds it at build time (`templates/always-on/chat/` is the template). The Chat Service mounts
the Cartridge's routes, delegates request identity, Session ownership, filing IDs,
invocation-payload policy and live-view authorization, hands the Cartridge its
account-history hooks, and keeps Session Metadata private. The generic Chat Service
contains no product routes or identity, and no harness-library code.

Container tool installation is owned by the Cartridge's `deploy/stage-tools.sh`
hook. Deployment names and provider values live under the Cartridge's `deploy/`
directory and are injected into BotCube; no product default is allowed in
the cube.

## Run the template

`templates/always-on/` is both the hello-world Cartridge and the cube test fixture. Run
`infra/local/run.sh -d`, then `infra/local/smoke.sh`, and open
`http://localhost:3001`. The template uses a credential-free echo model, an
echo-only tool backend, a placeholder auth router and UI brand, SQLite
checkpoints, and the Chat Service's Session Metadata. The automated local contract replaces the
Harness process between turns and verifies resumption.

## Owner Plan Usage sign-in

Run `uv run --project credential-service botcube-openai-plan-usage`
with `--account`, `--url`, `--secret-id`, `--region`, and a consistent
`--agent-name` that identifies the environment, such as `BotCube Production`
or `BotCube Local`. Local experiments use the same local target and name each
time. Sign-in needs the owner's browser on the machine running the command.

The first sign-in registers a ChatGPT app. Later runs reuse its
issued client ID. Registration metadata lives under
`${XDG_CONFIG_HOME:-~/.config}/botcube/openai-plan-usage/`, keyed by issuer,
resource, target URL and Account. Keep that directory between runs and back it
up. It contains the client ID, verified subject and stable host ID; refresh
tokens remain in the Credential Service. Changing `--agent-name` does not rename
an existing registration. Use a distinct target URL for each environment.

`--remove` revokes stored Plan Usage without opening a browser and keeps the
registration for future sign-ins. To drop the app's ChatGPT plan grant as well,
open ChatGPT Settings > Security > Sign in with ChatGPT and click Remove access
for that environment's app. Before removing any old app, map its client ID to
the credential it backs; removing production's grant interrupts its plan models.
Do not delete registration metadata to sign out, since the next run would
register another app.

The first run after upgrading from per-run registration needs the owner's
browser to establish the saved registration. Keep the current production grant
until the replacement sign-in has succeeded and its plan models work. Existing
ChatGPT app entries are not removed automatically.
