# syntax=docker/dockerfile:1
# Build from the repository root. Public clones pass BOTCUBE_ROOT=.
ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.13-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.19
FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE}
ARG BOTCUBE_ROOT=botcube
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
COPY ${BOTCUBE_ROOT}/cartridge/ /opt/botcube/cartridge/
COPY ${BOTCUBE_ROOT}/credential-service/ /opt/botcube/credential-service/
COPY ${BOTCUBE_ROOT}/template/ /opt/botcube/template/
WORKDIR /opt/botcube/template
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv sync --frozen --no-dev --no-editable && rm -rf /root/.cache/uv
ENV PATH="/opt/botcube/template/.venv/bin:$PATH"
EXPOSE 8125
CMD ["python", "-m", "botcube_template.credential_service"]
