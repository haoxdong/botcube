# Build context: the BotCube directory (the public clone root).
ARG REGISTRY=public.ecr.aws
ARG NODE_IMAGE=${REGISTRY}/docker/library/node:24-bookworm-slim
ARG STATIC_IMAGE=${REGISTRY}/docker/library/nginx:stable-alpine
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /workspace/botcube
COPY . ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --global pnpm@12.10.1 && \
  pnpm install --frozen-lockfile --ignore-scripts
FROM dependencies AS dev
ENV BOTCUBE_UI_PACKAGE=botcube-ui-web/plugin-default BOTCUBE_REPOSITORY_ROOT=../..
EXPOSE 3001
CMD ["pnpm", "--filter", "botcube-ui-web", "dev", "--hostname", "0.0.0.0"]

FROM dependencies AS build
ARG NEXT_PUBLIC_CHAT_SERVICE_URL
ARG BOTCUBE_UI_PACKAGE=botcube-ui-web/plugin-default
ARG BOTCUBE_UI_BUILD_CONFIG
ENV NEXT_PUBLIC_CHAT_SERVICE_URL=${NEXT_PUBLIC_CHAT_SERVICE_URL}
ENV BOTCUBE_UI_PACKAGE=${BOTCUBE_UI_PACKAGE} BOTCUBE_UI_BUILD_CONFIG=${BOTCUBE_UI_BUILD_CONFIG} BOTCUBE_REPOSITORY_ROOT=../..
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  pnpm --filter botcube-ui-web build

# Export this stage with --target artifact --output type=local,dest=ui-artifact.
FROM scratch AS artifact
COPY --from=build /workspace/botcube/ui/web/.next-bot/ /

FROM ${STATIC_IMAGE} AS runtime
COPY --from=build /workspace/botcube/ui/web/.next-bot/ /usr/share/nginx/html/
RUN sed -i 's/listen       80;/listen       3001;/; s/listen  \[::\]:80;/listen  [::]:3001;/; /location \/ {/a\        try_files $uri.html $uri $uri/ =404;' /etc/nginx/conf.d/default.conf
EXPOSE 3001
