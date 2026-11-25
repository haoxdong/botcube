# Build from the repository root. Public clones pass BOTCUBE_ROOT=.
ARG REGISTRY=public.ecr.aws
ARG NODE_IMAGE=${REGISTRY}/docker/library/node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG BOTCUBE_ROOT=botcube
WORKDIR /workspace/botcube
COPY ${BOTCUBE_ROOT}/package.json ${BOTCUBE_ROOT}/pnpm-lock.yaml ${BOTCUBE_ROOT}/pnpm-workspace.yaml ./
COPY ${BOTCUBE_ROOT}/patches/ patches/
COPY ${BOTCUBE_ROOT}/chat/ chat/
COPY ${BOTCUBE_ROOT}/config/ config/
COPY ${BOTCUBE_ROOT}/examples/bot/bot.yaml /bot/bot.yaml
COPY ${BOTCUBE_ROOT}/examples/enterprise/botcube.yaml examples/enterprise/botcube.yaml
COPY ${BOTCUBE_ROOT}/examples/public/botcube.yaml examples/public/botcube.yaml
COPY ${BOTCUBE_ROOT}/harness/deepagents/artifact-check/package.json harness/deepagents/artifact-check/
COPY ${BOTCUBE_ROOT}/credential-source/src/botcube_credential_source/refresh-windows.json credential-source/src/botcube_credential_source/refresh-windows.json
COPY ${BOTCUBE_ROOT}/harness/deepagents/artifact-check/src/ harness/deepagents/artifact-check/src/
COPY ${BOTCUBE_ROOT}/harness/deepagents/src/botcube_harness_deepagents/session-api.json harness/deepagents/src/botcube_harness_deepagents/session-api.json
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --global pnpm@12.10.1 && \
  pnpm install --frozen-lockfile --ignore-scripts --filter botcube-chat...
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  pnpm --filter botcube-chat build

FROM ${NODE_IMAGE}
# The local Agent Computer finds this Chromium on PATH, as /usr/bin/chromium.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/chat-service
COPY --from=build /workspace/botcube/chat/dist/ dist/
COPY --from=build /workspace/botcube/examples/ examples/
COPY --from=build /bot/ /bot/
ENV PORT=8123
EXPOSE 8123
CMD ["node", "dist/main.js"]
