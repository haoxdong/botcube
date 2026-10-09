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

## Run preinstalled file tools locally

From the repository root, prepare the independent tools environment and run its
export smoke. Install the Dockerfile's system tools and Noto fonts on your host
before running the smoke.

```bash
uv sync --project botcube/harness/deepagents/tools --frozen
botcube/harness/deepagents/tools/.venv/bin/python botcube/harness/deepagents/tools/smoke.py /tmp/exports
```

The Harness keeps its own Python environment. Its subprocesses select the tools
environment through PATH. Cartridge export tests supply this PATH explicitly.

## Shell execution limits

The shell worker drains stdout and stderr while retaining bounded buffers. On an
ordinary timeout or capture failure, it terminates command descendants: Linux
uses an invocation-local subreaper; other hosts use the command's process group.
Successful commands may leave background work running.

The backend adds no syscall restriction policy. The Runtime microVM provides
isolation; the worker is not an isolation mechanism. Cleanup is not guaranteed
if a command terminates or suspends its worker or hosting Harness. Direct local
servers and local Docker/test workers execute on their host without that Runtime
microVM boundary.
