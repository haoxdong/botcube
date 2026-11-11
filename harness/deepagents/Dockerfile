# syntax=docker/dockerfile:1
# Build context: botcube/harness/deepagents/
# The active Cartridge stages its tool bundle before this generic image builds.
FROM public.ecr.aws/docker/library/rust:1.88-slim-bookworm AS efs-utils
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

FROM public.ecr.aws/docker/library/python:3.13-slim AS base
COPY --from=efs-utils /efs-utils/build/amazon-efs-utils*.deb /tmp/

# Node.js for a Cartridge CLI + AWS CLI for agent-browser credential resolution
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then \
      export CURL_CA_BUNDLE=/run/secrets/build_ca NODE_EXTRA_CA_CERTS=/run/secrets/build_ca APT_CONFIG=/tmp/botcube-build-apt.conf; \
      printf 'Acquire::https::CaInfo "/run/secrets/build_ca";\n' > "$APT_CONFIG"; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends /tmp/amazon-efs-utils*.deb nfs-common openssl curl ca-certificates unzip p7zip-full bc ripgrep fd-find sqlite3 poppler-utils librsvg2-bin \
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
COPY tools/smoke.py tools/botcube_plotly.py ./
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

WORKDIR /opt/tools
COPY .tool-dist/ ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; \
    else test -f pnpm-lock.yaml && test -d node_modules; fi && \
    node -e 'const fs = require("node:fs"); const path = require("node:path"); for (const [name, target] of Object.entries(require("./package.json").bin)) fs.symlinkSync(path.resolve(target), path.join("/usr/local/bin", name));'

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
ENV BOTCUBE_WORKSPACE=/mnt/workspace/files
RUN mkdir -p /mnt/workspace/files && rm -f /tmp/amazon-efs-utils*.deb
EXPOSE 8080
# AgentCore runtime — serves /invocations via a hand-written FastAPI app (ADR 0029)
# with AG-UI SSE streaming; main() runs uvicorn on :8080.
CMD ["/opt/harness/.venv/bin/opentelemetry-instrument", "/opt/harness/.venv/bin/botcube-harness-deepagents"]
