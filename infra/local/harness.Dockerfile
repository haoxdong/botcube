# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.13-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:latest
FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE}

COPY --from=uv /uv /usr/local/bin/uv

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
