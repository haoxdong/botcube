# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.13-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:latest
FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE}
COPY --from=uv /uv /usr/local/bin/uv
COPY cartridge/ /opt/cartridge/
COPY credential-service/ /opt/credential-service/
COPY template/ /opt/template/
WORKDIR /opt/template
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv sync --frozen --no-dev --no-editable
ENV PATH="/opt/template/.venv/bin:$PATH"
CMD ["python", "-m", "botcube_template.credential_service"]
