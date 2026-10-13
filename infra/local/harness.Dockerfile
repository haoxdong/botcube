# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.13-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:latest
FROM ${UV_IMAGE} AS uv
FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS browser
WORKDIR /opt/browser
COPY harness/deepagents/browser/ ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm ci --omit=dev --ignore-scripts && node install.mjs /opt/browser && rm -rf node_modules
FROM ${PYTHON_IMAGE}

COPY --from=uv /uv /usr/local/bin/uv
COPY --from=browser /opt/browser/ /opt/browser/
RUN ARCH=$(dpkg --print-architecture) && \
  if [ "$ARCH" = "arm64" ]; then BIN=agent-browser-linux-arm64; else BIN=agent-browser-linux-x64; fi && \
  cp "/opt/browser/$BIN" /usr/local/bin/agent-browser && chmod +x /usr/local/bin/agent-browser

WORKDIR /opt/harness
COPY cartridge/ /cartridge/
COPY harness/deepagents/ ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv sync --frozen --no-dev --no-editable

COPY template/ /opt/template/
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv pip install --python /opt/harness/.venv/bin/python --no-deps /opt/template

COPY harness/deepagents/.tool-dist/ /opt/tools/
ENV PATH="/opt/tools/bin:/opt/harness/.venv/bin:$PATH"
ENV BOTCUBE_MODEL=echo
ENV BOTCUBE_CARTRIDGE_MODULE=botcube_template.harness
ENV BOTCUBE_CHECKPOINT_PATH=/var/lib/botcube-harness/checkpoints.sqlite3
EXPOSE 8080
CMD ["botcube-harness-deepagents"]
