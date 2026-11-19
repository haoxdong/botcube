ARG REGISTRY=public.ecr.aws
FROM ${REGISTRY}/docker/library/python:3.13-slim
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
  pip install --no-cache-dir uv==0.12.19
COPY credential-service/ /opt/credential-service/
COPY templates/always-on/ /opt/templates/always-on/
WORKDIR /opt/templates/always-on
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv sync --frozen --no-dev --no-editable
ENV PATH="/opt/templates/always-on/.venv/bin:$PATH"
CMD ["python", "-m", "botcube_always_on.credential_service"]
