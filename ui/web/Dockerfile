# syntax=docker/dockerfile:1
# Build context: the BotCube directory (the public clone root).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim
ARG STATIC_IMAGE=public.ecr.aws/docker/library/nginx:stable-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace/botcube
COPY . ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --global pnpm@12.10.1 && \
  pnpm install --frozen-lockfile --ignore-scripts
ARG NEXT_PUBLIC_CHAT_SERVICE_URL
ARG CARTRIDGE_UI_PACKAGE=botcube-template-ui-web
ARG CARTRIDGE_UI_BUILD_CONFIG
ENV NEXT_PUBLIC_CHAT_SERVICE_URL=${NEXT_PUBLIC_CHAT_SERVICE_URL}
ENV CARTRIDGE_UI_PACKAGE=${CARTRIDGE_UI_PACKAGE} CARTRIDGE_UI_BUILD_CONFIG=${CARTRIDGE_UI_BUILD_CONFIG} BOTCUBE_REPOSITORY_ROOT=../..
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  pnpm --filter botcube-ui-web build

# Export this stage with --target artifact --output type=local,dest=ui-artifact.
FROM scratch AS artifact
COPY --from=build /workspace/botcube/ui/web/.next-cartridge/ /

FROM ${STATIC_IMAGE}
COPY --from=build /workspace/botcube/ui/web/.next-cartridge/ /usr/share/nginx/html/
RUN sed -i 's/listen       80;/listen       3001;/; s/listen  \[::\]:80;/listen  [::]:3001;/; /location \/ {/a\        try_files $uri.html $uri $uri/ =404;' /etc/nginx/conf.d/default.conf
EXPOSE 3001
