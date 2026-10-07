# Build context: botcube/harness/deepagents/
# The active Cartridge stages its tool bundle before this generic image builds.
FROM public.ecr.aws/docker/library/python:3.13-slim

# Node.js for a Cartridge CLI + AWS CLI for agent-browser credential resolution
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip && \
    unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip && \
    apt-get purge -y unzip && apt-get autoremove -y && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Install the pre-staged Cartridge CLI package
WORKDIR /opt/tools
COPY .tool-dist/ ./
RUN npm install --omit=dev --ignore-scripts && npm link --ignore-scripts

# Install an optional agent-browser binary supplied by the Cartridge.
# Both x64 and arm64 binaries may be staged; pick the one matching the container arch.
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then BIN="agent-browser-linux-arm64"; \
    else BIN="agent-browser-linux-x64"; fi && \
    if [ -f "/opt/tools/$BIN" ]; then \
      cp "/opt/tools/$BIN" /usr/local/bin/agent-browser && chmod +x /usr/local/bin/agent-browser; \
    fi

# Install the Harness Python package
WORKDIR /opt/harness
COPY pyproject.toml uv.lock ./
RUN touch README.md && uv sync --frozen --no-dev --no-install-project
COPY src/ ./src/
RUN uv sync --frozen --no-dev --no-editable
RUN uv pip install --python /opt/harness/.venv/bin/python --no-deps /opt/tools/cartridge/*.whl

ENV PATH="/opt/harness/.venv/bin:$PATH"
ENV PORT=8080
EXPOSE 8080
# AgentCore runtime — serves /invocations via a hand-written FastAPI app (ADR 0029)
# with AG-UI SSE streaming; main() runs uvicorn on :8080.
CMD ["opentelemetry-instrument", "botcube-harness-deepagents"]
