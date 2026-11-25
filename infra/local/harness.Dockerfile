# BotCube's local Harness image, with no bot: a bot's image builds FROM it (examples/bot/Dockerfile).
ARG REGISTRY=public.ecr.aws
FROM ${REGISTRY}/docker/library/node:24-bookworm-slim AS browser
WORKDIR /opt/browser
COPY harness/deepagents/browser/ ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm ci --omit=dev --ignore-scripts && node install.mjs /opt/browser && rm -rf node_modules
FROM ${REGISTRY}/docker/library/python:3.13-slim

RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
  pip install --no-cache-dir uv==0.12.19
COPY --from=browser /opt/browser/ /opt/browser/
RUN ARCH=$(dpkg --print-architecture) && \
  if [ "$ARCH" = "arm64" ]; then BIN=agent-browser-linux-arm64; else BIN=agent-browser-linux-x64; fi && \
  cp "/opt/browser/$BIN" /usr/local/bin/agent-browser && chmod +x /usr/local/bin/agent-browser

WORKDIR /opt/harness
COPY credential-source/ /credential-source/
COPY harness/deepagents/ ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv sync --frozen --no-dev --no-editable

ENV PATH="/opt/harness/.venv/bin:$PATH"
ENV BOTCUBE_CHECKPOINT_PATH=/var/lib/botcube-harness/checkpoints.sqlite3
EXPOSE 8080
CMD ["botcube-harness-deepagents"]
