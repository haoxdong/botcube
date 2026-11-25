# The local Credential Service and fake site: BotCube's Credential Service package and the stand-ins beside this file.
ARG REGISTRY=public.ecr.aws
FROM ${REGISTRY}/docker/library/python:3.13-slim
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
  pip install --no-cache-dir uv==0.12.19
COPY config/pyproject.toml config/bot.schema.json /opt/config/
COPY config/src/ /opt/config/src/
COPY credential-source/ /opt/credential-source/
COPY credential-service/ /opt/credential-service/
WORKDIR /opt/credential-service
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
  uv sync --frozen --no-dev --no-editable
COPY infra/local/stand-ins/ /opt/stand-ins/
ENV PATH="/opt/credential-service/.venv/bin:$PATH"
CMD ["python", "/opt/stand-ins/credential_service.py"]
