# BotCube Context

BotCube is the generic agentic-chat platform that each bot deploys and configures: a bot is a Bot Image, and each deployment of it is one BotCube Config. Its relationships to the other contexts are in [GLOSSARY-MAP.md](../GLOSSARY-MAP.md).

## Language

**BotCube**:
The generic agentic-chatbot platform, free of any bot identity, that each bot deploys and configures rather than extends with code. It holds the Chat Service, the Harnesses, the white-label UI, per-host infrastructure, and a public and an enterprise example.
_Avoid_: AgentCradle (former name), agentstack, the stack, console, framework, Cartridge (retired: a bot is configuration, not plug-in code), Always On (retired: an example, not a term)

**Bot Image**:
The container image a bot's author builds on a Harness image, holding the bot's Skills, files and its settings file, `bot.yaml`. It is the bot: every deployment of it runs the same image.
_Avoid_: Cartridge (retired), bot package, custom image

**BotCube Config**:
`botcube.yaml`, the one file an operator writes for one deployment: which Bot Image runs, the integrations it uses, the existing resources it is given and its network.
_Avoid_: config (bare), environment, env file, manifest, integrator (say operator)

**Harness**:
A complete agent implementation on one third-party harness library, such as deepagents with LangGraph, together with everything coupled to that library, such as memory backends and LLM provider factories. It is swapped whole, never in place, and lives in `botcube/harness/<library>/`.
_Avoid_: Agent Service (former name), agent server, runtime, agent (bare), test harness (a test double is a Fake)

**Chat Service**:
The UI-facing service and durable center: it holds Session Metadata and reaches the agent. It never runs the agent and holds no harness-library code, so it survives any Harness swap.
_Avoid_: Backend, middleware, gateway, chat server

**Session**:
One User's ongoing exchange with the agent, identified by its Session ID and owned by that User, with one writer at a time. Main Chat and Side Chat are Sessions. It is LangGraph's thread, and it stays on the harness library that started it.
_Avoid_: conversation, thread (except as the wire field), chat, checkpoint (the Harness's internal saved state), STM, Journal

**Transcript**:
A Session's full record of its messages, which replay shows and resume continues. Compaction never shortens it. It is stored in AgentCore Memory's short-term memory.
_Avoid_: session history, rollout, checkpoint, STM

**Context**:
What the model is sent for its next call: the Transcript after compaction, with the system prompt and Memory reads, bounded by the model's context window. A project's glossary scope is a bounded context, never bare Context.
_Avoid_: effective history, prompt, history

**Session Metadata**:
The Chat Service's lookup record for one Session — owner, title, last activity, and deletion state — used for listing, owner changes, and deletion. For the Activity it also keeps each finished Turn's completion time, request's first line, and summary (ADR 0067 §2); it holds no Transcript.
_Avoid_: Journal, session history, session index, thread table

**User**:
A person using a bot: a Guest until Saving. Sessions, Sign-ins and Linked Accounts belong to them.
_Avoid_: account (except a person's account at an outside provider), user account, login, profile, actor, anonymous user

**Guest**:
A User with no login-capable Sign-in yet, held by one browser. Its Sessions and Linked Accounts are kept like any User's; a Guest never saved is deleted after a period of inactivity.
_Avoid_: anonymous user, visitor, temporary account, temporary chat

**Saving**:
Adding a Guest's first login-capable Sign-in. The User stays the same, so nothing moves.
_Avoid_: upgrade, claim, migration

**User ID**:
The identifier of one User, and one of the only two identifiers that cross from the bot to AgentCore, where it is `actorId`. Every other user-related identifier stays inside the bot.
_Avoid_: account ID, filing user ID, filing account ID, actor ID (AgentCore's field name only), owner ID, principal

**Session ID**:
The identifier of one Session, a server-issued UUID, and the other identifier that crosses to AgentCore, where it is `sessionId` (Memory) and `runtimeSessionId` (Runtime). It is used unchanged for the Session's record, its Sandbox and its prompt-cache scope.
_Avoid_: chat ID, conversation ID, thread ID (except as the wire field), runtime session ID, runtime binding, generation

**Test User**:
A User created only through an operator-only path for tests (isolation checks, Memory tests, the census, live checks), never through the public bot. It has no Sign-in, so it can never log in or be recovered. It may hold its owner's site-provider Linked Account credential, copied into its own Vault entry at the start of each run and revoked when the owner unlinks, so it tests with the owner's access. The check that creates it deletes it, copy included.
_Avoid_: anonymous account, throwaway account, service account

**Sign-in**:
A User's link to their identity at one provider, unique on that identity; a User holds many. Its provider is an identity provider (identity only, such as Google or Apple), a plan provider (identity plus Plan Usage, such as OpenAI), or a site provider (a bot's own site, whose login also sets up that site's Linked Account). A bot designates which providers are login-capable: their Sign-ins log the user in and recover the Account.
_Avoid_: connection, integration, Linked Account (an account the agent acts with), login (bare)

**Plan Usage**:
The user's paid AI plan at a plan provider paying for their model calls, in place of the platform's own inference.
_Avoid_: API key, inference credential, bring your own key, Model Subscription

**Linked Account**:
A User's account at an outside site, which the agent acts with on their behalf, such as their Gmail or GitHub account; a User holds many, and an outside account links to one User. A Linked Account never logs the user in; a site provider's login also sets up that site's Linked Account.
_Avoid_: Connector (that is how the agent reaches a service), Sign-in, connection, integration

**Durable Credential**:
A Sign-in's or Linked Account's long-lived credential, which alone renews its short-lived access with no password or MFA, such as a plan provider's refresh token, which is replaced on every use.
_Avoid_: refresh token (unqualified), the cookie

**Credential Service**:
The isolated service that alone can decrypt Durable Credentials. It attaches short-lived access to the calls the agent sends through it, to Linked Accounts' services and to plan providers' models, so the agent never holds a Durable Credential.
_Avoid_: Credential Broker, auth service, credential store (that is the Vault), proxy

**Vault**:
The per-User encrypted store of every Sign-in's and Linked Account's Durable Credential, one per provider, which only the Credential Service can decrypt.
_Avoid_: cookie store, database, keychain

**Turn**:
One user message and the agent's complete response within a Session.
_Avoid_: run, invocation

**End-to-end Latency**:
A Turn's time from the Chat Service receiving the user's message to the agent's last token, reported at p50 and p95. It is exactly Orchestration Overhead + Inference Latency + Tool Latency.
_Avoid_: response time, TTFT (one model call's first token)

**Orchestration Overhead**:
The part of End-to-end Latency spent outside model calls and tools: loading and saving the Session, Memory reads, credential fetches, admission, and the hops between them. The goal keeps it under 1 s per Turn, cold and warm.
_Avoid_: pre-dispatch stall, receipt-to-dispatch, harness overhead

**Inference Latency**:
Time a model call takes from leaving the agent to its last token, including the Credential Service's hop to the provider. Its first part is the call's TTFT, OpenTelemetry's `gen_ai.server.time_to_first_token`.
_Avoid_: model step, LLM time

**Tool Latency**:
Time a tool runs, from the agent's call to its result, OpenTelemetry's `execute_tool` span.
_Avoid_: tool step

**Activity**:
The owner's list of answered Turns across their Sessions, most recent first.
_Avoid_: history, task log

**Memory**:
What the agent knows about a User across Sessions: Written Memory and Extracted Memory.
_Avoid_: long-term memory, LTM, store, memory records, AgentCore Memory, agent-owned memory

**Written Memory**:
The User's `AGENTS.md` in their Files, which the agent and the User both write and the agent reads verbatim when a Session starts. It is deep agents' memory.
_Avoid_: notes, agent notes

**Extracted Memory**:
Facts and preferences the agent derives in the background from past Turns and explicit saves, found by search and not shown to the User. It is AgentCore Memory's long-term memory.
_Avoid_: LTM, auto-generated memory, Recall, Pending Memory

**Sandbox**:
The disposable compute that runs the Harness for one Session. Losing it costs only a cold start.
_Avoid_: runtime session, session, VM

**Agent Computer**:
The cloud machine the agent works in during a Session, such as its browser, which the user can watch and take over. It is distinct from the Sandbox that runs the Harness.
_Avoid_: browser panel, cloud desktop, VM, browser session

**Take-over**:
The user taking control of the Agent Computer while the agent pauses and sees nothing, until the user hands control back.
_Avoid_: takeover mode, manual mode, remote control

**Main Chat**:
The one lasting Session every User has, where the user lands and where scheduled results arrive.
_Avoid_: default thread, home chat, inbox

**Side Chat**:
Any Session other than the Main Chat, started by the user to keep a topic apart.
_Avoid_: thread, conversation, sub-chat

**Soul**:
The values and habits the agent holds to in every Session. It starts from a template the bot's configuration sets, and the user and agent can both change it per User.
_Avoid_: system prompt, persona file, skills (those hold the bot's rules)

**Agent Identity**:
The name, character, and look a user gives their agent, starting from the defaults the bot's configuration sets. It is distinct from Soul and from the User.
_Avoid_: identity (bare), profile, bot name

**Artifact**:
What the agent publishes for the User to keep, revise or pass on, with its own identity across Artifact Versions, shown as a web page. The reply shows it as a card, not inline; the User can edit it in place and download Exports of it.
_Avoid_: Report, document, long answer, canvas, page (bare), file

**Artifact Type**:
A ready-made format an Artifact can be written in, which fixes how it is edited and exported: Doc, Slides, Sheet or Email, with Data planned. An Artifact without one is the agent's own HTML.
_Avoid_: kind, template, Web Page

**Source**:
The files of an Artifact that the agent writes and the User's edits save to. Each Artifact Version is one saved state of its Source.
_Avoid_: raw file, content, data

**Viewer**:
What shows an Artifact's Source in the panel and edits it in place, one kind for each Artifact Type and one for an Artifact without a type. It keeps nothing of its own.
_Avoid_: renderer, preview, editor

**Export**:
A Word, PowerPoint, Excel, PDF or email file made from one Artifact Version when the User downloads it. It is not an Artifact.
_Avoid_: conversion, rendition, attachment

**Artifact Version**:
One saved state of an Artifact, made each time the agent publishes it or the User saves an edit.
_Avoid_: revision, snapshot, draft

**Visual**:
A chart, diagram, drawing or picture the agent embeds in a reply. It is the agent's own work, distinct from content a tool returns, and is not an Artifact.
_Avoid_: chart (bare), artifact, plot

## Apps

**App**:
Anything on a bot's Apps tab that extends what the agent can do: a Plugin, a Connector, a Terminal App or a Skill. One may require a Linked Account.
_Avoid_: plugin (that is a bundle), integration, extension, tool (the agent's tool calls)

**Plugin**:
Two or more Connectors, Terminal Apps or Skills shipped together and shown as one App, such as a site's Terminal App with the Skill that teaches it.
_Avoid_: bundle, package, extension

**Connector**:
An outside service the agent reaches over MCP, such as Gmail.
_Avoid_: MCP server (the protocol's name for it), integration, Linked Account

**Terminal App**:
A program on the Agent Computer that the agent runs from its shell.
_Avoid_: CLI, command-line tool, computer app, package

**Skill**:
Written instructions that teach the agent a workflow; it brings no tools and no account of its own.
_Avoid_: prompt, Soul (the agent's values), instructions (bot-wide)
