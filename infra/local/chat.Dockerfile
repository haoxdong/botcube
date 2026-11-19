ARG REGISTRY=public.ecr.aws
ARG NODE_IMAGE=${REGISTRY}/docker/library/node:24-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY chat/ chat/
COPY deployment-config/ deployment-config/
COPY examples/bot/bot.json examples/bot/bot.json
COPY examples/public/deployment-config.json examples/public/deployment-config.json
COPY harness/deepagents/artifact-check/package.json harness/deepagents/artifact-check/
COPY harness/deepagents/artifact-check/src/ harness/deepagents/artifact-check/src/
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --global pnpm@12.10.1 && \
  pnpm install --frozen-lockfile --ignore-scripts --filter botcube-chat...
RUN chat/node_modules/.bin/esbuild chat/src/main.ts --bundle --platform=node --format=esm \
  --banner:js="import{createRequire as __chatCreateRequire}from'node:module';const require=__chatCreateRequire(import.meta.url);" \
  --outfile=dist/main.js

FROM ${NODE_IMAGE}

# The local Agent Computer runs this Chromium, at its default /usr/bin/chromium.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/chat-service
COPY --from=build /workspace/dist/ dist/
COPY --from=build /workspace/examples/ examples/

ENV BOTCUBE_LOCAL_HARNESS_URL=http://harness:8080
ENV BOTCUBE_LOCAL_SESSION_API_URL=http://session-api:8081
ENV BOTCUBE_DEPLOYMENT_CONFIG=/opt/chat-service/examples/public/deployment-config.json
ENV PORT=8123
EXPOSE 8123
CMD ["node", "dist/main.js"]
