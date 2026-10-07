# BotCube Context

BotCube is the generic agentic-chat platform that bots fork; a Cartridge seated in it decides which bot it is. Its relationships to the other contexts are in [GLOSSARY-MAP.md](../GLOSSARY-MAP.md).

## Language

**BotCube**:
The generic agentic-chatbot platform, free of any bot identity, that new bots fork. It holds the Chat Service, the Harnesses, white-label UI templates, per-host infrastructure, and an example Cartridge.
_Avoid_: AgentCradle (former name), agentstack, the stack, console

**Cartridge**:
The pluggable unit seated in BotCube that answers "which bot is this?": skills, tool staging, auth routes, deploy identity, and UI plugins. It holds no harness-library code, so one Cartridge runs on any Harness. A Cartridge's folder is named for its bot, such as `botcube/template/`.
_Avoid_: Bot Definition, app, bot config, plugin (that is only its UI part)

**Harness**:
A complete agent implementation on one third-party harness library, such as deepagents with LangGraph, together with everything coupled to that library, such as memory backends and LLM provider factories. It is swapped whole, never in place, and lives in `botcube/harness/<library>/`.
_Avoid_: Agent Service (former name), agent server, runtime, agent (bare), test harness (a test double is a Fake)

**Chat Service**:
The UI-facing service and durable center: it holds Session Metadata, mounts the Cartridge's account routes, and reaches the agent. It never runs the agent and holds no harness-library code, so it survives any Harness swap.
_Avoid_: Backend, middleware, gateway, chat server

**Session**:
A multi-turn exchange between a user and the agent, owned by one Account, and its one persisted record of the agent's context, which serves both resume and replay. The Harness persists it in its library's format, so a Session stays on the harness library that started it.
_Avoid_: conversation, thread (except as the wire field), chat, checkpoint, STM, session history, Journal

**Session Metadata**:
The Chat Service's lookup record for one Session — owner, title, last activity, and deletion state — used for listing, owner changes, and deletion. For the Activity it also keeps each finished Turn's completion time, request's first line, and summary (ADR 0067 §2); it holds no transcript.
_Avoid_: Journal, session history, session index, thread table

**Account**:
The identity every visitor of a BotCube app has from their first visit, anonymous until a login-capable Sign-in claims it. Sessions and Sign-ins belong to it.
_Avoid_: user account, login, profile

**Sign-in**:
An Account's link to the user's identity at one provider, unique on that identity; an Account holds many. Its provider is an identity provider (identity only, such as Google or Apple), a plan provider (identity plus Plan Usage, such as OpenAI), or a site provider (a Cartridge's own site, whose login also sets up that site's Connector). An app designates which providers are login-capable: their Sign-ins log the user in and recover the Account.
_Avoid_: connection, integration, linked account, login (bare)

**Plan Usage**:
The user's paid AI plan at a plan provider paying for their Account's model calls, in place of the platform's own inference.
_Avoid_: API key, inference credential, bring your own key, Model Subscription

**Connector**:
An Account's link to an outside service the agent uses on the user's behalf, such as Gmail; an Account holds many. A Connector never logs the user in or claims an Account; a site provider's login also sets up that site's Connector.
_Avoid_: Sign-in, integration, plugin (that is a Cartridge's UI part)

**Durable Credential**:
A Sign-in's or Connector's long-lived credential, which alone renews its short-lived access with no password or MFA, such as a plan provider's refresh token, which is replaced on every use.
_Avoid_: refresh token (unqualified), the cookie

**Credential Service**:
The isolated service that alone can decrypt Durable Credentials. It attaches short-lived access to the calls the agent sends through it, to Connectors' services and to plan providers' models, so the agent never holds a Durable Credential.
_Avoid_: Credential Broker, auth service, credential store (that is the Vault), proxy

**Vault**:
The per-Account encrypted store of every Sign-in's and Connector's Durable Credential, one per provider, which only the Credential Service can decrypt.
_Avoid_: cookie store, database, keychain

**Turn**:
One user message and the agent's complete response within a Session.
_Avoid_: run, invocation

**Activity**:
The owner's list of answered Turns across their Sessions, most recent first.
_Avoid_: history, task log

**Memory**:
What the agent knows about a user across Sessions.
_Avoid_: long-term memory, LTM, store, memory records, AgentCore Memory

**Pending Memory**:
What the user asked the agent to remember that is not yet consolidated into Memory. The agent reads it back directly, so a new Session sees it right away.
_Avoid_: journal, memory journal, recent saves

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
The one lasting Session every user account has, where the user lands and where scheduled results arrive.
_Avoid_: default thread, home chat, inbox

**Side Chat**:
Any Session other than the Main Chat, started by the user to keep a topic apart.
_Avoid_: thread, conversation, sub-chat

**Soul**:
The values and habits the agent holds to in every Session. It starts from a template the Cartridge ships, and the user and agent can both change it per user account.
_Avoid_: system prompt, persona file, skills (those hold the bot's rules)

**Agent Identity**:
The name, character, and look a user gives their agent, starting from the Cartridge's defaults. It is distinct from Soul and from the user's own account.
_Avoid_: identity (bare), profile, bot name
