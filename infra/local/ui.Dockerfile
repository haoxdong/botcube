ARG REGISTRY=public.ecr.aws
ARG NODE_IMAGE=${REGISTRY}/docker/library/node:24-slim
FROM ${NODE_IMAGE}

WORKDIR /workspace/botcube
COPY . ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --global pnpm@12.10.1 && \
  pnpm install --frozen-lockfile --ignore-scripts

ENV CARTRIDGE_UI_PACKAGE=botcube-ui-web/cartridge-default
ENV BOTCUBE_REPOSITORY_ROOT=../..
EXPOSE 3001
CMD ["pnpm", "--filter", "botcube-ui-web", "dev", "--hostname", "0.0.0.0"]
