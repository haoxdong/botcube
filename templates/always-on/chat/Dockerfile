# syntax=docker/dockerfile:1
# Build from the repository root. Public clones pass BOTCUBE_ROOT=.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG BOTCUBE_ROOT=botcube
WORKDIR /workspace/botcube
COPY ${BOTCUBE_ROOT}/package.json ${BOTCUBE_ROOT}/pnpm-lock.yaml ${BOTCUBE_ROOT}/pnpm-workspace.yaml ./
COPY ${BOTCUBE_ROOT}/patches/ patches/
COPY ${BOTCUBE_ROOT}/chat/ chat/
COPY ${BOTCUBE_ROOT}/harness/deepagents/artifact-check/package.json harness/deepagents/artifact-check/
COPY ${BOTCUBE_ROOT}/harness/deepagents/artifact-check/src/ harness/deepagents/artifact-check/src/
COPY ${BOTCUBE_ROOT}/templates/always-on/chat/ templates/always-on/chat/
COPY ${BOTCUBE_ROOT}/templates/always-on/identity.ts templates/always-on/identity.ts
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --global pnpm@12.10.1 && \
  pnpm install --frozen-lockfile --ignore-scripts --filter botcube-always-on-chat...
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  pnpm --filter botcube-always-on-chat build

FROM ${NODE_IMAGE}
# The local Agent Computer finds this Chromium on PATH, as /usr/bin/chromium.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/chat-service
COPY --from=build /workspace/botcube/templates/always-on/chat/dist/ dist/
ENV PORT=8123
EXPOSE 8123
CMD ["node", "dist/main.js"]
