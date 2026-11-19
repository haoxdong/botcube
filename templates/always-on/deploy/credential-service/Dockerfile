# Build from the repository root. Public clones pass BOTCUBE_ROOT=.
ARG REGISTRY=public.ecr.aws
ARG PYTHON_IMAGE=${REGISTRY}/docker/library/python:3.13-slim
FROM ${PYTHON_IMAGE}
ARG BOTCUBE_ROOT=botcube
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
# uv from PyPI, so every image comes from the one registry.
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
  pip install --no-cache-dir uv==0.12.19
COPY ${BOTCUBE_ROOT}/credential-service/ /opt/botcube/credential-service/
COPY ${BOTCUBE_ROOT}/templates/always-on/ /opt/botcube/templates/always-on/
WORKDIR /opt/botcube/templates/always-on
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv sync --frozen --no-dev --no-editable && rm -rf /root/.cache/uv
ENV PATH="/opt/botcube/templates/always-on/.venv/bin:$PATH"
EXPOSE 8081
CMD ["python", "-m", "botcube_always_on.credential_service"]
