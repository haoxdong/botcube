# BotCube Chat Service

The Chat Service is the framework-free UI-facing peer service, written in
TypeScript (ADR 0068) on `@ag-ui/client` and Hono. It proxies the
BotCube wire contract to the configured sandbox and keeps Session Metadata,
the index of each user's Sessions. It stores no Session content: the Agent
Service's record is the only copy (ADR 0067), and the Chat Service replays and
purges a Session through the Harness's session API.

Applications compose it with a required `ChatServiceCartridge` (`src/cartridge.ts`):
a product entry point calls `serveChatService(factory)` and bundles the result. The
Cartridge supplies its auth and account routes, the account that owns a request's
Sessions, the user ID an account's Sessions are filed under, payload enrichment,
and browser-session authorization; the factory receives the account-history hooks
(deletion and Account Claim transfer). The Chat Service mounts those routes at the
root; it contains no bot-specific auth defaults.

Set `BOTCUBE_CHAT_TABLE` (default `chat`) and `AWS_DEFAULT_REGION`
(default `us-east-1`). The service uses the AWS credential chain. For local
execution, Compose supplies `AWS_ENDPOINT_URL_DYNAMODB` and dummy credentials.
Table provisioning is separate from serving; missing tables and storage failures
propagate. Set `BOTCUBE_SESSION_API_FUNCTION_ARN` to invoke the deployed
session API, or `BOTCUBE_LOCAL_SESSION_API_URL` for a local one; without
either, replay returns HTTP 503. `AWS_ENDPOINT_URL_BEDROCK_AGENTCORE` overrides
the AgentCore endpoint for invocations, warmup and live-view URLs; the generic Chat
Service tests use a local fake. From the public repository root,
`pnpm test:chat --reporter=verbose` runs generic unit tests and neutral HTTP
smoke. `pnpm test:chat:unit` runs only the generic unit tests.

Scheduled tasks (`/scheduled-tasks`, at most 10 per account) need
`BOTCUBE_SCHEDULE_GROUP`, `BOTCUBE_SCHEDULER_ROLE_ARN`,
`BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN` and `BOTCUBE_SCHEDULED_RUNS_QUEUE_URL`;
without them those routes return HTTP 503. Each task is an EventBridge
Scheduler schedule that sends `{owner, taskId}` to the queue; the service
polls it, runs the task's prompt in a fresh Side Chat, and posts the outcome
to the account's Main Chat.

The table has string `pk` and `sk` keys. Each Session has one item in its
owner's partition, `SESSIONS#<account ID>` / `SESSION#<Session ID>`, holding
its filing user ID, title (the first user message), creation time and last
activity. The partition is the owner index; it is read consistently. Account
Claim records the claimed account as `RETIRED#<account ID>` in the claiming
account's partition and moves each Session item to the claiming account; the
filing user ID stays, so no Session events move. Account/token storage uses
separate key prefixes in this shared table.

Each account has one Main Chat, recorded as `SESSIONS#<account ID>` / `MAIN`
holding its Session ID, assigned on the first `GET /main-chat`; that route
returns the ID and the replayed messages (none before its first Turn). Every
other Session is a Side Chat. `GET /threads` lists the Side Chats. The Main
Chat cannot be deleted (HTTP 409). Account Claim moves the claimed account's
Main Chat pointer only when the claiming account has none; otherwise it becomes
a Side Chat there.

`DELETE /threads/{id}` sets the Session's deletion fence (`deleted_at`, title
removed) and purges its events in the background. A fenced Session is never
listed or replayed; its item stays so a repeated delete retries the purge.
Account-history deletion fences and purges every Session the account owns,
including those under its retired IDs.

`/health` checks the Session Metadata table's readiness, key shape and read
access; unavailable storage returns HTTP 503. `/ping` remains a liveness
response.
