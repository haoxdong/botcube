# BotCube DeepAgents Harness

The DeepAgents Harness is the framework swap unit behind BotCube’s
container wire contract. It owns agent composition, AG-UI serving, model
factories, prompt-cache observability, and the in-memory and AgentCore memory
backends.

Applications must configure an `HarnessCartridge` before serving. The Cartridge
supplies the tool backend, skill sources, identity behavior, invocation
environment, session binding, and bot-facing name and prompt. `build_agent`
likewise requires explicit `backend` and `skills` arguments; there are no
product defaults.

## Development

```bash
cd botcube/harness/deepagents
uv sync
uv run pytest
```

Both memory implementations expose the four documented factory slots:
checkpointer, store, memory tools, and prewarm-to-`ltm.md`. A Cartridge can use
the Harness with fake tools and an empty skill list in deterministic tests.

The serving shell implements `POST /invocations` and `GET /ping` on port 8080
per ADR 0029. Run it through a composed Cartridge entrypoint; the generic
package intentionally has no standalone bot server command.
