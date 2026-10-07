# syntax=docker/dockerfile:1
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-slim
FROM ${NODE_IMAGE}

WORKDIR /workspace/botcube/ui/web
COPY ui/web/package.json ./
COPY template/ui/web/ /workspace/botcube/template/ui/web/
COPY template/identity.ts /workspace/botcube/template/identity.ts
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  npm install --ignore-scripts /workspace/botcube/template/ui/web && \
  ln -s ui/web/node_modules /workspace/botcube/node_modules && \
  ln -s .. node_modules/botcube-ui-web
COPY ui/web/ ./

ENV CARTRIDGE_UI_PACKAGE=botcube-template-ui-web
ENV BOTCUBE_REPOSITORY_ROOT=../..
EXPOSE 3001
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]
