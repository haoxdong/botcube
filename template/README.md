# Template Cartridge

This neutral Cartridge is both the template's hello-world and the permanent
fixture for BotCube's tests. It provides:

- a DeepAgents Harness definition with a shell backend restricted to `echo` and `template-cli data`;
- the `/auth/template` Chat Service router and local Account sessions;
- a complete default web UI plugin with neutral branding and a local sample artifact;
- a full placeholder deployment identity and a staged offline CLI;
- a fake HTTP site with a login page and authenticated data;
- no external provider, product, or AWS credentials.

Install workspace dependencies with `pnpm install --frozen-lockfile` and have
`uv` available. Run the complete stack through `../infra/local/run.sh`; it stages
the Harness CLI, Cartridge wheel and browser tools before building. Browser staging
uses `npm ci` with the shipped release lockfile and needs Node.js 24 or newer,
`npm`, and access to the npm registry or a populated npm cache. It works from
a standalone BotCube checkout. Then open
`http://localhost:3001`. The `echo` model returns the last user message without
calling an external model provider. Harness checkpoints and the Chat Service's Session Metadata
are persisted in separate local volumes.

Run `uv run template-site` to start the fake site on port 8124. Its login issues
a Durable Credential; only the Credential Service captures and decrypts it.
`python -m botcube_template.credential_service` registers the fake site beside
OpenAI. Configure `TEMPLATE_SITE_URL`, `BOTCUBE_VAULT_TABLE`,
`BOTCUBE_VAULT_KMS_KEY_ID` and `BOTCUBE_CREDENTIAL_INVOCATION_SECRET` on that service.
Its Vault is the platform's envelope-encrypted DynamoDB Vault.

The Chat Service needs `TEMPLATE_CREDENTIAL_SERVICE_URL` and the same invocation
signing secret. Open the agent profile's Sign-ins tab to link or unlink Template
site. Each browser receives an opaque local Account session cookie. These local
Account sessions expire after a day and reset when the Chat Service restarts.
The start, sign-in and complete routes bind Account Linking to that Account.
The fake site intentionally requires only a button click, with no real password.

A Turn forwards a scoped invocation binding the Account and Session. The Harness
passes only that invocation and Credential Service URL to `template-cli data`.
The Credential Service mints short-lived site access and attaches it to the data
request. Neither the CLI nor the Harness receives a site credential. Unlinking
deletes the vaulted credential; the next CLI call exits with sign-in needed.

`deploy/stage-tools.sh` stages the CLI executable and Cartridge wheel for the
Harness image. The packaged skill drives that executable. `pnpm test:chat` also
runs the template Chat Service against a real local Harness with a scripted test
model that reads the loaded skill and executes its command.

The Agent Computer is a real local Chromium browser with a private profile for
each Account's Session. The Chat Service container installs Chromium and opens
the fake site's login page when a Turn starts. The Harness receives a ten-minute
signed CDP URL bound to that Account, Session and browser instance. The Chat
Service filters cookie, storage and network-export commands and removes cookie
data from network events. Ordinary web navigation and page evaluation remain
available. Its HTTP live-view endpoint returns an owner-authorized browser image.

A computer sleeps after ten idle minutes. A Turn or permitted CDP command
refreshes its idle timer. Reading state or polling images does not. Retirement
closes CDP channels, removes the private profile and invalidates the old signed
CDP URL. State then returns `asleep`; the image endpoint returns HTTP 409 until
the computer wakes again. Stopping the Chat Service also cancels pending startup
and puts its computers to sleep.

For a process-based local run, set `TEMPLATE_SITE_URL` and
`TEMPLATE_CHROMIUM_PATH` on the Chat Service. Set `TEMPLATE_COMPUTER_CDP_URL`
when the Harness reaches it through a different hostname. Compose uses
`ws://chat-service:8123/agent-computer/cdp`. The live-view URL uses the platform's
`signedUrl` response field and still requires the owning Account's cookie.
The template does not provide local Take-over. This browser adapter establishes
offline behavior; AWS browser deployment acceptance remains a separate check.

To rename the bot or configure deployment inputs, follow [Customize the template identity](IDENTITY.md).

A confirmed scheduled task uses its owner’s site link. If that link has been
unlinked, Main Chat reports that the task could not finish and the composer
shows Sign in needed. Completing sign-in clears the chip. The local failure
indicator resets when the Chat Service restarts, like local Account sessions.

`pnpm test:chat tests/chat/template-stack.test.ts --reporter=verbose` exercises
the scheduled proposal, HTTP confirmation, local queue delivery, CLI data read,
and unlinked refusal with stand-ins. The scripted model is a test fixture; the
local echo model does not propose tool calls.
