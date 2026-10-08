# syntax=docker/dockerfile:1
# Build context: botcube/harness/deepagents/
# The session API function (ADR 0067 §5): the Harness package without the
# Sandbox's tools, served by Lambda's Python runtime interface.
FROM public.ecr.aws/lambda/python:3.13

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# The package sits at the depth it has in the Harness image's virtualenv,
# which its root .env lookup expects.
ENV PYTHONPATH=/opt/session-api/.venv/lib/python3.13/site-packages
WORKDIR /opt/session-api
COPY .tool-dist/cartridge-contract/ /cartridge/
COPY pyproject.toml uv.lock ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv export --frozen --no-dev --no-editable --no-emit-project --no-hashes -o requirements.txt && \
    uv pip install --no-cache --target "$PYTHONPATH" -r requirements.txt
COPY src/ ./src/
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    touch README.md && uv pip install --no-cache --no-deps --target "$PYTHONPATH" .

CMD ["botcube_harness_deepagents.session_api.lambda_handler"]
