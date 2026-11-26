# Build context: botcube/
# The session API function (ADR 0067 §5): the Harness package without the
# Sandbox's tools, served by Lambda's Python runtime interface.
ARG REGISTRY=public.ecr.aws
FROM ${REGISTRY}/lambda/python:3.13

RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install --no-cache-dir uv==0.12.19

ENV PYTHONPATH=/opt/session-api/.venv/lib/python3.13/site-packages
WORKDIR /opt/session-api
COPY harness/deepagents/pyproject.toml harness/deepagents/uv.lock ./
COPY config/pyproject.toml config/bot.schema.json /config/
COPY config/src/ /config/src/
COPY credential-source/ /credential-source/
COPY endpoint-tls/ /endpoint-tls/
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv export --frozen --no-dev --no-editable --no-emit-project --no-hashes -o requirements.txt && \
    uv pip install --no-cache --target "$PYTHONPATH" -r requirements.txt
COPY harness/deepagents/src/ ./src/
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    touch README.md && uv pip install --no-cache --no-deps --target "$PYTHONPATH" .

CMD ["botcube_harness_deepagents.session_api.lambda_handler"]
