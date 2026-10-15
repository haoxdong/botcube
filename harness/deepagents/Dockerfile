# syntax=docker/dockerfile:1
# Build context: botcube/harness/deepagents/
# The active Cartridge stages its tool bundle before this generic image builds.
FROM public.ecr.aws/docker/library/python:3.13-slim AS base

# Node.js for a Cartridge CLI + AWS CLI for agent-browser credential resolution
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then \
      export CURL_CA_BUNDLE=/run/secrets/build_ca NODE_EXTRA_CA_CERTS=/run/secrets/build_ca APT_CONFIG=/tmp/botcube-build-apt.conf; \
      printf 'Acquire::https::CaInfo "/run/secrets/build_ca";\n' > "$APT_CONFIG"; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip p7zip-full bc ripgrep fd-find sqlite3 poppler-utils librsvg2-bin \
    libcairo2 libfreetype6 fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip && \
    unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip && \
    ln -s /usr/bin/fdfind /usr/local/bin/fd && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && rm -f /tmp/botcube-build-apt.conf

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1

WORKDIR /opt/python-tools
COPY tools/pyproject.toml tools/uv.lock ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --no-cache
COPY tools/smoke.py ./

WORKDIR /opt/browser
COPY browser/package.json browser/package-lock.json ./
COPY browser/install.mjs ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --ignore-scripts && node install.mjs /opt/browser && \
    ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then BIN=agent-browser-linux-arm64; else BIN=agent-browser-linux-x64; fi && \
    cp "/opt/browser/$BIN" /usr/local/bin/agent-browser && chmod +x /usr/local/bin/agent-browser && \
    rm -rf /opt/browser/node_modules

FROM base AS cartridge

# Install the pre-staged Cartridge CLI package
WORKDIR /opt/tools
COPY .tool-dist/ ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm install --omit=dev --ignore-scripts && npm link --ignore-scripts

# Install the Harness Python package
WORKDIR /opt/harness
COPY .tool-dist/cartridge-contract/ /cartridge/
COPY pyproject.toml uv.lock ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    touch README.md && uv sync --frozen --no-dev --no-install-project
COPY src/ ./src/
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --no-editable && \
    uv pip install --python /opt/harness/.venv/bin/python --no-deps /opt/tools/cartridge/*.whl

ENV PATH="/opt/python-tools/.venv/bin:/opt/harness/.venv/bin:$PATH"
ENV PORT=8080
EXPOSE 8080
# AgentCore runtime — serves /invocations via a hand-written FastAPI app (ADR 0029)
# with AG-UI SSE streaming; main() runs uvicorn on :8080.
CMD ["/opt/harness/.venv/bin/opentelemetry-instrument", "/opt/harness/.venv/bin/botcube-harness-deepagents"]
