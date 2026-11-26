# Build context: botcube/
ARG REGISTRY=public.ecr.aws
FROM ${REGISTRY}/docker/library/rust:1.88-slim-bookworm AS efs-utils
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then \
      export CURL_CA_BUNDLE=/run/secrets/build_ca APT_CONFIG=/tmp/efs-build-apt.conf CARGO_HTTP_CAINFO=/run/secrets/build_ca; \
      printf 'Acquire::https::CaInfo "/run/secrets/build_ca";\n' > "$APT_CONFIG"; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates pkg-config libssl-dev build-essential cmake golang-go gettext-base && \
    curl -fsSL https://github.com/aws/efs-utils/archive/2341e82db7e1dec6060ede910d16a8a446f3597f.tar.gz -o /tmp/efs.tar.gz && \
    echo '705b25f84905504e254312949c0a2e1d3d8d0dce37afee3841846d6c844aeda9  /tmp/efs.tar.gz' | sha256sum -c - && \
    mkdir /efs-utils && tar -xzf /tmp/efs.tar.gz -C /efs-utils --strip-components=1 && \
    cd /efs-utils && ./build-deb.sh

FROM ${REGISTRY}/docker/library/python:3.13-slim AS base
COPY --from=efs-utils /efs-utils/build/amazon-efs-utils*.deb /tmp/

# Node.js for a bot CLI + AWS CLI for agent-browser credential resolution
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then \
      export CURL_CA_BUNDLE=/run/secrets/build_ca NODE_EXTRA_CA_CERTS=/run/secrets/build_ca APT_CONFIG=/tmp/botcube-build-apt.conf; \
      printf 'Acquire::https::CaInfo "/run/secrets/build_ca";\n' > "$APT_CONFIG"; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends /tmp/amazon-efs-utils*.deb nfs-common openssl curl ca-certificates unzip p7zip-full bc ripgrep fd-find git sqlite3 poppler-utils librsvg2-bin \
    libcairo2 libfreetype6 fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip && \
    unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip && \
    ln -s /usr/bin/fdfind /usr/local/bin/fd && \
    git config --system user.name BotCube && \
    git config --system user.email botcube@noreply.invalid && \
    git config --system --add safe.directory /mnt/workspace/files && \
    git config --system --add safe.directory '/mnt/workspace/files/*' && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && rm -f /tmp/botcube-build-apt.conf

# uv from PyPI, so every image comes from the one registry.
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install --no-cache-dir uv==0.12.19
ENV UV_COMPILE_BYTECODE=1

WORKDIR /opt/python-tools
COPY harness/deepagents/tools/pyproject.toml harness/deepagents/tools/uv.lock ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --no-cache
COPY harness/deepagents/tools/smoke.py harness/deepagents/tools/botcube_plotly.py ./
# Every figure the agent saves carries BotCube's chart look as plotly.py's default template (DESIGN.md, Charts).
RUN SITE=$(.venv/bin/python -c 'import sysconfig; print(sysconfig.get_path("purelib"))') && \
    mv botcube_plotly.py "$SITE"/ && echo 'import botcube_plotly' > "$SITE"/botcube_plotly.pth && \
    .venv/bin/python -c "from plotly import io; assert io.templates.default == 'botcube', io.templates.default"
# Build matplotlib's font cache now, or each cold microVM's first chart builds it.
# Matplotlib ignores a config dir it cannot write, so it stays writable for any user.
ENV MPLCONFIGDIR=/var/cache/matplotlib
RUN /opt/python-tools/.venv/bin/python -c "import matplotlib.pyplot" && \
    ls "$MPLCONFIGDIR"/fontlist-*.json && chmod -R a+rwX "$MPLCONFIGDIR"

WORKDIR /opt/browser
COPY harness/deepagents/browser/package.json harness/deepagents/browser/package-lock.json ./
COPY harness/deepagents/browser/install.mjs ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --ignore-scripts && node install.mjs /opt/browser && \
    ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then BIN=agent-browser-linux-arm64; else BIN=agent-browser-linux-x64; fi && \
    cp "/opt/browser/$BIN" /usr/local/bin/agent-browser && chmod +x /usr/local/bin/agent-browser && \
    rm -rf /opt/browser/node_modules

# The checker the Artifact tool runs on publish (artifact-check), and the `artifacts` skill beside it that the agent
# reads through the Harness (artifact.SKILLS). scripts/checks/artifact-check-lock.mjs checks package-lock.json
# against botcube/pnpm-lock.yaml so the image runs the same versions as the tests.
WORKDIR /opt/artifact-check
COPY harness/deepagents/artifact-check/package.json harness/deepagents/artifact-check/package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --ignore-scripts
COPY harness/deepagents/artifact-check/src/ ./src/
COPY harness/deepagents/artifact-check/skills/ ./skills/

# BotCube's Harness image, with no bot: a bot's image builds FROM it with its settings and skills (examples/bot/Dockerfile).
FROM base AS harness

WORKDIR /opt/harness
COPY harness/deepagents/pyproject.toml harness/deepagents/uv.lock ./
COPY config/pyproject.toml config/bot.schema.json /config/
COPY config/src/ /config/src/
COPY credential-source/ /credential-source/
COPY endpoint-tls/ /endpoint-tls/
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    touch README.md && uv sync --frozen --no-dev --no-install-project
COPY harness/deepagents/src/ ./src/
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --no-editable

ENV PATH="/opt/python-tools/.venv/bin:/opt/harness/.venv/bin:$PATH"
ENV PORT=8080
ENV BOTCUBE_WORKSPACE=/mnt/workspace/files
RUN mkdir -p /mnt/workspace/files && rm -f /tmp/amazon-efs-utils*.deb
EXPOSE 8080
# AgentCore runtime — serves /invocations via a hand-written FastAPI app (ADR 0029)
# with AG-UI SSE streaming; main() runs uvicorn on :8080.
CMD ["/opt/harness/.venv/bin/opentelemetry-instrument", "/opt/harness/.venv/bin/botcube-harness-deepagents"]
