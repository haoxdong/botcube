# syntax=docker/dockerfile:1
# Build from the repository root. Public clones pass BOTCUBE_ROOT=.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG BOTCUBE_ROOT=botcube
WORKDIR /workspace/botcube
COPY ${BOTCUBE_ROOT}/package.json ${BOTCUBE_ROOT}/pnpm-lock.yaml ${BOTCUBE_ROOT}/pnpm-workspace.yaml ./
COPY ${BOTCUBE_ROOT}/chat/ chat/
COPY ${BOTCUBE_ROOT}/template/chat/ template/chat/
COPY ${BOTCUBE_ROOT}/template/identity.ts template/identity.ts
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --global pnpm@12.10.1 && \
  pnpm install --frozen-lockfile --ignore-scripts --filter botcube-template-chat...
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  pnpm --filter botcube-template-chat build

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/chat-service
COPY --from=build /workspace/botcube/template/chat/dist/ dist/
ENV PORT=8123 TEMPLATE_CHROMIUM_PATH=/usr/bin/chromium
EXPOSE 8123
CMD ["node", "dist/main.js"]
