# syntax=docker/dockerfile:1
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /workspace
COPY chat/ chat/
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --no-save ./chat esbuild@^0.28.2
COPY template/chat/src/ template/chat/src/
COPY template/identity.ts template/identity.ts
RUN npx esbuild template/chat/src/main.ts --bundle --platform=node --format=esm \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --outfile=dist/main.js

FROM ${NODE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/chat-service
COPY --from=build /workspace/dist/ dist/

ENV BOTCUBE_LOCAL_HARNESS_URL=http://harness:8080
ENV BOTCUBE_LOCAL_SESSION_API_URL=http://session-api:8081
ENV PORT=8123
ENV TEMPLATE_CHROMIUM_PATH=/usr/bin/chromium
EXPOSE 8123
CMD ["node", "dist/main.js"]
